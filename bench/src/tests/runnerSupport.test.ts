import { describe, expect, it } from 'vitest'
import type { EvaluationContract } from '../evaluationContract'
import type { LlmClient } from '../llmClient'
import type { FinalizeQaArgs } from '../runner/support'
import { finalizeQaResult } from '../runner/support'
import { questionIdsHash, type SpeedRunContract } from '../speed/contract'
import type { PerSampleRecord } from '../types'

const evaluationContract: EvaluationContract = {
  metricSchemaVersion: 2,
  mrrDefinition: 'context-page-v1',
  contextBudgetTokens: 4096,
  contextTokenizer: 'BAAI/bge-m3',
  contextTokenizerRevision: 'main',
  evidenceMappingVersion: 'page-evidence-v1',
  datasetFingerprint: 'dataset',
  eligibleRetrievalQuestionIdsHash: 'eligible',
  eligibleRetrievalQuestionCount: 1,
}

const speedContract: SpeedRunContract = {
  speedMetricSchemaVersion: 1,
  speedDefinition: 'query-timeline-v1',
  datasetFingerprint: 'dataset',
  executedQuestionIdsHash: 'executed',
  streaming: true,
  llmCacheEnabled: false,
  queryConcurrency: 1,
  retryAttempts: 1,
  answerModelIdentity: 'answer-model',
  answerFramingIdentityHash: 'answer-framing',
  endpointIdentity: 'endpoint',
  generationSettingsHash: 'settings',
  executionEnvironmentFingerprint: 'environment',
}

const client: LlmClient = {
  complete: async () => '',
  chat: async () => '',
  stats: () => ({ hits: 2, misses: 3 }),
  latencies: () => [17],
  requestTimings: () => [],
}

function qualityRecord(): PerSampleRecord {
  return {
    id: 'p#0',
    paperId: 'p',
    source: 'smoke',
    metrics: {
      evidenceRecall: 1,
      evidenceHit: 1,
      contextPrecision: 0.5,
      contextPageMrr: 1,
      answerF1: 0.75,
    },
    timing: {
      queryRewriteLatencyMs: 3,
      retrievalLatencyMs: 11,
      answerGenerationLatencyMs: 13,
      queryEndToEndLatencyMs: 29,
    },
    retrievalStatus: 'completed',
    generationStatus: 'completed',
    judgeStatus: 'skipped',
  }
}

function finalizeArgs(records: PerSampleRecord[]): FinalizeQaArgs {
  return {
    config: { name: 'fixture' },
    contract: evaluationContract,
    records,
    perPaper: [{
      paperId: 'p',
      source: 'smoke',
      pageCount: 1,
      questionCount: 1,
      indexBuildLatencyMs: 7,
    }],
    errors: [],
    client,
    model: 'model',
    hasJudgeClient: false,
    judgeState: { sawUnanswerable: false, usedPatternFallback: false },
    gitSha: 'sha',
    startedAt: '2026-09-19T00:00:00.000Z',
    finishedAt: '2026-09-19T00:00:01.000Z',
    runWallClockMs: 1000,
    total: records.length,
    cacheHits: 2,
    cacheMisses: 3,
    retrievalAlgorithm: 'papermind-llm',
    qasperEvidenceQuestions: 0,
    mappedEvidenceQuestions: 0,
    ambiguousEvidenceQuestions: 0,
    unmappedEvidenceQuestions: 0,
  }
}

