import { describe, expect, it } from 'vitest'
import { introspectPassageStageEvent, summarizeColdStart, type PassageStageEventLike } from '../metrics/passageDiagnostics'

describe('summarizeColdStart', () => {
  const records = [
    { paperId: 'p1', source: 'qasper' as const, pageCount: 5, questionCount: 3, coldStartPassageMs: 100, coldStartEmbedPassagesMs: 200, coldStartStructureCallMs: 4000, coldStartStructureCacheHit: 0, coldStartStructureInputTokens: 8000, coldStartStructureOutputTokens: 400, coldStartEmbedCardsMs: 20, coldStartTotalMs: 4300, coldStartCardCount: 5, coldStartPassageCount: 40 },
    { paperId: 'p2', source: 'qasper' as const, pageCount: 5, questionCount: 2, coldStartPassageMs: 120, coldStartEmbedPassagesMs: 220, coldStartStructureCallMs: 100, coldStartStructureCacheHit: 1, coldStartStructureInputTokens: 8100, coldStartStructureOutputTokens: 410, coldStartEmbedCardsMs: 22, coldStartTotalMs: 400, coldStartPassageCount: 44 },
    { paperId: 'p3', source: 'qasper' as const, pageCount: 5, questionCount: 2, coldStartFailed: 1, coldStartStructureFallback: 'invalid-json', coldStartCardCount: 3, coldStartPassageCount: 30 },
  ]

  it('缓存命中的卡片调用不计入 structureCall 耗时统计', () => {
    const metrics = summarizeColdStart(records)
    expect(metrics.structureCallP50Ms).toBe(4000)
    expect(metrics.structureCallP95Ms).toBe(4000)
  })

  it('聚合出总耗时 P50/P95 与每篇 token 均值', () => {
    const metrics = summarizeColdStart(records)
    // p2 的卡片调用命中缓存，端到端不计入：只剩 p1 一个值
    expect(metrics.coldStartTotalP50Ms).toBe(4300)
    expect(metrics.coldStartTotalP95Ms).toBe(4300)
    expect(metrics.structureTokensPerPaper).toBe(8455)
  })

  it('回落率按尝试过的论文归一', () => {
    const metrics = summarizeColdStart(records)
    expect(metrics.structureFallbackRate).toBeCloseTo(1 / 3)
  })

  it('阶段耗时取各自分母的均值', () => {
    const metrics = summarizeColdStart(records)
    expect(metrics.avgColdStartPassageMs).toBeCloseTo(110)
    expect(metrics.avgColdStartEmbedPassagesMs).toBeCloseTo(210)
    expect(metrics.avgColdStartEmbedCardsMs).toBeCloseTo(21)
  })

  it('空输入产出空对象（报表据此跳过整块）', () => {
    expect(summarizeColdStart([])).toEqual({})
  })
})

describe('introspectPassageStageEvent', () => {
  it('把卡片事件映射为 token 估算与缓存命中标记', () => {
    const event: PassageStageEventLike = { stage: 'structure', latencyMs: 12, cardCount: 3 }
    expect(introspectPassageStageEvent(event, { inputChars: 100, outputChars: 40 })).toEqual({
      coldStartStructureCallMs: 12,
      coldStartCardCount: 3,
      coldStartStructureInputTokens: 25,
      coldStartStructureOutputTokens: 10,
      coldStartStructureTokensEstimated: 1,
      // 未命中缓存时显式记 0：聚合层用 `!== 1` 把命中篇排除出卡片调用耗时统计
      coldStartStructureCacheHit: 0,
    })
  })

  it('回落事件额外记原因', () => {
    const event: PassageStageEventLike = { stage: 'structure', latencyMs: 9, cardCount: 2, fallback: 'input-too-large' }
    expect(introspectPassageStageEvent(event, { inputChars: 0, outputChars: 0 }).coldStartStructureFallback).toBe('input-too-large')
  })
})

describe('summarizeColdStart — 缓存命中与向量失败', () => {
  const base = { source: 'qasper' as const, pageCount: 5, questionCount: 1 }
  it('冷启动端到端只统计卡片调用未命中缓存的论文', () => {
    const metrics = summarizeColdStart([
      { ...base, paperId: 'a', coldStartTotalMs: 5000, coldStartStructureCacheHit: 0 },
      { ...base, paperId: 'b', coldStartTotalMs: 300, coldStartStructureCacheHit: 1 },
    ])
    expect(metrics.coldStartTotalP50Ms).toBe(5000)
    expect(metrics.coldStartTotalP95Ms).toBe(5000)
  })

  it('向量失败的论文只计失败率，不进段落向量耗时均值', () => {
    const metrics = summarizeColdStart([
      { ...base, paperId: 'a', coldStartEmbedPassagesMs: 200 },
      { ...base, paperId: 'b', coldStartEmbedFailed: 1 },
    ])
    expect(metrics.avgColdStartEmbedPassagesMs).toBe(200)
    expect(metrics.passageEmbedFailureRate).toBe(0.5)
  })
})
