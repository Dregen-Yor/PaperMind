/**
 * TOC+jev 的**检索侧**对照臂比较（设计文档 §3.1 / §3.4）。
 *
 * 覆盖设计里的三条臂：
 *   A `toc-bm25`        —— 同一棵树、同一套遍历，只把打分器换成 BM25（**主对照**）
 *   B `toc-jev`         —— 同一棵树、同一套遍历，打分器是本地 MLX 判定模型（实验主体）
 *   D `flat-global-bm25`—— 不用树，对全文各页做 BM25，取前 K 页（地板）
 *
 * **C `passage-hybrid` 不在本脚本内**：它是产品默认路径，需要 `structureCards` 的
 * 每篇一次卡片 LLM 调用，而 bench 的 LLM 凭据来自 `BENCH_LLM_*` 环境变量、本机一个都没有。
 * 缺它不致命——设计文档 §3.1 明确「A vs B 是核心比较」，且 C 与 A/B 不同源（段落级、
 * 不是节树）。但**必须如实记下它缺席**，不能拿三条臂冒充四条。
 *
 * 用法：
 *   QASPER_PATH=bench/datasets/qasper/qasper-current.jsonl \
 *     npx tsx bench/scripts/jevArms.ts [--limit 60] [--out bench/results/jev-arms.md]
 *
 * 三条纪律：
 * 1. **切片**：默认跑全部 60 篇 / 179 题（冻结切片）。`--limit` 只用于冒烟，跑出的数字
 *    不得进任何横向主表。
 * 2. **防过拟合**：论文按 `paperId` 排序后交替切 dev/test。α/N 网格**只在 dev 上扫**，
 *    然后在 test 上只跑选出那一格。只报全体均值会让「网格是在同一批题上挑的」这件事消失。
 * 3. **分级报告**（§3.4）：深度 1 与深度 ≥2 必须分开报。只报深度 ≥2 是高估，
 *    混着报会低估层级机制本身。
 */
import { writeFile } from 'node:fs/promises'
import { loadQasperDataset } from '../src/datasets/qasper'
import { buildQasperTree } from '../src/toc/qasperTree'
import { createBm25Judge } from '../src/toc/bm25Judge'
import { createMlxJudge } from '../src/jev/mlxJudge'
import { aggregateProbe, failureReason, type ProbeObservation, type ProbeSummary } from '../src/toc/probeMetrics'
import { traverseWithJudge, type TocNode } from '../../src/utils/tocTree'
import { buildBm25Scorer } from '../../src/utils/bm25'
import type { EvidenceJudge } from '../../src/utils/evidenceJudge'
import type { EvalSample, QaQuestion } from '../src/types'

/** 扫描网格。α 偏向高段：实测这批概率挤在窄区间，中段阈值几乎不筛（设计文档 §3.2）。 */
const ALPHA_GRID = [0.5, 0.7, 0.8, 0.9, 1.0]
const TOP_N_GRID = [1, 2, 3]
/** D 臂取前 K 页的 K。与 A/B 的 meanSelectedPages 对照着看。 */
const FLAT_TOP_K = [1, 2, 3, 5]

type ArmId = 'A:toc-bm25' | 'B:toc-jev' | 'D:flat-global-bm25'

interface Args {
  limit: number
  out: string
}

function parseArgs(argv: string[]): Args {
  let limit = 60
  let out = 'bench/results/jev-arms.md'
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit') {
      limit = Number(argv[++i])
      if (!Number.isInteger(limit) || limit <= 0) throw new RangeError(`--limit 必须是正整数，收到 ${argv[i]}`)
    } else if (argv[i] === '--out') {
      out = argv[++i]
    }
  }
  return { limit, out }
}

/** 树的层数（根为第 1 层）。§3.4 的分组据此切。 */
function treeLevels(tree: TocNode[]): number {
  let maxDepth = -1
  const walk = (nodes: TocNode[]): void => {
    for (const node of nodes) {
      if (node.depth > maxDepth) maxDepth = node.depth
      walk(node.children)
    }
  }
  walk(tree)
  return maxDepth + 1
}

/** 选中节点贡献的页，去重升序——与 `tocNodePageSpan` 认的 `node.pages` 同源。 */
function pagesOfSelection(selected: TocNode[]): number[] {
  const pages = new Set<number>()
  for (const node of selected) for (const page of node.pages) pages.add(page)
  return [...pages].sort((a, b) => a - b)
}

/**
 * 判定器记忆化。MLX 判定器**确定性**（同一问题 × 同一候选集两次运行分数逐位相同，
 * 探针已实测），BM25 更不必说，故按 (query, 候选 id 序列) 缓存是精确的、不是近似。
 * α 不影响判定、只影响阈值，所以整个 α 网格共用一份缓存——这是网格能跑得动的原因。
 */
