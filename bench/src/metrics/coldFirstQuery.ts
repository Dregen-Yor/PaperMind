/**
 * 冷首问指标聚合（Task 7 Step 6）：`cold-first-query-v1`。
 *
 * 与 `aggregateSpeedMetrics` / Q 完全分开：本模块只消费 `ColdFirstQueryRecord`，
 * 它的输出只进入 `ColdFirstQueryResult.metrics`，**绝不**喂给 query-timeline 或质量口径。
 *
 * 口径要点：
 * - TTFT / Full Answer 的 P50/P95 只取**完整且同场景**的 cohort（completed 且两个时长都在）；
 *   失败与不完整记录不进分位数，但计数（样本/完成/失败）保持可见。
 * - 向量/目录就绪只在真的观测到时输出分位数——A 臂或失败路径缺席，绝不编码成 0。
 * - 策略或输入口径不一致的记录不能混进同一次聚合，直接抛错。
 */
import { percentile } from './aggregate'
import type { ColdFirstQueryRecord, ColdStrategy, PassageMode } from '../types'

export interface ColdFirstQueryScenario {
  mode: PassageMode
  strategy: ColdStrategy
}

/** 取有限非负的观测值（缺字段即缺席，不补 0）。 */
function finiteValues(
  records: ColdFirstQueryRecord[],
  pick: (record: ColdFirstQueryRecord) => number | undefined,
): number[] {
  return records.flatMap(record => {
    const value = pick(record)
    return value !== undefined && Number.isFinite(value) && value >= 0 ? [value] : []
  })
}

export function aggregateColdFirstQueryMetrics(
  records: ColdFirstQueryRecord[],
  scenario: ColdFirstQueryScenario,
): Record<string, number> {
  // cohort 身份必须一致：不同策略或不同输入口径的观测不是同一次实验，混读只会得出噪声数字
  for (const record of records) {
    if (record.strategy !== scenario.strategy) {
      throw new Error(`cold-first-query 不能混合不同策略的记录：${record.strategy} ≠ ${scenario.strategy}`)
    }
    if (record.inputKind !== 'pdf-bytes') {
      throw new Error(`cold-first-query 不能混合不同输入口径的记录：${record.inputKind} ≠ pdf-bytes`)
    }
  }

  const completed = records.filter(record =>
    record.completionStatus === 'completed'
    && record.timeToFirstTokenMs !== undefined
    && record.fullAnswerLatencyMs !== undefined)
  const failed = records.filter(record => record.completionStatus === 'failed')

  const metrics: Record<string, number> = {
    coldFirstQuerySampleCount: records.length,
    coldFirstQueryCompletedCount: completed.length,
    coldFirstQueryFailedCount: failed.length,
  }

  if (completed.length > 0) {
    metrics.timeToFirstTokenP50Ms = percentile(completed.map(record => record.timeToFirstTokenMs!), 50)
    metrics.timeToFirstTokenP95Ms = percentile(completed.map(record => record.timeToFirstTokenMs!), 95)
    metrics.fullAnswerLatencyP50Ms = percentile(completed.map(record => record.fullAnswerLatencyMs!), 50)
    metrics.fullAnswerLatencyP95Ms = percentile(completed.map(record => record.fullAnswerLatencyMs!), 95)

    const pdfLoad = finiteValues(completed, record => record.pdfLoadMs)
    if (pdfLoad.length > 0) {
      metrics.pdfLoadP50Ms = percentile(pdfLoad, 50)
      metrics.pdfLoadP95Ms = percentile(pdfLoad, 95)
    }
    const localModelInit = finiteValues(completed, record => record.localModelInitMs)
    if (localModelInit.length > 0) {
      metrics.localModelInitP50Ms = percentile(localModelInit, 50)
      metrics.localModelInitP95Ms = percentile(localModelInit, 95)
    }
    const lexicalReady = finiteValues(completed, record => record.lexicalReadyMs)
    if (lexicalReady.length > 0) {
      metrics.lexicalReadyP50Ms = percentile(lexicalReady, 50)
      metrics.lexicalReadyP95Ms = percentile(lexicalReady, 95)
    }
  }

  // 向量/目录就绪是「真的做了那一步」的观测：跨所有记录（含就绪成功但回答失败的篇）取分位数
  const denseReady = finiteValues(records, record => record.denseReadyMs)
  if (denseReady.length > 0) {
    metrics.denseReadyP50Ms = percentile(denseReady, 50)
    metrics.denseReadyP95Ms = percentile(denseReady, 95)
  }
  const outlineReady = finiteValues(records, record => record.outlineReadyMs)
  if (outlineReady.length > 0) {
    metrics.outlineReadyP50Ms = percentile(outlineReady, 50)
    metrics.outlineReadyP95Ms = percentile(outlineReady, 95)
  }

  // 目录实际使用率只对 C 臂有意义：A/B 没有目录先验，输出一个 0 使用率是误导。
  // `outlineUsed` 缺席（pdf-load/index/retrieve 失败或整篇跳过，从未走到检索）按「未使用」计入
  // 分母——与改造前默认 false 的口径一致；本模块**不**消费 `retrievalMode`，故其缺席无需特判。
  if (scenario.mode === 'hybrid-outline' && records.length > 0) {
    metrics.outlineUsedRate = records.filter(record => record.outlineUsed).length / records.length
  }

  return metrics
}
