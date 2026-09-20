/**
 * 强基线共享 QA 编排引擎（hybrid-rerank / long-section-rag 复用）：
 * 每篇建索引一次 → 逐问调用注入的检索器 → 公共 materializer 施加统一 token 预算 →
 * 与既有 runner 完全相同的生成 prompt、拒答/judge 口径、指标计算与聚合尾部。
 * 计划 §1.1 冻结契约：原始问题直投（无改写）、4096 token 预算、
 * 失败记入 errors 且不伪造上下文、index 阶段 LLM 调用恒为 0。
 *
 * 检索与生成是两个独立阶段（§6.2 / §6.3）：检索产物先落断点，生成即便失败也不丢检索指标。
 * 断点 v2 逐题登记 `{ record, pendingContext }`：pendingContext 存在且签名一致时跳过检索，
 * 从已物化的页序与文本继续生成与打分；生成成功即清除 pendingContext，只留 record。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { BenchResult, EvalSample, PaperTimingRecord, PerSampleRecord, PipelineTiming, QueryTimeline, SampleError } from '../types'
import type { PageSpan } from '../metrics/retrieval'
import type { ContextGroup, MaterializedContext } from '../../../src/utils/contextTrace'
import type { EvaluationContract } from '../evaluationContract'
import type { LlmClient, StreamingLlmClient } from '../llmClient'
import { MATH_FORMAT_INSTRUCTION } from '../../../src/utils/ragPipeline'
import { applyRetrievalMetrics, expandPages } from '../metrics/retrieval'
import { isRetrievalEligible } from '../evaluationContract'
import { judgeSample, type JudgeSampleState } from '../metrics/judge'
import { errorMessage, finalizeQaResult, newSampleRecord, recordIndexFailure, skipSampleRecord } from './support'
import { generateSpeedAnswer, type SpeedRunnerOptions } from '../speed/generate'
import { startQueryTimeline } from '../speed/queryTimeline'
import { assertStrongSpeedPolicy } from '../speed/policy'

export interface StrongRetrievalOutcome {
  /**
   * 选中候选的逐页精确分片组（按最终候选顺序）。最终上下文文本与页序由公共 materializer
   * 在统一 token 预算内同源产出（§3.1 / §4.2），禁止从事后推断的候选包络反推。
   */
  contextGroups: ContextGroup[]
  /**
   * 选中候选的页区间包络，仅供诊断字段 selectedPages 使用（含被预算截掉的页），
   * 不参与任何检索指标。可省略；省略时该题 selectedPages 记空数组。
   */
  selected?: PageSpan[]
  /** 检索阶段自身消耗的 LLM 调用次数（如 agentic 检索）；计入 llmCalls */
  retrievalLlmCalls?: number
}

export interface StrongRetrievalRuntime {
  /** 候选/上下文粒度自证（写入 meta.candidateGranularity） */
  granularity: string
  /** 每篇论文调用一次；返回该论文的逐问检索函数 */
  build(sample: EvalSample): Promise<{
    leafCount: number
    /** 索引阶段 LLM 调用与缓存命中（上游索引型基线如实计入；默认 0） */
    indexLlmCalls?: number
    indexCacheHits?: number
    indexCacheMisses?: number
    retrieve(question: string): Promise<StrongRetrievalOutcome>
  }>
}

/** 生成侧固定设置；任一项变化都会让旧断点失效（进入 signature），但不含任何凭据。 */
export interface StrongGenerationSettings {
  maxTokens?: number
  requestTimeoutMs?: number
}

