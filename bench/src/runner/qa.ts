/**
 * QA 任务 Runner——整个评测的中枢编排：
 * 加载数据（由调用方完成）→ 建索引 → 分阶段跑生产 RAG 管线 → 计算检索/答案指标 → 聚合。
 * 复用 src/utils/ 的生产实现（buildPageIndex / retrieveRagContext / generateRagAnswer），
 * 评测与应用跑同一份代码，这是 benchmark 有效性的前提。
 *
 * 检索与生成是两个独立阶段：检索产物先落盘（页序指标与诊断），生成即便失败也不丢检索指标（§6.2 / §6.3）。
 */
import { buildPageIndex, collectLeafNodes, type IndexNode, type IndexOptions } from '../../../src/utils/pageIndex'
import {
  generateRagAnswer,
  retrieveRagContext,
  type RagGenerationStage,
  type RagOptions,
  type RagRetrievalStage,
} from '../../../src/utils/ragPipeline'
import type { ContextGroup, MaterializedContext } from '../../../src/utils/contextTrace'
import type { Embedder } from '../../../src/utils/embedder'
import type { TokenCounter } from '../../../src/utils/passages'
import type { SemanticTreeHook } from '../metrics/treeDiagnostics'
import { summarizeTreeDiagnostics, treeRecordFields } from '../metrics/treeDiagnostics'
import { summarizeColdStart } from '../metrics/passageDiagnostics'
import type { PassageIndexHook, PassageIndexInfo } from './passageIndexHook'
import type {
  PaperMindConfig,
  BenchResult,
  EvalSample,
  PaperTimingRecord,
  PerSampleRecord,
  PipelineTiming,
  QaQuestion,
  QueryTimeline,
  SampleError,
} from '../types'
import type { LlmClient, StreamingLlmClient } from '../llmClient'
import { applyRetrievalMetrics, estimateTokens, expandPages } from '../metrics/retrieval'
import { executedQuestions, isRetrievalEligible, type EvaluationContract } from '../evaluationContract'
import { REFUSAL_PATTERN_VERSION } from '../metrics/answerF1'
import { judgeSample, type JudgeSampleState } from '../metrics/judge'
import { generateSpeedAnswer, type SpeedRunnerOptions } from '../speed/generate'
import { startQueryTimeline } from '../speed/queryTimeline'
import { assertSpeedAnswerClient } from '../speed/policy'
import { errorMessage, finalizeQaResult, newSampleRecord, recordIndexFailure, skipSampleRecord } from './support'

/** 与 src/stores/chat.ts 的 DEFAULT_PROFILE.systemPrompt 保持一致的字面值。 */
export const DEFAULT_SYSTEM_PROMPT =
  '你是一个专业的学术论文阅读助手，帮助用户理解和分析论文内容。'

export interface QaTaskDeps {
  buildIndex?: typeof buildPageIndex
  retrieveContext?: typeof retrieveRagContext
  generateAnswer?: typeof generateRagAnswer
}

export interface QaTaskArgs {
  samples: EvalSample[]
  config: PaperMindConfig
  client: LlmClient
  systemPrompt: string
  /**
   * 样本级语言覆盖指令：非空时以 `\n\n` 追加在 systemPrompt 之后。
   * QASPER 参考答案是英文而生产 prompt 是中文的，若不强制英文作答，
   * 中英 token 完全不相交，answerable 样本的 answerF1 恒≈0，量化评测失效。
   */
  answerLanguageInstruction?: string
  limit?: number
  gitSha: string
  model: string
  /** 提供时启用 LLM-as-judge；通常与 client 用不同模型 */
  judgeClient?: LlmClient
  judgeModel?: string
  /** 测试注入单调时钟；生产默认 Date.now */
  now?: () => number
  /** 注入替换生产实现，单测无需真实 LLM */
  deps?: QaTaskDeps
  /**
   * 提供时启用轻量语义树索引（§11.2 对照组的唯一变量）：
   * 同一条生产 RAG 管线，只是每篇论文多挂一棵树。
   */
  semanticTree?: SemanticTreeHook
  /** 提供时走段落级混合检索：hook 建索引、embedder 供提问时的查询向量 */
  passage?: {
    hook: PassageIndexHook
    embedder: Embedder | undefined
    countTokens: TokenCounter
    maxTokens: number
    /** 本轮 embedder 加载失败：结果标为不参与正式对照（方案 §7） */
    embedderUnavailable: boolean
  }
  /**
   * 受控上下文物化器（§3.1）：对比实验的统一 token 预算由它施加——四个检索指标
   * 消费的最终页序与上下文文本同源产出，禁止从事后推断的候选包络反推。
   * CLI 与测试都必须提供；产品默认的 maxContextChars 字符预算不受影响。
   */
  materialize: (groups: ContextGroup[]) => MaterializedContext
  /**
   * 版本化评测契约（§7）：指标 schema、tokenizer、预算、数据集与有效题集合身份。
   * 全量写入结果 meta，并据此校验「有效题数 == contextPageMrr 观测数」的固定分母不变量。
   */
  evaluationContract: EvaluationContract
  /** 提供时启用查询时间线与流式最终回答；缺省路径保持原生产生成调用。 */
  speed?: SpeedRunnerOptions
}

