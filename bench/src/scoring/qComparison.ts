import type { BenchResult, PerSampleRecord } from '../types'
import { aggregateQaQuality, QA_QUALITY_DEFINITION } from '../metrics/qaQuality'
import { qasperAnswerF1 } from '../metrics/qasperQuality'
import { aggregateSpeedMetrics } from '../speed/metrics'
import { questionIdsHash, speedComparisonIssues, SPEED_DEFINITION, SPEED_METRIC_SCHEMA_VERSION } from '../speed/contract'
import { assertCompletedSpeedRecord } from '../speed/queryTimeline'
import { calculateQ, parseQConfig, type QComponents, type QConfig } from './qScore'

export interface QComparison {
  schemaVersion: 1
  config: QConfig
  score: number | null
  reasons: string[]
  reference: QComponents | null
  candidate: QComponents | null
}

const identityStrings = [
  'datasetFingerprint', 'executedQuestionIdsHash', 'completedSpeedQuestionIdsHash',
  'answerModelIdentity', 'answerFramingIdentityHash', 'endpointIdentity',
  'generationSettingsHash', 'executionEnvironmentFingerprint',
] as const

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function sameNumber(actual: unknown, expected: number): boolean {
  return finite(actual) && actual === expected
}

function inspectResult(raw: unknown, label: string, reasons: string[]): QComponents | null {
  const issue = (message: string) => reasons.push(`${label}: ${message}`)
  if (!object(raw) || !object(raw.meta) || !object(raw.config) || !object(raw.metrics) || !Array.isArray(raw.perSample)) {
    issue('result needs meta, config, metrics, and perSample')
    return null
  }
  const result = raw as unknown as BenchResult
  const { meta, metrics, perSample } = result
  if (result.task !== 'qa') issue('task must be qa')
  if (typeof result.config.name !== 'string' || !result.config.name.trim()) issue('config.name must be nonempty')
  if (meta.qaQualityDefinition !== QA_QUALITY_DEFINITION) issue(`qaQualityDefinition must be ${QA_QUALITY_DEFINITION}`)
  if (meta.speedMetricSchemaVersion !== SPEED_METRIC_SCHEMA_VERSION || meta.speedDefinition !== SPEED_DEFINITION) {
    issue('speedMetricSchemaVersion 2 and speedDefinition query-timeline-v2 are required')
  }
  if (meta.streaming !== true || meta.llmCacheEnabled !== false || meta.queryConcurrency !== 1) {
    issue('speed requires streaming true, llmCacheEnabled false, queryConcurrency 1')
  }
  for (const key of identityStrings) {
    if (typeof meta[key] !== 'string' || !meta[key]?.trim()) issue(`${key} must be a nonempty string`)
  }
  if (!Number.isInteger(meta.retryAttempts) || meta.retryAttempts! < 0) issue('retryAttempts must be a nonnegative integer')
  if (!Number.isInteger(meta.total) || meta.total <= 0) issue('meta.total must be a positive integer')
  if (!Number.isInteger(meta.completed) || meta.completed < 0) issue('meta.completed must be a nonnegative integer')
  if (!Number.isInteger(meta.completedSpeedQuestionCount) || meta.completedSpeedQuestionCount! < 0) {
    issue('completedSpeedQuestionCount must be a nonnegative integer')
  }
  const ids = meta.qaExpectedQuestionIds
  if (!Array.isArray(ids) || ids.length === 0 || ids.some(id => typeof id !== 'string' || !id.trim()) || new Set(ids).size !== ids.length) {
    issue('qaExpectedQuestionIds must be a nonempty unique string array')
    return null
  }
  if (ids.length !== meta.total) issue('qaExpectedQuestionIds count differs from meta.total')
  if (meta.executedQuestionIdsHash !== questionIdsHash(ids)) issue('executedQuestionIdsHash differs from qaExpectedQuestionIds')
  if (perSample.some(row => !object(row) || !object(row.metrics) || typeof row.id !== 'string')) {
    issue('perSample rows require id and metrics object')
    return null
  }
  const byId = new Map<string, PerSampleRecord>()
  const expected = new Set(ids)
  for (const row of perSample) {
    if (!expected.has(row.id)) issue(`unexpected perSample id ${row.id}`)
    if (byId.has(row.id)) issue(`duplicate perSample id ${row.id}`)
    byId.set(row.id, row)
  }
  for (const id of ids) if (!byId.has(id)) issue(`missing perSample id ${id}`)
  if (byId.size !== ids.length || reasons.some(reason => reason.startsWith(`${label}:`) && /perSample/.test(reason))) return null

  let completed = 0
  const speedRows: PerSampleRecord[] = []
  for (const id of ids) {
    const row = byId.get(id)!
    if (row.source !== 'qasper') issue(`${id} source must be qasper`)
    if (!Array.isArray(row.referenceAnswers) || row.referenceAnswers.length === 0
      || row.referenceAnswers.some(answer => typeof answer !== 'string' || !answer.trim())) {
      issue(`${id} referenceAnswers must be nonempty valid strings`)
    }
    if (row.generationStatus === 'completed') {
      completed++
      if (typeof row.answer !== 'string') issue(`${id} completed answer must be a string`)
      else if (Array.isArray(row.referenceAnswers) && row.referenceAnswers.length > 0
        && row.referenceAnswers.every(answer => typeof answer === 'string' && answer.trim())) {
        if (!sameNumber(row.metrics.answerF1AllQuestions, qasperAnswerF1(row.answer, row.referenceAnswers))) {
          issue(`${id} answerF1AllQuestions differs from recomputed QASPER F1`)
        }
      }
      if (!object(row.speed)) issue(`${id} completed speed timeline is missing`)
      else {
        try {
          assertCompletedSpeedRecord(row.speed, meta.mode !== 'full-context')
          speedRows.push(row)
        } catch (error) {
          issue(`${id} ${error instanceof Error ? error.message : 'invalid speed timeline'}`)
        }
      }
    } else if (row.generationStatus === 'failed' || row.generationStatus === 'skipped') {
      if (row.metrics.answerF1AllQuestions !== 0) issue(`${id} failed/skipped answerF1AllQuestions must be zero`)
    } else issue(`${id} invalid generationStatus`)
    if (!finite(row.metrics.answerF1AllQuestions) || row.metrics.answerF1AllQuestions < 0 || row.metrics.answerF1AllQuestions > 1) {
      issue(`${id} answerF1AllQuestions must be finite in [0,1]`)
    }
  }
  if (meta.completed !== completed) issue('meta.completed differs from completed generation rows')
  if (speedRows.length !== completed) issue('completed speed cohort is incomplete')
  if (completed === 0) issue('completed speed cohort is empty')
  const speedIds = speedRows.map(row => row.id)
  if (meta.completedSpeedQuestionIdsHash !== questionIdsHash(speedIds)) issue('completedSpeedQuestionIdsHash differs from completed rows')
  if (meta.completedSpeedQuestionCount !== speedRows.length) issue('completedSpeedQuestionCount differs from completed rows')
  if (reasons.some(reason => reason.startsWith(`${label}:`) && /referenceAnswers|invalid generationStatus|answerF1AllQuestions must|completed answer/.test(reason))) return null

  try {
    const quality = aggregateQaQuality(perSample, ids)
    for (const [key, expectedValue] of Object.entries(quality)) {
      if (!sameNumber(metrics[key], expectedValue)) issue(`${key} differs from recomputed quality aggregate`)
    }
  } catch (error) {
    issue(error instanceof Error ? error.message : 'invalid quality aggregate')
  }
  const speed = aggregateSpeedMetrics(speedRows, { evidenceRequired: meta.mode !== 'full-context' })
  const speedKeys = new Set([...Object.keys(speed), ...Object.keys(metrics).filter(key => /^(speedSampleCount|onlineTokenSampleCount|timeToFirstToken|fullAnswerLatency|avgOnlineTokens|evidenceReadyLatency)/.test(key))])
  for (const key of speedKeys) {
    if (!(key in speed) || !sameNumber(metrics[key], speed[key])) issue(`${key} differs from recomputed speed aggregate`)
  }
  const answerF1 = metrics.answerF1AllQuestions
  const ttftP50 = metrics.timeToFirstTokenP50Ms
  const ttftP95 = metrics.timeToFirstTokenP95Ms
  if (!finite(answerF1) || answerF1 < 0 || answerF1 > 1) issue('answerF1AllQuestions must be finite in [0,1]')
  if (!finite(ttftP50) || ttftP50 <= 0) issue('timeToFirstTokenP50Ms must be positive finite')
  if (!finite(ttftP95) || ttftP95 <= 0 || ttftP95 < ttftP50) issue('timeToFirstTokenP95Ms must be finite and >= P50')
  return reasons.some(reason => reason.startsWith(`${label}:`))
    ? null : { answerF1, ttftP50, ttftP95 }
}

