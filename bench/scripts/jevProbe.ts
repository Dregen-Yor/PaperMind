/**
 * Jev 判定探针：**诊断，不是 benchmark**。
 *
 * ## 它证明什么
 * 给本地决策模型（Laya / Jev，经 Python 侧车）一套 QASPER 的原文节结构树，
 * 让它按「这一节对这个问题是不是证据」逐层打分、逐层筛选，然后量一件事：
 * **判定器选中的章节对不对**——命中率、召回、精度、选中页数，以及每一类跳过/失败各有多少。
 *
 * ## 它**不是**什么（别把它读成基准结果）
 * - **单臂**：没有对照组，没有基线可比，任何数字都不构成「比 X 好/差」。
 * - **无答题步骤**：不让 LLM 依据证据作答，因此不产出答案质量。Plan 2 才是真基准。
 * - **粒度不同**：这里的「选中页」是 `traverseWithJudge` 的**原始选择**，尚未过 token 预算物化，
 *   与冻结基线结果里的 `contextPageOrder`（物化后实际进上下文的页序）不是一回事，不可混排。
 * - **概率未校准**：`noul:2` 桶的温度 1.9834 > 1 把 softmax 压平，绝对概率没有意义，
 *   被信任的只有**名次**。层内相对阈值 θ = α × 层内最高分对这类失真免疫。
 *
 * ## 保真门（先跑，硬性）
 * 用**上游同一条**取数路径（`fetchQasperRows` + `normalizeQasperEntry`）重算，再与冻结记录
 * 逐题比对 `evidencePages` 与 `unanswerable`。对不上就**立刻非零退出**，不产出任何指标——
 * 金标映射错了的话，后面每个数都会看着合理却毫无意义。
 *
 * ## 网格为什么是 α∈[0.7,0.8,0.9,1.0] × topN∈[1,2,3]
 * - **α ≤ 1 是硬约束**：`traverseWithJudge` 没有运行时下限，α>1 会让 θ>max、整层清空，
 *   从而错触 `emptySelectionFallback`——那会把「阈值设错了」栽赃成「模型选不出来」。
 * - **不取 α=0.5**：实测该处层内阈值一个候选都滤不掉（survivors === candidates），
 *   该区间对阈值行为毫无信息量。
 * - 分数不校准（见上），所以网格扫的是**阈值对名次的影响**，不是绝对分数的好坏。
 *
 * 全部逻辑包在 main() 里，失败时有明确的 exit 1。顶层 await 在 bench/ 下可用
 * （bench/package.json 是 "type": "module"）。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { benchPath } from '../src/paths'
import { fetchQasperRows } from '../src/toc/qasperRows'
import { normalizeQasperEntry, type QasperEntry } from '../src/datasets/qasper'
import { aggregateProbe, failureReason, type ProbeObservation, type ProbeSkipAccount, type ProbeSummary }
  from '../src/toc/probeMetrics'
import { buildQasperTree } from '../src/toc/qasperTree'
import { createMlxJudge } from '../src/jev/mlxJudge'
import { traverseWithJudge } from '../../src/utils/tocTree'
import type { EvalSample } from '../src/types'
import type { EvidenceJudge, JudgeInput } from '../../src/utils/evidenceJudge'

/** QASPER validation split 全量篇数；`--limit 0` 取全部。 */
const QASPER_TOTAL = 281
const DEFAULT_LIMIT = 30
const ALPHAS = [0.7, 0.8, 0.9, 1.0]
const TOP_N = [1, 2, 3]

// ————————————————————————————— CLI —————————————————————————————

interface ProbeArgs {
  limit: number
  useCache: boolean
}

/** 非法取值立刻抛错而不是回落默认值：拼错的 flag 静默生效会产出一份看着正常的错结果。 */
function parseProbeArgs(argv: string[]): ProbeArgs {
  const args: ProbeArgs = { limit: DEFAULT_LIMIT, useCache: true }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    switch (flag) {
      case '--limit': {
        const raw = argv[++i]
        const value = Number(raw)
        // 允许 0（取全部），但不允许负数/小数/非数——它们会让下面的切片行为诡异
        if (raw === undefined || !Number.isInteger(value) || value < 0) {
          throw new Error(`--limit 需要非负整数（0 = 全部），收到：${raw}`)
        }
        args.limit = value
        break
      }
      case '--no-cache':
        args.useCache = false
        break
      default:
        throw new Error(`未知参数：${flag}`)
    }
  }
  return args
}

