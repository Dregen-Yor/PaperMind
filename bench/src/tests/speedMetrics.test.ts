import { describe, expect, it } from 'vitest'
import type { PerSampleRecord } from '../types'
import { questionIdsHash, speedContractMeta, type SpeedRunContract } from '../speed/contract'
import { aggregateSpeedMetrics } from '../speed/metrics'

function record(id: string, speed: PerSampleRecord['speed']): PerSampleRecord {
  return { id, paperId: id.split('#')[0], source: 'smoke', metrics: {}, speed }
}

const contract: SpeedRunContract = {
  speedMetricSchemaVersion: 2,
  speedDefinition: 'query-timeline-v2',
  datasetFingerprint: 'dataset',
  executedQuestionIdsHash: 'executed',
  streaming: true,
  llmCacheEnabled: false,
  queryConcurrency: 1,
  retryAttempts: 1,
  answerModelIdentity: 'model',
  answerFramingIdentityHash: 'framing',
  endpointIdentity: 'endpoint',
  generationSettingsHash: 'settings',
  executionEnvironmentFingerprint: 'environment',
}

describe('aggregateSpeedMetrics', () => {
  it('uses one completed retrieval cohort for all six time percentiles and online tokens', () => {
    const records = [
      record('p#0', { evidenceReadyLatencyMs: 10, timeToFirstTokenMs: 20, fullAnswerLatencyMs: 40, onlineTokenCount: 2, tokenAccountingComplete: true }),
      record('p#1', { evidenceReadyLatencyMs: 20, timeToFirstTokenMs: 30, fullAnswerLatencyMs: 60, onlineTokenCount: 4, tokenAccountingComplete: true }),
      record('p#2', { evidenceReadyLatencyMs: 100, timeToFirstTokenMs: 110, fullAnswerLatencyMs: 150, onlineTokenCount: 6, tokenAccountingComplete: true }),
      record('p#3', { evidenceReadyLatencyMs: 5, tokenAccountingComplete: false }),
      record('p#4', { evidenceReadyLatencyMs: 5, timeToFirstTokenMs: 8, tokenAccountingComplete: false }),
    ]

    expect(aggregateSpeedMetrics(records)).toEqual({
      evidenceReadyLatencyP50Ms: 20,
      evidenceReadyLatencyP95Ms: 100,
      timeToFirstTokenP50Ms: 30,
      timeToFirstTokenP95Ms: 110,
      fullAnswerLatencyP50Ms: 60,
      fullAnswerLatencyP95Ms: 150,
      avgOnlineTokensPerCompletedAnswer: 4,
      speedSampleCount: 3,
      onlineTokenSampleCount: 3,
    })
    expect(speedContractMeta(contract, records)).toMatchObject({
      completedSpeedQuestionCount: 3,
      completedSpeedQuestionIdsHash: questionIdsHash(['p#0', 'p#1', 'p#2']),
    })
  })

  it('withholds the token mean rather than averaging an accounting-complete subset', () => {
    const records = [
      record('p#0', { evidenceReadyLatencyMs: 10, timeToFirstTokenMs: 20, fullAnswerLatencyMs: 40, onlineTokenCount: 2, tokenAccountingComplete: true }),
      record('p#1', { evidenceReadyLatencyMs: 20, timeToFirstTokenMs: 30, fullAnswerLatencyMs: 60, tokenAccountingComplete: false }),
    ]

    expect(aggregateSpeedMetrics(records)).toMatchObject({ speedSampleCount: 2, onlineTokenSampleCount: 1 })
    expect(aggregateSpeedMetrics(records)).not.toHaveProperty('avgOnlineTokensPerCompletedAnswer')
  })

  it('emits only self-evidencing counts when no retrieval record completed', () => {
    expect(aggregateSpeedMetrics([
      record('p#0', { evidenceReadyLatencyMs: 10, tokenAccountingComplete: false }),
      record('p#1', { tokenAccountingComplete: false }),
    ])).toEqual({ speedSampleCount: 0, onlineTokenSampleCount: 0 })
  })

  it('aggregates full-context with TTFT and Full Answer only', () => {
    const records = [
      record('p#0', { timeToFirstTokenMs: 20, fullAnswerLatencyMs: 50, onlineTokenCount: 5, tokenAccountingComplete: true }),
      record('p#1', { timeToFirstTokenMs: 30, fullAnswerLatencyMs: 80, tokenAccountingComplete: false }),
      record('p#2', { timeToFirstTokenMs: 10, tokenAccountingComplete: false }),
    ]

    const metrics = aggregateSpeedMetrics(records, { evidenceRequired: false })
    expect(metrics).toMatchObject({
      timeToFirstTokenP50Ms: 20,
      timeToFirstTokenP95Ms: 30,
      fullAnswerLatencyP50Ms: 50,
      fullAnswerLatencyP95Ms: 80,
      speedSampleCount: 2,
      onlineTokenSampleCount: 1,
    })
    expect(metrics).not.toHaveProperty('evidenceReadyLatencyP50Ms')
    expect(metrics).not.toHaveProperty('evidenceReadyLatencyP95Ms')
    expect(metrics).not.toHaveProperty('avgOnlineTokensPerCompletedAnswer')
    expect(speedContractMeta(contract, records, { evidenceRequired: false })).toMatchObject({
      completedSpeedQuestionIdsHash: questionIdsHash(['p#0', 'p#1']),
      completedSpeedQuestionCount: 2,
    })
  })
})
