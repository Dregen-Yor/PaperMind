/**
 * Jev 探针的**纯**聚合：把逐题观测与跳过账目折成一份诊断汇总。
 *
 * 刻意无 I/O，也不碰判定器——指标定义要能被单测钉死，而不必起 Python 侧车、连网络。
 * 读盘 / 取数 / 跑模型的活儿全留在调用方（`bench/scripts/jevProbe.ts`）。
 *
 * **这是诊断，不是 benchmark**：单臂、无对照组、不接答题模型、粒度与冻结基线不同。
 * 它只回答一个问题——本地判定器**选中的章节对不对**。
 */

/** 一道被真正打分的题：只保留聚合要用的两个页集合与树诊断计数。 */
export interface ProbeObservation {
  /** 实际选中、进入选择的页（应已去重升序）；空数组表示这道题什么都没选 */
  selectedPages: number[]
  /** 金标证据页（来自 `normalizeQasperEntry`，与冻结基线同源） */
  goldEvidencePages: number[]
  /** `traverseWithJudge` 返回：存活但因 pages 为空被跳过的节点数 */
  emptyContentSkipped: number
  /** `traverseWithJudge` 返回：存活节点全无内容、回落文档首节点时置位 */
  emptySelectionFallback: boolean
}

/**
 * 跳过账目。**每一类单独计数**——一个悄悄丢掉四成题目却不报的探针，
 * 是在用沉默撒谎；各跳过原因分列后，「分母为什么是这些」才可被追问。
 */
export interface ProbeSkipAccount {
  /** 遍历过的论文里的**原始**题目总数（含被跳过者），供守恒对账 */
  attemptedQuestions: number
  /** unanswerable 题：本就无金标证据，不该打分 */
  skippedUnanswerable: number
  /** `evidenceMapping !== 'mapped'` 的题（ambiguous / unmapped） */
  skippedUnmapped: number
  /** 金标证据页为空的题 */
  skippedEmptyEvidence: number
  /** 建树失败被整篇跳过的**篇数**，按原因 */
  buildFailurePapersByReason: Record<string, number>
  /** 建树失败被丢掉的**问题数**，按原因；与上一项同源，供守恒对账 */
  buildFailureQuestionsByReason: Record<string, number>
  /**
   * 遍历 / 判定失败的题数，按原因（如 `not-an-array`、`sidecar error`）。
   * 这些题**没有**观测，从 all-hit / recall / precision 的分母里缺席，但**必须**在守恒式里出现，
   * 否则判定器大面积挂掉会被读成「题目变少了」，而不是「判定失败了」。
   */
  traversalFailureByReason: Record<string, number>
}

/** 一张网格单元（一组 α / topN）的诊断汇总。 */
export interface ProbeSummary {
  scoredQuestions: number
  /** 命中率：`selected ∩ gold ≠ ∅` 的已打分题占比 */
  anyHit: number
  /** recall 均值：`|selected ∩ gold| / |gold|` */
  meanRecall: number
  /** recall 均值的分母（金标非空的题数；正常情况下等于 scoredQuestions） */
  recallSampleCount: number
  /** precision 均值：`|selected ∩ gold| / |selected|` */
  meanPrecision: number
  /**
   * precision 均值的分母：`selected` 非空的题数。
   * **空选中被排除在 precision 均值之外，而不是记 0**——记 0 会把「什么都没选」
   * 与「选错了页」混为一谈；前者已由 `selectedNothing` 与 `anyHit` 单独反映。
   * 这条口径在报表里也会打印，避免读者自行假设。
   */
  precisionSampleCount: number
  /** `selected` 为空的题数（不进入 precision 均值） */
  selectedNothing: number
  /** 选中页数的均值：上下文体量的代理量 */
  meanSelectedPages: number
  /** `traverseWithJudge` 的 `emptyContentSkipped` 之和 */
  emptyContentSkipped: number
  /** `traverseWithJudge` 的 `emptySelectionFallback` 置位次数 */
  emptySelectionFallback: number
  /** 题级跳过计数（不含建树失败：那是篇级的） */
  skipped: {
    unanswerable: number
    unmapped: number
    emptyEvidence: number
    /** `traversalFailureByReason` 各原因之和 */
    traversalFailure: number
  }
  buildFailurePapersByReason: Record<string, number>
  buildFailureQuestionsByReason: Record<string, number>
  traversalFailureByReason: Record<string, number>
  /** 调用方声明的原始题数 */
  attemptedQuestions: number
  /** 实收口题数：已打分 + 题级跳过 + 建树失败丢题 */
  accountedQuestions: number
  /** `accountedQuestions === attemptedQuestions`。为 false 说明有一批题在某处凭空消失了 */
  conservationOk: boolean
}

