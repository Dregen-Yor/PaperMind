/**
 * Benchmark CLI——所有模块的最终汇合点：
 * 参数解析 → 配置加载 → 数据集加载 → QA/摘要 Runner → 结果落盘 → 报表渲染。
 * 通过 `npm run bench -- <args>` 执行（tsx 直跑 ESM）。
 * `--compare` 是独立路径：只读两份结果文件输出差异表，不跑评测。
 */
import { execSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, accessSync, constants } from 'node:fs'
import { join, dirname } from 'node:path'
import { parseArgs, fileStamp } from './args'
import { loadConfigs, configLabel } from './config'
import { createLlmClient, resolveEnvConfig } from './llmClient'
import { loadQasperDataset } from './datasets/qasper'
import { loadSmokeDataset } from './datasets/smoke'
import { runQaTask, DEFAULT_SYSTEM_PROMPT, type QaTaskArgs } from './runner/qa'
import { runFullContextQaTask } from './runner/fullContextQa'
import { runTraditionalRagQaTask } from './runner/traditionalRagQa'
import { runHybridRerankQaTask } from './runner/hybridRerankQa'
import { runLongSectionQaTask } from './runner/longSectionQa'
import { runSemanticTreeQaTask } from './runner/semanticTreeQa'
import { runSummaryTask } from './runner/summary'
import { renderReport, renderComparison } from './report'
import { benchPath } from './paths'
import type { BenchResult, BenchConfig, EvalSample, SampleSource } from './types'
import type { PaperMindConfig } from './types'
import type { LlmClient } from './llmClient'
import type { StrongBaselineQaArgs, StrongGenerationSettings } from './runner/strongBaselineQa'
import { materializeContext, type ContextGroup } from '../../src/utils/contextTrace'
import { MATH_FORMAT_INSTRUCTION } from '../../src/utils/ragPipeline'
import {
  buildEvaluationContract,
  composeBaseSystemPrompt,
  llmEndpointIdentity,
  systemPromptHash,
  CONTEXT_BUDGET_TOKENS,
  CONTEXT_TOKENIZER_MODEL,
  CONTEXT_TOKENIZER_REVISION,
} from './evaluationContract'
import { createBgeM3Tokenizer } from './traditionalRag/embedding'
import { retrievalTokenizerIdentity } from './config'

// 必须用 benchPath（fileURLToPath），不能用 new URL(...).pathname——
// 后者保留百分号转义，路径含空格/中文时得到字面量 %20 目录，写文件静默失败
const RESULTS_DIR = () => benchPath(import.meta.url, '../results/')
// 与各 runner 内部的 modelCacheDir() 指向同一目录（bench/cache/models/）：
// 受控物化器与检索侧加载的是同一份 BGE-M3 词表
const MODEL_CACHE_DIR = () => benchPath(import.meta.url, '../cache/models/')

