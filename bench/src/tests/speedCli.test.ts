import { describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { EvaluationContract } from '../evaluationContract'
import { createLlmClient, type StreamingLlmClient } from '../llmClient'
import { answerFramingIdentityHash, generationSettingsHash, questionIdsHash } from '../speed/contract'
import { benchmarkPathForLog, writeBenchmarkPathLine } from '../logging'
import {
  assertSpeedAnswerClient,
  buildSpeedExecutionPolicy,
  isLocalExecutionEndpoint,
  resolveQaClientCachePolicy,
} from '../speed/policy'
import { parseQaGenerationEnv, resolveQaAnswerOptions } from '../speed/qaOptions'

const evaluationContract: EvaluationContract = {
  metricSchemaVersion: 2,
  mrrDefinition: 'context-page-v1',
  contextBudgetTokens: 4096,
  contextTokenizer: 'BAAI/bge-m3',
  contextTokenizerRevision: 'main',
  evidenceMappingVersion: 'page-evidence-v1',
  datasetFingerprint: 'dataset-fingerprint',
  eligibleRetrievalQuestionIdsHash: 'eligible-question-ids',
  eligibleRetrievalQuestionCount: 2,
}

const common = {
  evaluationContract,
  executedQuestionIds: ['q-1', 'q-2'],
  provider: 'openai',
  model: 'answer-model',
  baseUrl: 'https://example.com/v1',
  retryAttempts: 2,
  maxTokens: 4096,
  answerSystemPrompt: 'system\n\nanswer in English',
  environment: {
    platform: 'darwin',
    arch: 'arm64',
    nodeVersion: 'v22.1.0',
  },
  env: {},
}

describe('speed CLI execution policy', () => {
  it.each([
    ['Ollama regardless of URL', 'ollama', 'https://remote.example/v1', true],
    ['localhost', 'openai', 'http://localhost:8000/v1', true],
    ['IPv4 loopback', 'openai', 'http://127.0.0.1:8000/v1', true],
    ['IPv6 loopback', 'openai', 'http://[::1]:8000/v1', true],
    ['IPv4-mapped IPv6 loopback', 'openai', 'http://[::ffff:127.0.0.1]:8000/v1', true],
    ['IPv4-mapped IPv6 private host', 'openai', 'http://[::ffff:192.168.1.2]:8000/v1', false],
    ['remote OpenAI-compatible endpoint', 'openai', 'https://api.example.com/v1', false],
  ])('classifies %s execution', (_label, provider, baseUrl, expected) => {
    expect(isLocalExecutionEndpoint(provider, baseUrl)).toBe(expected)
  })

  it('freezes answer-client, clock, concurrency, retry, generation, and contract identity', () => {
    const policy = buildSpeedExecutionPolicy(common)

    expect(policy.answerClientOverrides).toEqual({
      useCache: false,
      retryAttempts: 2,
      maxTokens: 4096,
      temperature: 0,
      timeoutMs: undefined,
      topP: undefined,
      thinking: undefined,
      stop: undefined,
    })
    expect(policy.generationSettings).toEqual({
      temperature: 0,
      maxTokens: 4096,
      stop: undefined,
      topP: undefined,
      thinking: undefined,
      timeoutMs: undefined,
    })
    expect(policy.queryConcurrency).toBe(1)
    expect(policy).not.toHaveProperty('checkpointPath')
    expect(policy.contract).toMatchObject({
      datasetFingerprint: evaluationContract.datasetFingerprint,
      executedQuestionIdsHash: questionIdsHash(['q-1', 'q-2']),
      retryAttempts: 2,
      queryConcurrency: 1,
      streaming: true,
      llmCacheEnabled: false,
      answerFramingIdentityHash: answerFramingIdentityHash(common.answerSystemPrompt),
      generationSettingsHash: generationSettingsHash({
        temperature: 0,
        maxTokens: 4096,
        stop: undefined,
      }),
    })
    expect(policy.runnerOptions).toEqual({
      contract: policy.contract,
      now: policy.now,
    })
  })

  it('maps every explicit setting into both request overrides and one contract identity', () => {
    const policy = buildSpeedExecutionPolicy({ ...common, temperature: 0.4, topP: 0.8, thinking: 'disabled', stop: ['END'], timeoutMs: 321 })
    expect(policy.answerClientOverrides).toMatchObject({ temperature: 0.4, topP: 0.8, thinking: 'disabled', stop: ['END'], timeoutMs: 321 })
    expect(policy.contract.generationSettingsHash).toBe(generationSettingsHash(policy.generationSettings))
    expect(policy.generationSettings).toEqual({ temperature: 0.4, maxTokens: 4096, topP: 0.8, thinking: 'disabled', stop: ['END'], timeoutMs: 321 })
  })

  it('sends the OpenAI streaming request described by its speed contract', async () => {
    const policy = buildSpeedExecutionPolicy({ ...common, topP: 0.8, thinking: 'disabled', stop: 'END', timeoutMs: 120_000 })
    let requestBody: Record<string, unknown> | undefined
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"answer"}}]}\n\ndata: [DONE]\n\n'))
        controller.close()
      },
    })
    const client = createLlmClient({
      provider: 'openai', model: common.model, baseUrl: common.baseUrl,
      ...policy.answerClientOverrides,
      fetchImpl: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return { ok: true, body: stream } as Response
      },
    })
    await client.chatStream([{ role: 'user', content: 'question' }], () => {})
    expect(requestBody).toMatchObject({ max_tokens: 4096, temperature: 0, top_p: 0.8, thinking: { type: 'disabled' }, stop: 'END', stream: true })
    expect(policy.contract.generationSettingsHash).toBe(generationSettingsHash({
      temperature: requestBody?.temperature as number,
      maxTokens: requestBody?.max_tokens as number,
      topP: requestBody?.top_p as number,
      thinking: (requestBody?.thinking as { type: 'disabled' }).type,
      stop: requestBody?.stop as string,
      timeoutMs: policy.answerClientOverrides.timeoutMs,
    }))
  })

  it('keeps offline comparison independent of invalid QA environment settings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-compare-'))
    try {
      const fixture = join(dir, 'result.json')
      writeFileSync(fixture, JSON.stringify({
        task: 'qa', config: { name: 'offline' },
        meta: { model: 'm', timestamp: '2026-01-01', gitSha: 'abc', completed: 1, total: 1 },
        metrics: {}, perSample: [], errors: [],
      }))
      const result = spawnSync(process.execPath, ['--import', 'tsx', 'bench/src/cli.ts', '--compare', fixture, fixture], {
        cwd: resolve('.'),
        env: { ...process.env, BENCH_QA_TOP_P: 'invalid', BENCH_QA_REQUEST_TIMEOUT_MS: 'invalid' },
        encoding: 'utf-8',
      })
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toContain('结果对比')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('parses optional QA generation parameters without replacing provider defaults', () => {
    expect(parseQaGenerationEnv({})).toEqual({ topP: undefined, thinking: undefined })
    expect(parseQaGenerationEnv({ BENCH_QA_TOP_P: '0.8', BENCH_QA_THINKING: 'disabled' })).toEqual({ topP: 0.8, thinking: 'disabled' })
    for (const raw of ['', ' ', 'NaN', 'Infinity', '-0.1', '1.1', 'bad']) {
      expect(() => parseQaGenerationEnv({ BENCH_QA_TOP_P: raw })).toThrow(/BENCH_QA_TOP_P/)
    }
    expect(() => parseQaGenerationEnv({ BENCH_QA_THINKING: 'true' })).toThrow(/BENCH_QA_THINKING/)
  })

  it('uses one QA answer options source for full-context and RAG limits', () => {
    expect(resolveQaAnswerOptions({})).toEqual({
      maxTokens: 4096, temperature: 0, timeoutMs: 120_000, retryAttempts: 3,
      topP: undefined, thinking: undefined, stop: undefined,
    })
    expect(resolveQaAnswerOptions({ BENCH_QA_REQUEST_TIMEOUT_MS: '900', BENCH_QA_RETRY_ATTEMPTS: '2', BENCH_QA_TOP_P: '0.5' })).toMatchObject({
      maxTokens: 4096, timeoutMs: 900, retryAttempts: 2, topP: 0.5,
    })
    expect(() => resolveQaAnswerOptions({ BENCH_QA_REQUEST_TIMEOUT_MS: '0' })).toThrow(/BENCH_QA_REQUEST_TIMEOUT_MS/)
  })

  it('provides directly callable monotonic clocks to speed runners', () => {
    const policy = buildSpeedExecutionPolicy(common)

    const startedAt = policy.now()
    const runnerAt = policy.runnerOptions.now!()

    expect(Number.isFinite(startedAt)).toBe(true)
    expect(Number.isFinite(runnerAt)).toBe(true)
    expect(runnerAt).toBeGreaterThanOrEqual(startedAt)
  })

  it('keeps the judge cache role separate from answer-client speed snapshots', () => {
    expect(resolveQaClientCachePolicy({ speed: true, useCache: true })).toEqual({
      answerUseCache: false,
      judgeUseCache: true,
    })
    expect(resolveQaClientCachePolicy({ speed: false, useCache: false })).toEqual({
      answerUseCache: false,
      judgeUseCache: false,
    })
    expect(resolveQaClientCachePolicy({ speed: false, useCache: true })).toEqual({
      answerUseCache: true,
      judgeUseCache: true,
    })
  })

  it('requires a sanitized local backend descriptor for Ollama', () => {
    expect(() => buildSpeedExecutionPolicy({ ...common, provider: 'ollama' }))
      .toThrow(/BENCH_EXECUTION_BACKEND/)

    const policy = buildSpeedExecutionPolicy({
      ...common,
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      env: { BENCH_EXECUTION_BACKEND: 'metal-gpu' },
    })
    expect(policy.contract.executionEnvironmentFingerprint).toMatch(/^[a-f0-9]{64}$/)
  })

  it('requires and fingerprints the backend for a local OpenAI-compatible endpoint', () => {
    const localExecution = isLocalExecutionEndpoint('openai', 'http://127.0.0.1:8000/v1')
    expect(() => buildSpeedExecutionPolicy({
      ...common,
      baseUrl: 'http://127.0.0.1:8000/v1',
      localExecution,
    })).toThrow(/BENCH_EXECUTION_BACKEND/)

    const local = buildSpeedExecutionPolicy({
      ...common,
      baseUrl: 'http://127.0.0.1:8000/v1',
      localExecution,
      env: { BENCH_EXECUTION_BACKEND: 'cuda:0' },
    })
    const remote = buildSpeedExecutionPolicy({
      ...common,
      baseUrl: 'https://api.example.com/v1',
      localExecution: isLocalExecutionEndpoint('openai', 'https://api.example.com/v1'),
      env: { BENCH_EXECUTION_BACKEND: 'cuda:0' },
    })
    expect(local.contract.executionEnvironmentFingerprint)
      .not.toBe(remote.contract.executionEnvironmentFingerprint)
  })

  it('requires the backend for an IPv4-mapped IPv6 loopback endpoint', () => {
    const baseUrl = 'http://[::ffff:127.0.0.1]:8000/v1'
    const localExecution = isLocalExecutionEndpoint('openai', baseUrl)

    expect(() => buildSpeedExecutionPolicy({
      ...common,
      baseUrl,
      localExecution,
    })).toThrow(/BENCH_EXECUTION_BACKEND/)

    expect(() => buildSpeedExecutionPolicy({
      ...common,
      baseUrl,
      localExecution,
      env: { BENCH_EXECUTION_BACKEND: 'cuda:0' },
    })).not.toThrow()
  })

  it('sends the same effective Ollama generation settings that the speed contract hashes', async () => {
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode([
          JSON.stringify({ message: { content: 'answer' }, done: false }),
          JSON.stringify({ done: true, prompt_eval_count: 3, eval_count: 2 }),
          '',
        ].join('\n')))
        controller.close()
      },
    })
    let requestBody: Record<string, unknown> | undefined
    const policy = buildSpeedExecutionPolicy({
      ...common,
      provider: 'ollama',
      env: { BENCH_EXECUTION_BACKEND: 'metal-gpu' },
    })
    const client = createLlmClient({
      provider: 'ollama',
      model: common.model,
      baseUrl: 'http://localhost:11434',
      ...policy.answerClientOverrides,
      fetchImpl: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return { ok: true, body } as Response
      },
    })

    await client.chatStream([{ role: 'user', content: 'question' }], () => {})

    expect(requestBody).toMatchObject({
      stream: true,
      options: { num_predict: 4096, temperature: 0 },
    })
    const options = requestBody?.options as { num_predict: number; temperature: number }
    expect(policy.contract.generationSettingsHash).toBe(generationSettingsHash({
      temperature: options.temperature,
      maxTokens: options.num_predict,
      stop: undefined,
    }))
  })

  it('rejects a cache-enabled answer client before a speed runner starts', () => {
    const client = {
      cacheEnabled: () => true,
    } as unknown as StreamingLlmClient

    expect(() => assertSpeedAnswerClient(client)).toThrow(/cache/i)
  })

  it('accepts a cache-disabled answer client', () => {
    const client = {
      cacheEnabled: () => false,
    } as unknown as StreamingLlmClient

    expect(() => assertSpeedAnswerClient(client)).not.toThrow()
  })

  it('prints repo-relative or redacted cache/result path labels in speed mode', () => {
    const write = vi.fn()
    const root = '/Users/private-user/project'

    writeBenchmarkPathLine(write, '缓存目录：', '/Users/private-user/project/bench/cache', {
      speed: true,
      root,
    })
    writeBenchmarkPathLine(write, '结果已写入 ', '/Users/private-user/secrets/result.json', {
      speed: true,
      root,
    })
    const output = write.mock.calls.flat().join('')

    expect(output).toContain('缓存目录：bench/cache')
    expect(output).toContain('结果已写入 <external>/result.json')
    expect(output).not.toContain('/Users/private-user')
    expect(benchmarkPathForLog('/Users/private-user/project/bench/cache', { speed: false, root }))
      .toBe('/Users/private-user/project/bench/cache')
  })
})
