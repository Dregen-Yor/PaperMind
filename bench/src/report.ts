import type { BenchResult } from './types'
import { REFUSAL_PATTERN_VERSION } from './metrics/answerF1'
import { aggregate } from './metrics/aggregate'

/** 各任务的主指标，用于在矩阵报表中标出最优行。 */
export const PRIMARY_METRIC: Record<'qa' | 'summary', string> = {
  qa: 'evidenceRecall',
  summary: 'rougeL',
}

function fmt(value: number): string {
  return Number.isInteger(value) && Math.abs(value) >= 10
    ? String(value)
    : value.toFixed(3)
}

/** 命中率百分比：31.7% → '31.7%'（保留 1 位小数，去尾零）。 */
function fmtPct(rate: number): string {
  return `${(rate * 100).toFixed(1).replace(/\.0$/, '')}%`
}

/** 时长格式化：< 1000 显示 N ms；< 60_000 显示 x.xx s；否则显示 Xm Ys。 */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`
  const roundedSeconds = Math.round(ms / 1000)
  const minutes = Math.floor(roundedSeconds / 60)
  const seconds = roundedSeconds % 60
  return `${minutes}m ${seconds}s`
}

function collectMetricNames(results: BenchResult[]): string[] {
  const names = new Set<string>()
  for (const r of results) for (const k of Object.keys(r.metrics)) names.add(k)
  return [...names].sort()
}

export function renderReport(
  results: BenchResult[],
  opts: { primaryMetric?: string } = {},
): string {
  if (results.length === 0) return '## 评测报表\n\n无结果。\n'

  const first = results[0]
  const primary = opts.primaryMetric ?? PRIMARY_METRIC[first.task]
  const metricNames = collectMetricNames(results)

  // 主指标最高的行加粗（> 严格大于，并列时取先出现的）；仅矩阵模式（多行）加粗，
  // 单结果不加粗，否则行标签变为 **name** 破坏 `| name |` 形态
  let bestIndex = -1
  let bestValue = -Infinity
  if (results.length > 1) {
    results.forEach((r, i) => {
      const v = r.metrics[primary]
      if (v !== undefined && v > bestValue) {
        bestValue = v
        bestIndex = i
      }
    })
  }

  const lines: string[] = []
  lines.push(`## 评测报表：${first.task}`)
  lines.push('')

  const sources = new Set(results.flatMap(result => result.perSample.map(record => record.source)))
  if (sources.size > 0) {
    lines.push('### 按数据来源')
    lines.push('')
    lines.push('| 配置 | 来源 | 完成 | evidenceRecall | evidenceHitRate |')
    lines.push('| --- | --- | --- | --- | --- |')
    for (const result of results) {
      for (const source of sources) {
        const records = result.perSample.filter(record => record.source === source)
        if (records.length === 0) continue
        const sourceMetrics = renameSourceRates(aggregate(records))
        lines.push(`| ${result.config.name} | ${source === 'qasper' ? 'QASPER（标题注入伪页）' : 'smoke（真实 PDF）'} | ${records.length} | ${sourceMetrics.evidenceRecall === undefined ? '—' : fmt(sourceMetrics.evidenceRecall)} | ${sourceMetrics.evidenceHitRate === undefined ? '—' : fmt(sourceMetrics.evidenceHitRate)} |`)
      }
    }
    lines.push('')
  }
  lines.push(`- 模型：\`${first.meta.model}\``)
  if (first.meta.judgeModel) lines.push(`- Judge 模型：\`${first.meta.judgeModel}\``)
  lines.push(`- 代码版本：\`${first.meta.gitSha}\``)
  if (first.meta.baselineFamily) lines.push(`- 基线家族：\`${first.meta.baselineFamily}\``)
  if (first.meta.candidateGranularity) lines.push(`- 候选/上下文粒度：\`${first.meta.candidateGranularity}\``)
  lines.push(`- 时间：${first.meta.timestamp}`)
  lines.push(`- 主指标：\`${primary}\`（加粗行为最优）`)
  if (first.meta.unanswerableMethod) {
    lines.push(`- \`unanswerableAccuracy\` 判定口径：\`${first.meta.unanswerableMethod}\``)
    // 口径自证：pattern 口径下补印拒答模式表版本，judge 口径的版本已嵌 prompt，无需重复打印
    if (first.meta.unanswerableMethod === 'pattern') {
      lines.push(`- 拒答模式表版本：\`${REFUSAL_PATTERN_VERSION}\``)
    }
  }
  if (first.meta.evidenceMappingCoverage !== undefined) {
    lines.push(`- Evidence 映射覆盖率：${fmt(first.meta.evidenceMappingCoverage)}`)
    lines.push(`- Evidence 歧义率：${fmt(first.meta.ambiguousEvidenceRate ?? 0)}`)
    lines.push(`- Evidence 未映射率：${fmt(first.meta.unmappedEvidenceRate ?? 0)}`)
  }
  lines.push('')

  const timingBlock = renderTimingSection(results)
  if (timingBlock.length > 0) lines.push(...timingBlock, '')

  const treeBlock = renderTreeSection(results)
  if (treeBlock.length > 0) lines.push(...treeBlock, '')

  lines.push(`| 配置 | 家族 | 检索算法 | 完成 | ${metricNames.join(' | ')} |`)
  lines.push(`| --- | --- | --- | --- | ${metricNames.map(() => '---').join(' | ')} |`)
  results.forEach((r, i) => {
    const cells = metricNames.map(n => {
      const v = r.metrics[n]
      if (v === undefined) return '—'
      return i === bestIndex && n === primary ? `**${fmt(v)}**` : fmt(v)
    })
    const label = i === bestIndex ? `**${r.config.name}**` : r.config.name
    lines.push(`| ${label} | ${r.meta.baselineFamily ?? '—'} | ${r.meta.retrievalAlgorithm ?? '—'} | ${r.meta.completed}/${r.meta.total} | ${cells.join(' | ')} |`)
  })
  lines.push('')

  const errorLines = renderErrors(results)
  if (errorLines.length > 0) {
    lines.push('### 失败样本')
    lines.push('')
    lines.push('| 配置 | 阶段 | 次数 | 示例信息 |')
    lines.push('| --- | --- | --- | --- |')
    lines.push(...errorLines)
    lines.push('')
  }

  return lines.join('\n')
}