function memoize(judge: EvidenceJudge): EvidenceJudge {
  const cache = new Map<string, number[]>()
  return {
    async judge(input) {
      const key = `${input.query}\u0000${input.nodes.map(n => n.id).join(',')}`
      const hit = cache.get(key)
      if (hit) return hit
      const scores = await judge.judge(input)
      cache.set(key, scores)
      return scores
    },
  }
}

/** D 臂：不用树，对整篇的各页做 BM25，取前 K 页。 */
function flatBm25Pages(pages: string[], query: string, topK: number): number[] {
  const scored = buildBm25Scorer(pages)(query)
  return scored
    .filter(d => d.score > 0)
    .sort((a, b) => (b.score - a.score) || (a.id - b.id))
    .slice(0, topK)
    .map(d => d.id)
    .sort((a, b) => a - b)
}

interface PaperEntry {
  sample: EvalSample
  tree: TocNode[] | null
  levels: number
  buildFailure: string | null
}

function isEligible(q: QaQuestion): boolean {
  return !q.unanswerable && q.evidenceMapping === 'mapped' && q.evidencePages.length > 0
}

function fmt(x: number, digits = 3): string {
  return x.toFixed(digits)
}

async function main(): Promise<void> {
  const { limit, out } = parseArgs(process.argv.slice(2))

  const all = await loadQasperDataset()
  const samples = all.slice(0, limit)
  console.log(`语料: ${all.length} 篇（本次取前 ${samples.length} 篇）`)

  // ---- 建树（一次，A/B 共用同一棵树） ----
  const entries: PaperEntry[] = []
  for (const sample of samples) {
    const names = sample.sectionNames
    const sectionPages = sample.sectionPages
    if (!names || !sectionPages || names.length === 0) {
      entries.push({ sample, tree: null, levels: 0, buildFailure: 'no-sections' })
      continue
    }
    try {
      const { tree } = buildQasperTree({ sectionNames: names, sectionPages })
      entries.push({ sample, tree, levels: treeLevels(tree), buildFailure: null })
    } catch (error) {
      entries.push({ sample, tree: null, levels: 0, buildFailure: failureReason(error) })
    }
  }

  const built = entries.filter(e => e.tree !== null)
  const levelsHistogram = new Map<number, number>()
  for (const e of built) levelsHistogram.set(e.levels, (levelsHistogram.get(e.levels) ?? 0) + 1)
  console.log(
    `建树: ${built.length}/${entries.length} 篇成功；层数分布 ` +
    `${[...levelsHistogram.entries()].sort((a, b) => a[0] - b[0]).map(([l, n]) => `${l}层:${n}`).join(' ')}`,
  )
  if (entries.length !== built.length) {
    console.log(`建树失败: ${JSON.stringify(countBy(entries.filter(e => e.buildFailure).map(e => e.buildFailure!)))}`)
  }

  // ---- dev / test 切分（按 paperId 排序后交替） ----
  const sortedBuilt = [...built].sort((a, b) => a.sample.paperId.localeCompare(b.sample.paperId))
  const splitOf = new Map<string, 'dev' | 'test'>()
  sortedBuilt.forEach((e, i) => splitOf.set(e.sample.paperId, i % 2 === 0 ? 'dev' : 'test'))

  const eligibleCount = built.reduce((n, e) => n + e.sample.questions.filter(isEligible).length, 0)
  const totalQuestions = samples.reduce((n, s) => n + s.questions.length, 0)
  console.log(
    `题目: 原始 ${totalQuestions}；可打分（非 unanswerable 且 evidenceMapping=mapped 且金标非空）${eligibleCount}`,
  )

  // ---- 判定器 ----
  const mlx = createMlxJudge()
  let summaries: Map<string, ProbeSummary>
  try {
    const warm = Date.now()
    await mlx.judge({ query: 'warmup', nodes: [{ id: 'warmup', title: 'warmup', path: [] }] })
    console.log(`MLX 判定器载入（热身一次，含权重）${Date.now() - warm}ms`)

    summaries = await runAllArms(built, splitOf, mlx)
  } finally {
    await mlx.close()
  }

  report(summaries, built, levelsHistogram, out)
}