// ——————————————————————————— 取数与缓存 ———————————————————————————

/**
 * 上游行的真实形状。`qasperRows.ts` 声明的 `QasperRawRow` 只暴露了冒烟用得到的字段，
 * 探针额外要 `abstract` 与（列式化的）`qas.answers`，故在此补一份本地类型。
 */
interface RawAnswer {
  unanswerable: boolean
  extractive_spans: string[]
  free_form_answer: string
  evidence: string[]
  yes_no?: boolean | null
}
interface RawUpstreamRow {
  id: string
  title: string
  abstract: string
  full_text: { section_name: string[]; paragraphs: string[][] }
  qas: { question: string[]; answers: Array<{ answer?: RawAnswer[] } | undefined> }
}

/**
 * datasets-server 把「list of struct」列式化：`answers[i]` 是 `{ answer: RawAnswer[] }`
 * （各标注者横排），而 `normalizeQasperEntry` 消费的是 `answers[i] = [{ answer }]`（纵排）。
 * 这层转置与 `datasets/qasper/fetch.ts` 的 `toCanonicalQas` **逐字同义**——它是取数适配，
 * 不是 evidence→page 映射（那段逻辑一律走 `normalizeQasperEntry`，绝不在此复刻）。
 * 若这层转置写错，保真门会当场抓到（unanswerable / evidencePages 会整体错位）。
 */
function toCanonicalEntry(row: RawUpstreamRow): QasperEntry {
  return {
    title: row.title,
    abstract: row.abstract,
    full_text: row.full_text,
    qas: {
      question: row.qas.question,
      answers: row.qas.answers.map(perQuestion => (perQuestion?.answer ?? []).map(a => ({ answer: a }))),
    },
  }
}

const CACHE_PATH = (limit: number): string =>
  benchPath(import.meta.url, `../cache/qasper-rows-${limit === 0 ? 'all' : limit}.json`)

/**
 * 读缓存或拉取上游。端点限流且今日不稳定，故把**原始行**按请求量落盘到 `bench/cache/`
 * （gitignored），后续运行直接读盘、离线且快。`--no-cache` 强制重取。
 */
async function loadRows(limit: number, useCache: boolean): Promise<RawUpstreamRow[]> {
  const path = CACHE_PATH(limit)
  if (useCache && existsSync(path)) {
    try {
      const rows = JSON.parse(await readFile(path, 'utf-8')) as RawUpstreamRow[]
      console.log(`读取缓存 ${path}（${rows.length} 篇）`)
      return rows
    } catch (error) {
      // 缓存损坏不该让整轮失败：它是可再生的，重取一次即可（网络不行时下面的 fetch 会响亮报错）。
      console.warn(`缓存不可读，改为重取：${(error as Error).message}`)
    }
  }
  const fetchCount = limit === 0 ? QASPER_TOTAL : limit
  console.log(`从上游拉取 ${fetchCount} 篇…`)
  const raw = await fetchQasperRows(fetchCount)
  const rows = raw as unknown as RawUpstreamRow[]
  await mkdir(benchPath(import.meta.url, '../cache'), { recursive: true })
  await writeFile(path, JSON.stringify(rows))
  console.log(`已写入缓存 ${path}`)
  return rows
}

// ———————————————————————————— 保真门 ————————————————————————————

/**
 * 读冻结记录供保真校验：**直接逐行 JSON.parse**，刻意不走 `loadQasperDataset()`。
 *
 * 本机冻结 jsonl 是 2026-09-04 的旧格式（无 `qualityAnswers`），而 `loadQasperDataset`
 * 自 2026-09-23 起硬性要求版本化参考答案——它在 `src/datasets/qasper.ts:214-218` 直接抛错，
 * 于是当前代码**根本跑不了 `--dataset qasper`**。那条守卫属 Q 指标口径，与 evidence 映射
 * 保真无关；而保真要的 `evidencePages` / `evidenceMapping` / `unanswerable` 本题对象上都有。
 *
 * 绝不重跑 `fetch.ts` 覆写该文件——它被 `.gitignore` 忽略、是全部既有基线的语料，覆写会换掉 gold 页。
 */
