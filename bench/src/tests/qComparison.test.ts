import { describe, expect, it } from 'vitest'
import type { BenchResult } from '../types'
import { buildQComparison } from '../scoring/qComparison'
import { aggregateSpeedMetrics } from '../speed/metrics'
import { questionIdsHash } from '../speed/contract'
import { qConfig, qFixture } from './qFixture'

describe('buildQComparison', () => {
  it('scores a baseline against itself as 100 without mutating inputs', () => {
    const reference = qFixture('reference', 'full-context')
    const original = JSON.stringify(reference)
    const comparison = buildQComparison(reference, qFixture('candidate'), qConfig)
    expect(comparison.score).toBe(100)
    expect(comparison.reference).toEqual({ answerF1: 0.5, ttftP50: 100, ttftP95: 200 })
    expect(comparison.reasons).toEqual([])
    expect(JSON.stringify(reference)).toBe(original)
    expect(comparison.config).not.toBe(qConfig)
  })

  it('uses first argument as the reference for quality and speed ratios', () => {
    const reference = qFixture('reference', 'full-context')
    const candidate = qFixture('candidate')
    candidate.perSample[0].answer = 'no'
    candidate.perSample[0].metrics.answerF1AllQuestions = 0
    candidate.perSample[1].answer = 'yes'
    candidate.perSample[1].metrics.answerF1AllQuestions = 1
    for (const row of candidate.perSample) {
      row.speed!.timeToFirstTokenMs! /= 2
      row.speed!.fullAnswerLatencyMs! /= 2
    }
    Object.assign(candidate.metrics, aggregateSpeedMetrics(candidate.perSample, { evidenceRequired: true }))
    const comparison = buildQComparison(reference, candidate, qConfig)
    expect(comparison.score).toBeCloseTo(100 * 2 ** 0.4)
    expect(buildQComparison(candidate, reference, qConfig).score).toBeNull()
    expect(buildQComparison(reference, candidate, qConfig).score).toBeGreaterThan(100)
  })

  it.each([
    ['legacy quality', (r: BenchResult) => { delete r.meta.qaQualityDefinition }],
    ['missing quality aggregate', (r: BenchResult) => { delete r.metrics.answerF1AllQuestions }],
    ['legacy speed', (r: BenchResult) => { r.meta.speedMetricSchemaVersion = 1 }],
    ['missing identity both sides', (r: BenchResult) => { delete r.meta.answerModelIdentity }],
    ['wrong identity type', (r: BenchResult) => { (r.meta as unknown as Record<string, unknown>).answerModelIdentity = 0 }],
    ['zero TTFT', (r: BenchResult) => { r.perSample[0].speed!.timeToFirstTokenMs = 0; Object.assign(r.metrics, aggregateSpeedMetrics(r.perSample, { evidenceRequired: true })) }],
    ['missing Evidence Ready', (r: BenchResult) => { delete r.perSample[0].speed!.evidenceReadyLatencyMs }],
    ['duplicate row', (r: BenchResult) => { r.perSample.push(r.perSample[0]) }],
    ['missing row', (r: BenchResult) => { r.perSample.pop() }],
    ['extra row', (r: BenchResult) => { r.perSample.push({ ...r.perSample[0], id: 'q3' }) }],
    ['bad status', (r: BenchResult) => { delete r.perSample[0].generationStatus }],
    ['bad reference answers', (r: BenchResult) => { r.perSample[0].referenceAnswers = [] }],
    ['tampered score', (r: BenchResult) => { r.perSample[0].metrics.answerF1AllQuestions = 0 }],
    ['tampered aggregate', (r: BenchResult) => { r.metrics.answerF1AllQuestions = 0.9 }],
    ['partial speed cohort', (r: BenchResult) => { delete r.perSample[0].speed }],
    ['wrong completed count', (r: BenchResult) => { r.meta.completedSpeedQuestionCount = 1 }],
    ['wrong completed hash', (r: BenchResult) => { r.meta.completedSpeedQuestionIdsHash = questionIdsHash(['q1']) }],
    ['wrong total', (r: BenchResult) => { r.meta.total = 3 }],
    ['wrong completion count', (r: BenchResult) => { r.meta.completed = 1 }],
    ['wrong retry type', (r: BenchResult) => { (r.meta as unknown as Record<string, unknown>).retryAttempts = '0' }],
    ['wrong streaming type', (r: BenchResult) => { (r.meta as unknown as Record<string, unknown>).streaming = 'true' }],
    ['empty completed cohort', (r: BenchResult) => { for (const row of r.perSample) { row.generationStatus = 'failed'; row.metrics.answerF1AllQuestions = 0; delete row.speed }; r.meta.completed = 0; r.meta.completedSpeedQuestionCount = 0; r.meta.completedSpeedQuestionIdsHash = questionIdsHash([]); r.metrics.answerF1AllQuestions = 0; r.metrics.qaCompletionRate = 0; Object.assign(r.metrics, { speedSampleCount: 0, onlineTokenSampleCount: 0 }) }],
  ])('rejects %s with actionable reasons', (_label, mutate) => {
    const reference = qFixture('reference', 'full-context')
    const candidate = qFixture('candidate')
    mutate(candidate)
    if (_label === 'missing identity both sides') mutate(reference)
    const result = buildQComparison(reference, candidate, qConfig)
    expect(result.score).toBeNull()
    expect(result.reasons.length).toBeGreaterThan(0)
  })

  it.each(['datasetFingerprint', 'answerModelIdentity', 'generationSettingsHash', 'executionEnvironmentFingerprint', 'executedQuestionIdsHash'] as const)('rejects %s mismatch', key => {
    const candidate = qFixture('candidate')
    candidate.meta[key] = 'different'
    expect(buildQComparison(qFixture('reference', 'full-context'), candidate, qConfig).score).toBeNull()
  })

  it('rejects snapshot drift even when the altered answer still scores the same', () => {
    const candidate = qFixture('candidate')
    candidate.perSample[0].referenceAnswers = ['yes', 'maybe']
    expect(buildQComparison(qFixture('reference', 'full-context'), candidate, qConfig).reasons.join(' ')).toMatch(/referenceAnswers/)
  })

  it('identifies an empty completed cohort without substituting a zero score', () => {
    const candidate = qFixture('candidate')
    for (const row of candidate.perSample) {
      row.generationStatus = 'failed'
      row.metrics.answerF1AllQuestions = 0
      delete row.speed
    }
    candidate.meta.completed = 0
    candidate.meta.completedSpeedQuestionIdsHash = questionIdsHash([])
    candidate.meta.completedSpeedQuestionCount = 0
    candidate.metrics = { answerF1AllQuestions: 0, answerF1AllQuestionsSampleCount: 2, qaCompletionRate: 0, speedSampleCount: 0, onlineTokenSampleCount: 0 }
    const comparison = buildQComparison(qFixture('reference', 'full-context'), candidate, qConfig)
    expect(comparison.score).toBeNull()
    expect(comparison.reasons.join(' ')).toMatch(/cohort is empty/)
  })

  it('returns zero for a zero-F1 candidate and null for a zero-F1 reference', () => {
    const zero = qFixture('zero')
    for (const row of zero.perSample) { row.answer = 'no'; row.metrics.answerF1AllQuestions = 0 }
    zero.metrics.answerF1AllQuestions = 0
    expect(buildQComparison(qFixture('ref', 'full-context'), zero, qConfig).score).toBe(0)
    zero.meta.mode = 'full-context'
    expect(buildQComparison(zero, qFixture('candidate'), qConfig).score).toBeNull()
  })
})