/** 只透传 config 中显式给出的分块字段，未设置的字段让生产代码用默认值。 */
function indexOptions(config: PaperMindConfig): IndexOptions {
  const out: IndexOptions = {}
  if (config.chunkPages !== undefined) out.chunkPages = config.chunkPages
  if (config.minSectionPages !== undefined) out.minSectionPages = config.minSectionPages
  if (config.forceFixedChunk !== undefined) out.forceFixedChunk = config.forceFixedChunk
  if (config.maxSectionPages !== undefined) out.maxSectionPages = config.maxSectionPages
  return out
}

/**
 * 只透传 config 中显式给出的检索字段（externalContext 已被 BenchConfig Omit，永不传入）。
 * 注入 `materialize` 时最终预算由物化器掌控，maxContextChars 不再生效——这由调用方决定，
 * 此处仍如实透传配置值，避免在同一 runner 里私改口径。
 */
function ragOptions(config: PaperMindConfig): RagOptions {
  const out: RagOptions = {}
  if (config.topK !== undefined) out.topK = config.topK
  if (config.minScore !== undefined) out.minScore = config.minScore
  if (config.enableRewrite !== undefined) out.enableRewrite = config.enableRewrite
  if (config.maxContextChars !== undefined) out.maxContextChars = config.maxContextChars
  return out
}

