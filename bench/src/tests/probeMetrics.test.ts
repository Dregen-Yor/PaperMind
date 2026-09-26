import { describe, it, expect } from 'vitest'
import {
  aggregateProbe,
  failureReason,
  type ProbeObservation,
  type ProbeSkipAccount,
} from '../toc/probeMetrics'

/** 只带聚合所需字段的观测构造器，省得每条用例抄一遍四个字段。 */
const obs = (
  selectedPages: number[],
  goldEvidencePages: number[],
  extra: Partial<Pick<ProbeObservation, 'emptyContentSkipped' | 'emptySelectionFallback'>> = {},
): ProbeObservation => ({
  selectedPages,
  goldEvidencePages,
  emptyContentSkipped: extra.emptyContentSkipped ?? 0,
  emptySelectionFallback: extra.emptySelectionFallback ?? false,
})

/** 空账目：默认没有跳过、没有失败，attempted 由调用方按需覆盖。 */
const account = (overrides: Partial<ProbeSkipAccount> = {}): ProbeSkipAccount => ({
  attemptedQuestions: 0,
  skippedUnanswerable: 0,
  skippedUnmapped: 0,
  skippedEmptyEvidence: 0,
  buildFailurePapersByReason: {},
  buildFailureQuestionsByReason: {},
  traversalFailureByReason: {},
  ...overrides,
})

describe('aggregateProbe —— anyHit / recall / precision 的定义', () => {
  it('手算三题：命中率 2/3，recall 与 precision 逐题取交再平均', () => {
    const summary = aggregateProbe([
      obs([0, 1], [1, 2]), // 命中；recall 1/2；precision 1/2
      obs([3], [3, 4]),    // 命中；recall 1/2；precision 1
      obs([5], [6]),       // 未命中；recall 0；precision 0
    ], account({ attemptedQuestions: 3 }))

    expect(summary.scoredQuestions).toBe(3)
    expect(summary.anyHit).toBeCloseTo(2 / 3, 10)
    expect(summary.meanRecall).toBeCloseTo((0.5 + 0.5 + 0) / 3, 10)
    expect(summary.meanPrecision).toBeCloseTo((0.5 + 1 + 0) / 3, 10)
    expect(summary.recallSampleCount).toBe(3)
    expect(summary.precisionSampleCount).toBe(3)
    expect(summary.selectedNothing).toBe(0)
  })

  it('anyHit 分母是**已打分**题而非命中数：全空选中时为 0', () => {
    const summary = aggregateProbe([obs([], [1]), obs([], [2])], account({ attemptedQuestions: 2 }))
    expect(summary.anyHit).toBe(0)
    expect(summary.meanRecall).toBe(0)
    expect(summary.scoredQuestions).toBe(2)
  })

  it('分母为 0 的汇总返回 0，绝不返回 NaN', () => {
    const summary = aggregateProbe([], account({ attemptedQuestions: 0 }))
    expect(summary.scoredQuestions).toBe(0)
    expect(summary.anyHit).toBe(0)
    expect(summary.meanRecall).toBe(0)
    expect(summary.meanPrecision).toBe(0)
    expect(summary.meanSelectedPages).toBe(0)
    expect(Number.isNaN(summary.meanRecall)).toBe(false)
  })
})

describe('aggregateProbe —— 空选中的 precision 口径（排除而非记 0）', () => {
  it('空选中题从 precision 均值剔除，并单独计入 selectedNothing', () => {
    const summary = aggregateProbe([
      obs([0], [0]), // 选中非空，precision 1
      obs([], [1]),  // 空选中：不进 precision 均值
    ], account({ attemptedQuestions: 2 }))

    // 若把空选中记 0，precision 会变成 0.5；这里刻意是 1，且分母只剩 1
    expect(summary.meanPrecision).toBe(1)
    expect(summary.precisionSampleCount).toBe(1)
    expect(summary.selectedNothing).toBe(1)
    // 空选中仍要进 anyHit / recall 的分母——它是一次真实的漏检
    expect(summary.anyHit).toBe(0.5)
    expect(summary.meanRecall).toBe(0.5)
  })

  it('全部空选中时 precision 均值为 0（无样本），且不产生 NaN', () => {
    const summary = aggregateProbe([obs([], [1]), obs([], [2])], account({ attemptedQuestions: 2 }))
    expect(summary.meanPrecision).toBe(0)
    expect(summary.precisionSampleCount).toBe(0)
    expect(summary.selectedNothing).toBe(2)
  })
})

