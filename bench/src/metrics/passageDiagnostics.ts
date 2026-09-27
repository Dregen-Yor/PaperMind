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
import type { PassageOutlineInfo } from '../runner/passageIndexHook'

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

/**
 * C 臂原生目录结果 → perPaper 的冷启动字段。
 *
 * 目录的可用性 / 节点数 / 回落原因是「C 臂到底有没有真的用上目录」的唯一证据：只把耗时
 * 折进总时长，会让「目录一直失败、整臂退化成 B」的一次运行在产物里读起来与 B 逐字相同。
 * 用 `coldStartOutline*` 前缀与 `coldStartStructure*`（LLM 卡片）刻意分开——目录失败不是卡片失败。
 */
export function outlineRecordFields(outline: PassageOutlineInfo | undefined): Partial<PaperTimingRecord> {
  if (!outline) return {}
  return {
    coldStartOutlineMs: outline.elapsedMs,
    coldStartOutlineAvailable: outline.available ? 1 : 0,
    coldStartOutlineNodeCount: outline.nodeCount,
    ...(outline.fallbackReason !== undefined ? { coldStartOutlineFallback: outline.fallbackReason } : {}),
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
  // 端到端与卡片调用同口径：只统计卡片调用未命中缓存的论文。命中时端到端只剩切段 +
  // 向量，同一次运行里后跑的 sectionWeight 臂会因此显得「冷启动更便宜」，是假象
  const totalMs = valuesOf(
    records.filter(record => record.coldStartStructureCacheHit !== 1),
    record => record.coldStartTotalMs,
  )
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
  store('passageEmbedFailureRate', records.filter(record => record.coldStartEmbedFailed === 1).length / attempted)
  store('avgColdStartPassageCount', meanOf(valuesOf(records, record => record.coldStartPassageCount)))

  // 目录可用率的分母是**尝试过目录的论文**（只有 hybrid-outline 的篇会写这个字段）：
  // 目录失败的 C 篇正是「这一臂退化成 B 了」的证据，必须留在分母里，不能被悄悄剔除
  const outlineAttempted = records.filter(record => record.coldStartOutlineAvailable !== undefined)
  store('outlineAvailabilityRate', outlineAttempted.length
    ? outlineAttempted.filter(record => record.coldStartOutlineAvailable === 1).length / outlineAttempted.length
    : undefined)
  // Task 8：valid/fallback 计数与目录可用率同分母（只统计 C 臂尝试过目录的论文），
  // 让「全 PDF 分母」与「有有效目录的配对子集」在产物里各自可见
  store('outlineAvailableCount', outlineAttempted.filter(record => record.coldStartOutlineAvailable === 1).length)
  store('outlineFallbackCount', outlineAttempted.filter(record => record.coldStartOutlineAvailable === 0).length)
  store('avgColdStartOutlineMs', meanOf(valuesOf(outlineAttempted, record => record.coldStartOutlineMs)))
  // 目录解析/建树/向量耗时按「尝试过目录的论文」取 P50/P95（C 臂真实等待的独立观测）
  const outlineMs = valuesOf(outlineAttempted, record => record.coldStartOutlineMs)

  return withPercentiles(metrics, { coldStartTotal: totalMs, structureCall: uncachedCallMs, outlineBuild: outlineMs })
}

/**
 * 目录实际使用率（Task 8）：逐题 `outlineUsed` 的聚合。
 *
 * 分母是**写了目录诊断**的题（`outlineUsed !== undefined`，即 C 臂真的产出了目录产物的论文
 * 的全部问题——含目录失败篇的「未使用」），分子是 `outlineUsed === true` 的题。目录可用率
 * （每篇）与使用率（每题）是两个口径，分列才能同时回答「有多少篇用得上目录」与「多少题真的用了」。
 */
export function summarizeOutlineUse(records: Array<{ outlineUsed?: boolean }>): Record<string, number> {
  const withDiagnostic = records.filter(record => record.outlineUsed !== undefined)
  if (withDiagnostic.length === 0) return {}
  const used = withDiagnostic.filter(record => record.outlineUsed).length
  return {
    outlineUsedRate: used / withDiagnostic.length,
    outlineUsedCount: used,
    outlineUseDenominatorCount: withDiagnostic.length,
  }
}
