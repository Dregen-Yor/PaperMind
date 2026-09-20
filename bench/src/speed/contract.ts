import { createHash } from 'node:crypto'
import { normalizeBaseUrl } from '../evaluationContract'
import { assertCompletedSpeedRecord } from './queryTimeline'
import type { PerSampleRecord } from '../types'
import { buildAnswerMessages } from '../../../src/utils/answerMessages'

export const SPEED_METRIC_SCHEMA_VERSION = 1 as const
export const SPEED_DEFINITION = 'query-timeline-v1' as const

export interface SpeedRunContract {
  speedMetricSchemaVersion: 1
  speedDefinition: 'query-timeline-v1'
  datasetFingerprint: string
  executedQuestionIdsHash: string
  streaming: true
  llmCacheEnabled: false
  queryConcurrency: 1
  retryAttempts: number
  answerModelIdentity: string
  answerFramingIdentityHash: string
  endpointIdentity: string
  generationSettingsHash: string
  executionEnvironmentFingerprint: string
}

export interface SpeedGenerationSettings {
  temperature: number
  maxTokens?: number
  stop?: string | string[]
}

export interface ExecutionEnvironment {
  platform: string
  arch: string
  nodeVersion: string
  backend: string
}

export interface BuildSpeedRunContractArgs {
  datasetFingerprint: string
  executedQuestionIds: string[]
  provider: string
  model: string
  baseUrl: string
  retryAttempts: number
  /** Exact base system prompt bytes passed to buildAnswerMessages, including any language instruction. */
  answerSystemPrompt: string
  generationSettings: SpeedGenerationSettings
  environment: Omit<ExecutionEnvironment, 'backend'>
  /** Set for a local provider that is not named Ollama. */
  localExecution?: boolean
  /** Injectable for deterministic tests; production defaults to process.env. */
  env?: Record<string, string | undefined>
}

export interface SpeedAggregationOptions {
  evidenceRequired?: boolean
}

export interface CompletedSpeedRecord extends PerSampleRecord {
  speed: NonNullable<PerSampleRecord['speed']>
}

export interface SpeedComparableResult {
  config: { name: string }
  meta: Partial<SpeedRunContract & {
    completedSpeedQuestionIdsHash: string
    completedSpeedQuestionCount: number
  }>
  metrics: Record<string, number>
}

const sha256 = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Executed order is part of the speed protocol, so this deliberately does not sort IDs. */
export function questionIdsHash(questionIds: readonly string[]): string {
  return sha256({
    domain: 'query-timeline-question-ids-v1',
    questionIds,
  })
}

export function answerModelIdentity(provider: string, model: string): string {
  return sha256({ provider, model })
}

/** Hashes the exact fixed message framing while replacing per-query data with domain sentinels. */
export function answerFramingIdentityHash(answerSystemPrompt: string): string {
  return sha256({
    domain: 'papermind-answer-framing-v1',
    messages: buildAnswerMessages(
      '__PAPERMIND_DYNAMIC_CONTEXT__',
      '__PAPERMIND_DYNAMIC_QUESTION__',
      [],
      answerSystemPrompt,
    ),
  })
}

/** Reuses the retrieval contract's credential-stripping endpoint normalization. */
export function speedEndpointIdentity(provider: string, baseUrl: string): string {
  return sha256({ provider, baseUrl: normalizeBaseUrl(baseUrl) })
}

export function generationSettingsHash(settings: SpeedGenerationSettings): string {
  return sha256({
    temperature: settings.temperature,
    maxTokens: settings.maxTokens ?? null,
    stop: settings.stop ?? null,
  })
}

/** Personal fields are intentionally ignored: only timing-relevant, non-sensitive environment data is hashed. */
export function executionEnvironmentFingerprint(environment: ExecutionEnvironment): string {
  return sha256({
    platform: environment.platform,
    arch: environment.arch,
    nodeVersion: environment.nodeVersion,
    backend: environment.backend,
  })
}

function executionBackend(args: BuildSpeedRunContractArgs): string {
  if (args.provider !== 'ollama' && !args.localExecution) return 'remote'
  const backend = (args.env ?? process.env).BENCH_EXECUTION_BACKEND?.trim()
  if (!backend) throw new Error('BENCH_EXECUTION_BACKEND is required for local/Ollama speed runs')
  return backend
}

