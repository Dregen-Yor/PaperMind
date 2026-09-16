/**
 * 语义树诊断指标（方案 §11.4）。
 *
 * 与检索质量指标分开成一块：树结构/覆盖率/成本回答「树是不是真的按语义长出来的、
 * 建得贵不贵、失败得多不多」，而 evidenceRecall 一类回答「检索有没有变好」。
 * 两者必须能同时从同一份结果文件里读出来（§阶段 E 完成标志）。
 */
import type { EvalSample, PaperTimingRecord } from '../types'
import type { SemanticPaperIndex } from '../../../src/utils/ragPipeline'
import type { SemanticTreeDiagnostics } from '../../../src/utils/semanticTree'

/**
 * 每篇论文的建树结果。
 *
 * 建树失败必须表达为 `failed: true` + 无 `semantic`，而不是抛错：
 * §8.2 要求建树失败时问答照常可用，评测要把这次降级如实计入失败率。
 */
export interface SemanticTreeHookResult {
  semantic?: SemanticPaperIndex
  diagnostics?: SemanticTreeDiagnostics
  /** 建树输入的证据块数量 */
  evidenceBlockCount?: number
  llmCalls: number
  cacheHits: number
  cacheMisses: number
  inputTokens: number
  outputTokens: number
  latencyMs: number
  failed?: boolean
}

/** 建树钩子：每篇论文调用一次，内部已吞掉一切异常。 */
export type SemanticTreeHook = (sample: EvalSample) => Promise<SemanticTreeHookResult>


/**
 * 建树结果 → perPaper 诊断字段。
 *
 * 多重归属与跨章节都是「节点数」量纲的比例，故按节点数归一；
 * 树不存在时这些字段整体缺席，交给聚合层从分母剔除，而不是填 0。
 */
export function treeRecordFields(
  info: SemanticTreeHookResult | undefined,
): Partial<PaperTimingRecord> {
  if (!info) return {}
  const fields: Partial<PaperTimingRecord> = {
    treeBuildLlmCalls: info.llmCalls,
    treeBuildInputTokens: info.inputTokens,
    treeBuildOutputTokens: info.outputTokens,
    treeBuildLatencyMs: info.latencyMs,
    treeBuildFailed: info.failed ? 1 : 0,
  }
  if (info.evidenceBlockCount !== undefined) fields.evidenceBlockCount = info.evidenceBlockCount

  const d = info.diagnostics
  if (!info.semantic || !d) return fields
  // 两侧命名刻意不同：诊断层用领域名（`nodeCount`），记录层带 `tree` 前缀
  // 与平面索引的 `leafCount` 区分开，这里逐项显式对齐而不是靠名字碰巧相同
  fields.treeNodeCount = d.nodeCount
  fields.treeDepth = d.depth
  fields.treeLevel1Count = d.level1Count
  fields.treeLevel2Count = d.level2Count
  fields.treeEvidenceCoverage = d.evidenceCoverage
  if (d.nodeCount > 0) {
    fields.treeSharedBlockRate = d.sharedBlockCount / d.nodeCount
    fields.treeCrossSectionNodeRate = d.crossSectionNodeCount / d.nodeCount
  }
  return fields
}

const mean = (values: number[]): number | undefined =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : undefined

/**
 * perPaper → 全轮树诊断聚合。
 *
 * 失败率的分母是**所有已建树的论文**（含失败的），而结构指标的分母只是成功建树的论文：
 * 把失败篇的 0 节点算进平均树规模会同时低估树的大小和高估失败率，两者必须分开取分母。
 */
export function summarizeTreeDiagnostics(perPaper: PaperTimingRecord[]): {
  metrics: Record<string, number>
  latencies: number[]
} {
  const attempted = perPaper.filter(p => p.treeBuildFailed !== undefined)
  const succeeded = attempted.filter(p => p.treeBuildFailed === 0)
  const metrics: Record<string, number> = {}

  if (attempted.length) {
    const failed = attempted.filter(p => p.treeBuildFailed === 1).length
    metrics.treeBuildFailureRate = failed / attempted.length
    metrics.treeBuildAttempts = attempted.length
  }

  // 取均值的字段一律带 avg 前缀，rate 类字段本身就是比例不再加前缀
  const fields: Array<[string, keyof PaperTimingRecord]> = [
    ['avgTreeNodeCount', 'treeNodeCount'],
    ['avgTreeDepth', 'treeDepth'],
    ['avgTreeLevel1Count', 'treeLevel1Count'],
    ['avgTreeLevel2Count', 'treeLevel2Count'],
    ['treeEvidenceCoverage', 'treeEvidenceCoverage'],
    ['treeSharedBlockRate', 'treeSharedBlockRate'],
    ['treeCrossSectionNodeRate', 'treeCrossSectionNodeRate'],
    // 建树成本只对成功的树求平均：失败篇的 token 消耗记在 perPaper 里可查，
    // 但混进均值会让「树建得贵不贵」这个结论被失败样本稀释
    ['avgTreeBuildInputTokens', 'treeBuildInputTokens'],
    ['avgTreeBuildOutputTokens', 'treeBuildOutputTokens'],
    ['avgTreeBuildCalls', 'treeBuildLlmCalls'],
  ]
  for (const [name, key] of fields) {
    const value = mean(succeeded.flatMap(p => (p[key] === undefined ? [] : [p[key] as number])))
    if (value !== undefined) metrics[name] = value
  }

  const latencies = attempted.flatMap(p => (p.treeBuildLatencyMs === undefined ? [] : [p.treeBuildLatencyMs]))
  return { metrics, latencies }
}
