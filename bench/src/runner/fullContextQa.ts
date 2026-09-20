import type { BenchConfig, BenchResult, EvalSample, PerSampleRecord, SampleError } from '../types'
import type { LlmClient } from '../llmClient'
import { answerF1, isRefusal, REFUSAL_PATTERN_VERSION } from '../metrics/answerF1'
import { aggregate, renameQaRates, withLatencyStats, withPercentiles } from '../metrics/aggregate'
import { estimateTokens } from '../metrics/retrieval'
import { MATH_FORMAT_INSTRUCTION } from '../../../src/utils/ragPipeline'
import { judgeAnswer, judgeUnanswerable, RUBRIC_VERSION } from '../metrics/judge'

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
}

/** 无 RAG 基线：完整论文仅作为 system context，user message 永远只含原始问题。 */
export async function runFullContextQaTask(args: FullContextQaArgs): Promise<BenchResult> {
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
    const system = `${args.systemPrompt}${language}\n\n${MATH_FORMAT_INSTRUCTION}\n\n参考内容：\n${paper}`
    for (const question of sample.questions) {
      if (args.limit !== undefined && total >= args.limit) break
      total++
      if (sample.source === 'qasper' && !question.unanswerable) { qasperEvidenceQuestions++; if (question.evidenceMapping === 'mapped') mappedEvidenceQuestions++; else if (question.evidenceMapping === 'ambiguous') ambiguousEvidenceQuestions++; else unmappedEvidenceQuestions++ }
      const questionStartedMs = now()
      try {
        const generationStartedMs = now()
        const answer = await args.client.chat([{ role: 'system', content: system }, { role: 'user', content: question.question }])
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
          if (verdict === null) usedPatternFallback = true
          metrics.unanswerableAccuracy = verdict === null ? (isRefusal(answer) ? 1 : 0) : (verdict ? 1 : 0)
        } else {
          metrics.answerF1 = answerF1(answer, question.answers)
          const evidence = question.evidencePages.map(p => sample.pages[p] ?? '').join('\n\n').trim()
          if (args.judgeClient && evidence) {
            const judged = await judgeAnswer({ question: question.question, evidence, answer, client: args.judgeClient })
            if (judged) Object.assign(metrics, { judgeFactuality: judged.factuality, judgeCompleteness: judged.completeness, judgeGroundedness: judged.groundedness })
          }
        }
        records.push({ id: question.id, paperId: sample.paperId, source: sample.source, metrics, timing, answer })
      } catch (error) {
        errors.push({ sampleId: question.id, stage: 'generate', message: error instanceof Error ? error.message : String(error) })
      }
    }
    if (args.limit !== undefined && total >= args.limit) break
  }

  const { hits: cacheHits, misses: cacheMisses } = args.client.stats()
  const timingValues = {
    retrievalLatency: records.map(r => r.timing!.retrievalLatencyMs),
    answerGenerationLatency: records.map(r => r.timing!.answerGenerationLatencyMs),
    queryEndToEndLatency: records.map(r => r.timing!.queryEndToEndLatencyMs),
    llmNetworkLatency: args.client.latencies(),
  }
  const finishedAt = new Date().toISOString()
  return {
    task: 'qa', config: args.config,
    meta: {
      model: args.model, ...(args.judgeModel ? { judgeModel: args.judgeModel } : {}), timestamp: finishedAt, startedAt, finishedAt,
      runWallClockMs: Math.max(0, now() - startedMs), cacheHits, cacheMisses,
      cacheHitRate: cacheHits + cacheMisses ? cacheHits / (cacheHits + cacheMisses) : 0,
      mode: 'full-context', retrievalAlgorithm: 'none', gitSha: args.gitSha, completed: records.length, total,
      // 全文直投是「回答模型能用全文时的效果上限」，不受 4096 受控预算约束（§5），
      // 因此不参与检索 MRR 横向排名。这是一份显式资格声明而非失败标记：
      // 缺了它，比较门禁只能靠「有没有 contextPageMrr」反推，full-context 会被算进检索排名。
      comparisonEligible: false,
      comparisonIneligibleReason: 'full-context-generation-ceiling',
      refusalPatternVersion: REFUSAL_PATTERN_VERSION, rubricVersion: RUBRIC_VERSION,
      ...(qasperEvidenceQuestions ? { evidenceMappingCoverage: mappedEvidenceQuestions / qasperEvidenceQuestions, ambiguousEvidenceRate: ambiguousEvidenceQuestions / qasperEvidenceQuestions, unmappedEvidenceRate: unmappedEvidenceQuestions / qasperEvidenceQuestions } : {}),
      ...(sawUnanswerable ? { unanswerableMethod: (args.judgeClient && !usedPatternFallback ? 'judge' : 'pattern') as 'judge' | 'pattern' } : {}),
    },
    metrics: withPercentiles(withLatencyStats(renameQaRates(aggregate(records)), args.client.latencies()), timingValues),
    perSample: records, errors,
  }
}
