import type { BenchResult, EvalSample, PaperTimingRecord, PerSampleRecord, PipelineTiming, QueryTimeline, SampleError, TraditionalRagConfig } from '../types'
import type { LlmClient, StreamingLlmClient } from '../llmClient'
import type { ContextGroup, MaterializedContext } from '../../../src/utils/contextTrace'
import type { EvaluationContract } from '../evaluationContract'
import { applyRetrievalMetrics, expandPages } from '../metrics/retrieval'
import { isRetrievalEligible } from '../evaluationContract'
import { errorMessage, finalizeQaResult, newSampleRecord, recordIndexFailure, skipSampleRecord } from './support'
import { chunkPages } from '../traditionalRag/chunker'
import { buildBm25Retriever } from '../traditionalRag/bm25'
import { buildJaccardRetriever } from '../traditionalRag/jaccard'
import { buildCosineRetriever } from '../traditionalRag/cosine'
import { createBgeM3Provider, createBgeM3Tokenizer } from '../traditionalRag/embedding'
import { selectContext } from '../traditionalRag/context'
import type { BenchChunk, BuiltRetriever, TextTokenizer } from '../traditionalRag/types'
import { benchPath } from '../paths'
import { MATH_FORMAT_INSTRUCTION } from '../../../src/utils/ragPipeline'
import { judgeSample, type JudgeSampleState } from '../metrics/judge'
import { generateSpeedAnswer, type SpeedRunnerOptions } from '../speed/generate'
import { startQueryTimeline } from '../speed/queryTimeline'
import { assertSpeedAnswerClient } from '../speed/policy'

export interface TraditionalRagQaArgs {
  samples: EvalSample[]; config: TraditionalRagConfig; client: LlmClient; systemPrompt: string; answerLanguageInstruction?: string; limit?: number; gitSha: string; model: string; judgeClient?: LlmClient; judgeModel?: string; now?: () => number
  /**
   * 受控上下文物化器（§3.1）：对比实验的统一 token 预算由它施加——四个检索指标消费的
   * 最终页序与提示词上下文文本同源产出，禁止从事后推断的候选包络反推。
   * 与 runQaTask 一样是必填参数；产品默认的 maxContextChars 字符预算不受影响。
   */
  materialize: (groups: ContextGroup[]) => MaterializedContext
  /**
   * 版本化评测契约（§7）：指标 schema、tokenizer、预算与有效题集合身份。
   * 全量写入结果 meta，并据此校验「有效题数 == contextPageMrr 观测数」的固定分母不变量。
   */
  evaluationContract: EvaluationContract
  /** 提供时启用查询时间线与流式最终回答；缺省路径保持现有注入与生成语义。 */
  speed?: SpeedRunnerOptions
  deps?: { tokenizer?: TextTokenizer; buildRetriever?: (chunks: ReturnType<typeof chunkPages>, config: TraditionalRagConfig) => Promise<BuiltRetriever>; generateAnswer?: (system: string, question: string) => Promise<string> }
}
const modelCacheDir = () => benchPath(import.meta.url, '../../cache/models/')

