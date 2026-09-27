/**
 * 产品实验 sweep（Task 8）——一条命令跑 A/B/C/R 热速度 + 冷首问。
 *
 * 复用既有 runner 原语（`runQaTask` / `runFullContextQaTask` / `runColdFirstQuery` /
 * `createPassageIndexHook`）而不复制检索/回答逻辑：sweep 只负责「同批 3 篇 PDF 上、
 * 同一次契约下，把四个臂 + 两条冷策略按顺序串起来」，并让所有注入点显式化，
 * 使 CLI 与单测用同一份接线、测试用假 embedder / 假流式客户端即可端到端驱动。
 *
 * A/B/C 共享同一 PDF 页文本、切段参数、4096 token 上下文预算与流式回答客户端；
 * C 的目录缺失/非法按 B 的 bm25+dense 回落，且**留在全 PDF 分母**（由 runQaTask 的
 * 逐篇目录诊断保证）。R 用 full-context 模式跑同一份 sample/question manifest。
 */
import { loadConfigs, resolvePassageMode } from '../config'
import { buildEvaluationContract, composeBaseSystemPrompt } from '../evaluationContract'
import { benchPath } from '../paths'
import { createPassageIndexHook, type HybridKnobs, type PassageIndexHook } from './passageIndexHook'
import { runQaTask } from './qa'
import { runFullContextQaTask } from './fullContextQa'
import { runColdFirstQuery } from './coldFirstQuery'
import { materializeContext, type ContextGroup } from '../../../src/utils/contextTrace'
import type { Embedder } from '../../../src/utils/embedder'
import type { LlmClient, StreamingLlmClient } from '../llmClient'
import { readQSource } from '../scoring/qArtifacts'
import type { QConfig } from '../scoring/qScore'
import { renderProductReport } from '../report'
import type { SpeedRunContract } from '../speed/contract'
import type { SpeedRunnerOptions } from '../speed/generate'
import type {
  BenchResult,
  ColdFirstQueryResult,
  ColdStrategy,
  EvalSample,
  PaperMindConfig,
  PassageMode,
  PdfStudySample,
} from '../types'
import { isPdfStudySample } from '../types'

/** 产品实验的三个固定臂配置（Task 4 交付物）。 */
const SWEEP_CONFIG_NAMES = ['structure-lexical', 'structure-hybrid-raw', 'structure-hybrid-outline'] as const

const COLD_STRATEGIES: readonly ColdStrategy[] = ['ready-before-query', 'ask-at-lexical-ready']

export interface ProductSweepArgs {
  samples: PdfStudySample[]
  /** 与 runQaTask / buildEvaluationContract 的 limit 同一语义：热臂切片上限；冷首问始终逐篇取首题。 */
  limit?: number
  gitSha: string
  model: string
  systemPrompt: string
  answerLanguageInstruction?: string
  /** 契约 tokenizer：materialize 与段落 hook 的计数同源（1 词 1 token 的确定性替身可替代 BGE-M3）。 */
  tokenizer: { tokenize(text: string): string[] }
  contextBudgetTokens: number
  /** 流式回答客户端；A/B/C 索引阶段零生成式 LLM 调用，故 `complete` 全程不应被调用。 */
  client: StreamingLlmClient
  /** B/C 共用的段落 embedder；lexical 臂不使用（undefined 时 B/C 会按 embedder-unavailable 降级）。 */
  embedder: Embedder | undefined
  /** 本次运行的 query-timeline-v2 契约；datasetFingerprint 必须与 samples 的评测契约一致。 */
  speedContract: SpeedRunContract
  /** 冷首问在 t0 之后重新打开原始 PDF 字节并抽取页文本。 */
  readPdf: (sample: PdfStudySample) => Promise<string[]>
  /**
   * 每完成一臂即回调（Issue 1）：CLI 借此**逐臂落盘**，某臂抛错（TimingInvariantViolation /
   * assertContextPageDenominator / 「论文没有切出任何段落」）时已完成的臂照常保留，不再整批丢弃。
   * runner 自身**不写文件**——落盘是 CLI 的职责。
   */
  onHot?: (result: BenchResult) => void
  onCold?: (result: ColdFirstQueryResult) => void
  now?: () => number
}

export interface ProductSweepResult {
  /** [structure-lexical, structure-hybrid-raw, structure-hybrid-outline, full-context(R)] */
  hot: BenchResult[]
  /** A/B/C × 2 条冷策略，共 6 条 */
  cold: ColdFirstQueryResult[]
}

