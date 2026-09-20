import type { BenchConfig, BenchResult, EvalSample, PerSampleRecord, SampleError } from '../types'
import type { LlmClient, StreamingLlmClient } from '../llmClient'
import { answerF1, isRefusal, REFUSAL_PATTERN_VERSION } from '../metrics/answerF1'
import { aggregate, renameQaRates, withLatencyStats, withPercentiles } from '../metrics/aggregate'
import { estimateTokens } from '../metrics/retrieval'
import { buildAnswerMessages } from '../../../src/utils/ragPipeline'
import { judgeAnswer, judgeUnanswerable, RUBRIC_VERSION } from '../metrics/judge'
import { startQueryTimeline } from '../speed/queryTimeline'
import { assertSpeedAnswerClient } from '../speed/policy'
import { aggregateSpeedMetrics } from '../speed/metrics'
import { speedContractMeta } from '../speed/contract'
import { generateSpeedAnswer, type SpeedRunnerOptions } from '../speed/generate'

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
  let sawUnanswerable = false
  let usedPatternFallback = false
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
      const questionStartedMs = now()
      // 与其他最终回答路径共用 builder；t0 必须在完整报文准备好之后。
      const messages = buildAnswerMessages(paper, question.question, [], baseSystemPrompt)
      const generationStartedMs = now()
      let answer: string
      let speed: PerSampleRecord['speed']
      if (args.speed) {
        const speedClient = args.client as StreamingLlmClient
        const before = speedClient.tokenSnapshot()
        const timeline = startQueryTimeline(args.speed.now ?? now, before)
        const speedRecord: PerSampleRecord = {
          id: question.id,
          paperId: sample.paperId,
          source: sample.source,
          metrics: {},
        }
        try {
          answer = await generateSpeedAnswer({
            context: paper,
            question: question.question,
            systemPrompt: baseSystemPrompt,
            messages,
            timeline,
            client: speedClient,
            record: speedRecord,
            streamAnswer: args.speed.streamAnswer,
            evidenceRequired: false,
          })
        } catch (error) {
          // Stream failures attach a partial record; completion-invariant failures do not and
          // invalidate the run rather than becoming an ordinary failed sample.
          if (speedRecord.speed === undefined) throw error
          speedRecord.generationStatus = 'failed'
          speedRecord.judgeStatus = 'skipped'
          records.push(speedRecord)
          errors.push({ sampleId: question.id, stage: 'stream', message: error instanceof Error ? error.message : String(error) })
          continue
        }
        speed = speedRecord.speed
      } else {
        try {
          answer = await args.client.chat(messages)
        } catch (error) {
          errors.push({ sampleId: question.id, stage: 'generate', message: error instanceof Error ? error.message : String(error) })
          continue
        }
      }
      try {
        const answerGenerationLatencyMs = Math.max(0, now() - generationStartedMs)
        const timing = {
          queryRewriteLatencyMs: 0,
          retrievalLatencyMs: 0,
          answerGenerationLatencyMs,
          queryEndToEndLatencyMs: Math.max(0, now() - questionStartedMs),
        }
        const metrics: Record<string, number> = {
          llmCalls: 1,
          rewrite: 0,
          leafCount: 0,
          contextTokens: paperTokens,
          ...timing,
        }
        if (question.unanswerable) {
          sawUnanswerable = true
          const verdict = args.judgeClient ? await judgeUnanswerable({ question: question.question, answer, client: args.judgeClient }) : null
          if (verdict === null) {
            usedPatternFallback = true
            if (args.judgeClient) {
              errors.push({ sampleId: question.id, stage: 'judge', message: 'judge returned no valid refusal verdict' })
            }
          }
          metrics.unanswerableAccuracy = verdict === null ? (isRefusal(answer) ? 1 : 0) : (verdict ? 1 : 0)
        } else {
          metrics.answerF1 = answerF1(answer, question.answers)
          const evidence = question.evidencePages.map(p => sample.pages[p] ?? '').join('\n\n').trim()
          if (args.judgeClient && evidence) {
            const judged = await judgeAnswer({ question: question.question, evidence, answer, client: args.judgeClient })
            if (judged) Object.assign(metrics, { judgeFactuality: judged.factuality, judgeCompleteness: judged.completeness, judgeGroundedness: judged.groundedness })
            else errors.push({ sampleId: question.id, stage: 'judge', message: 'judge returned no valid answer scores' })
          }
        }
        records.push({ id: question.id, paperId: sample.paperId, source: sample.source, metrics, timing, answer, ...(speed ? { speed } : {}) })
      } catch (error) {
        errors.push({ sampleId: question.id, stage: 'generate', message: error instanceof Error ? error.message : String(error) })
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
  const qualityMetrics = withPercentiles(withLatencyStats(renameQaRates(aggregate(records)), args.client.latencies()), timingValues)
  if (args.speed) Object.assign(qualityMetrics, aggregateSpeedMetrics(records, { evidenceRequired: false }))
  return {
    task: 'qa', config: args.config,
    meta: {
      model: args.model, ...(args.judgeModel ? { judgeModel: args.judgeModel } : {}), timestamp: finishedAt, startedAt, finishedAt,
      runWallClockMs: Math.max(0, now() - startedMs), cacheHits, cacheMisses,
      cacheHitRate: cacheHits + cacheMisses ? cacheHits / (cacheHits + cacheMisses) : 0,
      mode: 'full-context', retrievalAlgorithm: 'none', gitSha: args.gitSha, completed: records.filter(record => record.generationStatus !== 'failed').length, total,
      // 全文直投是「回答模型能用全文时的效果上限」，不受 4096 受控预算约束（§5），
      // 因此不参与检索 MRR 横向排名。这是一份显式资格声明而非失败标记：
      // 缺了它，比较门禁只能靠「有没有 contextPageMrr」反推，full-context 会被算进检索排名。
      comparisonEligible: false,
      comparisonIneligibleReason: 'full-context-generation-ceiling',
      refusalPatternVersion: REFUSAL_PATTERN_VERSION, rubricVersion: RUBRIC_VERSION,
      ...(args.speed ? speedContractMeta(args.speed.contract, records, { evidenceRequired: false }) : {}),
      ...(qasperEvidenceQuestions ? { evidenceMappingCoverage: mappedEvidenceQuestions / qasperEvidenceQuestions, ambiguousEvidenceRate: ambiguousEvidenceQuestions / qasperEvidenceQuestions, unmappedEvidenceRate: unmappedEvidenceQuestions / qasperEvidenceQuestions } : {}),
      ...(sawUnanswerable ? { unanswerableMethod: (args.judgeClient && !usedPatternFallback ? 'judge' : 'pattern') as 'judge' | 'pattern' } : {}),
    },
    metrics: qualityMetrics,
    perSample: records, errors,
  }
}
