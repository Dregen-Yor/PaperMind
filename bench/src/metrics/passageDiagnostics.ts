/**
 * 冷启动成本的记录与聚合（方案 §7）：**不进入 Q**，与 Q 并列报告。
 *
 * 口径要点：
 * - `structureCall` 的 P50/P95 **只统计未命中缓存的调用**——缓存命中时耗时接近 0，
 *   混进去会把卡片调用成本稀释成假象；命中的论文仍照记 token（估算）与卡片数。
 * - 回落率的分母是**所有尝试过的论文**（回落是结果的一部分），
 *   阶段耗时均值只在真的做了那一步的论文上平均。
 */
import { withPercentiles } from './aggregate'
import type { PaperTimingRecord } from '../types'

/**
 * 取均值，空数组返回 `undefined` 而非 0（与 `treeDiagnostics.ts` 的私有 `mean` 同口径，
 * 不能直接用 `aggregate.mean`——它对空数组返回 0，会把「没有数据」写成「成本为零」）。
 */
const meanOf = (values: number[]): number | undefined =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : undefined

export interface PassageStageEventLike {
  stage: 'passages' | 'passage-vectors' | 'structure' | 'card-vectors'
  latencyMs: number
  passageCount?: number
  cardCount?: number
  fallback?: string
  cacheHit?: boolean
}

/** 卡片事件的 token 估算：`LlmClient.complete` 不透传服务商 usage，故一律标 estimated=1。 */
export function introspectPassageStageEvent(
  event: PassageStageEventLike,
  input: { inputChars: number; outputChars: number; cacheHit?: boolean },
): Partial<PaperTimingRecord> {
  if (event.stage !== 'structure') return {}
  return {
    coldStartStructureCallMs: event.latencyMs,
    ...(event.cardCount !== undefined ? { coldStartCardCount: event.cardCount } : {}),
    coldStartStructureTokensEstimated: 1,
    coldStartStructureInputTokens: Math.max(1, Math.round(input.inputChars / 4)),
    coldStartStructureOutputTokens: Math.max(1, Math.round(input.outputChars / 4)),
    coldStartStructureCacheHit: (input.cacheHit ?? event.cacheHit) ? 1 : 0,
    ...(event.fallback ? { coldStartStructureFallback: event.fallback } : {}),
  }
}

function valuesOf(records: PaperTimingRecord[], pick: (record: PaperTimingRecord) => number | undefined): number[] {
  return records.map(pick).filter((value): value is number => value !== undefined && Number.isFinite(value))
}

/** 结果 JSON 的 `metrics` 增量；报表据此渲染「冷启动成本」表。 */
export function summarizeColdStart(records: PaperTimingRecord[]): Record<string, number> {
  if (records.length === 0) return {}
  const metrics: Record<string, number> = {}
  const store = (key: string, value: number | undefined) => {
    if (value !== undefined && Number.isFinite(value)) metrics[key] = value
  }

  const passageMs = valuesOf(records, record => record.coldStartPassageMs)
  const embedPassagesMs = valuesOf(records, record => record.coldStartEmbedPassagesMs)
  const embedCardsMs = valuesOf(records, record => record.coldStartEmbedCardsMs)
  const totalMs = valuesOf(records, record => record.coldStartTotalMs)
  store('avgColdStartPassageMs', meanOf(passageMs))
  store('avgColdStartEmbedPassagesMs', meanOf(embedPassagesMs))
  store('avgColdStartEmbedCardsMs', meanOf(embedCardsMs))

  // 卡片调用只统计未命中缓存的调用
  const uncachedCallMs = records
    .filter(record => record.coldStartStructureCacheHit !== 1)
    .map(record => record.coldStartStructureCallMs)
    .filter((value): value is number => value !== undefined && Number.isFinite(value))

  const tokensPerPaper = valuesOf(records, record => {
    const input = record.coldStartStructureInputTokens
    const output = record.coldStartStructureOutputTokens
    if (input === undefined && output === undefined) return undefined
    return (input ?? 0) + (output ?? 0)
  })
  store('structureTokensPerPaper', meanOf(tokensPerPaper))

  const attempted = records.length
  const fallbacks = records.filter(record => record.coldStartStructureFallback !== undefined).length
  store('structureFallbackRate', attempted > 0 ? fallbacks / attempted : undefined)
  store('avgColdStartCardCount', meanOf(valuesOf(records, record => record.coldStartCardCount)))
  store('avgColdStartPassageCount', meanOf(valuesOf(records, record => record.coldStartPassageCount)))

  return withPercentiles(metrics, { coldStartTotal: totalMs, structureCall: uncachedCallMs })
}
