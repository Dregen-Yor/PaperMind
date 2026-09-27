/**
 * 冷首问指标聚合（Task 7 Step 2）。
 *
 * 四条口径钉在这里：
 * 1. TTFT / Full Answer 的 P50/P95 只取**完整且同场景**的 cohort（completed 且两个时长都在），
 *    失败与不完整记录不进分位数；
 * 2. 样本/完成/失败计数保持可见（失败是结果的一部分，不能被静默剔除）；
 * 3. A 臂（或失败路径）缺失的向量/目录就绪**缺席**，绝不编码成 0；
 * 4. 策略或输入口径不一致的记录不能混进同一次聚合。
 */
import { describe, expect, it } from 'vitest'
import type { ColdFirstQueryRecord } from '../types'
import { aggregateColdFirstQueryMetrics } from '../metrics/coldFirstQuery'

function record(overrides: Partial<ColdFirstQueryRecord> = {}): ColdFirstQueryRecord {
  return {
    id: 'p#0',
    paperId: 'p',
    strategy: 'ready-before-query',
    inputKind: 'pdf-bytes',
    pdfLoadMs: 10,
    localModelInitMs: 5,
    lexicalReadyMs: 20,
    actualPassageStage: 2,
    retrievalMode: 'bm25+dense',
    outlineUsed: false,
    timeToFirstTokenMs: 100,
    fullAnswerLatencyMs: 200,
    completionStatus: 'completed',
    ...overrides,
  }
}

const READY_SCENARIO = { mode: 'hybrid-raw' as const, strategy: 'ready-before-query' as const }

describe('aggregateColdFirstQueryMetrics', () => {
  it('TTFT / Full Answer 的 P50/P95 只取完整同场景 cohort，失败与不完整不进分位数', () => {
    const records = [
      record({ id: 'p#0', timeToFirstTokenMs: 100, fullAnswerLatencyMs: 200 }),
      record({ id: 'p#1', timeToFirstTokenMs: 300, fullAnswerLatencyMs: 600 }),
      record({ id: 'p#2', timeToFirstTokenMs: 500, fullAnswerLatencyMs: 900 }),
      // 失败：不参与分位数，但计数必须可见
      record({ id: 'p#3', completionStatus: 'failed', failureStage: 'retrieve', timeToFirstTokenMs: undefined, fullAnswerLatencyMs: undefined }),
      // 完成但缺时长：不算完整 cohort
      record({ id: 'p#4', completionStatus: 'completed', timeToFirstTokenMs: undefined, fullAnswerLatencyMs: undefined }),
    ]

    const metrics = aggregateColdFirstQueryMetrics(records, READY_SCENARIO)
    expect(metrics.coldFirstQuerySampleCount).toBe(5)
    expect(metrics.coldFirstQueryCompletedCount).toBe(3)
    expect(metrics.coldFirstQueryFailedCount).toBe(1)
    expect(metrics.timeToFirstTokenP50Ms).toBe(300)
    expect(metrics.timeToFirstTokenP95Ms).toBe(500)
    expect(metrics.fullAnswerLatencyP50Ms).toBe(600)
    expect(metrics.fullAnswerLatencyP95Ms).toBe(900)
  })

  it('A 臂缺失的向量/目录就绪不编码成 0（字段整体缺席）', () => {
    const metrics = aggregateColdFirstQueryMetrics(
      [record({ strategy: 'ready-before-query' })],
      { mode: 'lexical', strategy: 'ready-before-query' },
    )
    expect(metrics).not.toHaveProperty('denseReadyP50Ms')
    expect(metrics).not.toHaveProperty('denseReadyP95Ms')
    expect(metrics).not.toHaveProperty('outlineReadyP50Ms')
    expect(metrics).not.toHaveProperty('outlineReadyP95Ms')
  })

  it('向量/目录就绪有观测时按观测值产 P50/P95', () => {
    const metrics = aggregateColdFirstQueryMetrics(
      [
        record({ denseReadyMs: 40, outlineReadyMs: 50 }),
        record({ denseReadyMs: 80, outlineReadyMs: 90 }),
      ],
      { mode: 'hybrid-outline', strategy: 'ready-before-query' },
    )
    expect(metrics.denseReadyP50Ms).toBe(40)
    expect(metrics.denseReadyP95Ms).toBe(80)
    expect(metrics.outlineReadyP50Ms).toBe(50)
    expect(metrics.outlineReadyP95Ms).toBe(90)
  })

  it('hybrid-outline 输出目录实际使用率', () => {
    const metrics = aggregateColdFirstQueryMetrics(
      [record({ outlineUsed: true }), record({ outlineUsed: false })],
      { mode: 'hybrid-outline', strategy: 'ready-before-query' },
    )
    expect(metrics.outlineUsedRate).toBe(0.5)
  })

  it('非 hybrid-outline 不输出目录使用率', () => {
    const metrics = aggregateColdFirstQueryMetrics([record()], READY_SCENARIO)
    expect(metrics).not.toHaveProperty('outlineUsedRate')
  })

  it('策略不一致的记录拒绝混入同一 cohort', () => {
    expect(() => aggregateColdFirstQueryMetrics(
      [record({ strategy: 'ask-at-lexical-ready' })],
      READY_SCENARIO,
    )).toThrow(/strategy|策略/)
  })

  it('输入口径不一致的记录拒绝混入同一 cohort', () => {
    expect(() => aggregateColdFirstQueryMetrics(
      [record({ inputKind: 'text' as ColdFirstQueryRecord['inputKind'] })],
      READY_SCENARIO,
    )).toThrow(/inputKind|口径/)
  })

  it('空记录集只输出自证计数，不产生分位数', () => {
    expect(aggregateColdFirstQueryMetrics([], READY_SCENARIO)).toEqual({
      coldFirstQuerySampleCount: 0,
      coldFirstQueryCompletedCount: 0,
      coldFirstQueryFailedCount: 0,
    })
  })
})
