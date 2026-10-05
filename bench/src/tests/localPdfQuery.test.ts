import { it, expect, vi } from 'vitest'
import type { StreamingLlmClient } from '../llmClient'
import { createLlmClient } from '../llmClient'
import { executeQuery } from '../localPdf/query'
import { TocRoutingError } from '../localPdf/tocRouting'
const question = { id: 'q', paperId: 'p', question: 'What?' }
it('measures retrieval and visible answer from same t0', async () => {
  let now = 100
  const client = { chatStream: async (_m: unknown, cb: (s: string) => void) => { now = 180; cb(' '); now = 200; cb('Yes'); return { content: 'Yes' } } } as unknown as StreamingLlmClient
  const r = await executeQuery(question, { method: 'A', retrieve: async () => { now = 140; return { text: '', trace: [] } } }, { client, now: () => now, systemPrompt: 'test' })
  expect(r.tContextReady! - r.t0!).toBe(40)
  expect(r.tFirstAnswerToken! - r.t0!).toBe(100)
})
it('keeps failed stream out of completed answers and R has no retrieval timing', async () => {
  const client = { chatStream: async (_m: unknown, cb: (s: string) => void) => { cb('partial'); throw new Error('broken') } } as unknown as StreamingLlmClient
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

it('includes D routing and materialization in retrieval latency but keeps TTFT at the first visible answer token', async () => {
  let now = 10
  const routing = {
    rawAttempts: ['ok'], reasoning: 'method', requestedNodeIds: ['n1'], selectedNodeIds: ['n1'],
    selectedRanges: [{ nodeId: 'n1', startPage: 1, endPage: 1 }],
  }
  const client = { chatStream: async (_m: unknown, cb: (s: string) => void) => {
    now = 80; cb(' '); now = 95; cb('Answer'); return { content: 'Answer' }
  } } as unknown as StreamingLlmClient
  const r = await executeQuery(question, { method: 'D', retrieve: async () => {
    now = 60
    return { text: 'method body', trace: [], routing }
  } }, { client, now: () => now, systemPrompt: 'test' })
  expect(r.tContextReady! - r.t0!).toBe(50)
  expect(r.tFirstAnswerToken! - r.t0!).toBe(85)
  expect(r.routing).toEqual(routing)
})

it('skips generation when D retrieval fails and does not fabricate evidence', async () => {
  const client = { chatStream: vi.fn() } as unknown as StreamingLlmClient
  const r = await executeQuery(question, { method: 'D', retrieve: async () => { throw new Error('routing failed') } }, { client, now: () => 1, systemPrompt: 'test' })
  expect(r).toMatchObject({ retrievalStatus: 'failed', generationStatus: 'skipped', evidence: null, error: { stage: 'retrieve' } })
  expect('routing' in r).toBe(false)
  expect(client.chatStream).not.toHaveBeenCalled()
})

it('persists failed D routing attempts and rejection reasons', async () => {
  const client = { chatStream: vi.fn() } as unknown as StreamingLlmClient
  const diagnostic = {
    rawAttempts: ['invalid'], rejectionReasons: ['invalid routing JSON'], reasoning: '',
    requestedNodeIds: [], selectedNodeIds: [], selectedRanges: [],
  }
  const r = await executeQuery(question, {
    method: 'D', retrieve: async () => { throw new TocRoutingError(diagnostic) },
  }, { client, now: () => 1, systemPrompt: 'test' })
  expect(r.routing).toEqual(diagnostic)
  expect(r).toMatchObject({ retrievalStatus: 'failed', generationStatus: 'skipped', error: { stage: 'retrieve' } })
})