/** 逐臂 × 逐格跑完，返回 `臂|split|group|cell -> 汇总`。 */
async function runAllArms(
  built: PaperEntry[],
  splitOf: Map<string, 'dev' | 'test'>,
  mlx: EvidenceJudge,
): Promise<Map<string, ProbeSummary>> {
  const judges: Array<{ arm: ArmId; judge: EvidenceJudge }> = [
    { arm: 'A:toc-bm25', judge: memoize(createBm25Judge()) },
    { arm: 'B:toc-jev', judge: memoize(mlx) },
  ]

  // (arm, split, group, cell) -> 观测
  const buckets = new Map<string, ProbeObservation[]>()
  const push = (key: string, obs: ProbeObservation): void => {
    const list = buckets.get(key)
    if (list) list.push(obs)
    else buckets.set(key, [obs])
  }

  for (const entry of built) {
    const sample = entry.sample
    const tree = entry.tree!
    const split = splitOf.get(sample.paperId) ?? 'dev'
    const group = entry.levels >= 2 ? 'depth>=2' : 'depth=1'
    const questions = sample.questions.filter(isEligible)

    for (const { arm, judge } of judges) {
      for (const alpha of ALPHA_GRID) {
        for (const topN of TOP_N_GRID) {
          const cell = `a${alpha}-n${topN}`
          for (const question of questions) {
            const selection = await traverseWithJudge(tree, question.question, judge, { alpha, topN })
            const obs: ProbeObservation = {
              selectedPages: pagesOfSelection(selection.selected),
              goldEvidencePages: question.evidencePages,
              emptyContentSkipped: selection.emptyContentSkipped,
              emptySelectionFallback: selection.emptySelectionFallback,
            }
            push(`${arm}|${split}|${group}|${cell}`, obs)
            push(`${arm}|${split}|all|${cell}`, obs)
            push(`${arm}|all|${group}|${cell}`, obs)
            push(`${arm}|all|all|${cell}`, obs)
          }
        }
      }
    }

    // D 臂：与树无关，每个 K 一格
    for (const topK of FLAT_TOP_K) {
      const cell = `k${topK}`
      for (const question of questions) {
        const obs: ProbeObservation = {
          selectedPages: flatBm25Pages(sample.pages, question.question, topK),
          goldEvidencePages: question.evidencePages,
          emptyContentSkipped: 0,
          emptySelectionFallback: false,
        }
        push(`D:flat-global-bm25|${split}|${group}|${cell}`, obs)
        push(`D:flat-global-bm25|${split}|all|${cell}`, obs)
        push(`D:flat-global-bm25|all|${group}|${cell}`, obs)
        push(`D:flat-global-bm25|all|all|${cell}`, obs)
      }
    }
  }

  // 每个 bucket 的跳过账目复用同一个（本脚本的跳过发生在**题级筛选之前**，
  // 由 isEligible 统一完成，因此不随臂/格变化）。
  const attempted = built.reduce((n, e) => n + e.sample.questions.length, 0)
  const account = {
    attemptedQuestions: attempted,
    skippedUnanswerable: built.reduce((n, e) => n + e.sample.questions.filter(q => q.unanswerable).length, 0),
    skippedUnmapped: built.reduce((n, e) => n + e.sample.questions.filter(q => !q.unanswerable && q.evidenceMapping !== 'mapped').length, 0),
    skippedEmptyEvidence: built.reduce((n, e) => n + e.sample.questions.filter(q => !q.unanswerable && q.evidenceMapping === 'mapped' && q.evidencePages.length === 0).length, 0),
    buildFailurePapersByReason: countBy(built.filter(e => e.buildFailure).map(e => e.buildFailure!)),
    // 按**题**算，不是按篇：守恒式是题级的，拿篇数去凑会对不上。
    buildFailureQuestionsByReason: {} as Record<string, number>,
    traversalFailureByReason: {} as Record<string, number>,
  }
  for (const e of built) {
    if (!e.buildFailure) continue
    account.buildFailureQuestionsByReason[e.buildFailure] =
      (account.buildFailureQuestionsByReason[e.buildFailure] ?? 0) + e.sample.questions.length
  }

  const summaries = new Map<string, ProbeSummary>()
  for (const [key, obs] of buckets) summaries.set(key, aggregateProbe(obs, account))
  return summaries
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const v of values) out[v] = (out[v] ?? 0) + 1
  return out
}

