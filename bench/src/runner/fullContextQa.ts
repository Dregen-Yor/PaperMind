import type { BenchConfig, BenchResult, EvalSample, PerSampleRecord, SampleError } from '../types'
import type { LlmClient, StreamingLlmClient } from '../llmClient'
import { REFUSAL_PATTERN_VERSION } from '../metrics/answerF1'
import { aggregate, renameQaRates, withLatencyStats, withPercentiles } from '../metrics/aggregate'
import { estimateTokens } from '../metrics/retrieval'
import { buildAnswerMessages } from '../../../src/utils/ragPipeline'
import { RUBRIC_VERSION } from '../metrics/judge'
import { startQueryTimeline } from '../speed/queryTimeline'
import { assertSpeedAnswerClient } from '../speed/policy'
import { aggregateSpeedMetrics } from '../speed/metrics'
import { speedContractMeta } from '../speed/contract'
import { generateSpeedAnswer, type SpeedRunnerOptions } from '../speed/generate'
import { executedQuestions } from '../evaluationContract'
import { finalizeQaQuality } from '../metrics/qaQuality'
import { judgeSample, type JudgeSampleState } from '../metrics/judge'
import { newSampleRecord } from './support'

export interface FullContextQaArgs {
  samples: EvalSample[]
  config: BenchConfig
  client: LlmClient
  systemPrompt: string
  answerLanguageInstruction?: string
  limit?: number
  gitSha: string
  model: string
  judgeClient?: LlmClient
  judgeModel?: string
  now?: () => number
  /** 提供时流式测量全文直投的生成上限；它不代表任何检索阶段。 */
  speed?: SpeedRunnerOptions
}

