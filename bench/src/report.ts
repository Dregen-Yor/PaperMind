import type { BenchResult } from './types'
import { REFUSAL_PATTERN_VERSION } from './metrics/answerF1'
import { aggregate } from './metrics/aggregate'
import { MRR_DEFINITION } from './evaluationContract'
import { SPEED_DEFINITION, speedComparisonIssues } from './speed/contract'

/** 各任务的主指标，用于在矩阵报表中标出最优行（legacy 历史表按此加粗）。 */
export const PRIMARY_METRIC: Record<'qa' | 'summary', string> = {
  qa: 'evidenceRecall',
  summary: 'rougeL',
}

/** Context Page MRR 的展示名（§9）：以口径名出现，避免与 legacy `mrr` 混读。 */
const CONTEXT_PAGE_MRR_LABEL = `MRR (${MRR_DEFINITION})`

/**
 * 四个受控检索指标（含命中率的改名口径）。横向门禁不通过时它们的差值必须为「—」：
 * 身份或分母不一致时「多 0.05 的 Recall」不是比较结果，只是两次不同实验的噪声。
 */
const CONTROLLED_RETRIEVAL_METRICS = new Set([
  'contextPageMrr', 'evidenceRecall', 'evidenceHit', 'evidenceHitRate', 'contextPrecision',
])

/**
 * 单一归属策略：一个指标只能从某张表中排除，前提是它的归属区块会渲染**同一行**，
 * 且该区块必须真的渲染（见 renderReport 的 sharedSections）。归属区块覆盖不到的行
 * （上限表里的 full-context 行不进检索主表）必须保留该指标，否则数字会从报表里消失。
 *
 * 下面的归属清单因此是手写的而不是 `/LatencyP\d+Ms$/` 这类模式：模式分不清「归属耗时区块、
 * 该排除」与「只有某张表会显示、该保留」——废弃的 `latencyP50`/`latencyP95` 与裸的
 * `*LatencyMs` 均值都不被任何区块渲染，按模式排除会让它们彻底消失。
 *
 * §9 检索主表各列实际读取的 6 个键。回答质量伴侣表排除它们——检索主表渲染的是同一批行，
 * 同一指标再列一遍会让人以为两个数字应当相等，一旦聚合路径不同就成了无声的矛盾。
 * Hit Rate 列同时读 `evidenceHitRate` 与其别名 `evidenceHit`（见 renderRetrievalTable），
 * 故两者都算这一族。
 */
export const RETRIEVAL_SECTION_METRICS: string[] = [
  'contextPageMrr', 'contextPageMrrEligibleCount',
  'evidenceRecall', 'evidenceHit', 'evidenceHitRate', 'contextPrecision',
]

/**
 * 同族、但**没有任何一列读它**的键：`contextPageMrrSampleCount` 仍要在回答质量伴侣表里排除，
 * 理由却与上面那条列清单不同，所以必须单独列——并进列清单会让「各列实际读取的键」变成假话。
 * 真实理由是它的值可证与已经显示的数字相同：`finalizeQaResult` 里的 `assertContextPageDenominator`
 * 要求 `contextPageMrr` 的观测数恒等于契约的 `eligibleRetrievalQuestionCount`（由同处落盘为
 * `contextPageMrrEligibleCount`，正是检索主表「有效题数」列读的表达式
 * `meta.eligibleRetrievalQuestionCount ?? metrics.contextPageMrrEligibleCount`），
 * 不相等直接抛错让整轮失效。因此任何成功收尾的结果里两者必然相等，不显示它不丢信息。
 */
export const RETRIEVAL_EXEMPT_METRICS: string[] = ['contextPageMrrSampleCount']

/**
 * 回答质量伴侣表实际排除的检索族键：列清单（有列读，重复列会摆出两个应当相等却可能不等的数字）
 * 加上豁免键（无列读，但值可证与「有效题数」列相同）。
 */
const ANSWER_QUALITY_EXCLUDED_METRICS = new Set([
  ...RETRIEVAL_SECTION_METRICS,
  ...RETRIEVAL_EXEMPT_METRICS,
])

/** 「耗时与缓存」表实际渲染的 10 个键（5 组 P50/P95）。 */
export const TIMING_SECTION_METRICS: string[] = [
  'indexBuildLatencyP50Ms', 'indexBuildLatencyP95Ms',
  'retrievalLatencyP50Ms', 'retrievalLatencyP95Ms',
  'answerGenerationLatencyP50Ms', 'answerGenerationLatencyP95Ms',
  'queryEndToEndLatencyP50Ms', 'queryEndToEndLatencyP95Ms',
  'llmNetworkLatencyP50Ms', 'llmNetworkLatencyP95Ms',
]

/** Query-timeline headline values plus their supporting denominator diagnostics. */
const SPEED_HEADLINE_METRICS = [
  'evidenceReadyLatencyP50Ms', 'evidenceReadyLatencyP95Ms',
  'timeToFirstTokenP50Ms', 'timeToFirstTokenP95Ms',
  'fullAnswerLatencyP50Ms', 'fullAnswerLatencyP95Ms',
  'avgOnlineTokensPerCompletedAnswer',
] as const

const SPEED_SECTION_METRICS = new Set<string>([
  ...SPEED_HEADLINE_METRICS,
  'speedSampleCount', 'onlineTokenSampleCount',
])

