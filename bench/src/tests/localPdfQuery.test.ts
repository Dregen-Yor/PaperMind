import { it, expect, vi } from 'vitest'
import type { StreamingLlmClient } from '../llmClient'
import { createLlmClient } from '../llmClient'
import { executeQuery } from '../localPdf/query'
const question = { id: 'q', paperId: 'p', question: 'What?' }
it('measures retrieval and visible answer from same t0', async () => {
  let now = 100
  const client = { chatStream: async (_m: unknown, cb: (s: string) => void) => { now = 180; cb(' '); now = 200; cb('Yes'); return { content: 'Yes' } } } as StreamingLlmClient
  const r = await executeQuery(question, { method: 'A', retrieve: async () => { now = 140; return { text: '', trace: [] } } }, { client, now: () => now, systemPrompt: 'test' })
  expect(r.tContextReady! - r.t0!).toBe(40)
  expect(r.tFirstAnswerToken! - r.t0!).toBe(100)
})
it('keeps failed stream out of completed answers and R has no retrieval timing', async () => {
  const client = { chatStream: async (_m: unknown, cb: (s: string) => void) => { cb('partial'); throw new Error('broken') } } as StreamingLlmClient
  const r = await executeQuery(question, { method: 'R', fullText: 'all' }, { client, now: () => 1, systemPrompt: 'test' })
  expect(r).toMatchObject({ answer: '', partialAnswer: 'partial', generationStatus: 'failed', tContextReady: null, evidence: null })
})
it('does not transparently retry after visible stream output', async () => {
  const fetchImpl = vi.fn(async () => new Response(new ReadableStream({ start(c) {
    c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'))
    setTimeout(() => c.error(new TypeError('fetch failed')), 0)
  } })))
  const c = createLlmClient({ provider: 'openai', model: 'test', apiKey: 'fake', baseUrl: 'https://example.invalid', useCache: false, retryAttempts: 1, retryBaseDelayMs: 0, fetchImpl })
  await expect(c.chatStream([], () => {})).rejects.toThrow()
  expect(fetchImpl).toHaveBeenCalledTimes(1)
})