/** 无 RAG 基线：完整论文仅作为 system context，user message 永远只含原始问题。 */
export async function runFullContextQaTask(args: FullContextQaArgs): Promise<BenchResult> {
  if (args.speed) assertSpeedAnswerClient(args.client as StreamingLlmClient)
  const now = args.now ?? Date.now
  const startedAt = new Date().toISOString()
  const startedMs = now()
  const records: PerSampleRecord[] = []
  const errors: SampleError[] = []
  let total = 0
  const judgeState: JudgeSampleState = { sawUnanswerable: false, usedPatternFallback: false }
  const qualityQuestions = executedQuestions(args.samples, args.limit)
    .filter(({ sample }) => sample.source === 'qasper')
    .map(({ question }) => question)
  let qasperEvidenceQuestions = 0; let mappedEvidenceQuestions = 0; let ambiguousEvidenceQuestions = 0; let unmappedEvidenceQuestions = 0
  const language = args.answerLanguageInstruction ? `\n\n${args.answerLanguageInstruction}` : ''

  for (const sample of args.samples) {
    if (args.limit !== undefined && total >= args.limit) break
    const paper = sample.pages.join('\n\n')
    const paperTokens = estimateTokens(paper)
    const baseSystemPrompt = `${args.systemPrompt}${language}`
    for (const question of sample.questions) {
      if (args.limit !== undefined && total >= args.limit) break
      total++
      if (sample.source === 'qasper' && !question.unanswerable) { qasperEvidenceQuestions++; if (question.evidenceMapping === 'mapped') mappedEvidenceQuestions++; else if (question.evidenceMapping === 'ambiguous') ambiguousEvidenceQuestions++; else unmappedEvidenceQuestions++ }
      // t0 is query entrance: online prompt assembly belongs to the query timeline.
      // Per-paper preparation above is shared index/document work and stays outside it.
      const speedClient = args.speed ? args.client as StreamingLlmClient : undefined
      const timeline = speedClient && args.speed
        ? startQueryTimeline(args.speed.now ?? now, speedClient.tokenSnapshot())
        : undefined
      const questionStartedMs = now()
      const record = newSampleRecord(sample, question)
      records.push(record)
      // 与其他最终回答路径共用 builder；每题只构造一次报文。
      const messages = buildAnswerMessages(paper, question.question, [], baseSystemPrompt)
      const generationStartedMs = now()
      let answer: string
      if (args.speed && speedClient && timeline) {
        try {
          answer = await generateSpeedAnswer({
            context: paper,
            question: question.question,
            systemPrompt: baseSystemPrompt,
            messages,
            timeline,
            client: speedClient,
            record,
            streamAnswer: args.speed.streamAnswer,
            evidenceRequired: false,
          })
        } catch (error) {
          // Stream failures attach a partial record; completion-invariant failures do not and
          // invalidate the run rather than becoming an ordinary failed sample.
          if (record.speed === undefined) throw error
          record.generationStatus = 'failed'
          record.judgeStatus = 'skipped'
          errors.push({ sampleId: question.id, stage: 'stream', message: error instanceof Error ? error.message : String(error) })
          continue
        }
      } else {
        try {
          answer = await args.client.chat(messages)
        } catch (error) {
          record.generationStatus = 'failed'
          record.judgeStatus = 'skipped'
          errors.push({ sampleId: question.id, stage: 'generate', message: error instanceof Error ? error.message : String(error) })
          continue
        }
      }
      const answerGenerationLatencyMs = Math.max(0, now() - generationStartedMs)
      const timing = {
        queryRewriteLatencyMs: 0,
        retrievalLatencyMs: 0,
        answerGenerationLatencyMs,
        queryEndToEndLatencyMs: Math.max(0, now() - questionStartedMs),
      }
      Object.assign(record.metrics, {
        llmCalls: 1,
        rewrite: 0,
        leafCount: 0,
        contextTokens: paperTokens,
        ...timing,
      })
      record.timing = timing
      record.answer = answer
      record.generationStatus = 'completed'

      const evidenceText = question.evidencePages.map(p => sample.pages[p] ?? '').join('\n\n').trim()
      try {
        await judgeSample({
          question,
          answer,
          evidenceText,
          judgeClient: args.judgeClient,
          metrics: record.metrics,
          record,
          state: judgeState,
        })
        if (record.judgeStatus === 'failed') {
          errors.push({
            sampleId: question.id,
            stage: 'judge',
            message: question.unanswerable
              ? 'judge returned no valid refusal verdict'
              : 'judge returned no valid answer scores',
          })
        }
      } catch (error) {
        record.judgeStatus = 'failed'
        errors.push({ sampleId: question.id, stage: 'judge', message: error instanceof Error ? error.message : String(error) })
      }
    }
    if (args.limit !== undefined && total >= args.limit) break
  }

  const { hits: cacheHits, misses: cacheMisses } = args.client.stats()
  const timingValues = {
    retrievalLatency: records.flatMap(r => r.timing ? [r.timing.retrievalLatencyMs] : []),
    answerGenerationLatency: records.flatMap(r => r.timing ? [r.timing.answerGenerationLatencyMs] : []),
    queryEndToEndLatency: records.flatMap(r => r.timing ? [r.timing.queryEndToEndLatencyMs] : []),
    llmNetworkLatency: args.client.latencies(),
  }
  const finishedAt = new Date().toISOString()
  const quality = qualityQuestions.length > 0 ? finalizeQaQuality(records, qualityQuestions) : undefined
  const qualityMetrics = {
    ...withPercentiles(withLatencyStats(renameQaRates(aggregate(records)), args.client.latencies()), timingValues),
    ...quality?.metrics,
  }
  if (args.speed) Object.assign(qualityMetrics, aggregateSpeedMetrics(records, { evidenceRequired: false }))
  return {
    task: 'qa', config: args.config,
    meta: {
      model: args.model, ...(args.judgeModel ? { judgeModel: args.judgeModel } : {}), timestamp: finishedAt, startedAt, finishedAt,
      runWallClockMs: Math.max(0, now() - startedMs), cacheHits, cacheMisses,
      cacheHitRate: cacheHits + cacheMisses ? cacheHits / (cacheHits + cacheMisses) : 0,
      mode: 'full-context', retrievalAlgorithm: 'none', gitSha: args.gitSha, completed: records.filter(record => record.generationStatus === 'completed').length, total,
      // 全文直投是「回答模型能用全文时的效果上限」，不受 4096 受控预算约束（§5），
      // 因此不参与检索 MRR 横向排名。这是一份显式资格声明而非失败标记：
      // 缺了它，比较门禁只能靠「有没有 contextPageMrr」反推，full-context 会被算进检索排名。
      comparisonEligible: false,
      comparisonIneligibleReason: 'full-context-generation-ceiling',
      refusalPatternVersion: REFUSAL_PATTERN_VERSION, rubricVersion: RUBRIC_VERSION,
      ...(args.speed ? speedContractMeta(args.speed.contract, records, { evidenceRequired: false }) : {}),
      ...quality?.meta,
      ...(qasperEvidenceQuestions ? { evidenceMappingCoverage: mappedEvidenceQuestions / qasperEvidenceQuestions, ambiguousEvidenceRate: ambiguousEvidenceQuestions / qasperEvidenceQuestions, unmappedEvidenceRate: unmappedEvidenceQuestions / qasperEvidenceQuestions } : {}),
      ...(judgeState.sawUnanswerable ? { unanswerableMethod: (args.judgeClient && !judgeState.usedPatternFallback ? 'judge' : 'pattern') as 'judge' | 'pattern' } : {}),
    },
    metrics: qualityMetrics,
    perSample: records, errors,
  }
}
