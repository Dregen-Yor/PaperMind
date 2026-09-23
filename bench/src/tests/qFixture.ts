import type { BenchResult } from '../types'
import { aggregateSpeedMetrics } from '../speed/metrics'
import { questionIdsHash } from '../speed/contract'
import type { QConfig } from '../scoring/qScore'

export const qConfig: QConfig = {
  schemaVersion: 1, formula: 'weighted-geometric-relative-v1', baselineMode: 'full-context',
  weights: { answerF1: 0.6, ttftP50: 0.2, ttftP95: 0.2 },
}

export function qFixture(name: string, mode: 'rag' | 'full-context' = 'rag'): BenchResult {
  const evidence = mode === 'rag'
  const perSample: BenchResult['perSample'] = [
    { id: 'q1', paperId: 'p', source: 'qasper', generationStatus: 'completed', answer: 'yes', referenceAnswers: ['yes'], metrics: { answerF1AllQuestions: 1 }, speed: { ...(evidence ? { evidenceReadyLatencyMs: 20 } : {}), timeToFirstTokenMs: 100, fullAnswerLatencyMs: 200, onlineTokenCount: 10, tokenAccountingComplete: true } },
    { id: 'q2', paperId: 'p', source: 'qasper', generationStatus: 'completed', answer: 'no', referenceAnswers: ['yes'], metrics: { answerF1AllQuestions: 0 }, speed: { ...(evidence ? { evidenceReadyLatencyMs: 40 } : {}), timeToFirstTokenMs: 200, fullAnswerLatencyMs: 300, onlineTokenCount: 10, tokenAccountingComplete: true } },
  ]
  return {
    task: 'qa', config: { name }, perSample, errors: [],
    meta: {
      model: 'model', timestamp: '2026-09-23', gitSha: 'abc', completed: 2, total: 2, mode,
      qaQualityDefinition: 'qasper-all-questions-v1', qaExpectedQuestionIds: ['q1', 'q2'],
      speedMetricSchemaVersion: 2, speedDefinition: 'query-timeline-v2',
      datasetFingerprint: 'dataset', executedQuestionIdsHash: questionIdsHash(['q1', 'q2']),
      completedSpeedQuestionIdsHash: questionIdsHash(['q1', 'q2']), completedSpeedQuestionCount: 2,
      streaming: true, llmCacheEnabled: false, queryConcurrency: 1, retryAttempts: 0,
      answerModelIdentity: 'model-id', answerFramingIdentityHash: 'framing', endpointIdentity: 'endpoint',
      generationSettingsHash: 'params', executionEnvironmentFingerprint: 'environment',
    },
    metrics: { answerF1AllQuestions: 0.5, answerF1AllQuestionsSampleCount: 2, qaCompletionRate: 1,
      ...aggregateSpeedMetrics(perSample, { evidenceRequired: evidence }) },
  }
}