export interface StrongBaselineQaArgs {
  samples: EvalSample[]
  client: LlmClient
  systemPrompt: string
  /** 样本级语言覆盖指令，语义与 runQaTask 一致 */
  answerLanguageInstruction?: string
  limit?: number
  gitSha: string
  model: string
  judgeClient?: LlmClient
  judgeModel?: string
  now?: () => number
  retrieval: StrongRetrievalRuntime
  /** 写入 meta 的基线标识 */
  meta: { retrievalAlgorithm: NonNullable<BenchResult['meta']['retrievalAlgorithm']>; baselineFamily: BenchResult['meta']['baselineFamily']; config: BenchResult['config'] }
  /** 测试注入，替换真实 LLM 生成 */
  generateAnswer?: (system: string, question: string) => Promise<string>
  /** 强基线逐题断点；签名不匹配时忽略旧文件，避免串用数据集/模型/配置。 */
  checkpointPath?: string
  /** CLI 进度观察；测试默认静默。processed 包含成功与失败题。 */
  onProgress?: (event: { processed: number; total: number; completed: number; errors: number; sampleId: string; status: 'completed' | 'failed' | 'resumed' }) => void
  /**
   * 受控上下文物化器（§3.1）：统一 token 预算由它施加——四个检索指标消费的最终页序与
   * 提示词上下文文本同源产出，禁止从事后推断的候选包络反推。与 runQaTask 一样是必填参数。
   */
  materialize: (groups: ContextGroup[]) => MaterializedContext
  /**
   * 版本化评测契约（§7）：断点签名的身份来源与「有效题数 == contextPageMrr 观测数」的
   * 固定分母不变量依据；全量写入结果 meta。
   */
  evaluationContract: EvaluationContract
  /**
   * provider + 规范化 base URL 的身份指纹（**绝不含 API key**）：换端点必须让旧断点失效。
   * 与 systemPromptHash 一样由调用方在 CLI 层算出（Task 9 接线）。
   */
  llmEndpointIdentity: string
  /** 生效 system prompt（含 answerLanguageInstruction）的哈希：改 prompt 必须让旧断点失效。 */
  systemPromptHash: string
  /** 生成侧固定设置；随签名落盘，任一项变化都会让旧断点失效。 */
  generationSettings?: StrongGenerationSettings
  /** judge 是否启用；缺省按是否提供 judgeClient 判定。与 judgeModel 一并进入断点签名。 */
  judgeEnabled?: boolean
  /** 提供时启用查询时间线与流式最终回答；speed 模式禁止任何断点路径或续跑条目。 */
  speed?: SpeedRunnerOptions
}

/** 断点里逐题登记的条目：record 是已落盘的逐样本记录，pendingContext 标记「检索已产出、生成未完成」。 */
interface StrongCheckpointEntry {
  record: PerSampleRecord
  /** 检索已物化、生成尚未完成时保存的最终上下文；生成成功后清除（断点只剩 record） */
  pendingContext?: MaterializedContext
}

interface StrongCheckpoint {
  version: 2
  signature: string
  startedAt: string
  elapsedMs: number
  entries: StrongCheckpointEntry[]
  llmLatencies: number[]
  cacheHits: number
  cacheMisses: number
  /**
   * 上一进程的 judge 口径状态快照（仅两个布尔量，**不含任何凭据**）。`sawUnanswerable`
   * 与 `usedPatternFallback` 都是「一旦为真即保持」的闩锁，续跑加载即等价于按 OR 合并，
   * 否则上一进程判定过的不可回答题会在本进程被跳过，meta.unanswerableMethod 静默消失。
   */
  judgeState?: JudgeSampleState
}

/**
 * 断点签名：只有「同一份实验身份」才允许复用旧断点。进入签名的量覆盖评测契约、
 * 模型、代码版本、配置、切片题号、端点身份、生效 prompt 指纹、生成设置与 judge 身份；
 * **绝不包含 API key 或任何凭据**（端点只取 provider + 规范化 base URL 的身份哈希）。
 */
function checkpointSignature(args: StrongBaselineQaArgs): string {
  const allQuestionIds = args.samples.flatMap(sample => sample.questions.map(question => question.id))
  const questionIds = args.limit === undefined ? allQuestionIds : allQuestionIds.slice(0, args.limit)
  return createHash('sha256').update(JSON.stringify({
    version: 2,
    // 契约整体入签：数据集/有效题指纹、指标 schema、MRR 口径、evidence 映射版本、
    // 上下文 tokenizer/revision/budget 任一变化都必须让旧断点失效
    contract: args.evaluationContract,
    model: args.model,
    gitSha: args.gitSha,
    config: args.meta.config,
    questionIds,
    llmEndpointIdentity: args.llmEndpointIdentity,
    systemPromptHash: args.systemPromptHash,
    generationSettings: args.generationSettings ?? null,
    judgeEnabled: args.judgeEnabled ?? args.judgeClient !== undefined,
    judgeModel: args.judgeModel ?? null,
  })).digest('hex')
}

