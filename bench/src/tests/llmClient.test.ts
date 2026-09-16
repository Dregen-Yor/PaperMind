import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLlmClient, resolveEnvConfig } from '../llmClient'

let cacheDir: string

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'bench-cache-'))
})
afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

function okResponse(content: string): Response {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  } as unknown as Response
}

function ollamaResponse(content: string): Response {
  return {
    ok: true,
    json: async () => ({ message: { content } }),
  } as unknown as Response
}

describe('resolveEnvConfig', () => {
  it('从 BENCH_* 环境变量读取配置', () => {
    const cfg = resolveEnvConfig({
      BENCH_LLM_PROVIDER: 'openai',
      BENCH_LLM_MODEL: 'gpt-4o',
      BENCH_LLM_API_KEY: 'sk-test',
      BENCH_LLM_BASE_URL: 'https://example.com/v1',
    })
    expect(cfg).toEqual({
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'sk-test',
      baseUrl: 'https://example.com/v1',
    })
  })

  it('缺 model 时抛出可诊断的错误', () => {
    expect(() => resolveEnvConfig({ BENCH_LLM_API_KEY: 'k' })).toThrow(/BENCH_LLM_MODEL/)
  })
})

describe('generation-limit cache isolation', () => {
  it('does not reuse a response cached under a different maxTokens limit', async () => {
    const firstFetch = vi.fn().mockResolvedValue(okResponse('long'))
    const secondFetch = vi.fn().mockResolvedValue(okResponse('short'))
    const common = { provider: 'openai', model: 'm', apiKey: 'k', baseUrl: 'http://x/v1', cacheDir }
    expect(await createLlmClient({ ...common, maxTokens: 100, fetchImpl: firstFetch as unknown as typeof fetch }).complete('q')).toBe('long')
    expect(await createLlmClient({ ...common, maxTokens: 10, fetchImpl: secondFetch as unknown as typeof fetch }).complete('q')).toBe('short')
    expect(secondFetch).toHaveBeenCalledOnce()
  })
})

describe('request timeout', () => {
  it('maps an AbortError caused by its timer to a diagnostic timeout', async () => {
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))))
    const client = createLlmClient({ provider: 'openai', model: 'm', apiKey: 'k', baseUrl: 'http://x/v1', cacheDir, timeoutMs: 1, fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(client.complete('q')).rejects.toThrow(/请求超时/)
  })
})