/**
 * 段落索引的配置旋钮提取（Issue 6）：主循环、冷首问、产品 sweep 三处此前各抄一份——
 * 任一旋钮漏写，多次运行就会产出「自称不同口径、实则同一份数字」的结果。
 */
export function hybridKnobsOf(config: PaperMindConfig): HybridKnobs {
  return {
    minTokens: config.minTokens as number,
    maxTokens: config.maxTokens as number,
    maxInputChars: config.maxInputChars as number,
    rrfK: config.rrfK as number,
    sectionWeight: config.sectionWeight as number,
    neighbourFactor: config.neighbourFactor as number,
    skipLimit: config.skipLimit as number,
  }
}

export interface ProductPassageHookArgs {
  config: PaperMindConfig
  mode: PassageMode
  /** 加载失败时为 undefined：本篇/本轮降级为 bm25*，由调用方标为不参与正式对照。 */
  embedder: Embedder | undefined
  client: LlmClient
  countTokens: (text: string) => number
  /** 卡片指纹里的模型身份；`LlmClient` 无 identity 方法，故显式传入 `env.model`。 */
  modelIdentity: string
}

/**
 * 段落索引 hook 的唯一装配点（Issue 6）：三处调用点共用同一份 knobs 与 outlineIndex 访问器，
 * `outlineIndex`（C 臂的原生目录来源）只在此处拼装一次，不会被某处漏写而静默退化。
 */
export function createProductPassageHook(args: ProductPassageHookArgs): PassageIndexHook {
  const { config, mode } = args
  return createPassageIndexHook({
    knobs: hybridKnobsOf(config),
    client: args.client,
    embedder: args.embedder,
    countTokens: args.countTokens,
    modelIdentity: args.modelIdentity,
    mode,
    // C 臂的原生目录只在 outline-study 样本上存在；显式注入访问器，让 hook 不必窄化样本
    ...(mode === 'hybrid-outline'
      ? { outlineIndex: (sample: EvalSample) => isPdfStudySample(sample) ? sample.pdfOutline : undefined }
      : {}),
  })
}

/**
 * harness 故障判定（与 CLI 主路径同一口径）：有任何一份结果 `total>0` 却 `completed===0`
 * （典型为 API key 配错）即整轮无效。单样本失败是正常数据点，不算 harness 故障。
 */
export function hasHarnessFailure(results: BenchResult[]): boolean {
  return results.some(result => result.meta.total > 0 && result.meta.completed === 0)
}

/** sweep 结果的 meta 定格（Issue 2）：跳过读缓存；非 full-context 一律标 rag。 */
export function applySweepResultMeta(result: BenchResult): void {
  result.meta.cacheMode = 'bypass'
  if (result.meta.mode !== 'full-context') result.meta.mode = 'rag'
}

/**
 * sweep 收尾（Issue 2）：把逐臂结果口径定格，读两份 Q 配置，再装配三张产品表。
 * **不写文件**——落盘仍由 CLI 负责；这里只做可变与装配，故可单测（注入 `qConfigs` 避开磁盘）。
 */
export function finalizeProductSweep(
  hot: BenchResult[],
  cold: ColdFirstQueryResult[],
  qConfigs: { qDefault: QConfig; qSpeed: QConfig } = readProductQConfigs(),
): { hot: BenchResult[]; report: string } {
  for (const result of hot) applySweepResultMeta(result)
  return { hot, report: renderProductReport(hot, cold, qConfigs.qDefault, qConfigs.qSpeed) }
}

/** 读两份冻结 Q 配置（全文参考 / 速度优先）；路径相对本模块，与 CLI 落盘位置无关。 */
function readProductQConfigs(): { qDefault: QConfig; qSpeed: QConfig } {
  return {
    qDefault: readQSource(benchPath(import.meta.url, '../../configs/scoring/q-score.json')).data as QConfig,
    qSpeed: readQSource(benchPath(import.meta.url, '../../configs/scoring/q-speed-first.json')).data as QConfig,
  }
}