async function loadFrozenForFidelity(): Promise<EvalSample[]> {
  const path = benchPath(import.meta.url, '../datasets/qasper/qasper.jsonl')
  const content = await readFile(path, 'utf-8')
  return content
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as EvalSample)
}

/**
 * 逐题比对本地重算与冻结记录。**这是硬门**：任何一处不符即抛错，绝不降级为警告——
 * 金标映射一旦错位，下游每个指标都会看着合理却毫无意义。
 */
async function assertFidelity(samples: EvalSample[]): Promise<{ papers: number; questions: number }> {
  const frozen = await loadFrozenForFidelity()
  const frozenById = new Map(frozen.map(sample => [sample.paperId, sample]))
  const mismatches: string[] = []
  let papers = 0
  let questions = 0

  for (const sample of samples) {
    const reference = frozenById.get(sample.paperId)
    if (!reference) continue
    papers += 1
    const referenceQuestions = new Map(reference.questions.map(q => [q.id, q]))
    for (const question of sample.questions) {
      const expected = referenceQuestions.get(question.id)
      if (!expected) continue
      questions += 1
      const samePages = question.evidencePages.length === expected.evidencePages.length
        && question.evidencePages.every((page, i) => page === expected.evidencePages[i])
      if (!samePages || question.unanswerable !== expected.unanswerable) {
        mismatches.push(
          `  ${sample.paperId} ${question.id}\n`
          + `    本地重算: evidencePages=[${question.evidencePages.join(',')}] unanswerable=${question.unanswerable}\n`
          + `    冻结记录: evidencePages=[${expected.evidencePages.join(',')}] unanswerable=${expected.unanswerable}`,
        )
      }
    }
  }

  // 一道题都没比过的「保真校验」等于没做，同样按失败处理——否则取数一旦错位到没有交集，
  // 门会静默放行，而探针照常打印数字。
  if (questions === 0) throw new Error('保真校验没有可比对的重叠题目：取数路径或 paperId 对不上')

  if (mismatches.length > 0) {
    console.error(`[保真校验失败] ${mismatches.length}/${questions} 题与冻结记录不符，探针不成立，立即终止：`)
    for (const line of mismatches.slice(0, 20)) console.error(line)
    throw new Error('fidelity-check-failed')
  }
  return { papers, questions }
}

// ——————————————————————————— 判定器缓存 ———————————————————————————

/**
 * 按 (question, 候选节点集) 记忆化判定调用。
 *
 * 为什么需要：α 只改层内阈值、不改送去判定的候选集，因此同一层在 12 个网格点上是**同一次**
 * 判定。不缓存就要把整棵树的打分重复 12 遍（本地模型逐节点推理，代价实打实）。缓存后网格
 * 共享同一份分数场——这正好让网格**隔离出阈值行为**，而不是把采样噪声也一起扫进去。
 *
 * 失败**不缓存**：一次瞬时失败（超时）若被钉死，会让整片网格跟着陪葬；删掉条目后
 * 下一个网格点还有一次新的机会。缓存按**篇**建立（调用方每篇新建一个），故不含跨篇
 * 碰撞之虞。
 */
function memoizeJudge(inner: EvidenceJudge): EvidenceJudge {
  const cache = new Map<string, Promise<number[]>>()
  return {
    judge(input: JudgeInput): Promise<number[]> {
      const key = input.query + '\u0000'
        + input.nodes.map(n => `${n.id}|${n.path.join('/')}|${n.title}`).join('\u0000')
      const hit = cache.get(key)
      if (hit) return hit
      const pending = inner.judge(input).catch((error: unknown) => {
        cache.delete(key)
        throw error
      })
      cache.set(key, pending)
      return pending
    },
  }
}

// ———————————————————————————— 输出 ————————————————————————————