function report(
  summaries: Map<string, ProbeSummary>,
  built: PaperEntry[],
  levelsHistogram: Map<number, number>,
  out: string,
): void {
  const lines: string[] = []
  const say = (s = ''): void => { lines.push(s); console.log(s) }

  say('# TOC+jev 检索侧对照臂')
  say()
  say(`论文 ${built.length} 篇；层数分布 ${[...levelsHistogram.entries()].sort((a, b) => a[0] - b[0]).map(([l, n]) => `${l}层:${n}`).join(' ')}`)
  say()
  say('> **C `passage-hybrid` 缺席**：它需要每篇一次卡片 LLM 调用，而本机没有 `BENCH_LLM_*` 凭据。')
  say('> 因此下表是**三条臂**，不是四条。A vs B 是设计文档 §3.1 的核心比较，不受影响。')
  say()
  say('> **这是检索侧诊断，不是冻结基线表**：不接答题模型、不产出 `contextPageMrr` 的契约口径，')
  say('> 数字**不得**与 `bench/results/` 里的既有基线混排或做差值。')
  say()

  const arms: ArmId[] = ['A:toc-bm25', 'B:toc-jev', 'D:flat-global-bm25']

  for (const arm of arms) {
    say(`## ${arm}`)
    say()
    const cells = arm === 'D:flat-global-bm25'
      ? FLAT_TOP_K.map(k => `k${k}`)
      : ALPHA_GRID.flatMap(a => TOP_N_GRID.map(n => `a${a}-n${n}`))
    say('| 格 | 已打分 | anyHit | meanRecall | meanPrecision | 平均选中页数 | 空选 | 空选择回落 |')
    say('|---|---|---|---|---|---|---|---|')
    for (const cell of cells) {
      const s = summaries.get(`${arm}|all|all|${cell}`)
      if (!s) continue
      say(`| ${cell} | ${s.scoredQuestions} | ${fmt(s.anyHit)} | ${fmt(s.meanRecall)} | ${fmt(s.meanPrecision)} | ${fmt(s.meanSelectedPages, 2)} | ${s.selectedNothing} | ${s.emptySelectionFallback} |`)
    }
    say()
  }

  // ---- dev 上挑格，test 上只跑那一格 ----
  say('## dev 挑格 → test 验证')
  say()
  say('网格**只在 dev 上扫**；下表 test 列是选定格在 test 半边的结果，未参与挑格。')
  say()
  say('| 臂 | dev 选定格 | dev recall | test recall | test anyHit | test precision |')
  say('|---|---|---|---|---|---|')
  for (const arm of arms) {
    const cells = arm === 'D:flat-global-bm25'
      ? FLAT_TOP_K.map(k => `k${k}`)
      : ALPHA_GRID.flatMap(a => TOP_N_GRID.map(n => `a${a}-n${n}`))
    let best: { cell: string; s: ProbeSummary } | null = null
    for (const cell of cells) {
      const s = summaries.get(`${arm}|dev|all|${cell}`)
      if (!s) continue
      if (!best || s.meanRecall > best.s.meanRecall
        || (s.meanRecall === best.s.meanRecall && s.meanSelectedPages < best.s.meanSelectedPages)) {
        best = { cell, s }
      }
    }
    if (!best) { say(`| ${arm} | — | — | — | — | — |`); continue }
    const t = summaries.get(`${arm}|test|all|${best.cell}`)
    say(`| ${arm} | ${best.cell} | ${fmt(best.s.meanRecall)} | ${t ? fmt(t.meanRecall) : '—'} | ${t ? fmt(t.anyHit) : '—'} | ${t ? fmt(t.meanPrecision) : '—'} |`)
  }
  say()

  // ---- §3.4 分级报告（all 半边，用各自 dev 选定格） ----
  say('## 分级报告（§3.4 要求分开报）')
  say()
  say('只报全体均值会掩盖层级机制在单层树上的退化。')
  say()
  say('| 臂 | 组 | 已打分 | anyHit | meanRecall | meanPrecision |')
  say('|---|---|---|---|---|---|')
  for (const arm of arms) {
    for (const group of ['depth=1', 'depth>=2']) {
      const s = summaries.get(`${arm}|all|${group}|${arm === 'D:flat-global-bm25' ? 'k3' : 'a0.7-n3'}`)
      if (!s) continue
      say(`| ${arm} | ${group} | ${s.scoredQuestions} | ${fmt(s.anyHit)} | ${fmt(s.meanRecall)} | ${fmt(s.meanPrecision)} |`)
    }
  }
  say()
  say('（上表统一用 `a0.7-n3` / `k3` 一格做**跨臂可比**的分组对照，不是各臂的 dev 最优格。）')
  say()

  const anySummary = summaries.get(`${arms[0]}|all|all|a0.7-n3`)
  if (anySummary) {
    say(`跳过账目：原始题 ${anySummary.attemptedQuestions}，已打分 ${anySummary.scoredQuestions}，`)
    say(`unanswerable ${anySummary.skipped.unanswerable}，unmapped ${anySummary.skipped.unmapped}，空金标 ${anySummary.skipped.emptyEvidence}，`)
    say(`建树失败丢题 ${Object.values(anySummary.buildFailureQuestionsByReason).reduce((a, b) => a + b, 0)}，守恒 ${anySummary.conservationOk ? '通过' : '**未通过**'}`)
  }

  void writeFile(out, lines.join('\n') + '\n')
}

main().catch(error => {
  console.error(`\n运行失败: ${error instanceof Error ? error.stack : String(error)}`)
  process.exit(1)
})