describe('recoverable request retries', () => {
  it('retries transient fetch failures before returning a successful answer', async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new Error('terminated'))
      .mockResolvedValue(okResponse('recovered'))
    const client = createLlmClient({ provider: 'openai', model: 'm', apiKey: 'k', baseUrl: 'http://x/v1', cacheDir, retryAttempts: 2, retryBaseDelayMs: 0, fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(client.complete('q')).resolves.toBe('recovered')
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('reports retry reason and bounded attempt information', async () => {
    const onRetry = vi.fn()
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'rate limited' } as unknown as Response)
      .mockResolvedValue(okResponse('recovered'))
    const client = createLlmClient({
      provider: 'openai', model: 'm', apiKey: 'k', baseUrl: 'http://x/v1', cacheDir,
      retryAttempts: 2, retryBaseDelayMs: 0, onRetry,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await expect(client.complete('q')).resolves.toBe('recovered')
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({
      attempt: 1,
      retryAttempts: 2,
      error: expect.stringContaining('429'),
    }))
  })

  it('does not retry non-recoverable authorization failures', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'unauthorized' } as unknown as Response)
    const client = createLlmClient({ provider: 'openai', model: 'm', apiKey: 'k', baseUrl: 'http://x/v1', cacheDir, retryAttempts: 3, retryBaseDelayMs: 0, fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(client.complete('q')).rejects.toThrow(/401/)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('allows a benchmark to keep retrying recoverable failures until it gets an answer', async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new Error('terminated'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValue(okResponse('eventually recovered'))
    const client = createLlmClient({ provider: 'openai', model: 'm', apiKey: 'k', baseUrl: 'http://x/v1', cacheDir, retryAttempts: Number.POSITIVE_INFINITY, retryBaseDelayMs: 0, fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(client.complete('q')).resolves.toBe('eventually recovered')
    expect(fetchImpl).toHaveBeenCalledTimes(4)
  })
})

describe('createLlmClient 缓存', () => {
  it('相同 prompt 第二次命中缓存，不再发请求', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse('answer'))
    const client = createLlmClient({
      provider: 'openai', model: 'm', apiKey: 'k', baseUrl: 'http://x/v1',
      cacheDir, fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    expect(await client.complete('hello')).toBe('answer')
    expect(await client.complete('hello')).toBe('answer')

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(client.stats()).toEqual({ hits: 1, misses: 1 })
    expect(readdirSync(cacheDir)).toHaveLength(1)
  })

  it('不同 model 不共享缓存', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse('answer'))
    const base = { provider: 'openai', apiKey: 'k', baseUrl: 'http://x/v1', cacheDir, fetchImpl: fetchImpl as unknown as typeof fetch }

    await createLlmClient({ ...base, model: 'm1' }).complete('hello')
    await createLlmClient({ ...base, model: 'm2' }).complete('hello')

    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('useCache=false 时绕过缓存', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse('answer'))
    const client = createLlmClient({
      provider: 'openai', model: 'm', apiKey: 'k', baseUrl: 'http://x/v1',
      cacheDir, useCache: false, fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await client.complete('hello')
    await client.complete('hello')

    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('HTTP 失败时抛错并带状态码，不写缓存', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false, status: 503, text: async () => 'overloaded',
    } as unknown as Response)
    const client = createLlmClient({
      provider: 'openai', model: 'm', apiKey: 'k', baseUrl: 'http://x/v1',
      cacheDir, fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await expect(client.complete('hello')).rejects.toThrow(/503/)
    expect(readdirSync(cacheDir)).toHaveLength(0)
  })

  it('ollama provider 走 /api/chat 并解析 message.content', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ message: { content: 'ollama-answer' } }),
    } as unknown as Response)
    const client = createLlmClient({
      provider: 'ollama', model: 'llama3', apiKey: '', baseUrl: 'http://localhost:11434',
      cacheDir, fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    expect(await client.complete('hello')).toBe('ollama-answer')
    expect(fetchImpl.mock.calls[0][0]).toBe('http://localhost:11434/api/chat')
  })

  it('OpenAI 兼容地址未带 /v1 时补全版本路径，并透传生成上限', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse('answer'))
    const client = createLlmClient({
      provider: 'openai', model: 'deepseek-v4-flash', apiKey: 'k', baseUrl: 'https://api.deepseek.com',
      maxTokens: 4096, cacheDir, fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await client.complete('hello')

    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.deepseek.com/v1/chat/completions')
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({ max_tokens: 4096 })
  })

  it('记录每次真实请求的耗时', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse('answer'))
    const client = createLlmClient({
      provider: 'openai', model: 'm', apiKey: 'k', baseUrl: 'http://x/v1',
      cacheDir, fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await client.complete('a')
    await client.complete('a') // 命中缓存，不计入延迟

    expect(client.latencies()).toHaveLength(1)
  })

  it('miss 记录 cacheHit=false、有限 elapsedMs 与 networkLatencyMs，latencies 仅含 miss', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse('answer'))
    const client = createLlmClient({
      provider: 'openai', model: 'm', apiKey: 'k', baseUrl: 'http://x/v1',
      cacheDir, fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await client.complete('a')
    const timings = client.requestTimings()

    expect(timings).toHaveLength(1)
    expect(timings[0].cacheHit).toBe(false)
    expect(Number.isFinite(timings[0].elapsedMs)).toBe(true)
    expect(timings[0].elapsedMs).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(timings[0].networkLatencyMs)).toBe(true)
    // elapsed 覆盖缓存/请求调度与网络，必不小于纯网络延迟
    expect(timings[0].elapsedMs!).toBeGreaterThanOrEqual(timings[0].networkLatencyMs!)
    expect(client.latencies()).toEqual([timings[0].networkLatencyMs])
  })

  it('命中同一缓存第二次调用记录 cacheHit=true，且 latencies 长度不增加', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse('answer'))
    const client = createLlmClient({
      provider: 'openai', model: 'm', apiKey: 'k', baseUrl: 'http://x/v1',
      cacheDir, fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await client.complete('a')
    await client.complete('a')
    const timings = client.requestTimings()

    expect(timings).toHaveLength(2)
    expect(timings[1].cacheHit).toBe(true)
    expect(timings[1].networkLatencyMs).toBeUndefined()
    expect(Number.isFinite(timings[1].elapsedMs)).toBe(true)
    expect(client.latencies()).toHaveLength(1)
  })

  it('HTTP 失败计入 miss 但不生成成功网络 latency 记录', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false, status: 503, text: async () => 'overloaded',
    } as unknown as Response)
    const client = createLlmClient({
      provider: 'openai', model: 'm', apiKey: 'k', baseUrl: 'http://x/v1',
      cacheDir, fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await expect(client.complete('hello')).rejects.toThrow(/503/)

    expect(client.stats()).toEqual({ hits: 0, misses: 1 })
    expect(client.latencies()).toEqual([])
    expect(client.requestTimings()).toEqual([])
  })

  it('HTTP 200 但 choices[0].message.content 缺失时抛错且不写缓存', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ error: { message: 'content_filter' } }),
    } as unknown as Response)
    const client = createLlmClient({
      provider: 'openai', model: 'm', apiKey: 'k', baseUrl: 'http://x/v1',
      cacheDir, fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await expect(client.complete('hello')).rejects.toThrow(/缺少 content/)
    expect(readdirSync(cacheDir)).toHaveLength(0)
  })

  it('ollama 分支 200 但 message.content 缺失时抛错且不写缓存', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ message: { content: '   ' } }),
    } as unknown as Response)
    const client = createLlmClient({
      provider: 'ollama', model: 'llama3', apiKey: '', baseUrl: 'http://localhost:11434',
      cacheDir, fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await expect(client.complete('hello')).rejects.toThrow(/缺少 content/)
    expect(readdirSync(cacheDir)).toHaveLength(0)
  })

  it('opts 只覆盖部分字段时逐字段合并，不整体回落到环境变量', async () => {
    vi.stubEnv('BENCH_LLM_PROVIDER', 'openai')
    vi.stubEnv('BENCH_LLM_MODEL', 'env-model')
    vi.stubEnv('BENCH_LLM_BASE_URL', 'https://env.example.com/v1')
    const fetchImpl = vi.fn().mockResolvedValue(ollamaResponse('ok'))

    // 只给 provider / baseUrl，不给 model：model 取环境变量，端点必须用 opts 的
    const client = createLlmClient({
      provider: 'ollama', baseUrl: 'http://localhost:9999',
      cacheDir, fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    expect(await client.complete('hello')).toBe('ok')
    expect(fetchImpl.mock.calls[0][0]).toBe('http://localhost:9999/api/chat')
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).model).toBe('env-model')
  })

  it('只给 model 时 apiKey / baseUrl 仍回落到环境变量', async () => {
    // 对应 judge 客户端的真实写法 createLlmClient({ model: process.env.BENCH_JUDGE_MODEL })：
    // 只覆盖 model，凭据与端点必须继续来自 BENCH_LLM_*，否则会打到 api.openai.com 并 401
    vi.stubEnv('BENCH_LLM_PROVIDER', undefined)
    vi.stubEnv('BENCH_LLM_API_KEY', 'sk-env')
    vi.stubEnv('BENCH_LLM_BASE_URL', 'https://env.example.com/v1')
    const fetchImpl = vi.fn().mockResolvedValue(okResponse('ok'))

    const client = createLlmClient({
      model: 'gpt-4o',
      cacheDir, fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    expect(await client.complete('hello')).toBe('ok')
    expect(fetchImpl.mock.calls[0][0]).toBe('https://env.example.com/v1/chat/completions')
    expect(fetchImpl.mock.calls[0][1].headers['Authorization']).toBe('Bearer sk-env')
  })

  it('同名 model 跨 provider / 跨 baseUrl 不共享缓存', async () => {
    const openaiFetch = vi.fn().mockResolvedValue(okResponse('from-openai'))
    const ollamaFetch = vi.fn().mockResolvedValue(ollamaResponse('from-ollama'))
    const otherBaseFetch = vi.fn().mockResolvedValue(okResponse('from-other-base'))

    await createLlmClient({
      provider: 'openai', model: 'llama3', apiKey: 'k', baseUrl: 'http://x/v1',
      cacheDir, fetchImpl: openaiFetch as unknown as typeof fetch,
    }).complete('hello')

    // 同名 model、不同 provider：必须真的发请求
    await createLlmClient({
      provider: 'ollama', model: 'llama3', apiKey: '', baseUrl: 'http://localhost:11434',
      cacheDir, fetchImpl: ollamaFetch as unknown as typeof fetch,
    }).complete('hello')

    // 同名 model、同 provider、不同 baseUrl：同样不能共享
    await createLlmClient({
      provider: 'openai', model: 'llama3', apiKey: 'k', baseUrl: 'http://y/v1',
      cacheDir, fetchImpl: otherBaseFetch as unknown as typeof fetch,
    }).complete('hello')

    expect(ollamaFetch).toHaveBeenCalledTimes(1)
    expect(otherBaseFetch).toHaveBeenCalledTimes(1)
    expect(readdirSync(cacheDir)).toHaveLength(3)
  })

  it('缓存文件损坏时当作 miss 重新请求，不抛错', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse('answer'))
    const opts = {
      provider: 'openai', model: 'm', apiKey: 'k', baseUrl: 'http://x/v1',
      cacheDir, fetchImpl: fetchImpl as unknown as typeof fetch,
    }

    await createLlmClient(opts).complete('hello')
    const [cacheFile] = readdirSync(cacheDir)
    writeFileSync(join(cacheDir, cacheFile), '{"content": "half-writ')

    expect(await createLlmClient(opts).complete('hello')).toBe('answer')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    // 坏文件被原子写覆盖，实现自愈
    expect(readdirSync(cacheDir)).toHaveLength(1)
  })

  it('anthropic 分支带 x-api-key 与 anthropic-version 请求头', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse('answer'))
    const client = createLlmClient({
      provider: 'anthropic', model: 'claude', apiKey: 'sk-ant', baseUrl: 'http://x/v1',
      cacheDir, fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await client.complete('hello')

    const headers = fetchImpl.mock.calls[0][1].headers
    expect(headers['x-api-key']).toBe('sk-ant')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(headers['Authorization']).toBeUndefined()
  })
})