/** 空数组返回 0 而非 NaN：无观测时宁可报 0，也不能让 NaN 渗进报表。 */
function mean(values: number[]): number {
  if (values.length === 0) return 0
  let total = 0
  for (const value of values) total += value
  return total / values.length
}

function intersectionSize(a: number[], b: number[]): number {
  const set = new Set(b)
  let count = 0
  for (const value of a) if (set.has(value)) count += 1
  return count
}

const sumOf = (counts: Record<string, number>): number =>
  Object.values(counts).reduce((a, b) => a + b, 0)

/**
 * 把错误折成**稳定**的原因键：剥掉随论文变化的数字，避免同一原因碎成无数个小桶
 * （`section-pages-length-mismatch: 3 names vs 1 page-lists` 与 `… 5 names vs 2 …`
 * 是同一个原因，必须落进同一桶）。
 */
export function failureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\d+/g, '#').slice(0, 120)
}

/**
 * 聚合。观测按题给入，跳过账目单独给入——两者口径不同（一个题级、一个含篇级），
 * 混进一个结构会让守恒式无从写起。
 */
export function aggregateProbe(
  observations: ProbeObservation[],
  account: ProbeSkipAccount,
): ProbeSummary {
  const hitCount = observations.filter(
    o => intersectionSize(o.selectedPages, o.goldEvidencePages) > 0,
  ).length

  // 金标为空的题不该出现在观测里（调用方已按 skippedEmptyEvidence 剔除）；
  // 若仍漏进一道，recall 的 `|gold|` 会是 0 —— 这里把它排除并如实计入
  // recallSampleCount，而不是让 0/0 变成 NaN 污染整列。
  const recallSamples = observations.filter(o => o.goldEvidencePages.length > 0)
  const precisionSamples = observations.filter(o => o.selectedPages.length > 0)

  const selectedNothing = observations.length - precisionSamples.length

  const skipped = {
    unanswerable: account.skippedUnanswerable,
    unmapped: account.skippedUnmapped,
    emptyEvidence: account.skippedEmptyEvidence,
    traversalFailure: sumOf(account.traversalFailureByReason),
  }

  const accountedQuestions = observations.length
    + skipped.unanswerable
    + skipped.unmapped
    + skipped.emptyEvidence
    + skipped.traversalFailure
    + sumOf(account.buildFailureQuestionsByReason)

  return {
    scoredQuestions: observations.length,
    anyHit: observations.length === 0 ? 0 : hitCount / observations.length,
    meanRecall: mean(recallSamples.map(
      o => intersectionSize(o.selectedPages, o.goldEvidencePages) / o.goldEvidencePages.length,
    )),
    recallSampleCount: recallSamples.length,
    meanPrecision: mean(precisionSamples.map(
      o => intersectionSize(o.selectedPages, o.goldEvidencePages) / o.selectedPages.length,
    )),
    precisionSampleCount: precisionSamples.length,
    selectedNothing,
    meanSelectedPages: mean(observations.map(o => o.selectedPages.length)),
    emptyContentSkipped: observations.reduce((total, o) => total + o.emptyContentSkipped, 0),
    emptySelectionFallback: observations.filter(o => o.emptySelectionFallback).length,
    skipped,
    buildFailurePapersByReason: { ...account.buildFailurePapersByReason },
    buildFailureQuestionsByReason: { ...account.buildFailureQuestionsByReason },
    traversalFailureByReason: { ...account.traversalFailureByReason },
    attemptedQuestions: account.attemptedQuestions,
    accountedQuestions,
    conservationOk: accountedQuestions === account.attemptedQuestions,
  }
}