function renameSourceRates(metrics: Record<string, number>): Record<string, number> {
  return {
    ...metrics,
    ...(metrics.evidenceHit !== undefined ? { evidenceHitRate: metrics.evidenceHit } : {}),
  }
}

/** 失败样本按阶段聚合计数 + 一条示例信息（截断 80 字符），不逐条罗列。 */
function renderErrors(results: BenchResult[]): string[] {
  const lines: string[] = []
  for (const r of results) {
    const byStage = new Map<string, { count: number; sample: string }>()
    for (const e of r.errors) {
      const entry = byStage.get(e.stage) ?? { count: 0, sample: e.message }
      entry.count++
      byStage.set(e.stage, entry)
    }
    for (const [stage, { count, sample }] of byStage) {
      lines.push(`| ${r.config.name} | ${stage} | ${count} | ${sample.slice(0, 80)} |`)
    }
  }
  return lines
}

/**
 * 「耗时与缓存」区块：单结果与矩阵结果都必须输出。
 * 字段缺失或无完成题时渲染「—」，防止 0 ms 被误读为极速完成。
 */
function renderTimingSection(results: BenchResult[]): string[] {
  // 仅 QA 结果带时延元数据；summary 任务（HF 摘要）不适用，跳过区块
  if (!results.some(r => r.meta.startedAt && r.meta.finishedAt)) return []

  const lines: string[] = []
  lines.push('### 耗时与缓存')
  lines.push('')

  for (const r of results) {
    if (!r.meta.startedAt || !r.meta.finishedAt) continue
    const requests = (r.meta.cacheHits ?? 0) + (r.meta.cacheMisses ?? 0)
    const hitRate = r.meta.cacheHitRate
    const scopeLabel = r.meta.cacheScope === 'rag' ? 'RAG 缓存' : '缓存'
    lines.push(`- **${r.config.name}**：运行区间 ${r.meta.startedAt} → ${r.meta.finishedAt}，整轮 wall-clock ${r.meta.runWallClockMs === undefined ? '—' : fmtDuration(r.meta.runWallClockMs!)}，${scopeLabel} ${r.meta.cacheHits ?? 0} hits / ${requests} requests（${hitRate === undefined ? '—' : fmtPct(hitRate)}）`)
  }

  lines.push('')
  lines.push('| 配置 | 索引 P50/P95 | 检索 P50/P95 | 生成 P50/P95 | 单题端到端 P50/P95 | LLM 网络 P50/P95 |')
  lines.push('| --- | --- | --- | --- | --- | --- |')
  for (const r of results) {
    // 无完成题或字段缺失时 cell 渲染「—」，防止 0 ms 被误读为极速完成
    lines.push(`| ${r.config.name} | ${cell(r.metrics, 'indexBuildLatency')} | ${cell(r.metrics, 'retrievalLatency')} | ${cell(r.metrics, 'answerGenerationLatency')} | ${cell(r.metrics, 'queryEndToEndLatency')} | ${cell(r.metrics, 'llmNetworkLatency')} |`)
  }
  return lines
}

/** token 数过大时用 k 单位，避免 41000 与 41 这类数字在同一列里视觉同权。 */
function fmtTokens(value: number): string {
  return value >= 10_000 ? `${(value / 1000).toFixed(1)}k` : fmt(value)
}