describe('finalizeQaResult speed hook', () => {
  it('keeps pre-speed quality metrics byte-for-byte unchanged when speed is absent', () => {
    const result = finalizeQaResult(finalizeArgs([qualityRecord()]))

    expect(JSON.stringify(result.metrics)).toBe(JSON.stringify({
      evidenceRecall: 1,
      evidenceHitRate: 1,
      contextPrecision: 0.5,
      contextPageMrr: 1,
      answerF1: 0.75,
      evidenceRecallSampleCount: 1,
      evidenceHitSampleCount: 1,
      contextPrecisionSampleCount: 1,
      contextPageMrrSampleCount: 1,
      contextPageMrrEligibleCount: 1,
      latencyP50: 17,
      latencyP95: 17,
      llmNetworkLatencyP50Ms: 17,
      llmNetworkLatencyP95Ms: 17,
      indexBuildLatencyP50Ms: 7,
      indexBuildLatencyP95Ms: 7,
      retrievalLatencyP50Ms: 11,
      retrievalLatencyP95Ms: 11,
      answerGenerationLatencyP50Ms: 13,
      answerGenerationLatencyP95Ms: 13,
      queryEndToEndLatencyP50Ms: 29,
      queryEndToEndLatencyP95Ms: 29,
    }))
    expect(result.meta).not.toHaveProperty('speedDefinition')
  })

  it('appends speed metrics and metadata after the existing quality result', () => {
    const record = qualityRecord()
    record.speed = {
      evidenceReadyLatencyMs: 5,
      timeToFirstTokenMs: 8,
      fullAnswerLatencyMs: 13,
      onlineTokenCount: 23,
      tokenAccountingComplete: true,
    }
    const quality = finalizeQaResult(finalizeArgs([record]))
    const withSpeed = finalizeQaResult({ ...finalizeArgs([record]), speed: { contract: speedContract } })

    const qualityKeys = Object.keys(quality.metrics)
    expect(Object.keys(withSpeed.metrics).slice(0, qualityKeys.length)).toEqual(qualityKeys)
    expect(Object.fromEntries(qualityKeys.map(key => [key, withSpeed.metrics[key]]))).toEqual(quality.metrics)
    expect(withSpeed.metrics).toMatchObject({
      evidenceReadyLatencyP50Ms: 5,
      evidenceReadyLatencyP95Ms: 5,
      timeToFirstTokenP50Ms: 8,
      timeToFirstTokenP95Ms: 8,
      fullAnswerLatencyP50Ms: 13,
      fullAnswerLatencyP95Ms: 13,
      avgOnlineTokensPerCompletedAnswer: 23,
      speedSampleCount: 1,
      onlineTokenSampleCount: 1,
    })
    expect(withSpeed.meta).toMatchObject({
      ...speedContract,
      completedSpeedQuestionIdsHash: questionIdsHash(['p#0']),
      completedSpeedQuestionCount: 1,
    })
    expect(withSpeed.meta.datasetFingerprint).toBe(evaluationContract.datasetFingerprint)
  })

  it('rejects a speed contract that would overwrite quality dataset provenance', () => {
    const record = qualityRecord()
    record.speed = {
      evidenceReadyLatencyMs: 5,
      timeToFirstTokenMs: 8,
      fullAnswerLatencyMs: 13,
      onlineTokenCount: 23,
      tokenAccountingComplete: true,
    }

    expect(() => finalizeQaResult({
      ...finalizeArgs([record]),
      speed: { contract: { ...speedContract, datasetFingerprint: 'different-dataset' } },
    })).toThrow('speed contract dataset fingerprint does not match evaluation contract')
  })

  it('still rejects a broken retrieval denominator before emitting speed output', () => {
    const record = qualityRecord()
    delete record.metrics.contextPageMrr
    record.speed = {
      evidenceReadyLatencyMs: 5,
      timeToFirstTokenMs: 8,
      fullAnswerLatencyMs: 13,
      onlineTokenCount: 23,
      tokenAccountingComplete: true,
    }

    expect(() => finalizeQaResult({ ...finalizeArgs([record]), speed: { contract: speedContract } }))
      .toThrow('固定分母不变量被破坏')
  })

  it.each([
    ['datasetFingerprint', 'forged-dataset'],
    ['metricSchemaVersion', 999],
    ['answerModelIdentity', 'forged-answer-model'],
  ] as const)('rejects extraMeta overrides of contract-owned %s', (key, value) => {
    const record = qualityRecord()
    record.speed = {
      evidenceReadyLatencyMs: 5,
      timeToFirstTokenMs: 8,
      fullAnswerLatencyMs: 13,
      onlineTokenCount: 23,
      tokenAccountingComplete: true,
    }

    expect(() => finalizeQaResult({
      ...finalizeArgs([record]),
      speed: { contract: speedContract },
      extraMeta: { [key]: value },
    })).toThrow(new RegExp(`extraMeta.*${key}.*contract`, 'i'))
  })

  it('accepts but does not source contract metadata from an equal extraMeta duplicate', () => {
    const result = finalizeQaResult({
      ...finalizeArgs([qualityRecord()]),
      extraMeta: { datasetFingerprint: evaluationContract.datasetFingerprint },
    })

    expect(result.meta.datasetFingerprint).toBe(evaluationContract.datasetFingerprint)
  })
})