export async function runProductSweep(args: ProductSweepArgs): Promise<ProductSweepResult> {
  const now = args.now ?? Date.now
  const { samples } = args
  const answerSystemPrompt = composeBaseSystemPrompt(args.systemPrompt, args.answerLanguageInstruction)
  const materialize = (groups: ContextGroup[]) =>
    materializeContext(groups, args.tokenizer, args.contextBudgetTokens)
  const countTokens = (text: string) => args.tokenizer.tokenize(text).length
  const evaluationContract = buildEvaluationContract(samples, args.limit)
  const speed: SpeedRunnerOptions = { contract: args.speedContract, now }

  const armConfigs = await Promise.all(
    SWEEP_CONFIG_NAMES.map(async name => {
      const configs = await loadConfigs(name)
      if (configs.length !== 1) {
        throw new Error(`sweep 期望单臂配置，${name} 展开为 ${configs.length} 臂`)
      }
      return { paperConfig: configs[0] as PaperMindConfig, mode: resolvePassageMode(configs[0] as PaperMindConfig) }
    }),
  )

  // CLI 从 structure-hybrid-raw pin 出 B/C 共用的 embedder；sweep 假定 C 臂 pin 的是同一份。
  // 两者一旦不同，pin 的 embedder 就不属于 C 臂配置身份，整份对照失效——此处显式拦住。
  const embedderOf = (name: string) =>
    armConfigs.find(a => a.paperConfig.name === name)?.paperConfig.passage?.embedder
  const rawEmbedder = embedderOf('structure-hybrid-raw')
  const outlineEmbedder = embedderOf('structure-hybrid-outline')
  const sameEmbedder = (a: typeof rawEmbedder, b: typeof rawEmbedder): boolean =>
    a === undefined || b === undefined
      ? a === b
      : a.model === b.model && a.revision === b.revision && a.dtype === b.dtype && a.dim === b.dim
  if (!sameEmbedder(rawEmbedder, outlineEmbedder)) {
    throw new Error('sweep 假定 structure-hybrid-outline 与 structure-hybrid-raw pin 同一 embedder，实际不同')
  }

  const createHook = (config: PaperMindConfig, mode: PassageMode, embedder: Embedder | undefined) =>
    createProductPassageHook({
      config,
      mode,
      embedder,
      client: args.client,
      countTokens,
      modelIdentity: args.model,
    })

  const hot: BenchResult[] = []
  for (const { paperConfig, mode } of armConfigs) {
    const knobs = hybridKnobsOf(paperConfig)
    // lexical 臂本就不加载嵌入器：注入 undefined 让 hook 兜底，也让检索侧不携带 dense 路
    const passageEmbedder = mode === 'lexical' ? undefined : args.embedder
    const result = await runQaTask({
      samples,
      config: paperConfig,
      client: args.client,
      systemPrompt: args.systemPrompt,
      answerLanguageInstruction: args.answerLanguageInstruction,
      limit: args.limit,
      gitSha: args.gitSha,
      model: args.model,
      now,
      materialize,
      evaluationContract,
      passage: {
        hook: createHook(paperConfig, mode, passageEmbedder),
        embedder: passageEmbedder,
        countTokens,
        contextBudgetTokens: args.contextBudgetTokens,
        rrfK: knobs.rrfK,
        sectionWeight: knobs.sectionWeight,
        neighbourFactor: knobs.neighbourFactor,
        skipLimit: knobs.skipLimit,
        embedderUnavailable: mode !== 'lexical' && passageEmbedder === undefined,
      },
      speed,
    })
    hot.push(result)
    args.onHot?.(result)
  }

  // R：full-context 全文直投，用同一份 sample/question manifest，是 Q 的参考而不是检索选手
  const reference = await runFullContextQaTask({
    samples,
    config: { name: 'full-context', kind: 'papermind' },
    client: args.client,
    systemPrompt: args.systemPrompt,
    answerLanguageInstruction: args.answerLanguageInstruction,
    limit: args.limit,
    gitSha: args.gitSha,
    model: args.model,
    now,
    speed,
  })
  hot.push(reference)
  args.onHot?.(reference)

  const cold: ColdFirstQueryResult[] = []
  for (const { paperConfig, mode } of armConfigs) {
    const knobs = hybridKnobsOf(paperConfig)
    for (const strategy of COLD_STRATEGIES) {
      const coldResult = await runColdFirstQuery({
        samples,
        mode,
        strategy,
        client: args.client,
        systemPrompt: answerSystemPrompt,
        materialize,
        readPdf: args.readPdf,
        initLocalModel: async () => (mode === 'lexical' ? undefined : args.embedder),
        createHook: embedder => createHook(paperConfig, mode, embedder),
        countTokens,
        contextBudgetTokens: args.contextBudgetTokens,
        rrfK: knobs.rrfK,
        sectionWeight: knobs.sectionWeight,
        neighbourFactor: knobs.neighbourFactor,
        skipLimit: knobs.skipLimit,
        now,
      })
      cold.push(coldResult)
      args.onCold?.(coldResult)
    }
  }

  return { hot, cold }
}