export function buildSpeedRunContract(args: BuildSpeedRunContractArgs): SpeedRunContract {
  return {
    speedMetricSchemaVersion: SPEED_METRIC_SCHEMA_VERSION,
    speedDefinition: SPEED_DEFINITION,
    datasetFingerprint: args.datasetFingerprint,
    executedQuestionIdsHash: questionIdsHash(args.executedQuestionIds),
    streaming: true,
    llmCacheEnabled: false,
    queryConcurrency: 1,
    retryAttempts: args.retryAttempts,
    answerModelIdentity: answerModelIdentity(args.provider, args.model),
    answerFramingIdentityHash: answerFramingIdentityHash(args.answerSystemPrompt),
    endpointIdentity: speedEndpointIdentity(args.provider, args.baseUrl),
    generationSettingsHash: generationSettingsHash(args.generationSettings),
    executionEnvironmentFingerprint: executionEnvironmentFingerprint({
      ...args.environment,
      backend: executionBackend(args),
    }),
  }
}

/**
 * Filters records rather than repairing them: partial, failed, and malformed observations never enter a speed cohort.
 * `complete()` has already made malformed completed records fatal at their source; this defensive pass also keeps
 * externally constructed result JSON from silently contaminating aggregate values.
 */
export function completedSpeedRecords(
  records: PerSampleRecord[],
  options: SpeedAggregationOptions = {},
): CompletedSpeedRecord[] {
  const evidenceRequired = options.evidenceRequired ?? true
  return records.flatMap(record => {
    if (!record.speed) return []
    try {
      assertCompletedSpeedRecord(record.speed, evidenceRequired)
      return [{ ...record, speed: record.speed }]
    } catch {
      return []
    }
  })
}

/** Adds the speed contract and the exact completed-query denominator used by the aggregator to result metadata. */
export function speedContractMeta(
  contract: SpeedRunContract,
  records: PerSampleRecord[],
  options: SpeedAggregationOptions = {},
): SpeedRunContract & { completedSpeedQuestionIdsHash: string; completedSpeedQuestionCount: number } {
  const completed = completedSpeedRecords(records, options)
  return {
    ...contract,
    completedSpeedQuestionIdsHash: questionIdsHash(completed.map(record => record.id)),
    completedSpeedQuestionCount: completed.length,
  }
}

/**
 * Gates speed-time deltas independently from retrieval-quality comparison gates.
 * Token-accounting completeness is deliberately absent: it suppresses only token deltas, not valid time deltas.
 */
export function speedComparisonIssues(a: SpeedComparableResult, b: SpeedComparableResult): string[] {
  const issues: string[] = []
  const fields: Array<keyof SpeedComparableResult['meta']> = [
    'datasetFingerprint', 'executedQuestionIdsHash', 'completedSpeedQuestionIdsHash',
    'speedMetricSchemaVersion', 'speedDefinition', 'answerModelIdentity', 'endpointIdentity',
    'answerFramingIdentityHash', 'generationSettingsHash', 'retryAttempts', 'streaming', 'llmCacheEnabled',
    'queryConcurrency', 'executionEnvironmentFingerprint',
  ]

  for (const field of fields) {
    const av = a.meta[field]
    const bv = b.meta[field]
    if (av === undefined || bv === undefined) issues.push(`${field} 缺失`)
    else if (av !== bv) issues.push(`${field} 不一致`)
  }

  for (const result of [a, b]) {
    const completed = result.meta.completedSpeedQuestionCount
    const samples = result.metrics.speedSampleCount
    if (completed === undefined) issues.push(`${result.config.name} completedSpeedQuestionCount 缺失`)
    else if (samples === undefined) issues.push(`${result.config.name} speedSampleCount 缺失`)
    else if (samples !== completed) issues.push(`${result.config.name} speedSampleCount 与 completedSpeedQuestionCount 不一致`)
  }

  if (a.metrics.speedSampleCount !== undefined
    && b.metrics.speedSampleCount !== undefined
    && a.metrics.speedSampleCount !== b.metrics.speedSampleCount) {
    issues.push('speedSampleCount 不一致')
  }

  return [...new Set(issues)]
}
