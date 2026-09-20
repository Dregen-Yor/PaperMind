export interface PageSpan { startPage: number; endPage: number }
export interface ScoredPageSpan { id: number; score: number }

/** 估算 token 数：英文约 4 字符/token，够用作成本代理指标。 */
const CHARS_PER_TOKEN = 4

export function estimateTokens(text: string): number {
  return Math.round(text.length / CHARS_PER_TOKEN)
}

/** 把节点的页码区间展开为去重升序页号数组（0-based）。诊断用（如 PerSampleRecord.selectedPages）。 */
export function expandPages(nodes: PageSpan[]): number[] {
  const set = new Set<number>()
  for (const n of nodes) {
    for (let p = n.startPage; p <= n.endPage; p++) set.add(p)
  }
  return [...set].sort((a, b) => a - b)
}

export interface ContextPageMetrics {
  /** 最终上下文中首个 gold evidence 页的名次倒数；未命中记 0 */
  contextPageMrr: number
  /** 页序覆盖的 gold evidence 页数 / gold evidence 页总数 */
  evidenceRecall: number
  /** 是否至少覆盖一个 gold evidence 页（0/1；聚合后成为 evidenceHitRate） */
  evidenceHit: number
  /** 页序中的 gold evidence 页数 / 页序总页数 */
  contextPrecision: number
}

/**
 * 有效题在检索/索引失败时写入的零观测：本类型（ContextPageMetrics）的零值，
 * 固定分母要求有效题逐题产生观测，失败以 0 如实表达，而不是靠缺字段退出分母
 * （否则失败会被误当成「没这题」）。三个 runner 引擎共用同一份零值。
 */
export const ZERO_CONTEXT_PAGE_METRICS: ContextPageMetrics = {
  contextPageMrr: 0,
  evidenceRecall: 0,
  evidenceHit: 0,
  contextPrecision: 0,
}

/**
 * 四个检索指标的唯一口径：全部消费同一份「最终送入生成模型的去重首次出现页序」。
 * 页序由公共 materializer 与上下文文本同源产出，禁止从事后推断的候选包络反推。
 *
 * 对有效题即使未命中也要显式写出 0（不能靠缺字段退出分母），因此本函数恒返回四个数；
 * 「是否有效题」由调用方按 `isRetrievalEligible` 判定后再决定是否写入。
 */
export function computeContextPageMetrics(pageOrder: number[], evidencePages: number[]): ContextPageMetrics {
  const ordered = [...new Set(pageOrder)]
  const evidence = new Set(evidencePages)
  const first = ordered.findIndex(page => evidence.has(page))
  const covered = ordered.filter(page => evidence.has(page)).length
  return {
    contextPageMrr: first < 0 ? 0 : 1 / (first + 1),
    evidenceRecall: evidence.size === 0 ? 0 : covered / evidence.size,
    evidenceHit: covered > 0 ? 1 : 0,
    contextPrecision: ordered.length === 0 ? 0 : covered / ordered.length,
  }
}

export interface RetrievalMetricArgs {
  /** 最终生成上下文中的去重首次出现页序（由公共 materializer 产出） */
  pageOrder: number[]
  /** 标注的 evidence 页号（0-based） */
  evidencePages: number[]
  /** 最终送入生成模型的上下文文本，用于估算 token */
  context: string
}

export interface RetrievalMetrics extends ContextPageMetrics {
  contextTokens: number
}

/** 四个检索指标 + token 估算的便捷包装；`selected/leaves/scores` 不再参与任何指标。 */
export function computeRetrievalMetrics(args: RetrievalMetricArgs): RetrievalMetrics {
  const { pageOrder, evidencePages, context } = args
  return {
    ...computeContextPageMetrics(pageOrder, evidencePages),
    contextTokens: estimateTokens(context),
  }
}

export interface ApplyRetrievalMetricsArgs {
  /** 是否有效题（由调用方按 `isRetrievalEligible` 判定）；决定是否写四个检索指标 */
  eligible: boolean
  /**
   * 最终生成上下文页序。有效题传 `undefined` 表示检索产物丢失了页序——这是契约违约，
   * 在此统一抛出：静默按 `[]` 算成 0 会把「本该有观测却丢失」伪装成合法的 0 命中，
   * 而固定分母不变量照样通过（0 也是观测），正是本设计要杜绝的静默丢弃（§7）。
   */
  pageOrder: number[] | undefined
  /** 标注的 evidence 页号（0-based） */
  evidencePages: number[]
  /** 最终送入生成模型的上下文文本，用于估算 token */
  context: string
  /** 仅用于违约错误消息的可读性，非必需 */
  questionId?: string
}

/**
 * 把检索指标写进逐样本记录：有效题写四个检索指标，非有效题只写 token 估算。
 * 三个 runner 引擎共用同一口径，避免「谁算有效题、非有效题写什么」被各自复制后分叉；
 * `eligible` 由调用方按 `isRetrievalEligible` 判定后传入。有效题页序缺失的契约守卫
 * 也收敛在此处，禁止各 runner 自行复制或遗漏。
 */
export function applyRetrievalMetrics(
  metrics: Record<string, number>,
  args: ApplyRetrievalMetricsArgs,
): void {
  const { eligible, pageOrder, evidencePages, context, questionId } = args
  if (eligible && pageOrder === undefined) {
    throw new Error(`有效题${questionId ? ` ${questionId}` : ''} 的检索产物缺少 contextPageOrder，无法计算检索指标`)
  }
  if (eligible) Object.assign(metrics, computeRetrievalMetrics({ pageOrder: pageOrder ?? [], evidencePages, context }))
  else metrics.contextTokens = estimateTokens(context)
}