export async function runQaTask(args: QaTaskArgs): Promise<BenchResult> {
  if (args.speed) assertSpeedAnswerClient(args.client as StreamingLlmClient)
  const { samples, config, client, limit, gitSha, model } = args
  const now = args.now ?? Date.now
  const startedAt = new Date().toISOString()
  const runStartedMs = now()
  const buildIndex = args.deps?.buildIndex ?? buildPageIndex
  const retrieveContext = args.deps?.retrieveContext ?? retrieveRagContext
  const generateAnswer = args.deps?.generateAnswer ?? generateRagAnswer
  const contract = args.evaluationContract
  const qualityQuestions = executedQuestions(samples, limit)
    .filter(({ sample }) => sample.source === 'qasper')
    .map(({ question }) => question)
  // 语言覆盖指令追加在调用方 systemPrompt 之后；未传时 prompt 原样透传
  const systemPrompt = args.answerLanguageInstruction
    ? `${args.systemPrompt}\n\n${args.answerLanguageInstruction}`
    : args.systemPrompt

  const perSample: PerSampleRecord[] = []
  const perPaper: PaperTimingRecord[] = []
  const errors: SampleError[] = []
  let total = 0
  // judge 阶段累计口径状态：sawUnanswerable 决定 meta.unanswerableMethod 是否落盘，
  // usedPatternFallback（judge 不可用/失败而回落正则）决定该标注为 judge 还是 pattern
  const judgeState: JudgeSampleState = { sawUnanswerable: false, usedPatternFallback: false }
  let qasperEvidenceQuestions = 0
  let mappedEvidenceQuestions = 0
  let ambiguousEvidenceQuestions = 0
  let unmappedEvidenceQuestions = 0

  for (const sample of samples) {
    if (limit !== undefined && total >= limit) break

    const indexClientBefore = client.stats()
    const indexStartedMs = now()
    let tree: IndexNode | undefined
    let passageInfo: PassageIndexInfo | undefined
    let indexError: unknown
    try {
      if (args.passage) {
        // 段落配置下索引由 hook 全权产出：不计 buildPageIndex 的 N+1 次调用，
        // 也不存在「hook 失败后回落平面索引」——失败即本篇记 index 阶段错误（方案 §7）
        passageInfo = await args.passage.hook(sample)
        tree = passageInfo.index.tree
      } else {
        tree = await buildIndex(sample.pages, client.complete, indexOptions(config))
      }
    } catch (e) {
      indexError = e
    }
    const indexFinishedMs = now()
    const indexClientAfter = client.stats()
    // 本篇在 limit 约束下实际将执行的问题数；失败分支与成功分支共用，保证口径一致
    const paperQuestionCount = countExecutedQuestions(sample, limit, total)

    if (indexError !== undefined || tree === undefined) {
      // 建索引失败：该论文全部问题记 index 阶段错误，并写底部逐题记录。
      // 有效题必须补齐四个零检索观测，否则有效题数少于契约数、固定分母不变量会误报；
      // 生成阶段从未开始，按 skipped 计，不污染 meta.completed（§6.2）
      recordIndexFailure(sample, paperQuestionCount, errorMessage(indexError), errors, perSample)
      total += paperQuestionCount
      // 仍记录已消耗的索引时长与缓存差值——「索引慢后失败」的论文不能被时延分析漏掉
      perPaper.push({
        paperId: sample.paperId,
        source: sample.source,
        pageCount: sample.pages.length,
        questionCount: paperQuestionCount,
        indexBuildLatencyMs: Math.max(0, indexFinishedMs - indexStartedMs),
        indexLlmCalls:
          (indexClientAfter.hits - indexClientBefore.hits)
          + (indexClientAfter.misses - indexClientBefore.misses),
        indexCacheHits: indexClientAfter.hits - indexClientBefore.hits,
        indexCacheMisses: indexClientAfter.misses - indexClientBefore.misses,
        // 索引失败也要在冷启动账上留痕：该论文一次构建都没走完（Task 13 的 D73）
        ...(args.passage ? { coldStartFailed: 1 } : {}),
        error: errorMessage(indexError),
      })
      continue
    }

    // 单节点文档（buildPageIndex 直接返回叶子）时叶节点是树本身，
    // 与生产 pipeline 里的树路由用同一个取法，保证两边的候选集合一致
    const leaves = collectLeafNodes(tree)
    // 语义树在平面索引之后单独建：树的输入是原文证据块，与平面索引互不依赖。
    // 建树失败只是没有树，本篇所有问题照常走平面路径（§8.2）。
    // 段落配置下不再建语义树：检索已被段落索引接管，多建一棵树只会白花一次 LLM 调用
    const treeInfo = !args.passage && args.semanticTree ? await args.semanticTree(sample) : undefined

    perPaper.push({
      paperId: sample.paperId,
      source: sample.source,
      pageCount: sample.pages.length,
      questionCount: paperQuestionCount,
      indexBuildLatencyMs: Math.max(0, indexFinishedMs - indexStartedMs),
      // LLM 调用数 = 网络请求 + 缓存命中（buildPageIndex 的每叶 summarize + 根索引一次）
      indexLlmCalls:
        (indexClientAfter.hits - indexClientBefore.hits)
        + (indexClientAfter.misses - indexClientBefore.misses),
      indexCacheHits: indexClientAfter.hits - indexClientBefore.hits,
      indexCacheMisses: indexClientAfter.misses - indexClientBefore.misses,
      leafCount: leaves.length,
      ...treeRecordFields(treeInfo),
      // 段落索引的冷启动成本（不进入 Q，与 Q 并列报告）
      ...(passageInfo ? passageInfo.coldStart : {}),
    })

    for (const question of sample.questions) {
      if (limit !== undefined && total >= limit) break
      total++
      if (sample.source === 'qasper' && !question.unanswerable) {
        qasperEvidenceQuestions++
        if (question.evidenceMapping === 'mapped') mappedEvidenceQuestions++
        else if (question.evidenceMapping === 'ambiguous') ambiguousEvidenceQuestions++
        else unmappedEvidenceQuestions++
      }

      const eligible = isRetrievalEligible(question)
      const record = newSampleRecord(sample, question)
      // 先入列：后续任何阶段的失败都保留这条记录，生成异常不得把它整条删掉（§6.3）
      perSample.push(record)

      // ---------- 检索阶段 ----------
      const speedClient = args.speed ? client as StreamingLlmClient : undefined
      let timeline: QueryTimeline | undefined
      if (args.speed && speedClient) {
        const before = speedClient.tokenSnapshot()
        timeline = startQueryTimeline(args.speed.now ?? now, before)
      }
      let retrieval: RagRetrievalStage
      try {
        retrieval = await retrieveContext(
          [{
            tree,
            pages: sample.pages,
            ...(treeInfo?.semantic ? { semantic: treeInfo.semantic } : {}),
            ...(passageInfo?.index ? { passageIndex: passageInfo.index } : {}),
          }],
          question.question,
          [],                       // 单轮评测，无历史；rewriteRate 因此在本评测中恒为 0
          client.complete,
          ragOptions(config),
          {
            now,
            materialize: args.materialize,
            // 段落路径的注入项：查询向量模型、契约分词器、冻结预算（与物化器同一常量）。
            // 三者同源是「填充放得下 ⇒ 物化不截断」成立的前提（见 passageRetrieval 文件头）
            ...(args.passage
              ? {
                  passage: {
                    ...(args.passage.embedder ? { embedder: args.passage.embedder } : {}),
                    countTokens: args.passage.countTokens,
                    maxTokens: args.passage.maxTokens,
                  },
                }
              : {}),
          },
        )
        timeline?.markEvidenceReady()
        assertRetrievalTiming(retrieval)
      } catch (e) {
        // 时延不变量破坏是评测口径漂移而非样本失败，向上抛出让整轮失效
        if (e instanceof TimingInvariantViolation) throw e
        if (timeline && speedClient) record.speed = timeline.partial(speedClient.tokenSnapshot())
        skipSampleRecord(record, eligible, eligible ? 'failed' : 'ineligible')
        errors.push({ sampleId: question.id, stage: 'retrieve', message: errorMessage(e) })
        continue
      }

      const first = retrieval.retrievals[0]
      const metrics = record.metrics
      // 非有效题照常记录运行诊断，但状态是 ineligible（不进检索质量分母），不是 completed
      record.retrievalStatus = eligible ? 'completed' : 'ineligible'
      record.retrievalQuery = retrieval.retrievalQuery
      if (retrieval.contextPageOrder !== undefined) record.contextPageOrder = retrieval.contextPageOrder
      if (retrieval.contextTokenCount !== undefined) record.contextTokenCount = retrieval.contextTokenCount
      // 段落配置下逐题记录实际生效的检索模式（bm25 / bm25+dense / full / …）；
      // 非段落路径没有 hybrid 诊断，该字段缺席
      record.retrievalMode = retrieval.retrievals[0]?.hybrid?.retrievalMode
      record.contextTruncated = retrieval.contextTruncated
      // selectedPages 是诊断字段（候选页区间包络），真实页集合一律看 contextPageOrder
      record.selectedPages = first ? expandPages(first.selected) : []

      // 生成阶段必定再发一次调用；检索阶段只记改写 + 逐题评分（与 runRagPipeline 口径一致）
      metrics.llmCalls = retrieval.llmCalls + 1
      metrics.rewrite = retrieval.rewritten ? 1 : 0
      metrics.leafCount = leaves.length
      metrics.contextTruncated = retrieval.contextTruncated ? 1 : 0
      // 必须量最终送入生成模型的**合并**上下文（`retrieval.context`，正是 generateAnswer 组提示词时
      // 读的同一个对象）。量 `first.context` 会在多篇检索时报出单篇物化前的大小，单篇时也不等于提示词，
      // 从而与同一份 JSON 里的 contextTokens / contextTokenCount 自相矛盾。
      metrics.selectedContextTokens = estimateTokens(retrieval.context)

      // 四个检索指标统一消费最终物化页序（§2.1 目标 2 / §3.1），不再事后反推候选包络。
      // 有效题页序为 undefined 的契约违约守卫已收敛进 applyRetrievalMetrics：undefined
      // 会把「本该有观测却丢失」伪装成合法的 MRR 0，而空上下文写 [] 照常按未命中计。
      applyRetrievalMetrics(metrics, {
        eligible,
        pageOrder: retrieval.contextPageOrder,
        questionId: question.id,
        evidencePages: question.evidencePages,
        context: retrieval.context,
      })

      // 树诊断（§11.4）：本篇根本没建出树时记 treeDegraded，与「有树但没被选中」区分开。
      // 降级有两种来源，漏掉任何一种都会把失败路由统计成成功：
      // - 树取证不足（insufficientEvidence，已就地回落平面）
      // - 打分本身失败（first.degraded：JSON 非法 / 覆盖不全 / 请求异常）
      if (treeInfo) {
        const semantic = first?.semantic
        metrics.treeUsed = semantic ? 1 : 0
        metrics.treeDegraded = semantic
          ? (semantic.insufficientEvidence || first?.degraded ? 1 : 0)
          : 1
        if (semantic) {
          metrics.selectedNodeCount = semantic.selectedNodeCount
          metrics.routableNodeCount = semantic.routableNodeCount
        }
      }
      if (first) {
        metrics.degraded = first.degraded ? 1 : 0
        metrics.partialScoreCoverage = first.degradedReason === 'incomplete-score-coverage' ? 1 : 0
      }

      // ---------- 生成阶段 ----------
      let generation: RagGenerationStage
      if (args.speed && timeline && speedClient) {
        let generationStartedAt: number | undefined
        let generationFinishedAt: number | undefined
        let answer: string
        try {
          answer = await generateSpeedAnswer({
            context: retrieval.context,
            question: question.question,
            history: [],
            systemPrompt,
            timeline,
            client: speedClient,
            record,
            streamAnswer: args.speed.streamAnswer,
            onStreamStarted: () => { generationStartedAt = now() },
            onStreamCompleted: () => { generationFinishedAt = now() },
          })
        } catch (e) {
          // 流异常由 adapter 附 partial；没有 partial 说明 complete() 的时间线不变量失败，整轮失效。
          if (record.speed === undefined) throw e
          record.generationStatus = 'failed'
          record.judgeStatus = 'skipped'
          errors.push({ sampleId: question.id, stage: 'stream', message: errorMessage(e) })
          continue
        }
        if (generationStartedAt === undefined || generationFinishedAt === undefined) {
          throw new TimingInvariantViolation()
        }
        generation = {
          answer,
          answerGenerationLatencyMs: Math.max(0, generationFinishedAt - generationStartedAt),
          queryEndToEndLatencyMs: Math.max(0, generationFinishedAt - retrieval.pipelineStartedAt),
        }
        assertGenerationTiming(generation)
      } else {
        try {
          generation = await generateAnswer(
            retrieval,
            question.question,
            [],
            client.chat,
            systemPrompt,
            { now },
          )
          assertGenerationTiming(generation)
        } catch (e) {
          if (e instanceof TimingInvariantViolation) throw e
          record.generationStatus = 'failed'
          record.judgeStatus = 'skipped'
          errors.push({ sampleId: question.id, stage: 'generate', message: errorMessage(e) })
          continue
        }
      }

      record.generationStatus = 'completed'
      record.answer = generation.answer
      const timing: PipelineTiming = {
        queryRewriteLatencyMs: retrieval.queryRewriteLatencyMs,
        retrievalLatencyMs: retrieval.retrievalLatencyMs,
        answerGenerationLatencyMs: generation.answerGenerationLatencyMs,
        queryEndToEndLatencyMs: generation.queryEndToEndLatencyMs,
      }
      record.timing = { ...timing }
      // 端到端与阶段时延写入 metrics 让 aggregate 能产生均值；分位数由 withPercentiles
      // 从 perSample.timing 单独计算，不能把 P50/P95 误当均值
      metrics.queryRewriteLatencyMs = timing.queryRewriteLatencyMs
      metrics.retrievalLatencyMs = timing.retrievalLatencyMs
      metrics.answerGenerationLatencyMs = timing.answerGenerationLatencyMs
      metrics.queryEndToEndLatencyMs = timing.queryEndToEndLatencyMs

      // ---------- 打分阶段（生成成功后才执行；失败不牵连检索指标与答案） ----------
      // judge 只看 evidence 原文，不看检索到的上下文——避免检索失败连带压低 judge 分；
      // trim 保证 evidencePages 全部越界时（join 结果为纯空白）也走「为空则跳过 judge 打分」的裁定
      const evidenceText = question.evidencePages
        .map(p => sample.pages[p] ?? '')
        .join('\n\n')
        .trim()

      try {
        await judgeSample({
          question,
          answer: generation.answer,
          evidenceText,
          judgeClient: args.judgeClient,
          metrics,
          record,
          state: judgeState,
        })
      } catch (e) {
        // judge 是独立阶段：其异常不得牵连已产出的检索指标与答案。
        // 时延不变量破坏是评测口径漂移而非样本失败，向上抛出让整轮失效
        if (e instanceof TimingInvariantViolation) throw e
        record.judgeStatus = 'failed'
        errors.push({ sampleId: question.id, stage: 'judge', message: errorMessage(e) })
      }
    }
  }

  const finishedAt = new Date().toISOString()
  const { hits: cacheHits, misses: cacheMisses } = client.stats()
  const runWallClockMs = Math.max(0, now() - runStartedMs)
  // 树诊断与检索质量指标合流进同一份 metrics，报表才能在同一行同时回答
  // 「检索有没有变好」与「树是什么样、贵不贵、失败得多不多」（§阶段 E）
  const treeAgg = summarizeTreeDiagnostics(perPaper)
  return finalizeQaResult({
    config,
    contract,
    records: perSample,
    perPaper,
    errors,
    client,
    model,
    judgeModel: args.judgeModel,
    hasJudgeClient: args.judgeClient !== undefined,
    judgeState,
    gitSha,
    startedAt,
    finishedAt,
    runWallClockMs,
    total,
    cacheHits,
    cacheMisses,
    retrievalAlgorithm: args.passage ? 'hybrid-passage' : args.semanticTree ? 'semantic-tree' : 'papermind-llm',
    qasperEvidenceQuestions,
    mappedEvidenceQuestions,
    ambiguousEvidenceQuestions,
    unmappedEvidenceQuestions,
    ...(qualityQuestions.length > 0 ? { qualityQuestions } : {}),
    // 段落配置下 extraMetrics 换成冷启动成本（树诊断在段落路径上恒为空：hook 接管后不再建树）
    extraMetrics: args.passage ? summarizeColdStart(perPaper) : treeAgg.metrics,
    ...(args.passage
      ? {
          extraMeta: {
            baselineFamily: 'classic' as const,
            candidateGranularity: 'paragraph passage',
            // 向量模型不可用时本轮检索信号与其它基线不同源，如实标为不可比（方案 §7）
            ...(args.passage.embedderUnavailable
              ? { comparisonEligible: false, comparisonIneligibleReason: 'embedder-unavailable' }
              : {}),
          },
        }
      : {}),
    extraTimingValues: { treeBuildLatency: treeAgg.latencies },
    ...(args.speed ? { speed: { contract: args.speed.contract } } : {}),
  })
}