describe('aggregateProbe —— 跳过原因各计各的', () => {
  it('每类跳过原样透传，题级失败按原因求和', () => {
    const summary = aggregateProbe([
      obs([0], [0]),
      obs([1], [1]),
    ], account({
      attemptedQuestions: 10,
      skippedUnanswerable: 3,
      skippedUnmapped: 2,
      skippedEmptyEvidence: 1,
      traversalFailureByReason: { 'not-an-array': 1, 'sidecar error': 1 },
    }))

    expect(summary.skipped).toEqual({
      unanswerable: 3,
      unmapped: 2,
      emptyEvidence: 1,
      traversalFailure: 2,
    })
    // 未跳过的题只有 2 道，绝不能被算进任何跳过桶
    expect(summary.scoredQuestions).toBe(2)
    expect(summary.attemptedQuestions).toBe(10)
  })

  it('建树失败按原因分列：篇数与丢题数各自成表', () => {
    const summary = aggregateProbe([obs([0], [0])], account({
      attemptedQuestions: 6,
      buildFailurePapersByReason: { 'invalid-section-structure: too-deep': 1 },
      buildFailureQuestionsByReason: { 'invalid-section-structure: too-deep': 5 },
    }))
    expect(summary.buildFailurePapersByReason).toEqual({ 'invalid-section-structure: too-deep': 1 })
    expect(summary.buildFailureQuestionsByReason).toEqual({ 'invalid-section-structure: too-deep': 5 })
  })

  it('返回的原因表是副本，改它不会污染入参账目', () => {
    const source = account({ traversalFailureByReason: { 'not-an-array': 1 } })
    const summary = aggregateProbe([], source)
    summary.traversalFailureByReason['injected'] = 99
    expect(source.traversalFailureByReason).toEqual({ 'not-an-array': 1 })
  })
})

describe('aggregateProbe —— 守恒对账', () => {
  it('已打分 + 题级跳过 + 建树丢题 === attempted 时 conservationOk 为真', () => {
    const summary = aggregateProbe([
      obs([0], [0]),
      obs([1], [1]),
      obs([2], [2]),
    ], account({
      attemptedQuestions: 3 + 4 + 2 + 1 + 5, // scored + 四类跳过 + 建树丢题
      skippedUnanswerable: 4,
      skippedUnmapped: 2,
      skippedEmptyEvidence: 1,
      traversalFailureByReason: { 'not-an-array': 5 },
    }))
    expect(summary.accountedQuestions).toBe(15)
    expect(summary.conservationOk).toBe(true)
  })

  it('有题凭空消失时 conservationOk 为假（不静默）', () => {
    const summary = aggregateProbe([obs([0], [0])], account({ attemptedQuestions: 5 }))
    expect(summary.accountedQuestions).toBe(1)
    expect(summary.conservationOk).toBe(false)
  })
})

describe('aggregateProbe —— 树诊断计数聚合', () => {
  it('emptyContentSkipped 求和、emptySelectionFallback 计次', () => {
    const summary = aggregateProbe([
      obs([0], [0], { emptyContentSkipped: 2, emptySelectionFallback: false }),
      obs([1], [1], { emptyContentSkipped: 1, emptySelectionFallback: true }),
      obs([2], [2], { emptyContentSkipped: 0, emptySelectionFallback: true }),
    ], account({ attemptedQuestions: 3 }))
    expect(summary.emptyContentSkipped).toBe(3)
    expect(summary.emptySelectionFallback).toBe(2)
  })

  it('meanSelectedPages 取选中页数的均值（上下文体量代理）', () => {
    const summary = aggregateProbe([
      obs([0, 1, 2], [0]),
      obs([3], [3]),
    ], account({ attemptedQuestions: 2 }))
    expect(summary.meanSelectedPages).toBe(2)
  })
})

describe('failureReason —— 原因键稳定化', () => {
  it('数字被抹平，同一原因的不同论文落进同一桶', () => {
    expect(failureReason(new Error('section-pages-length-mismatch: 3 names vs 1 page-lists')))
      .toBe(failureReason(new Error('section-pages-length-mismatch: 5 names vs 2 page-lists')))
  })

  it('保留可读的原因分类', () => {
    expect(failureReason(new Error('invalid-section-structure: too-deep')))
      .toBe('invalid-section-structure: too-deep')
    expect(failureReason(new Error('invalid-section-structure: non-adjacent-repeat')))
      .toBe('invalid-section-structure: non-adjacent-repeat')
  })

  it('非 Error 输入也能折成字符串', () => {
    expect(failureReason('boom')).toBe('boom')
    expect(failureReason({ toString: () => 'weird' })).toBe('weird')
  })
})