export async function runTraditionalRagQaTask(args: TraditionalRagQaArgs): Promise<BenchResult> {
  if (args.speed) assertSpeedAnswerClient(args.client as StreamingLlmClient)
  const now = args.now ?? Date.now; const startedAt = new Date().toISOString(); const runStartedMs = now(); const contract = args.evaluationContract; const records: PerSampleRecord[] = []; const perPaper: PaperTimingRecord[] = []; const errors: SampleError[] = []; let total = 0
  // judge 阶段累计口径状态：sawUnanswerable 决定 meta.unanswerableMethod 是否落盘，
  // usedPatternFallback（judge 不可用/失败而回落正则）决定该标注为 judge 还是 pattern
  const judgeState: JudgeSampleState = { sawUnanswerable: false, usedPatternFallback: false }
  let qasperEvidenceQuestions = 0; let mappedEvidenceQuestions = 0; let ambiguousEvidenceQuestions = 0; let unmappedEvidenceQuestions = 0
  let tokenizer = args.deps?.tokenizer
  let defaultBuild: ((chunks: ReturnType<typeof chunkPages>) => Promise<BuiltRetriever>) | undefined
  if (args.config.retrieval.algorithm === 'cosine' && !args.deps?.buildRetriever) {
    const embedding = args.config.retrieval.embedding
    const runtime = await createBgeM3Provider({ ...embedding, cacheDir: modelCacheDir() })
    tokenizer ??= runtime.tokenizer
    defaultBuild = chunks => buildCosineRetriever(chunks, runtime.provider, embedding)
  }
  if (!tokenizer) {
    // 所有算法共用 BGE-M3 tokenizer；只有 cosine 额外加载 embedding pipeline。
    tokenizer = await createBgeM3Tokenizer({ model: 'BAAI/bge-m3', revision: 'main', cacheDir: modelCacheDir() })
  }
  const build = args.deps?.buildRetriever ?? (async chunks => {
    if (args.config.retrieval.algorithm === 'bm25') return buildBm25Retriever(chunks, args.config.retrieval)
    if (args.config.retrieval.algorithm === 'jaccard') return buildJaccardRetriever(chunks)
    if (!defaultBuild) throw new Error('cosine embedding provider 未初始化')
    return defaultBuild(chunks)
  })
  const generate = args.deps?.generateAnswer
  const baseSystemPrompt = args.answerLanguageInstruction ? `${args.systemPrompt}\n\n${args.answerLanguageInstruction}` : args.systemPrompt
  for (const sample of args.samples) {
    if (args.limit !== undefined && total >= args.limit) break
    const questionCount = Math.min(sample.questions.length, args.limit === undefined ? Infinity : Math.max(0, args.limit - total))
    let retriever: BuiltRetriever
    const indexStart = now()
    try { retriever = await build(chunkPages(sample.pages, tokenizer, args.config.chunking), args.config) } catch (e) {
      const message = errorMessage(e)
      // 传统 RAG 的索引从不触碰 client，缓存差值真值恒为 0；失败路径也照写，
      // 免得消费方对同一逻辑字段既要处理 undefined 又要处理 0
      perPaper.push({ paperId: sample.paperId, source: sample.source, pageCount: sample.pages.length, questionCount, indexBuildLatencyMs: Math.max(0, now() - indexStart), indexLlmCalls: 0, indexCacheHits: 0, indexCacheMisses: 0, error: message })
      recordIndexFailure(sample, questionCount, message, errors, records)
      total += questionCount; continue
    }
    perPaper.push({ paperId: sample.paperId, source: sample.source, pageCount: sample.pages.length, questionCount, indexBuildLatencyMs: Math.max(0, now() - indexStart), indexLlmCalls: 0, indexCacheHits: 0, indexCacheMisses: 0, leafCount: retriever.chunks.length })
    for (const question of sample.questions) {
      if (args.limit !== undefined && total >= args.limit) break
      total++; const queryStarted = now()
      if (sample.source === 'qasper' && !question.unanswerable) { qasperEvidenceQuestions++; if (question.evidenceMapping === 'mapped') mappedEvidenceQuestions++; else if (question.evidenceMapping === 'ambiguous') ambiguousEvidenceQuestions++; else unmappedEvidenceQuestions++ }

      const eligible = isRetrievalEligible(question)
      const record = newSampleRecord(sample, question)
      // 先入列：后续任何阶段的失败只更新状态，生成异常不得把这条记录整条删掉（§6.3）
      records.push(record)
      const speedClient = args.speed ? args.client as StreamingLlmClient : undefined
      let timeline: QueryTimeline | undefined
      if (args.speed && speedClient) {
        const before = speedClient.tokenSnapshot()
        timeline = startQueryTimeline(args.speed.now ?? now, before)
      }

      // ---------- 检索阶段 ----------
      // 只取用 contextGroups（物化输入）与 selected（诊断包络）两样；selectContext 的
      // context / tokenCount 已不参与任何计算，显式解构以免被误当成指标来源
      let contextGroups: ContextGroup[]
      let selected: BenchChunk[]
      let context: MaterializedContext
      const retrieveStarted = now()
      try {
        const scores = await retriever.score(question.question)
        const ctx = selectContext(retriever.chunks, scores, { retrievalTopK: args.config.retrieval.topK, topK: args.config.generationContext.topK })
        contextGroups = ctx.contextGroups
        selected = ctx.selected
        // 最终 token 预算由注入的物化器施加（Task 9 冻结）；上下文文本与页序同源产出，
        // 四个检索指标只认这份 pageOrder，禁止事后从候选包络反推（§3.1）
        context = args.materialize(contextGroups)
        timeline?.markEvidenceReady()
      } catch (e) {
        if (timeline && speedClient) record.speed = timeline.partial(speedClient.tokenSnapshot())
        skipSampleRecord(record, eligible, eligible ? 'failed' : 'ineligible')
        errors.push({ sampleId: question.id, stage: 'retrieve', message: errorMessage(e) })
        continue
      }
      const retrievalLatencyMs = Math.max(0, now() - retrieveStarted)

      // 非有效题照常记录运行诊断，但状态是 ineligible（不进检索质量分母），不是 completed
      record.retrievalStatus = eligible ? 'completed' : 'ineligible'
      record.retrievalQuery = question.question
      record.contextPageOrder = context.pageOrder
      record.contextTokenCount = context.tokenCount
      record.contextTruncated = context.truncated
      // selectedPages 仅诊断（被选中候选的页区间包络，含被预算截掉的页），不参与任何指标
      record.selectedPages = expandPages(selected)

      const metrics = record.metrics
      metrics.llmCalls = 1; metrics.rewrite = 0; metrics.leafCount = retriever.chunks.length
      metrics.contextTruncated = context.truncated ? 1 : 0
      // 物化页序非可选（MaterializedContext.pageOrder 恒为数组），本路径不会产出 undefined 页序，
      // 故共享守卫在此不触发；有效题一律有观测
      applyRetrievalMetrics(metrics, { eligible, pageOrder: context.pageOrder, questionId: question.id, evidencePages: question.evidencePages, context: context.text })

      // ---------- 生成阶段 ----------
      const systemPrompt = `${baseSystemPrompt}\n\n${MATH_FORMAT_INSTRUCTION}` + (context.text ? `\n\n参考内容：\n${context.text}` : '')
      let answer: string
      let answerGenerationLatencyMs: number
      if (args.speed && timeline && speedClient) {
        let generationStartedAt: number | undefined
        let generationFinishedAt: number | undefined
        try {
          answer = await generateSpeedAnswer({
            context: context.text,
            question: question.question,
            systemPrompt: baseSystemPrompt,
            timeline,
            client: speedClient,
            record,
            streamAnswer: args.speed.streamAnswer,
            onStreamStarted: () => { generationStartedAt = now() },
            onStreamCompleted: () => { generationFinishedAt = now() },
          })
        } catch (e) {
          // 流异常由 adapter 附 partial；complete() 的时间线不变量失败则使整轮失效。
          if (record.speed === undefined) throw e
          record.generationStatus = 'failed'
          record.judgeStatus = 'skipped'
          errors.push({ sampleId: question.id, stage: 'stream', message: errorMessage(e) })
          continue
        }
        if (generationStartedAt === undefined || generationFinishedAt === undefined) {
          throw new Error('speed generation did not report legacy timing boundaries')
        }
        answerGenerationLatencyMs = Math.max(0, generationFinishedAt - generationStartedAt)
      } else {
        try {
          const generateStarted = now()
          answer = generate ? await generate(systemPrompt, question.question) : await args.client.chat([{ role: 'system', content: systemPrompt }, { role: 'user', content: question.question }])
          answerGenerationLatencyMs = Math.max(0, now() - generateStarted)
        } catch (e) {
          // 生成失败不得丢弃已算出的检索指标：检索产物在上一阶段就已落盘（§6.2 / §6.3）
          record.generationStatus = 'failed'
          record.judgeStatus = 'skipped'
          errors.push({ sampleId: question.id, stage: 'generate', message: errorMessage(e) })
          continue
        }
      }
      const timing: PipelineTiming = { queryRewriteLatencyMs: 0, retrievalLatencyMs, answerGenerationLatencyMs, queryEndToEndLatencyMs: Math.max(0, now() - queryStarted) }
      record.timing = { ...timing }
      metrics.queryRewriteLatencyMs = timing.queryRewriteLatencyMs
      metrics.retrievalLatencyMs = timing.retrievalLatencyMs
      metrics.answerGenerationLatencyMs = timing.answerGenerationLatencyMs
      metrics.queryEndToEndLatencyMs = timing.queryEndToEndLatencyMs
      record.generationStatus = 'completed'
      record.answer = answer

      // ---------- 打分阶段（生成成功后才执行；异常不牵连检索指标与答案） ----------
      // judge 只看 evidence 原文，不看检索到的上下文——避免检索失败连带压低 judge 分；
      // trim 保证 evidencePages 全部越界时（join 结果为纯空白）也走「为空则跳过 judge 打分」的裁定
      const evidenceText = question.evidencePages.map(p => sample.pages[p] ?? '').join('\n\n').trim()
      try {
        await judgeSample({ question, answer, evidenceText, judgeClient: args.judgeClient, metrics, record, state: judgeState })
      } catch (e) {
        // judge 是独立阶段：其异常不得牵连已产出的检索指标与答案
        record.judgeStatus = 'failed'
        errors.push({ sampleId: question.id, stage: 'judge', message: errorMessage(e) })
      }
    }
  }
  const finishedAt = new Date().toISOString()
  const { hits, misses } = args.client.stats()
  return finalizeQaResult({
    config: args.config,
    contract,
    records,
    perPaper,
    errors,
    client: args.client,
    model: args.model,
    judgeModel: args.judgeModel,
    hasJudgeClient: args.judgeClient !== undefined,
    judgeState,
    gitSha: args.gitSha,
    startedAt,
    finishedAt,
    runWallClockMs: Math.max(0, now() - runStartedMs),
    total,
    cacheHits: hits,
    cacheMisses: misses,
    retrievalAlgorithm: args.config.retrieval.algorithm,
    qasperEvidenceQuestions,
    mappedEvidenceQuestions,
    ambiguousEvidenceQuestions,
    unmappedEvidenceQuestions,
    ...(args.speed ? { speed: { contract: args.speed.contract } } : {}),
  })
}
