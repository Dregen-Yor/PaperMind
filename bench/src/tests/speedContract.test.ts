import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  answerFramingIdentityHash,
  answerModelIdentity,
  buildSpeedRunContract,
  executionEnvironmentFingerprint,
  generationSettingsHash,
  questionIdsHash,
  speedComparisonIssues,
  speedEndpointIdentity,
  type SpeedComparableResult,
} from '../speed/contract'

const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

describe('speed contract identities', () => {
  it('hashes question IDs in their executed order', () => {
    expect(questionIdsHash(['p1#0', 'p2#0'])).toBe(sha256({
      domain: 'query-timeline-question-ids-v1',
      questionIds: ['p1#0', 'p2#0'],
    }))
    expect(questionIdsHash(['p1#0', 'p2#0'])).not.toBe(questionIdsHash(['p2#0', 'p1#0']))
  })

  it('hashes the exact credential-free fixed answer framing bytes', () => {
    const framing = answerFramingIdentityHash('system\n\nanswer in English')

    expect(framing).toBe(sha256({
      domain: 'papermind-answer-framing-v1',
      messages: [
        {
          role: 'system',
          content: 'system\n\nanswer in English\n\n数学公式请使用 LaTeX：行内公式使用 $...$，独立公式使用 $$...$$。不要使用 \\(...\\) 或 \\[...\\] 包裹公式。\n\n参考内容：\n__PAPERMIND_DYNAMIC_CONTEXT__',
        },
        { role: 'user', content: '__PAPERMIND_DYNAMIC_QUESTION__' },
      ],
    }))
    expect(answerFramingIdentityHash('different system')).not.toBe(framing)
    expect(JSON.stringify(framing)).not.toContain('answer in English')
  })

  it('identifies the answer model by both provider and model', () => {
    const base = answerModelIdentity('openai', 'gpt-4.1')
    expect(base).toBe(sha256({ provider: 'openai', model: 'gpt-4.1' }))
    expect(answerModelIdentity('ollama', 'gpt-4.1')).not.toBe(base)
    expect(answerModelIdentity('openai', 'gpt-4.1-mini')).not.toBe(base)
  })

  it('strips endpoint credentials before hashing its normalized identity', () => {
    const plain = speedEndpointIdentity('openai', 'https://api.openai.com/v1')
    expect(speedEndpointIdentity('openai', 'https://user:secret@API.OpenAI.com/v1/#ignored')).toBe(plain)
    expect(plain).toBe(sha256({ provider: 'openai', baseUrl: 'https://api.openai.com/v1' }))
  })

  it('changes generation identity for every request setting and distinguishes provider defaults', () => {
    const baseline = generationSettingsHash({ temperature: 0, maxTokens: 128, stop: ['END'] })
    expect(baseline).toBe(sha256({ temperature: 0, maxTokens: 128, stop: ['END'], topP: 'provider-default', thinking: 'provider-default', timeoutMs: null }))
    expect(generationSettingsHash({ temperature: 0.2, maxTokens: 128, stop: ['END'] })).not.toBe(baseline)
    expect(generationSettingsHash({ temperature: 0, maxTokens: 256, stop: ['END'] })).not.toBe(baseline)
    expect(generationSettingsHash({ temperature: 0, maxTokens: 128, stop: ['STOP'] })).not.toBe(baseline)
    expect(generationSettingsHash({ temperature: 0, maxTokens: 128, stop: ['END'], topP: 1 })).not.toBe(baseline)
    expect(generationSettingsHash({ temperature: 0, maxTokens: 128, stop: ['END'], thinking: 'disabled' })).not.toBe(baseline)
    expect(generationSettingsHash({ temperature: 0, maxTokens: 128, stop: ['END'], timeoutMs: 120_000 })).not.toBe(baseline)
  })

  it('hashes only platform, architecture, Node version, and backend for execution identity', () => {
    const baseline = executionEnvironmentFingerprint({
      platform: 'darwin', arch: 'arm64', nodeVersion: 'v22.1.0', backend: 'metal',
    })
    const withPersonalFields = {
      platform: 'darwin', arch: 'arm64', nodeVersion: 'v22.1.0', backend: 'metal',
      username: 'person', absolutePath: '/Users/person/private',
    }
    expect(executionEnvironmentFingerprint(withPersonalFields)).toBe(baseline)
    expect(executionEnvironmentFingerprint({ ...withPersonalFields, backend: 'cpu' })).not.toBe(baseline)
    expect(executionEnvironmentFingerprint({ ...withPersonalFields, arch: 'x64' })).not.toBe(baseline)
  })

  it('requires an explicit local backend for Ollama while remote providers use remote', () => {
    const common = {
      datasetFingerprint: 'dataset',
      executedQuestionIds: ['p1#0'],
      model: 'model',
      baseUrl: 'http://localhost:11434',
      retryAttempts: 1,
      answerSystemPrompt: 'system\n\nanswer in English',
      generationSettings: { temperature: 0, maxTokens: 128, stop: ['END'] },
      environment: { platform: 'darwin', arch: 'arm64', nodeVersion: 'v22.1.0' },
    }

    expect(() => buildSpeedRunContract({ ...common, provider: 'ollama', env: {} })).toThrow('BENCH_EXECUTION_BACKEND')
    const ollama = buildSpeedRunContract({ ...common, provider: 'ollama', env: { BENCH_EXECUTION_BACKEND: 'metal' } })
    const remote = buildSpeedRunContract({ ...common, provider: 'openai', env: { BENCH_EXECUTION_BACKEND: 'metal' } })

    expect(ollama.executionEnvironmentFingerprint).toBe(executionEnvironmentFingerprint({
      ...common.environment, backend: 'metal',
    }))
    expect(ollama.answerFramingIdentityHash).toBe(answerFramingIdentityHash(common.answerSystemPrompt))
    expect(remote.executionEnvironmentFingerprint).toBe(executionEnvironmentFingerprint({
      ...common.environment, backend: 'remote',
    }))
  })
})