export function buildQComparison(reference: BenchResult, candidate: BenchResult, input: QConfig): QComparison {
  const config = parseQConfig(input)
  const reasons: string[] = []
  const referenceComponents = inspectResult(reference, 'reference', reasons)
  const candidateComponents = inspectResult(candidate, 'candidate', reasons)
  if (reference?.meta?.mode !== 'full-context') reasons.push('reference: mode must be full-context')
  if (referenceComponents && candidateComponents) {
    const referenceRows = new Map(reference.perSample.map(row => [row.id, row]))
    for (const row of candidate.perSample) {
      if (JSON.stringify(referenceRows.get(row.id)?.referenceAnswers) !== JSON.stringify(row.referenceAnswers)) {
        reasons.push(`referenceAnswers differ for ${row.id}`)
      }
    }
    reasons.push(...speedComparisonIssues(reference, candidate))
  }
  if (referenceComponents?.answerF1 === 0) reasons.push('reference answerF1AllQuestions must be greater than zero')
  let score: number | null = null
  if (reasons.length === 0 && referenceComponents && candidateComponents) {
    try {
      score = calculateQ(candidateComponents, referenceComponents, config)
    } catch (error) {
      reasons.push(error instanceof Error ? error.message : 'invalid Q components')
    }
  }
  return { schemaVersion: 1, config, score, reasons: [...new Set(reasons)], reference: referenceComponents, candidate: candidateComponents }
}