/** QASPER 参考答案是英文而生产 prompt 是中文，不强制英文作答则 answerF1 恒≈0（Task 10 裁定 3） */
const QASPER_LANGUAGE_INSTRUCTION = '请依据参考内容，用论文原文语言（英文）作答。'
const FULL_CONTEXT_LIMITS = { timeoutMs: 120_000, maxTokens: 4096 } as const
const QA_REQUEST_TIMEOUT_MS = 120_000
// 可恢复错误有限重试，避免单题在 429/5xx/断网时永久占住整轮。失败题由 runner 记录，
// 强基线可凭逐题 checkpoint 重启续跑。环境变量便于跑批按端点稳定性收紧超时与次数。
function nonNegativeIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} 必须是非负整数，收到：${raw}`)
  return value
}

function positiveIntEnv(name: string, fallback: number): number {
  const value = nonNegativeIntEnv(name, fallback)
  if (value <= 0) throw new Error(`${name} 必须是正整数，收到：${value}`)
  return value
}

const QA_RETRY_ATTEMPTS = nonNegativeIntEnv('BENCH_QA_RETRY_ATTEMPTS', 3)
const EFFECTIVE_QA_REQUEST_TIMEOUT_MS = positiveIntEnv('BENCH_QA_REQUEST_TIMEOUT_MS', QA_REQUEST_TIMEOUT_MS)
const retryLog = (event: { attempt: number; retryAttempts: number; delayMs: number; error: string }) => {
  process.stderr.write(
    `[LLM 重试 ${event.attempt}/${event.retryAttempts}] ${event.error}; ` +
    `${Math.ceil(event.delayMs / 1000)} 秒后重试\n`,
  )
}

function gitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim()
  } catch {
    return 'unknown'
  }
}

async function loadDatasets(which: string): Promise<EvalSample[]> {
  const out: EvalSample[] = []
  if (which === 'qasper' || which === 'all') out.push(...await loadQasperDataset())
  if (which === 'smoke' || which === 'all') out.push(...await loadSmokeDataset())
  if (out.length === 0) {
    throw new Error(
      `数据集为空（--dataset ${which}）。QASPER 需先运行 ` +
      `npx tsx bench/datasets/qasper/fetch.ts；冒烟集见 bench/datasets/smoke/README.md`,
    )
  }
  return out
}

/** 按数据来源分组，保持原有出现顺序。 */
function groupBySource(samples: EvalSample[]): Array<[SampleSource, EvalSample[]]> {
  const map = new Map<SampleSource, EvalSample[]>()
  for (const s of samples) {
    const group = map.get(s.source) ?? []
    group.push(s)
    map.set(s.source, group)
  }
  return [...map.entries()]
}

const args = parseArgs(process.argv.slice(2))

// --compare 是独立路径：只读两份结果输出差异表，不跑评测
if (args.compare) {
  const [pathA, pathB] = args.compare
  // readFileSync / JSON.parse 裸抛英文 stack 难以定位，转成中文报错并保留原始原因
  const load = (p: string): BenchResult => {
    let raw: string
    try {
      raw = readFileSync(p, 'utf-8')
    } catch (err) {
      throw new Error(`结果文件不存在：${p}（原始错误：${err instanceof Error ? err.message : err}）`)
    }
    try {
      return JSON.parse(raw) as BenchResult
    } catch (err) {
      throw new Error(`结果文件不是合法 JSON：${p}（原始错误：${err instanceof Error ? err.message : err}）`)
    }
  }
  const a = load(pathA)
  const b = load(pathB)
  process.stdout.write(renderComparison(a, b))
  process.exit(0)
}

// --judge 的前置校验：judge 模型名必须显式给出，judge 客户端按配置矩阵逐组创建
if (args.judge && !process.env.BENCH_JUDGE_MODEL) {
  throw new Error('使用 --judge 需设置环境变量 BENCH_JUDGE_MODEL（judge 用的 LLM 模型名）')
}
const judgeModel = process.env.BENCH_JUDGE_MODEL

const sha = gitSha()
const configs = await loadConfigs(args.config)
// 不支持的组合必须在加载数据、发任何 LLM 请求或写结果前失败。
// 新基线（hybrid-rerank / long-section-rag）是 QA 专有对照组，同样不支持摘要。
if ((args.task === 'summary' || args.task === 'all') && configs.some(config => config.kind !== 'papermind')) {
  throw new Error('summary task 只接受 PaperMind 配置')
}
// full-context 模式绕过检索配置，只对 PaperMind 管线有意义；检索型基线（传统 RAG
// 与强基线）在 full-context 下跑出的数字与自身配置无关，必须拒绝而非静默跑错对象
if (args.mode === 'full-context' && configs.some(config => config.kind !== 'papermind')) {
  throw new Error('--mode full-context 只接受 PaperMind 配置；检索型基线请直接用对应 --config')
}
const samples = await loadDatasets(args.dataset)
mkdirSync(RESULTS_DIR(), { recursive: true })

// 缓存目录在 createLlmClient 内部决定（bench/cache/），CLI 层打印解析结果并检查可写性，
// 不阻塞——缓存只是加速手段，写失败会在 llmClient 内以警告形式降级
const cacheDir = benchPath(import.meta.url, '../cache/')
try {
  accessSync(dirname(cacheDir), constants.W_OK)
} catch {
  process.stdout.write(`警告：缓存目录父目录不可写（${dirname(cacheDir)}），缓存将无法写入\n`)
}
process.stdout.write(`缓存目录：${cacheDir}\n`)

process.stdout.write(
  `配置 ${configs.length} 组，样本 ${samples.length} 篇论文，代码版本 ${sha}\n`,
)

const qaResults: BenchResult[] = []
const summaryResults: BenchResult[] = []

/**
 * 四个 RAG runner（papermind / semantic-tree / traditional / 强基线）共有的受控口径字段。
 * 以 QaTaskArgs 为准取字段：其余三个引擎的同名字段类型若与之分叉，传入处即编译报错。
 */
type ControlledQaArgs = Pick<QaTaskArgs, 'materialize' | 'evaluationContract'>

/** 只有强基线声明这两个：它们只进逐题断点签名，其他 runner 没有断点概念。 */
type StrongIdentityArgs = Pick<StrongBaselineQaArgs, 'llmEndpointIdentity' | 'systemPromptHash'>

/**
 * 每个 runner 的入参在各自的分支里就地构造，共享字段经由下面这组**显式类型**的中间对象传递。
 * 从前那套「构造一个 taskArgs 再 spread 给全部 runner」的写法会绕过 TypeScript 的多余属性
 * 检查（excess property check 不作用于 spread），本 runner 不认的字段被静默吞掉——
 * 受控物化器与评测契约就曾被 `runFullContextQaTask` 无声忽略。
 *
 * 只把字段列清楚还不够：单靠一个 interface，日后有人加上 `llmEndpointIdentity?: string`
 * 就又能把它打进 common 再 spread 给不认识它的 runner，静默吞字段的洞原样复现。
 * 故用映射类型把两个专有类型的键**按构造**声明为 never：往专有类型里加字段即自动在此禁用，
 * 想往 common 里塞专有字段会被多余属性检查当场拦下，不必在调用点维护任何禁用清单。
 */
type CommonQaArgs = {
  samples: EvalSample[]
  client: LlmClient
  systemPrompt: string
  answerLanguageInstruction?: string
  limit?: number
  gitSha: string
  model: string
  judgeClient?: LlmClient
  judgeModel?: string
} & { [K in keyof ControlledQaArgs | keyof StrongIdentityArgs]?: never }

/**
 * 生成侧固定设置：随断点签名落盘，改动会让旧断点失效。
 * RAG 模式**不设生成上限**（客户端拿到的是未设 maxTokens 的默认行为），故这里只冻结请求超时。
 * 若将来 RAG 真的加了生成上限，必须把该值一并接进这个对象——它是签名的一部分，
 * 只改调用点而漏了这里，就会导致「换了生成上限却复用旧断点」。
 */
const RAG_GENERATION_SETTINGS: StrongGenerationSettings = { requestTimeoutMs: EFFECTIVE_QA_REQUEST_TIMEOUT_MS }

/** 强基线逐题进度；processed 含成功与失败题，与前缀语义一致。 */
type StrongProgressEvent = Parameters<NonNullable<StrongBaselineQaArgs['onProgress']>>[0]
const strongProgress = (config: BenchConfig) => (event: StrongProgressEvent) =>
  process.stdout.write(
    `[进度] ${config.name} ${event.processed}/${event.total}；` +
    `成功 ${event.completed}，本轮失败 ${event.errors}；${event.status} ${event.sampleId}\n`,
  )

/**
 * 结果文件名。--dataset all 时 QA 结果按来源分组各写一份，带 source 后缀防混淆；
 * --out 显式指定时追加后缀（同名会互相覆盖），单一来源时不加后缀保持简报语义。
 * 多配置矩阵（--config 展开多个配置）+ --out 时 fileTag 只含 source 不含配置标识，
 * 每个配置会写出同名文件、后写的覆盖先写的，评测数据静默丢失——
 * 故 configs.length > 1 时强制在文件名中拼上配置标签。
 */
function writeResult(result: BenchResult, fileTag = '') {
  const stamp = fileStamp(result.meta.timestamp)
  let path: string
  if (args.out) {
    const configTag = configs.length > 1 ? configLabel(result.config) : ''
    const tag = [configTag, fileTag].filter(Boolean).join('-')
    path = tag ? args.out.replace(/\.json$/i, '') + `-${tag}.json` : args.out
  } else {
    const tag = fileTag ? `-${fileTag}` : ''
    path = join(RESULTS_DIR(), `${result.task}${tag}-${configLabel(result.config)}-${stamp}.json`)
  }
  writeFileSync(path, JSON.stringify(result, null, 2))
  process.stdout.write(`  结果已写入 ${path}\n`)
}

for (const config of configs) {
  if (args.task === 'qa' || args.task === 'all') {
    // answerLanguageInstruction 是 runQaTask 的整轮级参数，--dataset all 混合两种来源
    // 时无法一次传入，故按 source 分组各跑一次、结果分别落盘（文件名带 source 后缀）
    for (const [source, group] of groupBySource(samples)) {
      const env = resolveEnvConfig(process.env)
      // 全文直投模式不截断论文；为避免上游长上下文请求永久卡死，单题请求 120 秒后中止并由 runner 记为失败后继续。
      // 生成最多 4,096 tokens，防止推理模型在极简单的 QA 上无限延长隐藏推理；此限制不影响输入论文全文。
      const client = createLlmClient({
        ...env,
        useCache: args.useCache,
        timeoutMs: args.mode === 'full-context' ? FULL_CONTEXT_LIMITS.timeoutMs : EFFECTIVE_QA_REQUEST_TIMEOUT_MS,
        retryAttempts: QA_RETRY_ATTEMPTS,
        onRetry: retryLog,
        ...(args.mode === 'full-context' ? { maxTokens: FULL_CONTEXT_LIMITS.maxTokens } : {}),
      })
      // judge 只换模型，凭据与端点沿用主配置；缓存与主 client 共目录但 key 含模型名，互不污染
      const judgeClient = args.judge
        ? createLlmClient({ ...env, model: judgeModel!, useCache: args.useCache, timeoutMs: args.mode === 'full-context' ? FULL_CONTEXT_LIMITS.timeoutMs : EFFECTIVE_QA_REQUEST_TIMEOUT_MS, retryAttempts: QA_RETRY_ATTEMPTS, onRetry: retryLog, ...(args.mode === 'full-context' ? { maxTokens: FULL_CONTEXT_LIMITS.maxTokens } : {}) })
        : undefined

      process.stdout.write(`\n[QA] ${config.name}（${source}，${group.length} 篇）...\n`)
      const promptLanguage = source === 'qasper' ? QASPER_LANGUAGE_INSTRUCTION : undefined
      const common: CommonQaArgs = {
        samples: group,
        client,
        systemPrompt: DEFAULT_SYSTEM_PROMPT,
        ...(promptLanguage ? { answerLanguageInstruction: promptLanguage } : {}),
        limit: args.limit,
        gitSha: sha,
        model: env.model,
        judgeClient,
        judgeModel: args.judge ? judgeModel : undefined,
      }

      let result: BenchResult
      if (args.mode === 'full-context') {
        // 全文直投不参与受控检索：本分支一次 BGE-M3 加载都不会发生（tokenizer 只在 RAG 分支创建），
        // 结果也不携带任何检索契约身份——它只是回答模型的上限参照，不是参赛者（§5）
        result = await runFullContextQaTask({ ...common, config })
      } else {
        // 受控上下文预算（§5）：所有 RAG runner 共用同一份 BGE-M3 tokenizer 与 4096 token 预算，
        // 页序与 token 数才落在同一坐标上。工厂内部按 model/revision 记忆化词表，
        // 「每个 QA 来源一组一份」在配置矩阵循环里仍然成立，不会逐个配置重新加载词表。
        const contractTokenizer = await createBgeM3Tokenizer({
          model: CONTEXT_TOKENIZER_MODEL,
          revision: CONTEXT_TOKENIZER_REVISION,
          cacheDir: MODEL_CACHE_DIR(),
        })
        const materialize = (groups: ContextGroup[]) =>
          materializeContext(groups, contractTokenizer, CONTEXT_BUDGET_TOKENS)
        // 检索路径自带的那份 BGE-M3 与契约同源时才把这一份注入 deps：分块与受控物化共用同一实例，
        // 词表不重复加载。配置 pin 了别的 model/revision 时**绝不注入**——那份实例不属于契约身份，
        // 拿它物化会让结果 meta 断言一份本次运行并未真正使用的 tokenizer（差值照样算得出来，只是不可信）
        const identity = retrievalTokenizerIdentity(config)
        const tokenizerDeps = identity.model === CONTEXT_TOKENIZER_MODEL && identity.revision === CONTEXT_TOKENIZER_REVISION
          ? { tokenizer: contractTokenizer }
          : undefined
        const controlled: ControlledQaArgs = {
          // 契约的 tokenizer/budget 身份取自契约本身，不在这里改写：占位口径那种「身份写着 A、
          // 实际用着 B」的账，正是 Task 10 的比较门禁要挡的东西
          evaluationContract: buildEvaluationContract(group, args.limit),
          materialize,
        }
        // 端点身份只由 provider + 规范化 base URL 决定（函数签名里没有 key 的位置）；
        // 生效 prompt 指纹取自 runner 真正使用的那一份拼装（语言指令 + 固定数学格式约束）。
        // 基座刻意取 common.systemPrompt 而不是再写一遍 DEFAULT_SYSTEM_PROMPT：两处字面量
        // 只要有一天改动其一，指纹就会哈希一段模型从未见过的文本，旧断点照旧复用
        const strongIdentity: StrongIdentityArgs = {
          llmEndpointIdentity: llmEndpointIdentity(env.provider, env.baseUrl),
          systemPromptHash: systemPromptHash(`${composeBaseSystemPrompt(common.systemPrompt, promptLanguage)}\n\n${MATH_FORMAT_INSTRUCTION}`),
        }
        if (config.kind === 'traditional-rag') {
          result = await runTraditionalRagQaTask({
            ...common, ...controlled, config,
            ...(tokenizerDeps ? { deps: tokenizerDeps } : {}),
          })
        } else if (config.kind === 'hybrid-rerank') {
          result = await runHybridRerankQaTask({
            ...common, ...controlled, ...strongIdentity, config,
            ...(tokenizerDeps ? { deps: tokenizerDeps } : {}),
            generationSettings: RAG_GENERATION_SETTINGS,
            checkpointPath: join(cacheDir, `checkpoint-${source}-${configLabel(config)}.json`),
            onProgress: strongProgress(config),
          })
        } else if (config.kind === 'long-section-rag') {
          result = await runLongSectionQaTask({
            ...common, ...controlled, ...strongIdentity, config,
            ...(tokenizerDeps ? { deps: tokenizerDeps } : {}),
            generationSettings: RAG_GENERATION_SETTINGS,
            checkpointPath: join(cacheDir, `checkpoint-${source}-${configLabel(config)}.json`),
            onProgress: strongProgress(config),
          })
        } else if (config.kind === 'semantic-tree') {
          result = await runSemanticTreeQaTask({ ...common, ...controlled, config })
        } else {
          result = await runQaTask({ ...common, ...controlled, config })
        }
        // 显式资格声明：受控预算下产出的四个检索指标可进入横向比较。
        // full-context 分支由它自己的 runner 写 false + 原因，这里不覆盖也不代填
        result.meta.comparisonEligible = true
      }
      // --no-cache 当前只跳过读缓存，不覆写已有缓存文件（llmClient 待后续优化），如实记录口径
      result.meta.cacheMode = args.useCache ? 'normal' : 'bypass'
      result.meta.mode = args.mode
      if (args.mode === 'full-context') {
        result.meta.requestTimeoutMs = FULL_CONTEXT_LIMITS.timeoutMs
        result.meta.generationMaxTokens = FULL_CONTEXT_LIMITS.maxTokens
      }
      // 缓存计数来自主 RAG client（meta.cacheHits/cacheMisses 在 runQaTask 内统计），
      // 不含 judgeClient——启用 --judge 时明确标注，避免被误读为整轮全部 LLM 流量
      if (args.judge) result.meta.cacheScope = 'rag'

      const { hits, misses } = client.stats()
      process.stdout.write(
        `  完成 ${result.meta.completed}/${result.meta.total}，` +
        `缓存命中 ${hits}/${hits + misses}，失败 ${result.errors.length}\n`,
      )
      qaResults.push(result)
      writeResult(result, args.dataset === 'all' ? source : '')
    }
  }

  if (args.task === 'summary' || args.task === 'all') {
    // 已在循环前拒绝 traditional-rag；此处收窄仅供 TypeScript 表达该不变量。
    const paperConfig = config as PaperMindConfig
    process.stdout.write(`\n[摘要] ${config.name}...\n`)
    const result = await runSummaryTask({
      samples,
      config: paperConfig,
      hfToken: process.env.HF_TOKEN ?? '',
      limit: args.limit,
      gitSha: sha,
      model: process.env.HF_MODEL ?? 'Bashaarat1/t5-small-arxiv-summarizer',
    })
    // summary 走 HuggingFace 摘要模型，不经过 LLM 缓存，cacheMode 仅与其他任务的
    // 结果结构保持口径统一，--no-cache 对 summary 无实际作用
    result.meta.cacheMode = args.useCache ? 'normal' : 'bypass'
    process.stdout.write(
      `  完成 ${result.meta.completed}/${result.meta.total}，失败 ${result.errors.length}\n`,
    )
    summaryResults.push(result)
    writeResult(result)
  }
}

process.stdout.write('\n')
if (qaResults.length > 0) process.stdout.write(renderReport(qaResults) + '\n')
if (summaryResults.length > 0) process.stdout.write(renderReport(summaryResults) + '\n')

// 退出码语义：单样本失败是正常数据点（errors 记录后继续，exit 0）；
// 整轮零完成（completed === 0 且 total > 0，典型为 API key 配错）是 harness 故障，
// 报表照常输出后以 exit 1 告知 CI/脚本「跑完了但整轮无效」。
// 多配置时任一配置 completed=0 即视为整轮失败；--compare 路径始终 exit 0。
const allResults = [...qaResults, ...summaryResults]
if (allResults.some((r) => r.meta.total > 0 && r.meta.completed === 0)) {
  process.exit(1)
}