/** 取指标字段渲染为百分比，缺失时输出「—」。 */
function pctCell(metrics: Record<string, number>, name: string): string {
  const v = metrics[name]
  return v === undefined ? '—' : fmtPct(v)
}

/**
 * 「语义树诊断」区块（§11.4）：只在结果里真的出现过树指标时渲染，
 * 否则旧基线报表会多出一整块空表。
 *
 * 这一块与主指标表并排存在，是为了让同一份结果文件同时回答
 * 「检索有没有变好」「树是不是真的按语义长的」「产品够不够快」（§阶段 E 完成标志）。
 */
function renderTreeSection(results: BenchResult[]): string[] {
  const hasTree = results.some(r => r.metrics.treeBuildFailureRate !== undefined || r.metrics.avgTreeNodeCount !== undefined)
  if (!hasTree) return []

  const lines: string[] = []
  lines.push('### 语义树诊断')
  lines.push('')
  lines.push('| 配置 | 平均节点数 | 平均树深 | 一级/二级 | 证据块覆盖率 | 多重归属率 | 跨章节节点率 | 建树失败率 | 建树 P50/P95 | 建树输入/输出 token | 树使用率 | 降级率 | 单问选中节点数 |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const r of results) {
    const m = r.metrics
    const num = (name: string) => (m[name] === undefined ? '—' : fmt(m[name]))
    const token = (name: string) => (m[name] === undefined ? '—' : fmtTokens(m[name]))
    lines.push(
      `| ${r.config.name} | ${num('avgTreeNodeCount')} | ${num('avgTreeDepth')} | `
      + `${num('avgTreeLevel1Count')} / ${num('avgTreeLevel2Count')} | `
      + `${num('treeEvidenceCoverage')} | ${num('treeSharedBlockRate')} | ${num('treeCrossSectionNodeRate')} | `
      + `${pctCell(m, 'treeBuildFailureRate')} | ${cell(m, 'treeBuildLatency')} | `
      + `${token('avgTreeBuildInputTokens')} / ${token('avgTreeBuildOutputTokens')} | `
      + `${pctCell(m, 'treeUsedRate')} | ${pctCell(m, 'treeDegradationRate')} | ${num('selectedNodeCount')} |`,
    )
  }
  lines.push('')
  lines.push('> 「多重归属率」「跨章节节点率」按节点数归一，后者越高说明树把分散在不同位置的证据组织到了一起；')
  lines.push('> 「降级率」含建树失败与树取证不足两种情况，两者都不会增加查询阶段的串行模型调用。')
  return lines
}

/** 取 `${prefix}P50Ms/P95Ms` 两个字段渲染为 `P50 / P95` 形态；缺失时输出「—」。 */
function cell(metrics: Record<string, number>, prefix: string): string {
  const p50 = metrics[`${prefix}P50Ms`]
  const p95 = metrics[`${prefix}P95Ms`]
  if (p50 === undefined || p95 === undefined) return '—'
  return `${fmtDuration(p50)} / ${fmtDuration(p95)}`
}

export function renderComparison(a: BenchResult, b: BenchResult): string {
  const names = collectMetricNames([a, b])
  const lines: string[] = []
  lines.push(`## 结果对比：${a.config.name} → ${b.config.name}`)
  lines.push('')
  lines.push(`- A：\`${a.meta.gitSha}\` @ ${a.meta.timestamp}（完成 ${a.meta.completed}/${a.meta.total}）`)
  lines.push(`  - mode：\`${a.meta.mode ?? 'rag'}\`；检索：\`${a.meta.retrievalAlgorithm ?? '—'}\``)
  lines.push(`- B：\`${b.meta.gitSha}\` @ ${b.meta.timestamp}（完成 ${b.meta.completed}/${b.meta.total}）`)
  lines.push(`  - mode：\`${b.meta.mode ?? 'rag'}\`；检索：\`${b.meta.retrievalAlgorithm ?? '—'}\``)
  lines.push('')
  lines.push('| 指标 | A | B | 差值 |')
  lines.push('| --- | --- | --- | --- |')
  for (const name of names) {
    const va = a.metrics[name]
    const vb = b.metrics[name]
    const delta = va !== undefined && vb !== undefined
      ? `${vb - va >= 0 ? '+' : ''}${fmt(vb - va)}`
      : '—'
    lines.push(`| ${name} | ${va !== undefined ? fmt(va) : '—'} | ${vb !== undefined ? fmt(vb) : '—'} | ${delta} |`)
  }
  lines.push('')
  lines.push('> 时延字段（`*Latency*Ms`）越低越好，其余质量指标越高越好。')
  lines.push('')
  return lines.join('\n')
}