/** 「语义树诊断」表实际渲染的 15 个键（建树时延一项展开成 P50/P95 两列）。 */
export const TREE_SECTION_METRICS: string[] = [
  'avgTreeNodeCount', 'avgTreeDepth', 'avgTreeLevel1Count', 'avgTreeLevel2Count',
  'treeEvidenceCoverage', 'treeSharedBlockRate', 'treeCrossSectionNodeRate',
  'treeBuildFailureRate', 'treeBuildLatencyP50Ms', 'treeBuildLatencyP95Ms',
  'avgTreeBuildInputTokens', 'avgTreeBuildOutputTokens',
  'treeUsedRate', 'treeDegradationRate', 'selectedNodeCount',
]

/**
 * 「冷启动成本」区块占用的 13 个键（后两个是降级诊断，只在非零时以脚注呈现），按列序：端到端与卡片调用各展开成 P50/P95 两列
 * （`coldStartTotal*` / `structureCall*`，见 `summarizeColdStart`），其余为单值键。
 * 与 `TREE_SECTION_METRICS` 同一约定：区块真的渲染时才把这些键从伴侣表里排除，
 * 否则同一个指标会既进冷启动区块、又以原值列在回答质量/生成上限表里。
 */
export const COLD_START_SECTION_METRICS: string[] = [
  'coldStartTotalP50Ms', 'coldStartTotalP95Ms',
  'avgColdStartPassageMs', 'avgColdStartEmbedPassagesMs',
  'structureCallP50Ms', 'structureCallP95Ms',
  'avgColdStartEmbedCardsMs', 'structureTokensPerPaper',
  'structureFallbackRate', 'avgColdStartCardCount', 'avgColdStartPassageCount',
  'passageEmbedFailureRate', 'passageDegradedQuestionRate',
]

/** schema-v2 判定：缺 `mrrDefinition: 'context-page-v1'` 一律按 legacy 处理（§7）。 */
function isSchemaV2(result: BenchResult): boolean {
  return result.meta.mrrDefinition === MRR_DEFINITION
}

/**
 * 结果三分区（§9）。资格判定必须先于 schema 判定：full-context 不带 mrrDefinition，
 * 先测 schema 会把它误归 legacy。
 *
 * 单个 if / else if / else 才是「完整且互斥」的保证——每个结果恰好落入一个数组，
 * 将来新增结果类型也不会被渲染两次或静默丢弃。
 */
export function partitionResults(results: BenchResult[]): {
  retrievalRows: BenchResult[]
  ceilingRows: BenchResult[]
  legacyRows: BenchResult[]
} {
  const retrievalRows: BenchResult[] = []
  const ceilingRows: BenchResult[] = []
  const legacyRows: BenchResult[] = []
  for (const r of results) {
    if (r.meta.comparisonEligible === false) ceilingRows.push(r)
    else if (isSchemaV2(r)) retrievalRows.push(r)
    else legacyRows.push(r)
  }
  return { retrievalRows, ceilingRows, legacyRows }
}

function fmt(value: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return Number.isInteger(value) && Math.abs(value) >= 10
    ? String(value)
    : value.toFixed(3)
}