/**
 * 时延不变量破坏（检索/生成阶段缺失 timing，或字段非有限/为负）是评测口径漂移
 * 而非样本失败，用专用异常向上抛出让整轮失效，避免把诊断性失败吞成 errors 数据点。
 */
class TimingInvariantViolation extends Error {
  constructor() {
    super('检索或生成阶段返回的 timing 缺失，或存在非有限/负值的字段')
    this.name = 'TimingInvariantViolation'
  }
}

/** 检索阶段的时延字段在生成之前就应成立，单独校验让它在生成失败时也不被漏检。 */
function assertRetrievalTiming(stage: RagRetrievalStage): void {
  if (!Number.isFinite(stage.queryRewriteLatencyMs) || stage.queryRewriteLatencyMs < 0
    || !Number.isFinite(stage.retrievalLatencyMs) || stage.retrievalLatencyMs < 0) throw new TimingInvariantViolation()
}

function assertGenerationTiming(stage: RagGenerationStage): void {
  if (!Number.isFinite(stage.answerGenerationLatencyMs) || stage.answerGenerationLatencyMs < 0
    || !Number.isFinite(stage.queryEndToEndLatencyMs) || stage.queryEndToEndLatencyMs < 0) throw new TimingInvariantViolation()
}

/**
 * 本篇论文在 limit 约束下实际将执行的问题数。索引失败分支与成功分支共用，
 * 保证 perPaper.questionCount 与 errors / 逐题记录计数口径一致。
 */
function countExecutedQuestions(sample: EvalSample, limit: number | undefined, total: number): number {
  const remaining = limit === undefined ? Infinity : Math.max(0, limit - total)
  return Math.min(sample.questions.length, remaining)
}

export { REFUSAL_PATTERN_VERSION }