describe('speed comparison gate', () => {
  const comparable = (name: string, patch: Partial<SpeedComparableResult['meta']> = {}): SpeedComparableResult => ({
    config: { name },
    meta: {
      datasetFingerprint: 'dataset',
      executedQuestionIdsHash: 'executed',
      completedSpeedQuestionIdsHash: 'completed',
      speedMetricSchemaVersion: 1 as const,
      speedDefinition: 'query-timeline-v1' as const,
      answerModelIdentity: 'model',
      answerFramingIdentityHash: 'framing',
      endpointIdentity: 'endpoint',
      generationSettingsHash: 'settings',
      retryAttempts: 1,
      streaming: true,
      llmCacheEnabled: false,
      queryConcurrency: 1,
      executionEnvironmentFingerprint: 'environment',
      completedSpeedQuestionCount: 2,
      ...patch,
    },
    metrics: { speedSampleCount: 2, onlineTokenSampleCount: 2 },
  })

  it('rejects same-sized cohorts whose completed question IDs differ', () => {
    expect(speedComparisonIssues(
      comparable('before'),
      comparable('after', { completedSpeedQuestionIdsHash: 'different-completed' }),
    )).toContain('completedSpeedQuestionIdsHash 不一致')
  })

  it('rejects internally consistent runs with different completed cohort sizes', () => {
    const after = comparable('after', { completedSpeedQuestionCount: 3 })
    after.metrics.speedSampleCount = 3

    expect(speedComparisonIssues(comparable('before'), after)).toContain('speedSampleCount 不一致')
  })

  it('rejects runs with different effective answer framing', () => {
    expect(speedComparisonIssues(
      comparable('before'),
      comparable('after', { answerFramingIdentityHash: 'different-framing' }),
    )).toContain('answerFramingIdentityHash 不一致')
  })

  it('reads historical v1 fields while separating v1 from v2 comparisons', () => {
    const old = comparable('old')
    const next = comparable('next', { speedMetricSchemaVersion: 2, speedDefinition: 'query-timeline-v2' })
    expect(old.meta.speedMetricSchemaVersion).toBe(1)
    expect(speedComparisonIssues(old, next)).toContain('speedMetricSchemaVersion 不一致')
  })
})
