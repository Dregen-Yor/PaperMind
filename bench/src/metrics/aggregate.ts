import type { PerSampleRecord } from '../types'

export function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((a, b) => a + b, 0) / values.length
}

/** 最近秩法分位数：排序后取 ceil(p/100 * n) - 1 位。 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

/**
 * 逐样本指标 → 聚合均值。
 * 只在「拥有该指标」的样本上求均值：失败样本不写指标，
 * 从而自动从分母中剔除，不会把网络超时误算成质量下降。
 */
export function aggregate(records: PerSampleRecord[]): Record<string, number> {
  const buckets = new Map<string, number[]>()
  for (const r of records) {
    for (const [key, value] of Object.entries(r.metrics)) {
      if (!Number.isFinite(value)) continue
      const list = buckets.get(key) ?? []
      list.push(value)
      buckets.set(key, list)
    }
  }
  const out: Record<string, number> = {}
  for (const [key, values] of buckets) out[key] = mean(values)
  return out
}

/** Number of valid observations for every sparse metric. */
export function metricSampleCounts(records: PerSampleRecord[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const record of records) {
    for (const [key, value] of Object.entries(record.metrics)) {
      if (Number.isFinite(value)) counts[key] = (counts[key] ?? 0) + 1
    }
  }
  return counts
}

/** QA runner 共用的展示/结果契约键名。 */
export function renameQaRates(metrics: Record<string, number>): Record<string, number> {
  const names: Record<string, string> = {
    evidenceHit: 'evidenceHitRate',
    degraded: 'degradedRate',
    rewrite: 'rewriteRate',
    contextTruncated: 'contextTruncatedRate',
    partialScoreCoverage: 'partialScoreCoverageRate',
    llmCalls: 'llmCallsPerQuery',
    treeUsed: 'treeUsedRate',
    treeDegraded: 'treeDegradationRate',
  }
  return Object.fromEntries(Object.entries(metrics).map(([key, value]) => [names[key] ?? key, value]))
}

/**
 * 兼容包装：输出既有 latencyP50/P95（deprecated，下一发布周期删除，空数组仍记 0 与历史契约一致），
 * 再追加 llmNetworkLatencyP50Ms/P95Ms 让口径以 Ms 后缀字段为准；网络无真实请求时不产生 Ms 字段，
 * 由报表以「—」展示，防止 0 ms 被误读为极速完成。
 */
export function withLatencyStats(
  metrics: Record<string, number>,
  latencies: number[],
): Record<string, number> {
  const clean = latencies.filter(v => Number.isFinite(v) && v >= 0)
  return {
    ...metrics,
    latencyP50: percentile(clean, 50),
    latencyP95: percentile(clean, 95),
    ...(clean.length > 0
      ? {
          llmNetworkLatencyP50Ms: percentile(clean, 50),
          llmNetworkLatencyP95Ms: percentile(clean, 95),
        }
      : {}),
  }
}

/**
 * 为每个时延前缀生成 P50/P95（最近秩法），输出 `${key}P50Ms` / `${key}P95Ms`。
 * - 过滤非有限数与负数；
 * - 空数组不产生字段（而非写 0），让报表能显示「—」，防止 0 ms 被误读为极速完成。
 */
export function withPercentiles(
  metrics: Record<string, number>,
  values: Record<string, number[]>,
): Record<string, number> {
  const out = { ...metrics }
  for (const [key, list] of Object.entries(values)) {
    const clean = list.filter(v => Number.isFinite(v) && v >= 0)
    if (clean.length === 0) continue
    out[`${key}P50Ms`] = percentile(clean, 50)
    out[`${key}P95Ms`] = percentile(clean, 95)
  }
  return out
}
