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
import { createPassageIndexHook, type HybridKnobs } from './passageIndexHook'
import { runQaTask } from './qa'
import { runFullContextQaTask } from './fullContextQa'
import { runColdFirstQuery } from './coldFirstQuery'
import { materializeContext, type ContextGroup } from '../../../src/utils/contextTrace'
import type { Embedder } from '../../../src/utils/embedder'
import type { StreamingLlmClient } from '../llmClient'
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
  now?: () => number
}

export interface ProductSweepResult {
  /** [structure-lexical, structure-hybrid-raw, structure-hybrid-outline, full-context(R)] */
  hot: BenchResult[]
  /** A/B/C × 2 条冷策略，共 6 条 */
  cold: ColdFirstQueryResult[]
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

  const knobsOf = (config: PaperMindConfig): HybridKnobs => ({
    minTokens: config.minTokens as number,
    maxTokens: config.maxTokens as number,
    maxInputChars: config.maxInputChars as number,
    rrfK: config.rrfK as number,
    sectionWeight: config.sectionWeight as number,
    neighbourFactor: config.neighbourFactor as number,
    skipLimit: config.skipLimit as number,
  })

  const createHook = (config: PaperMindConfig, mode: PassageMode, embedder: Embedder | undefined) =>
    createPassageIndexHook({
      knobs: knobsOf(config),
      client: args.client,
      embedder,
      countTokens,
      modelIdentity: args.model,
      mode,
      // C 臂的原生目录只在 outline-study 样本上存在；显式注入访问器，让 hook 不必窄化样本
      ...(mode === 'hybrid-outline'
        ? { outlineIndex: (sample: EvalSample) => isPdfStudySample(sample) ? sample.pdfOutline : undefined }
        : {}),
    })

  const hot: BenchResult[] = []
  for (const { paperConfig, mode } of armConfigs) {
    const knobs = knobsOf(paperConfig)
    // lexical 臂本就不加载嵌入器：注入 undefined 让 hook 兜底，也让检索侧不携带 dense 路
    const passageEmbedder = mode === 'lexical' ? undefined : args.embedder
    hot.push(await runQaTask({
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
    }))
  }

  // R：full-context 全文直投，用同一份 sample/question manifest，是 Q 的参考而不是检索选手
  hot.push(await runFullContextQaTask({
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
  }))

  const cold: ColdFirstQueryResult[] = []
  for (const { paperConfig, mode } of armConfigs) {
    const knobs = knobsOf(paperConfig)
    for (const strategy of COLD_STRATEGIES) {
      cold.push(await runColdFirstQuery({
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
      }))
    }
  }

  return { hot, cold }
}