function readCheckpoint(path: string | undefined, signature: string): StrongCheckpoint | undefined {
  if (!path) return undefined
  try {
    const checkpoint = JSON.parse(readFileSync(path, 'utf-8')) as StrongCheckpoint
    if (!checkpoint || checkpoint.version !== 2 || checkpoint.signature !== signature || !Array.isArray(checkpoint.entries)) return undefined
    // 逐条校验条目形状：合法 JSON 但被截断/改写成 `[{}]` 的断点必须回落全新运行，
    // 不能让后续 `entry.record.id` 抛出未捕获 TypeError 中断续跑（违反本函数「无效即忽略」的契约）。
    const entriesValid = checkpoint.entries.every(
      entry => entry !== null && typeof entry === 'object'
        && entry.record !== null && typeof entry.record === 'object'
        && typeof entry.record.id === 'string',
    )
    return entriesValid ? checkpoint : undefined
  } catch {
    return undefined
  }
}

function writeCheckpoint(path: string | undefined, checkpoint: StrongCheckpoint) {
  if (!path) return
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp.${process.pid}`
  writeFileSync(tmp, JSON.stringify(checkpoint, null, 2))
  renameSync(tmp, path)
}

export async function runStrongBaselineQaTask(args: StrongBaselineQaArgs): Promise<BenchResult> {
  assertStrongSpeedPolicy({
    speed: args.speed !== undefined,
    checkpointPath: args.checkpointPath,
    client: args.client as StreamingLlmClient,
  })
  const now = args.now ?? Date.now
  const started = now()
  const signature = checkpointSignature(args)
  const checkpoint = readCheckpoint(args.checkpointPath, signature)
  const startedAt = checkpoint?.startedAt ?? new Date().toISOString()
  const elapsedBeforeResume = checkpoint?.elapsedMs ?? 0
  const priorLlmLatencies = checkpoint?.llmLatencies ?? []
  const priorCacheHits = checkpoint?.cacheHits ?? 0
  const priorCacheMisses = checkpoint?.cacheMisses ?? 0
  // 断点逐题登记。records 是结果全量清单，entries 只登记「可续跑」的题：检索/索引失败的
  // 记录（skipSampleRecord / recordIndexFailure）刻意只进 records 不入 entries，续跑时整题重试，
  // 故两者并非一一对应。检索成功的新题同时入列并登记断点，续跑题原地复用 record。
  const entries: StrongCheckpointEntry[] = checkpoint ? checkpoint.entries.map(entry => ({ ...entry })) : []
  const entryById = new Map(entries.map(entry => [entry.record.id, entry]))
  const records: PerSampleRecord[] = entries.map(entry => entry.record)
  const perPaper: PaperTimingRecord[] = []
  const errors: SampleError[] = []
  // judge 阶段累计口径状态：sawUnanswerable 决定 meta.unanswerableMethod 是否落盘，
  // usedPatternFallback（judge 不可用/失败而回落正则）决定该标注为 judge 还是 pattern。
  // 两者都是只从 false 置 true 的闩锁（judgeSample 从不复位），故从断点恢复即等价于按 OR 合并：
  // 上一进程判定过的不可回答题在本进程被跳过时，unanswerableMethod 不会静默消失。
  const judgeState: JudgeSampleState = {
    sawUnanswerable: checkpoint?.judgeState?.sawUnanswerable ?? false,
    usedPatternFallback: checkpoint?.judgeState?.usedPatternFallback ?? false,
  }
  let total = 0
  let qasperEvidenceQuestions = 0
  let mappedEvidenceQuestions = 0
  let ambiguousEvidenceQuestions = 0
  let unmappedEvidenceQuestions = 0

  const baseSystemPrompt = args.answerLanguageInstruction
    ? `${args.systemPrompt}\n\n${args.answerLanguageInstruction}`
    : args.systemPrompt
  const targetTotal = Math.min(
    args.samples.reduce((sum, sample) => sum + sample.questions.length, 0),
    args.limit ?? Number.POSITIVE_INFINITY,
  )
  // meta.completed 的语义（§6.2）只有一处定义：走完生成阶段的题；续跑恢复的题同样计入
  const completedCount = () => records.filter(record => record.generationStatus === 'completed').length

  const saveCheckpoint = () => {
    const stats = args.client.stats()
    writeCheckpoint(args.checkpointPath, {
      version: 2,
      signature,
      startedAt,
      elapsedMs: elapsedBeforeResume + Math.max(0, now() - started),
      entries,
      llmLatencies: [...priorLlmLatencies, ...args.client.latencies()],
      cacheHits: priorCacheHits + stats.hits,
      cacheMisses: priorCacheMisses + stats.misses,
      // 快照当前 judge 口径闩锁；只有两个布尔量，凭据（API key 等）绝不进入断点
      judgeState: { sawUnanswerable: judgeState.sawUnanswerable, usedPatternFallback: judgeState.usedPatternFallback },
    })
  }

  for (const sample of args.samples) {
    if (args.limit !== undefined && total >= args.limit) break
    const questionCount = Math.min(sample.questions.length, args.limit === undefined ? Infinity : args.limit - total)
    const indexStart = now()
    let runtime: { leafCount: number; indexLlmCalls?: number; indexCacheHits?: number; indexCacheMisses?: number; retrieve(question: string): Promise<StrongRetrievalOutcome> }
    try {
      runtime = await args.retrieval.build(sample)
    } catch (e) {
      const message = errorMessage(e)
      perPaper.push({ paperId: sample.paperId, source: sample.source, pageCount: sample.pages.length, questionCount, indexBuildLatencyMs: Math.max(0, now() - indexStart), error: message })
      // 建索引失败：该篇尚未有断点记录的题按有效题补四个零观测（固定分母不变量），
      // 已在断点里完成或待生成的题不重复登记（否则会写重记录并破坏分母）。
      const pending = sample.questions.slice(0, questionCount).filter(question => !entryById.has(question.id))
      if (pending.length > 0) recordIndexFailure({ ...sample, questions: pending }, pending.length, message, errors, records)
      total += questionCount
      saveCheckpoint()
      continue
    }
    perPaper.push({
      paperId: sample.paperId, source: sample.source, pageCount: sample.pages.length, questionCount,
      indexBuildLatencyMs: Math.max(0, now() - indexStart),
      indexLlmCalls: runtime.indexLlmCalls ?? 0, indexCacheHits: runtime.indexCacheHits ?? 0, indexCacheMisses: runtime.indexCacheMisses ?? 0,
      leafCount: runtime.leafCount,
    })

    for (const question of sample.questions) {
      if (args.limit !== undefined && total >= args.limit) break
      total++
      if (sample.source === 'qasper' && !question.unanswerable) {
        qasperEvidenceQuestions++
        if (question.evidenceMapping === 'mapped') mappedEvidenceQuestions++
        else if (question.evidenceMapping === 'ambiguous') ambiguousEvidenceQuestions++
        else unmappedEvidenceQuestions++
      }
      try {
        const existingEntry = entryById.get(question.id)
        if (args.speed && existingEntry) {
          throw new Error('speed mode cannot resume checkpoint entries')
        }
        // 生成已完成、打分非 failed（completed 或 skipped）的题整套续跑跳过。
        // judgeStatus==='skipped' 表示 judge 未启用或该题不适用，必须保持跳过，不重放。
        if (existingEntry && existingEntry.record.generationStatus === 'completed' && existingEntry.record.judgeStatus !== 'failed') {
          args.onProgress?.({ processed: total, total: targetTotal, completed: completedCount(), errors: errors.length, sampleId: question.id, status: 'resumed' })
          continue
        }

        // 打分阶段的唯一入口（正常路径与续跑重放共用）：只看 evidence 原文，不看检索到的上下文——
        // 避免检索失败连带压低 judge 分；trim 保证 evidencePages 全部越界（join 为纯空白）时也跳过评分。
        const runJudgeStage = async (record: PerSampleRecord) => {
          const evidenceText = question.evidencePages.map(p => sample.pages[p] ?? '').join('\n\n').trim()
          try {
            await judgeSample({ question, answer: record.answer ?? '', evidenceText, judgeClient: args.judgeClient, metrics: record.metrics, record, state: judgeState })
          } catch (e) {
            // judge 是独立阶段：其异常不得牵连已产出的检索指标与答案
            record.judgeStatus = 'failed'
            errors.push({ sampleId: question.id, stage: 'judge', message: errorMessage(e) })
          }
        }

        // 生成已完成但打分失败（生成成功、judge 抛异常或降级）：answer 已落盘，只重放打分阶段——
        // judge 模型在断点签名里，重放是缓存确定性的；检索与生成都不重跑，判分分母不被永久缩小。
        if (existingEntry && existingEntry.record.generationStatus === 'completed') {
          await runJudgeStage(existingEntry.record)
          args.onProgress?.({ processed: total, total: targetTotal, completed: completedCount(), errors: errors.length, sampleId: question.id, status: 'completed' })
          continue
        }

        const eligible = isRetrievalEligible(question)
        const queryStart = now()
        const speedClient = args.speed ? args.client as StreamingLlmClient : undefined
        let timeline: QueryTimeline | undefined
        if (args.speed && speedClient) {
          const before = speedClient.tokenSnapshot()
          timeline = startQueryTimeline(args.speed.now ?? now, before)
        }

        // ---------- 检索阶段 ----------
        let context: MaterializedContext
        let entry: StrongCheckpointEntry
        if (existingEntry?.pendingContext) {
          // 续跑：检索产物已在上一轮物化并落盘，跳过检索，从已保存的页序与文本继续
          entry = existingEntry
          context = existingEntry.pendingContext
        } else {
          const record = newSampleRecord(sample, question)
          try {
            const retrievalStart = now()
            const outcome = await runtime.retrieve(question.question)
            const retrievalLatencyMs = Math.max(0, now() - retrievalStart)
            // 最终 token 预算由注入的物化器施加；上下文文本与页序同源产出（§3.1）
            context = args.materialize(outcome.contextGroups)
            timeline?.markEvidenceReady()
            const metrics = record.metrics
            metrics.llmCalls = 1 + (outcome.retrievalLlmCalls ?? 0)
            metrics.rewrite = 0
            metrics.leafCount = runtime.leafCount
            if (outcome.retrievalLlmCalls !== undefined) metrics.retrievalLlmCalls = outcome.retrievalLlmCalls
            metrics.contextTruncated = context.truncated ? 1 : 0
            // 检索阶段就写下检索时延：续跑跳过检索时仍能从记录里恢复该分位数样本
            metrics.queryRewriteLatencyMs = 0
            metrics.retrievalLatencyMs = retrievalLatencyMs
            // 四个检索指标统一消费最终物化页序，不再事后反推候选包络
            applyRetrievalMetrics(metrics, {
              eligible,
              pageOrder: context.pageOrder,
              questionId: question.id,
              evidencePages: question.evidencePages,
              context: context.text,
            })
            // 非有效题照常记录运行诊断，但状态是 ineligible（不进检索质量分母），不是 completed
            record.retrievalStatus = eligible ? 'completed' : 'ineligible'
            record.retrievalQuery = question.question
            record.contextPageOrder = context.pageOrder
            record.contextTokenCount = context.tokenCount
            record.contextTruncated = context.truncated
            // selectedPages 仅是诊断包络（按检索器自报的页区间），真实页集合一律看 contextPageOrder
            record.selectedPages = outcome.selected ? expandPages(outcome.selected) : []
            records.push(record)
            // 检索完成即登记「待生成」断点并立刻落盘：即便随后生成失败或进程被杀，
            // 续跑也无需重跑检索（finally 里的 saveCheckpoint 只是常规兜底）
            entry = { record, pendingContext: context }
            entries.push(entry)
            entryById.set(record.id, entry)
            saveCheckpoint()
          } catch (e) {
            if (timeline && speedClient) record.speed = timeline.partial(speedClient.tokenSnapshot())
            // 检索失败：有效题补四个零观测，整题记 retrieve 错误；不登记断点，续跑时整题重试
            skipSampleRecord(record, eligible, eligible ? 'failed' : 'ineligible')
            records.push(record)
            errors.push({ sampleId: question.id, stage: 'retrieve', message: errorMessage(e) })
            continue
          }
        }

        const record = entry.record
        const metrics = record.metrics

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
          const generationStart = now()
          try {
            answer = args.generateAnswer
              ? await args.generateAnswer(systemPrompt, question.question)
              : await args.client.chat([{ role: 'system', content: systemPrompt }, { role: 'user', content: question.question }])
          } catch (e) {
            // 生成失败不得丢弃已落盘的检索指标与断点：pendingContext 保留，续跑直接重跑生成
            record.generationStatus = 'failed'
            record.judgeStatus = 'skipped'
            errors.push({ sampleId: question.id, stage: 'generate', message: errorMessage(e) })
            continue
          }
          answerGenerationLatencyMs = Math.max(0, now() - generationStart)
        }
        // 续跑路径的检索时延来自检索阶段写入记录的 metrics（检索本身不再重放）
        // queryEndToEndLatencyMs 只量本进程此次迭代：续跑题的检索发生在上一进程，端到端仅覆盖
        // 生成半程，故含续跑题的整轮 queryEndToEndLatencyP50/P95 天然偏低——这是「题内续跑」的
        // 固有口径，勿伪造一段检索时延来「修正」。
        const timing: PipelineTiming = {
          queryRewriteLatencyMs: 0,
          retrievalLatencyMs: metrics.retrievalLatencyMs ?? 0,
          answerGenerationLatencyMs,
          queryEndToEndLatencyMs: Math.max(0, now() - queryStart),
        }
        record.generationStatus = 'completed'
        record.answer = answer
        record.timing = { ...timing }
        // 端到端与阶段时延写入 metrics 让 aggregate 能产生均值；分位数由 withPercentiles
        // 从 perSample.timing 单独计算，不能把 P50/P95 误当均值。
        // 注意 retrievalLatencyMs 在此与检索阶段写入的值相同，是刻意重写而非「修正」：
        // 值取自记录 metrics，早期那次写入才是续跑跳过检索时恢复分位数样本的依据，勿删除。
        metrics.queryRewriteLatencyMs = timing.queryRewriteLatencyMs
        metrics.retrievalLatencyMs = timing.retrievalLatencyMs
        metrics.answerGenerationLatencyMs = timing.answerGenerationLatencyMs
        metrics.queryEndToEndLatencyMs = timing.queryEndToEndLatencyMs
        // 生成成功：清除待生成标记，断点只剩 record
        entry.pendingContext = undefined

        // ---------- 打分阶段（生成成功后才执行；异常不牵连检索指标与答案） ----------
        await runJudgeStage(record)
        args.onProgress?.({ processed: total, total: targetTotal, completed: completedCount(), errors: errors.length, sampleId: question.id, status: 'completed' })
      } finally {
        saveCheckpoint()
      }
    }
  }

  const finishedAt = new Date().toISOString()
  const currentStats = args.client.stats()
  const hits = priorCacheHits + currentStats.hits
  const misses = priorCacheMisses + currentStats.misses
  // 续跑时把上一轮的 LLM 网络时延并入分位数样本；stats 已单独累加，避免重复计入
  const mergedClient: LlmClient = { ...args.client, latencies: () => [...priorLlmLatencies, ...args.client.latencies()] }
  return finalizeQaResult({
    config: args.meta.config,
    contract: args.evaluationContract,
    records,
    perPaper,
    errors,
    client: mergedClient,
    model: args.model,
    judgeModel: args.judgeModel,
    hasJudgeClient: args.judgeClient !== undefined,
    judgeState,
    gitSha: args.gitSha,
    startedAt,
    finishedAt,
    runWallClockMs: elapsedBeforeResume + Math.max(0, now() - started),
    total,
    cacheHits: hits,
    cacheMisses: misses,
    retrievalAlgorithm: args.meta.retrievalAlgorithm,
    qasperEvidenceQuestions,
    mappedEvidenceQuestions,
    ambiguousEvidenceQuestions,
    unmappedEvidenceQuestions,
    extraMeta: { baselineFamily: args.meta.baselineFamily, candidateGranularity: args.retrieval.granularity },
    ...(args.speed ? { speed: { contract: args.speed.contract } } : {}),
  })
}