/** 朴素等宽表格；列内容不含换行。CJK 对齐不完美，够诊断用。 */
function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)))
  const line = (cells: string[]): string =>
    '| ' + cells.map((c, i) => c.padEnd(widths[i])).join(' | ') + ' |'
  const separator = '|' + widths.map(w => '-'.repeat(w + 2)).join('|') + '|'
  return [line(headers), separator, ...rows.map(line)].join('\n')
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`
const fixed = (x: number, digits = 2): string => x.toFixed(digits)

function printSkipAccounting(account: ProbeSkipAccount): void {
  console.log('跳过账目（题级，与网格点无关）：')
  console.log(`  原始题目 ${account.attemptedQuestions}`)
  console.log(`    · unanswerable            ${account.skippedUnanswerable}`)
  console.log(`    · evidenceMapping≠mapped  ${account.skippedUnmapped}`)
  console.log(`    · 金标证据页为空           ${account.skippedEmptyEvidence}`)
  const buildPapers = Object.entries(account.buildFailurePapersByReason)
  if (buildPapers.length > 0) {
    console.log('  建树失败（整篇跳过）：')
    for (const [reason, count] of buildPapers) {
      console.log(`    · ${reason}: ${count} 篇 / 丢题 ${account.buildFailureQuestionsByReason[reason] ?? 0}`)
    }
  } else {
    console.log('  建树失败：0 篇')
  }
}

function printSummaryRow(alpha: number, topN: number, summary: ProbeSummary): string[] {
  return [
    alpha.toFixed(1),
    String(topN),
    String(summary.scoredQuestions),
    pct(summary.anyHit),
    pct(summary.meanRecall),
    pct(summary.meanPrecision),
    fixed(summary.meanSelectedPages),
    String(summary.selectedNothing),
    String(summary.skipped.traversalFailure),
  ]
}

// ———————————————————————————— 主流程 ————————————————————————————

async function main(): Promise<void> {
  const args = parseProbeArgs(process.argv.slice(2))
  for (const alpha of ALPHAS) {
    // α>1 会让 θ>层内最高分、整层清空，从而错触 emptySelectionFallback——把阈值设错栽赃成模型失败
    if (!(alpha > 0 && alpha <= 1)) throw new Error(`α 必须在 (0,1]，收到 ${alpha}`)
  }

  console.log('=== Jev 判定探针（诊断，非 benchmark：单臂 / 无对照组 / 无答题步骤）===')
  console.log('粒度说明：这里的「选中页」是 traverseWithJudge 的原始选择，未过 token 预算物化，')
  console.log('          与冻结基线的 contextPageOrder 不同，禁止与基准结果混排。\n')

  const rows = await loadRows(args.limit, args.useCache)
  // 归一化不设 try：这与 datasets/qasper/fetch.ts 的规范路径逐字同义，若它对某篇抛错，
  // 规范取数本身也会抛——把它吞掉只会让探针在别的语料上静默地量错东西。
  const samples = rows.map(row => normalizeQasperEntry(row.id, toCanonicalEntry(row)))

  // ——— 硬门：保真校验必须先于任何指标 ———
  const fidelity = await assertFidelity(samples)
  console.log(`[保真校验通过] 比对论文 ${fidelity.papers} 篇 / 题目 ${fidelity.questions} 道，全部与冻结记录一致`)
  console.log('  冻结记录来源：bench/datasets/qasper/qasper.jsonl（2026-09-04 旧格式，直接解析；')
  console.log('                其缺 qualityAnswers，loadQasperDataset 的 Q 参考守卫不适用于本诊断链路）\n')

  // ——— 建树与逐题分类（与网格点无关，只做一次）———
  let attemptedQuestions = 0
  for (const sample of samples) attemptedQuestions += sample.questions.length

  const account: ProbeSkipAccount = {
    attemptedQuestions,
    skippedUnanswerable: 0,
    skippedUnmapped: 0,
    skippedEmptyEvidence: 0,
    buildFailurePapersByReason: {},
    buildFailureQuestionsByReason: {},
    traversalFailureByReason: {}, // 每次网格点单独统计，见下
  }

  interface Eligible {
    paperId: string
    question: string
    gold: number[]
    tree: ReturnType<typeof buildQasperTree>['tree']
  }
  const eligible: Eligible[] = []
  let builtPapers = 0
  for (const sample of samples) {
    // 归一化上游行必然产出 sectionNames / sectionPages；缺失即取数路径出错。
    // 绝不用 `?? []` 兜底：那会静默建出空树，而 traverseWithJudge 对空树立刻返回空选择、
    // 判定器一次都不被调用，脚本却照常 exit 0——正是本探针最该防的假绿。
    if (!sample.sectionNames || !sample.sectionPages) {
      throw new Error(`论文 ${sample.paperId} 缺少 sectionNames/sectionPages：节结构必须来自归一化的上游行`)
    }
    let tree: Eligible['tree']
    try {
      tree = buildQasperTree({ sectionNames: sample.sectionNames, sectionPages: sample.sectionPages }).tree
    } catch (error) {
      // 建树失败按原因计数并整篇跳过，绝不让单篇拖垮整轮
      const reason = failureReason(error)
      account.buildFailurePapersByReason[reason] = (account.buildFailurePapersByReason[reason] ?? 0) + 1
      account.buildFailureQuestionsByReason[reason] =
        (account.buildFailureQuestionsByReason[reason] ?? 0) + sample.questions.length
      continue
    }
    builtPapers += 1
    for (const question of sample.questions) {
      // 每题恰计一次，按第一个命中的原因归类（顺序即优先级）
      if (question.unanswerable) { account.skippedUnanswerable += 1; continue }
      if (question.evidenceMapping !== 'mapped') { account.skippedUnmapped += 1; continue }
      if (question.evidencePages.length === 0) { account.skippedEmptyEvidence += 1; continue }
      eligible.push({ paperId: sample.paperId, question: question.question, gold: question.evidencePages, tree })
    }
  }

  console.log(`论文 ${samples.length} 篇（成功建树 ${builtPapers}），可打分题目 ${eligible.length} 道`)
  printSkipAccounting(account)
  console.log()

  const judge = createMlxJudge()
  try {
    // 记忆化判定器**按篇**建树后逐篇替换：跨篇节点签名可能撞车，按篇隔离最省心
    const memosByPaper = new Map<string, EvidenceJudge>()
    const judgeFor = (paperId: string): EvidenceJudge => {
      let memo = memosByPaper.get(paperId)
      if (!memo) { memo = memoizeJudge(judge); memosByPaper.set(paperId, memo) }
      return memo
    }

    const tableRows: string[][] = []
    const startedAt = Date.now()
    for (const alpha of ALPHAS) {
      for (const topN of TOP_N) {
        const observations: ProbeObservation[] = []
        const traversalFailureByReason: Record<string, number> = {}
        for (const item of eligible) {
          try {
            const selection = await traverseWithJudge(item.tree, item.question, judgeFor(item.paperId), { alpha, topN })
            observations.push({
              // 选中节点的页并集去重升序：同一页可能被父子节点共同覆盖，只算一次
              selectedPages: [...new Set(selection.selected.flatMap(node => node.pages))].sort((a, b) => a - b),
              goldEvidencePages: item.gold,
              emptyContentSkipped: selection.emptyContentSkipped,
              emptySelectionFallback: selection.emptySelectionFallback,
            })
          } catch (error) {
            const reason = failureReason(error)
            traversalFailureByReason[reason] = (traversalFailureByReason[reason] ?? 0) + 1
          }
        }
        const summary = aggregateProbe(observations, {
          ...account,
          buildFailurePapersByReason: account.buildFailurePapersByReason,
          buildFailureQuestionsByReason: account.buildFailureQuestionsByReason,
          traversalFailureByReason,
        })
        tableRows.push(printSummaryRow(alpha, topN, summary))
      }
    }
    const elapsed = Date.now() - startedAt

    console.log('网格结果（判定器选择 vs 金标证据页）：')
    console.log(formatTable(
      ['alpha', 'topN', '已打分', 'anyHit', 'meanRecall', 'meanPrecision', '均选页', '空选中', '判定失败'],
      tableRows,
    ))
    console.log()
    console.log(`precision 口径：meanPrecision 的分母是「选中非空」的题（空选中被排除，不记 0）；`)
    console.log(`                空选中单独计入「空选中」列，并已计入 anyHit / recall 的分母。`)
    console.log(`网格说明：α≤1 是硬约束；α=0.5 处阈值一个都没滤掉（survivors===candidates），故不取。`)
    console.log(`          分数未校准（noul:2 温度 1.9834>1 压平 softmax），只信名次、不信绝对值。`)
    console.log(`遍历总墙钟耗时：${elapsed}ms`)
  } finally {
    // 必须关：侧车的 stdio 管道会让 Node 事件循环一直活着，脚本否则挂住不退出
    await judge.close()
  }
}

main().catch(error => { console.error(error); process.exit(1) })