/** 命中率百分比：31.7% → '31.7%'（保留 1 位小数，去尾零）。 */
function fmtPct(rate: number): string {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return '—'
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

  // schema-v2 结果按资格分流（§9）：完整性与互斥性由 partitionResults 单点保证
  const { retrievalRows, ceilingRows, legacyRows } = partitionResults(results)
  const contractRef = results.find(isSchemaV2)

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
  // 主指标说明按表分流：检索主表按 Context Page MRR 加粗，历史表仍按各自主指标加粗
  if (retrievalRows.length > 0) {
    lines.push(`- 检索主表主指标：\`contextPageMrr\`（${CONTEXT_PAGE_MRR_LABEL}，加粗行为最优）`)
  }
  if (legacyRows.length > 0) {
    lines.push(`- 历史结果表主指标：\`${primary}\`（加粗行为最优）`)
  }
  if (contractRef) {
    lines.push(`- 指标定义：\`${contractRef.meta.mrrDefinition}\`（schema v${contractRef.meta.metricSchemaVersion}）`)
    lines.push(`- 受控上下文预算：${contractRef.meta.contextBudgetTokens} tokens；tokenizer：\`${contractRef.meta.contextTokenizer}\`@\`${contractRef.meta.contextTokenizerRevision}\``)
  }
  // §9 要求报告自证「统一预算 / tokenizer / 指标定义版本 / 比较资格」四项坐标。
  // 这里只是一句坐标声明，不重复门禁逻辑：真正的判定在 retrievalComparisonIssues，
  // 由排名表在加粗最优行前自行调用——声明合格与否只能看 comparisonEligible，不看身份。
  if (retrievalRows.length > 0) {
    lines.push('- 检索比较资格：排名表各行均未声明自身不合格（`comparisonEligible` 非 `false`）；跨行比较要求数据集指纹、有效题集合哈希、指标版本、MRR 定义、上下文预算、tokenizer 模型与 revision、evidence 映射版本全部一致，该判定由排名表自身执行，不一致时不标注最优行（§8）')
  }
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

  const speedBlock = renderSpeedSection(results)
  if (speedBlock.length > 0) lines.push(...speedBlock, '')

  const timingBlock = renderTimingSection(results)
  if (timingBlock.length > 0) lines.push(...timingBlock, '')

  const treeBlock = renderTreeSection(results)
  if (treeBlock.length > 0) lines.push(...treeBlock, '')

  const coldStartBlock = renderColdStartSection(results)
  if (coldStartBlock.length > 0) lines.push(...coldStartBlock, '')

  // 上面四个区块跨所有结果渲染，因此它们就是这些指标在任何行上的归属区块。
  // length 守卫不是性能优化：区块根本没渲染时若仍然排除，这些数值会从整份报表里消失。
  const sharedSections = new Set<string>()
  if (speedBlock.length > 0) for (const n of SPEED_SECTION_METRICS) sharedSections.add(n)
  if (timingBlock.length > 0) for (const n of TIMING_SECTION_METRICS) sharedSections.add(n)
  if (treeBlock.length > 0) for (const n of TREE_SECTION_METRICS) sharedSections.add(n)
  if (coldStartBlock.length > 0) for (const n of COLD_START_SECTION_METRICS) sharedSections.add(n)

  if (retrievalRows.length > 0) {
    lines.push('### 检索排名（Context Page MRR）')
    lines.push('')
    lines.push(...renderRetrievalTable(retrievalRows))
    lines.push('')

    // §9 检索主表只放四个受控检索口径，回答质量（answerF1 / judge / unanswerable）另起一表，
    // 否则新运行的答案质量数字会在报表中彻底消失。
    const answerBlock = renderAnswerQualityTable(retrievalRows, sharedSections)
    if (answerBlock.length > 0) {
      lines.push('### 回答质量（检索口径之外）')
      lines.push('')
      lines.push(...answerBlock)
      lines.push('')
    }
  }

  if (ceilingRows.length > 0) {
    lines.push(...renderCeilingSection(ceilingRows, sharedSections))
    lines.push('')
  }

  if (legacyRows.length > 0) {
    lines.push(...renderLegacySection(legacyRows, primary))
    lines.push('')
  }

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

/**
 * 逐样本阶段状态 → 检索/生成失败数（§6.3）。
 * `ineligible`（非有效题）与 `skipped`（阶段从未开始）表示「不适用」而非「失败」：
 * 把它们计入会让报表把「没这题」显示成「这题挂了」，是最容易出错的一个数。
 */
function stageFailureCounts(result: BenchResult): { retrieval: number; generation: number } {
  let retrieval = 0
  let generation = 0
  for (const record of result.perSample) {
    if (record.retrievalStatus === 'failed') retrieval++
    if (record.generationStatus === 'failed') generation++
  }
  return { retrieval, generation }
}

/**
 * 检索主表（§9）：schema-v2 合格结果按 Context Page MRR 排名。
 * 失败数只从逐样本阶段状态统计，与 `errors[]` 的文本聚合相互独立——生成失败的样本
 * 仍保留检索观测（§6.3），因此同一行可以既有检索指标又有生成失败。
 */
function renderRetrievalTable(rows: BenchResult[]): string[] {
  const lines: string[] = []

  // 排名表收的是「未声明不合格」的行，而 comparisonEligible 为 undefined 也算未声明；
  // 声明合格不等于身份一致，所以加粗前必须逐对跑门禁，否则会把两次不同实验的 MRR 并列排名。
  const identityIssues = new Set<string>()
  for (const a of rows) {
    for (const b of rows) {
      if (a === b) continue
      for (const issue of retrievalComparisonIssues(a, b)) identityIssues.add(issue)
    }
  }
  const comparable = rows.length > 1 && identityIssues.size === 0
  // 只报具体分叉的坐标（去重后即门禁的原话），不给读者留「为什么没加粗」的猜测
  if (rows.length > 1 && !comparable) {
    lines.push('> **跨行不可比**：以下身份或分母条件不满足，本表不标注最优行（§8）。')
    for (const issue of identityIssues) lines.push(`> - ${issue}`)
    lines.push('')
  }

  lines.push(`| 配置 | 检索算法 | ${CONTEXT_PAGE_MRR_LABEL} | Recall | Hit Rate | Precision | 有效题数 | 检索失败 | 生成失败 |`)
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |')

  // 只在多行且身份可比时评最优；单行不加粗，保持 `| name |` 形态
  let bestIndex = -1
  let bestValue = -Infinity
  if (comparable) {
    rows.forEach((r, i) => {
      const v = r.metrics.contextPageMrr
      if (v !== undefined && v > bestValue) {
        bestValue = v
        bestIndex = i
      }
    })
  }

  rows.forEach((r, i) => {
    const m = r.metrics
    const { retrieval, generation } = stageFailureCounts(r)
    const eligible = r.meta.eligibleRetrievalQuestionCount ?? m.contextPageMrrEligibleCount
    const num = (v: number | undefined) => (v === undefined ? '—' : fmt(v))
    // 配置名与主指标同时加粗，与历史表口径一致——报表前言对两张表都写「加粗行为最优」
    const label = i === bestIndex ? `**${r.config.name}**` : r.config.name
    const mrr = i === bestIndex && m.contextPageMrr !== undefined
      ? `**${fmt(m.contextPageMrr)}**`
      : num(m.contextPageMrr)
    // 别名 `evidenceHit` 只有「按数据来源」表经 renameSourceRates 改过名；本表直接读指标，
    // 两个键都要认，否则只带别名的新结果会把命中率渲染成「—」，数值从报表里消失
    const hitRate = m.evidenceHitRate ?? m.evidenceHit
    lines.push(
      `| ${label} | ${r.meta.retrievalAlgorithm ?? '—'} | ${mrr} | ${num(m.evidenceRecall)} | `
      + `${num(hitRate)} | ${num(m.contextPrecision)} | ${eligible === undefined ? '—' : eligible} | `
      + `${retrieval} | ${generation} |`,
    )
  })
  return lines
}

/**
 * 回答质量伴侣表：检索主表只固定展示四个受控检索口径，answerF1 / unanswerableAccuracy /
 * judge 三件套若不另列，新运行就再也看不到这些数字（legacy 详情表只收旧结果）。
 *
 * 不标最优行：这张表混有「越低越好」的时延列与不同量纲的 judge 分，
 * 用单一主指标加粗会给出误导性的「最优」；排名信号一律以 §9 的 Context Page MRR 为准。
 *
 * 排除规则见文件头的单一归属策略：检索族整族排除（检索主表渲染的就是这批行），
 * 耗时/语义树/冷启动族只在对应区块真的渲染时排除（sharedSections）。
 */
function renderAnswerQualityTable(rows: BenchResult[], sharedSections: Set<string>): string[] {
  const names = collectMetricNames(rows).filter(
    n => !ANSWER_QUALITY_EXCLUDED_METRICS.has(n) && !sharedSections.has(n),
  )
  if (names.length === 0) return []
  const lines: string[] = []
  lines.push(`| 配置 | 完成 | ${names.join(' | ')} |`)
  lines.push(`| --- | --- | ${names.map(() => '---').join(' | ')} |`)
  for (const r of rows) {
    const cells = names.map(n => (r.metrics[n] === undefined ? '—' : fmt(r.metrics[n])))
    lines.push(`| ${r.config.name} | ${r.meta.completed}/${r.meta.total} | ${cells.join(' | ')} |`)
  }
  return lines
}

/** 生成上限区块（§9）：full-context 只作回答模型上限的参照，不进检索排名、不参与加粗。 */
function renderCeilingSection(rows: BenchResult[], sharedSections: Set<string>): string[] {
  const lines: string[] = []
  lines.push('### 生成上限（不参与检索排名）')
  lines.push('')
  lines.push('> 全文直投结果衡量的是回答模型上限，不受 4096 受控上下文预算约束，故不进入检索排名（§9）。')
  lines.push('')
  // 列由结果自行推导而非手写清单：runner 新增什么指标就展示什么，不会因为本表漏列而消失
  // （answerF1 是「全文可见时能做到多好」这个上限量本身，与其它指标一视同仁）。
  // 只排除耗时/语义树/冷启动区块真的渲染了的键；检索族不排除——检索主表只渲染检索行，
  // 覆盖不到上限行，在这里排除的话上限行携带的检索指标就再也没有地方显示了。
  const metricCols = collectMetricNames(rows).filter(name => !sharedSections.has(name))
  const header = ['配置', '完成', ...metricCols, '排除原因']
  lines.push(`| ${header.join(' | ')} |`)
  lines.push(`| ${header.map(() => '---').join(' | ')} |`)
  for (const r of rows) {
    const cells = metricCols.map(n => (r.metrics[n] === undefined ? '—' : fmt(r.metrics[n])))
    lines.push(`| ${[r.config.name, `${r.meta.completed}/${r.meta.total}`, ...cells, r.meta.comparisonIneligibleReason ?? 'comparisonEligible=false'].join(' | ')} |`)
  }
  return lines
}

/**
 * 历史结果详情（§7/§9）：旧结果仍可读，但整块与检索主表分开，`mrr` 列标注为
 * `Legacy candidate MRR`——legacy 数字不参与新口径排名，也不会被加粗成「最优新 MRR」。
 */
function renderLegacySection(rows: BenchResult[], primary: string): string[] {
  const lines: string[] = []
  lines.push('### 历史结果（旧口径）')
  lines.push('')
  lines.push('> 缺少 `mrrDefinition: \'context-page-v1\'` 的结果按 legacy 处理；`mrr` 为候选排序 MRR（`Legacy candidate MRR`），不进入检索主表。')
  lines.push('')
  lines.push(...renderGenericTable(rows, collectMetricNames(rows), primary, true))
  return lines
}

/** 既有「全指标」表：保留给 legacy 详情，列名与加粗口径与历史保持一致。 */
function renderGenericTable(
  rows: BenchResult[],
  metricNames: string[],
  primary: string,
  relabelLegacyMrr: boolean,
): string[] {
  const lines: string[] = []
  let bestIndex = -1
  let bestValue = -Infinity
  if (rows.length > 1) {
    rows.forEach((r, i) => {
      const v = r.metrics[primary]
      if (v !== undefined && v > bestValue) {
        bestValue = v
        bestIndex = i
      }
    })
  }
  const header = metricNames.map(n => (relabelLegacyMrr && n === 'mrr' ? 'Legacy candidate MRR' : n))
  lines.push(`| 配置 | 家族 | 检索算法 | 完成 | ${header.join(' | ')} |`)
  lines.push(`| --- | --- | --- | --- | ${metricNames.map(() => '---').join(' | ')} |`)
  rows.forEach((r, i) => {
    const cells = metricNames.map(n => {
      const v = r.metrics[n]
      if (v === undefined) return '—'
      return i === bestIndex && n === primary ? `**${fmt(v)}**` : fmt(v)
    })
    const label = i === bestIndex ? `**${r.config.name}**` : r.config.name
    lines.push(`| ${label} | ${r.meta.baselineFamily ?? '—'} | ${r.meta.retrievalAlgorithm ?? '—'} | ${r.meta.completed}/${r.meta.total} | ${cells.join(' | ')} |`)
  })
  return lines
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

function isQueryTimelineResult(result: BenchResult): boolean {
  return result.meta.speedDefinition === SPEED_DEFINITION
}

function isRetrievalSpeedResult(result: BenchResult): boolean {
  return isQueryTimelineResult(result) && result.meta.mode !== 'full-context'
}

function speedValue(metrics: Record<string, number>, name: typeof SPEED_HEADLINE_METRICS[number]): string {
  const value = metrics[name]
  if (value === undefined) return '—'
  return name === 'avgOnlineTokensPerCompletedAnswer' ? fmt(value) : fmtDuration(value)
}

function tokenAccountingComplete(result: BenchResult): boolean {
  const completed = result.meta.completedSpeedQuestionCount
  return completed !== undefined && result.metrics.onlineTokenSampleCount === completed
}

function renderSpeedTable(rows: BenchResult[], evidenceReady: boolean): string[] {
  const lines = [
    '| 方法 | Evidence Ready P50 | P95 | TTFT P50 | P95 | Full Answer P50 | P95 | Avg Online Tokens |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ]
  for (const result of rows) {
    const metrics = result.metrics
    const evidenceP50 = evidenceReady ? speedValue(metrics, 'evidenceReadyLatencyP50Ms') : '—'
    const evidenceP95 = evidenceReady ? speedValue(metrics, 'evidenceReadyLatencyP95Ms') : '—'
    const tokens = tokenAccountingComplete(result)
      ? speedValue(metrics, 'avgOnlineTokensPerCompletedAnswer')
      : '—'
    lines.push(
      `| ${result.config.name} | ${evidenceP50} | ${evidenceP95} | `
      + `${speedValue(metrics, 'timeToFirstTokenP50Ms')} | ${speedValue(metrics, 'timeToFirstTokenP95Ms')} | `
      + `${speedValue(metrics, 'fullAnswerLatencyP50Ms')} | ${speedValue(metrics, 'fullAnswerLatencyP95Ms')} | ${tokens} |`,
    )
  }
  return lines
}

function speedFailureCounts(result: BenchResult): {
  retrieval: number
  generation: number
  stream: number
  judge: number
} {
  const count = (stage: string) => result.errors.filter(error => error.stage === stage).length
  const judgeFailures = new Set(
    result.errors.filter(error => error.stage === 'judge').map(error => error.sampleId),
  )
  for (const record of result.perSample) {
    if (record.judgeStatus === 'failed') judgeFailures.add(record.id)
  }
  return {
    retrieval: count('retrieve'),
    generation: count('generate'),
    stream: count('stream'),
    judge: judgeFailures.size,
  }
}

/** Fixed query-timeline headline tables plus supporting counts kept outside the seven public values. */
function renderSpeedSection(results: BenchResult[]): string[] {
  const current = results.filter(isQueryTimelineResult)
  if (current.length === 0) return []

  const retrievalRows = current.filter(isRetrievalSpeedResult)
  const ceilingRows = current.filter(result => result.meta.mode === 'full-context')
  const lines: string[] = []

  if (retrievalRows.length > 0) {
    lines.push(`### 检索方法速度（${SPEED_DEFINITION}）`)
    lines.push('')
    lines.push(...renderSpeedTable(retrievalRows, true))
    lines.push('')
  }

  if (ceilingRows.length > 0) {
    lines.push(`### 生成上限速度（${SPEED_DEFINITION}）`)
    lines.push('')
    lines.push('> full-context 只表示生成上限，Evidence Ready 不适用；不参与检索方法速度排名或 delta。')
    lines.push('')
    lines.push(...renderSpeedTable(ceilingRows, false))
    lines.push('')
  }

  lines.push('### Query-timeline 支持计数与失败诊断')
  lines.push('')
  lines.push('| 方法 | Speed 样本 | Completed 契约 | Token 完整 | Retrieval 失败 | Generation 失败 | Stream 失败 | Judge 失败 |')
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
  for (const result of current) {
    const completed = result.meta.completedSpeedQuestionCount
    const speedSamples = result.metrics.speedSampleCount
    const tokenSamples = result.metrics.onlineTokenSampleCount
    const failures = speedFailureCounts(result)
    lines.push(
      `| ${result.config.name} | ${speedSamples ?? '—'} | ${completed ?? '—'} | `
      + `${tokenSamples ?? '—'}/${completed ?? '—'} | ${failures.retrieval} | ${failures.generation} | `
      + `${failures.stream} | ${failures.judge} |`,
    )
  }
  const incomplete = current.filter(result => (
    !tokenAccountingComplete(result)
    || result.metrics.avgOnlineTokensPerCompletedAnswer === undefined
  ))
  for (const result of incomplete) {
    const completed = result.meta.completedSpeedQuestionCount ?? '—'
    const tokenSamples = result.metrics.onlineTokenSampleCount ?? '—'
    lines.push(`> - **${result.config.name}**：token accounting 不完整（${tokenSamples}/${completed}），Avg Online Tokens 显示 —。`)
  }
  return lines
}

/**
 * 「详细耗时与缓存诊断（Legacy timing）」区块：单结果与矩阵结果都必须输出。
 * 字段缺失或无完成题时渲染「—」，防止 0 ms 被误读为极速完成。
 */
function renderTimingSection(results: BenchResult[]): string[] {
  // 仅 QA 结果带时延元数据；summary 任务（HF 摘要）不适用，跳过区块
  if (!results.some(r => r.meta.startedAt && r.meta.finishedAt)) return []

  const lines: string[] = []
  lines.push('### 详细耗时与缓存诊断（Legacy timing）')
  lines.push('')
  lines.push('> 本区块保留 index / retrieval / generation / end-to-end / network 旧时延与 wall-clock 诊断，不作为 query-timeline 速度主指标。')
  if (results.some(result => result.meta.speedDefinition !== SPEED_DEFINITION)) {
    lines.push(`> 缺少 \`speedDefinition: '${SPEED_DEFINITION}'\` 的结果只在 Legacy timing / 诊断区域读取，不进入速度主表或 delta。`)
  }
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

/**
 * 「冷启动成本」区块（方案 §7）：与 Q **并列**报告，不进入 Q。
 * 只在结果里真的出现过冷启动指标时渲染，否则旧基线报表会多出一整块空表
 * （与 `renderTreeSection` 同一约定）。
 */
function renderColdStartSection(results: BenchResult[]): string[] {
  const hasColdStart = results.some(r => r.metrics.coldStartTotalP50Ms !== undefined || r.metrics.structureTokensPerPaper !== undefined)
  if (!hasColdStart) return []

  const lines: string[] = []
  lines.push('### 冷启动成本（不进入 Q）')
  lines.push('')
  lines.push('| 配置 | 冷启动端到端 P50 / P95 | 切段均值 | 段落向量均值 | 卡片调用 P50 / P95 | 卡片向量均值 | 卡片 token/篇 | 卡片回落率 | 平均卡片数 | 平均段落数 |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const result of results) {
    if (result.metrics.coldStartTotalP50Ms === undefined && result.metrics.structureTokensPerPaper === undefined) continue
    const m = result.metrics
    // 三个「均值」列各自是单值字段（`avgColdStartPassageMs` 等），没有 `...P50Ms/P95Ms`
    // 后缀：用两值的 `cell` 查它们会全部落到缺失分支，真实数据整列渲染成「—」。
    // 真正的百分位列（端到端、卡片调用）才走 `cell`。
    lines.push(
      `| ${result.config.name} | ${cell(m, 'coldStartTotal')} | ${avgCell(m, 'avgColdStartPassageMs')} | `
      + `${avgCell(m, 'avgColdStartEmbedPassagesMs')} | ${cell(m, 'structureCall')} | ${avgCell(m, 'avgColdStartEmbedCardsMs')} | `
      + `${m.structureTokensPerPaper === undefined ? '—' : fmtTokens(m.structureTokensPerPaper)} | `
      + `${pctCell(m, 'structureFallbackRate')} | ${numCell(m, 'avgColdStartCardCount')} | ${numCell(m, 'avgColdStartPassageCount')} |`,
    )
  }
  lines.push('')
  lines.push('> 「卡片调用 P50/P95」只统计**未命中缓存**的调用（命中时耗时接近 0，混进去会把成本稀释成假象）；')
  for (const result of results) {
    const failed = result.metrics.passageEmbedFailureRate ?? 0
    const degraded = result.metrics.passageDegradedQuestionRate ?? 0
    if (failed > 0 || degraded > 0) {
      lines.push(`> ⚠ ${result.config.name}：段落向量失败率 ${(failed * 100).toFixed(1)}%，降级为 bm25* 检索的题占 ${(degraded * 100).toFixed(1)}%，本轮已标为不可比。`)
    }
  }
  lines.push('> 「冷启动端到端」同样只统计卡片调用未命中缓存的论文。')
  lines.push('> 卡片 token 由字符数估算（`LlmClient.complete` 不透传服务商 usage），每篇论文的冷启动只发生**一次**卡片调用。')
  return lines
}

/** 单个均值字段渲染；缺失输出「—」。 */
const avgCell = (metrics: Record<string, number>, name: string): string =>
  metrics[name] === undefined ? '—' : fmtDuration(metrics[name])
/** 单个计数/均值字段渲染（非时长口径）；缺失输出「—」。 */
const numCell = (metrics: Record<string, number>, name: string): string =>
  metrics[name] === undefined ? '—' : fmt(metrics[name])

/**
 * 分母计数行（`contextPageMrrSampleCount` / `EligibleCount`）：它们的差值抑制与门禁无关，
 * 所以判定要独立出来——门禁通过时报表也照样出现「—」，需要一条脚注说明这不是异常。
 */
function isCountMetric(name: string): boolean {
  return name !== 'contextPageMrr' && name.startsWith('contextPageMrr')
}

/**
 * 差值抑制规则。两个来源：
 * - 分母计数（`contextPageMrrSampleCount` / `EligibleCount`）**恒不输出差值**：样本数差
 *   不是质量信号，放进「差值」列会被读成改进；
 * - 四个受控检索指标在门禁未通过时输出「—」：身份或分母不一致时它们的增减没有意义（§8）。
 */
function shouldSuppressDelta(name: string, gated: boolean): boolean {
  if (isCountMetric(name)) return true
  return gated && CONTROLLED_RETRIEVAL_METRICS.has(name)
}

/** 指标展示名：`contextPageMrr` 以口径名出现，避免与 legacy `mrr` 混读。 */
function comparisonMetricLabel(name: string): string {
  return name === 'contextPageMrr' ? CONTEXT_PAGE_MRR_LABEL : name
}

const SPEED_COMPARISON_ROWS: Array<{
  name: typeof SPEED_HEADLINE_METRICS[number]
  label: string
  duration: boolean
}> = [
  { name: 'evidenceReadyLatencyP50Ms', label: 'Evidence Ready P50', duration: true },
  { name: 'evidenceReadyLatencyP95Ms', label: 'Evidence Ready P95', duration: true },
  { name: 'timeToFirstTokenP50Ms', label: 'TTFT P50', duration: true },
  { name: 'timeToFirstTokenP95Ms', label: 'TTFT P95', duration: true },
  { name: 'fullAnswerLatencyP50Ms', label: 'Full Answer P50', duration: true },
  { name: 'fullAnswerLatencyP95Ms', label: 'Full Answer P95', duration: true },
  { name: 'avgOnlineTokensPerCompletedAnswer', label: 'Avg Online Tokens', duration: false },
]

function tokenComparisonIssues(result: BenchResult): string[] {
  const completed = result.meta.completedSpeedQuestionCount
  const tokenSamples = result.metrics.onlineTokenSampleCount
  if (completed === undefined) return [`${result.config.name} completedSpeedQuestionCount 缺失`]
  if (tokenSamples === undefined) return [`${result.config.name} onlineTokenSampleCount 缺失`]
  if (tokenSamples !== completed) return [`${result.config.name} token accounting 不完整（${tokenSamples}/${completed}）`]
  if (result.metrics.avgOnlineTokensPerCompletedAnswer === undefined) {
    return [`${result.config.name} Avg Online Tokens 缺失`]
  }
  return []
}

function comparisonSpeedValue(value: number | undefined, duration: boolean): string {
  if (value === undefined) return '—'
  return duration ? fmtDuration(value) : fmt(value)
}

function comparisonSpeedDelta(delta: number, duration: boolean): string {
  const value = `${delta >= 0 ? '+' : ''}${fmt(delta)}`
  return duration ? `${value} ms` : value
}

function renderSpeedComparison(a: BenchResult, b: BenchResult): string[] {
  const issues = speedComparisonIssues(a, b)
  const tokenIssues = [...tokenComparisonIssues(a), ...tokenComparisonIssues(b)]
  const lines: string[] = ['### Query-timeline 速度对比', '']

  if (issues.length > 0) {
    lines.push('> **速度不可比较**：以下 query-timeline 身份或 completed cohort 条件不满足，七个速度 delta 均不输出。')
    for (const issue of issues) lines.push(`> - ${issue}`)
    lines.push('')
  }
  lines.push('| 指标 | A | B | 差值（B - A） |')
  lines.push('| --- | ---: | ---: | ---: |')
  for (const row of SPEED_COMPARISON_ROWS) {
    const va = a.metrics[row.name]
    const vb = b.metrics[row.name]
    const tokenSuppressed = row.name === 'avgOnlineTokensPerCompletedAnswer' && tokenIssues.length > 0
    const delta = issues.length > 0 || tokenSuppressed || !Number.isFinite(va) || !Number.isFinite(vb)
      ? '—'
      : comparisonSpeedDelta(vb - va, row.duration)
    lines.push(`| ${row.label} | ${comparisonSpeedValue(va, row.duration)} | ${comparisonSpeedValue(vb, row.duration)} | ${delta} |`)
  }
  if (issues.length === 0 && tokenIssues.length > 0) {
    lines.push('')
    lines.push('> token accounting 不完整，仅抑制 Avg Online Tokens delta；六个时间 delta 仍按 query-timeline 门禁独立计算。')
    for (const issue of tokenIssues) lines.push(`> - ${issue}`)
  }
  return lines
}

/**
 * 横向比较门禁（§8）：数据集指纹、有效题集合哈希、指标版本、MRR 定义、上下文预算、
 * tokenizer 模型与 revision、evidence 映射版本全部一致，且两侧都声明具备检索比较资格、
 * 固定分母完整时，才允许计算受控检索指标的差值。返回空数组表示可比较。
 *
 * 判定用「存在且相等」而非单纯相等：两侧都缺同一字段时 `undefined === undefined`
 * 会让缺失的身份静默通过——两个不知道自己在哪份数据上跑的结果会被当成可比较。
 */
export function retrievalComparisonIssues(a: BenchResult, b: BenchResult): string[] {
  const issues: string[] = []
  const fields: Array<keyof BenchResult['meta']> = [
    'datasetFingerprint', 'eligibleRetrievalQuestionIdsHash', 'metricSchemaVersion',
    'mrrDefinition', 'contextBudgetTokens', 'contextTokenizer',
    'contextTokenizerRevision', 'evidenceMappingVersion',
  ]
  for (const field of fields) {
    const av = a.meta[field]
    const bv = b.meta[field]
    if (av === undefined || bv === undefined) issues.push(`${field} 缺失`)
    else if (av !== bv) issues.push(`${field} 不一致`)
  }
  for (const result of [a, b]) {
    // `!== true` 同时覆盖 false 与 undefined：legacy 与 full-context 都因此被拒
    if (result.meta.comparisonEligible !== true) issues.push(`${result.config.name} 不具备检索比较资格`)
    // 两侧都补 `?? 0`：没有有效题时聚合根本不会输出 SampleCount 字段，
    // 直接比会让 `undefined !== 0` 报成「样本数不完整」，把「没有观测」说成「观测偏少」。
    const samples = result.metrics.contextPageMrrSampleCount ?? 0
    const eligible = result.metrics.contextPageMrrEligibleCount ?? 0
    if (eligible === 0) {
      // 分母为 0 时 MRR 没有定义，比较一个空均值同样无意义，故也是 issue 而非放行
      issues.push(`${result.config.name} 没有可参与 Context Page MRR 的有效题（分母为 0）`)
    } else if (samples !== eligible) {
      // 用 !== 而非 <：样本数多于有效题说明有题被重复计数，同样是固定分母被破坏，两个方向都要拒
      issues.push(`${result.config.name} 的 Context Page MRR 样本数不完整`)
    }
  }
  return [...new Set(issues)]
}

export function renderComparison(a: BenchResult, b: BenchResult): string {
  const issues = retrievalComparisonIssues(a, b)
  const gated = issues.length > 0
  const names = collectMetricNames([a, b]).filter(name => !SPEED_SECTION_METRICS.has(name))
  const lines: string[] = []
  lines.push(`## 结果对比：${a.config.name} → ${b.config.name}`)
  lines.push('')
  lines.push(`- A：\`${a.meta.gitSha}\` @ ${a.meta.timestamp}（完成 ${a.meta.completed}/${a.meta.total}）`)
  lines.push(`  - mode：\`${a.meta.mode ?? 'rag'}\`；检索：\`${a.meta.retrievalAlgorithm ?? '—'}\``)
  lines.push(`- B：\`${b.meta.gitSha}\` @ ${b.meta.timestamp}（完成 ${b.meta.completed}/${b.meta.total}）`)
  lines.push(`  - mode：\`${b.meta.mode ?? 'rag'}\`；检索：\`${b.meta.retrievalAlgorithm ?? '—'}\``)
  lines.push('')

  if (isRetrievalSpeedResult(a) && isRetrievalSpeedResult(b)) {
    lines.push(...renderSpeedComparison(a, b))
    lines.push('')
  } else if ([a, b].some(result => (
    result.meta.speedDefinition !== undefined
    || Object.keys(result.metrics).some(name => SPEED_SECTION_METRICS.has(name))
  ))) {
    if (!isQueryTimelineResult(a) || !isQueryTimelineResult(b)) {
      lines.push(`> Legacy timing 不进入 query-timeline 速度 delta；两侧都必须声明 \`speedDefinition: '${SPEED_DEFINITION}'\`。`)
    } else {
      lines.push('> full-context 是独立生成上限，不进入检索方法的 query-timeline 速度 delta。')
    }
    lines.push('')
  }
  if (gated) {
    lines.push('> **不可比较**：以下身份或分母条件不满足，受控检索指标不输出差值（§8）。')
    for (const issue of issues) lines.push(`> - ${issue}`)
    lines.push('')
  }
  lines.push('| 指标 | A | B | 差值 |')
  lines.push('| --- | --- | --- | --- |')
  let hasCountRow = false
  for (const name of names) {
    const va = a.metrics[name]
    const vb = b.metrics[name]
    if (isCountMetric(name)) hasCountRow = true
    const delta = shouldSuppressDelta(name, gated) || !Number.isFinite(va) || !Number.isFinite(vb)
      ? '—'
      : `${vb - va >= 0 ? '+' : ''}${fmt(vb - va)}`
    lines.push(`| ${comparisonMetricLabel(name)} | ${va !== undefined ? fmt(va) : '—'} | ${vb !== undefined ? fmt(vb) : '—'} | ${delta} |`)
  }
  lines.push('')
  lines.push('> Query-timeline 主指标中 Evidence Ready、TTFT、Full Answer 与 Avg Online Tokens 均为越低越好；详细/Legacy 时延字段（`*Latency*Ms`）也越低越好；质量指标越高越好。')
  // 门禁通过时计数行仍然印「—」，不解释的话会被读成渲染 bug
  if (hasCountRow) {
    lines.push('>')
    lines.push('> `contextPageMrr*Count` 是分母计数行，恒不输出差值：样本数差异不是质量信号，两个数值已分别列在 A / B 列。')
  }
  lines.push('')
  return lines.join('\n')
}
