import { describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '../stores/chat'
const readProviderStream = (response: Response, provider: 'openai' | 'anthropic' | 'ollama', onToken: (text: string) => void, signal?: AbortSignal) => {
  setActivePinia(createPinia())
  global.fetch = (async () => response) as typeof fetch
  const store = useChatStore()
  return store.requestCompletion([], { ...store.chatProfile, provider }, { onToken, signal })
}

const cases = [
  { provider: 'openai', token: 'data: {"choices":[{"delta":{"content":"半截"}}]}', terminal: 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}', error: 'data: {"error":{"message":"service failed"}}' },
  { provider: 'anthropic', token: 'data: {"type":"content_block_delta","delta":{"text":"半截"}}', terminal: 'data: {"type":"message_stop"}', error: 'data: {"type":"error","error":{"message":"service failed"}}' },
  { provider: 'ollama', token: '{"message":{"content":"半截"}}', terminal: '{"done":true}', error: '{"error":"service failed"}' },
] as const

describe.each(cases)('$provider stream contract', ({ provider, token, terminal, error }) => {
  it('rejects EOF without a terminal and preserves emitted partial text', async () => {
    let partial = ''
    await expect(readProviderStream(new Response(token + '\n'), provider, text => { partial += text })).rejects.toThrow('结束')
    expect(partial).toBe('半截')
  })
  it('flushes an unterminated last record and accepts the provider terminal', async () => {
    const result = await readProviderStream(new Response(token + '\n' + terminal), provider, () => {})
    expect(result.content).toBe('半截')
  })
  it('rejects service errors after partial output', async () => {
    await expect(readProviderStream(new Response(token + '\n' + error), provider, () => {})).rejects.toThrow('service failed')
  })
  it('aborts an open stream promptly while retaining emitted text', async () => {
    const controller = new AbortController()
    let partial = ''
    const body = new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode(token + '\n')) } })
    await expect(readProviderStream(new Response(body), provider, text => {
      partial += text
      controller.abort()
    }, controller.signal)).rejects.toThrow()
    expect(partial).toBe('半截')
  })
  it('does not wait for EOF after the terminal', async () => {
    const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(token + '\n' + terminal + '\n')) } })
    await expect(readProviderStream(new Response(body), provider, () => {})).resolves.toMatchObject({ content: '半截' })
  })
})

it.each([[-10, 0], [10, 2], [Number.NaN, 0.7], [0, 0], [0.4, 0.4]])('sends normalized Ollama temperature %s without imposing a token limit', async (temperature, expected) => {
  setActivePinia(createPinia())
  const store = useChatStore()
  const request = vi.fn().mockResolvedValue(new Response('{"message":{"content":"ok"}}'))
  global.fetch = request
  await store.requestCompletion([], { ...store.chatProfile, provider: 'ollama', temperature, maxTokens: 0 })
  const body = JSON.parse(request.mock.calls[0][1].body)
  expect(body.options.temperature).toBe(expected)
  expect(body.options).not.toHaveProperty('num_predict')
})

it('decodes UTF-8 split across byte chunks and flushes the final NDJSON record', async () => {
  const bytes = new TextEncoder().encode('{"message":{"content":"中文"},"done":true}')
  const body = new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
    controller.close()
  } })
  await expect(readProviderStream(new Response(body), 'ollama', () => {})).resolves.toEqual({ content: '中文', truncated: false })
})
