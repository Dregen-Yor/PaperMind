// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { runProductBenchmark, createProductModel, readDoclingInput, readExtractedInput, PRODUCT_SYSTEM_PROMPT, sha256, type ProductProfile, type ProductRunArgs } from '../runner/product'
import { syntheticPdf, smokeDocling, smokeEmbedder } from '../../product-fixtures/smoke'

const profile: ProductProfile = { provider: 'openai', model: 'standard-chat', revision: 'operator-model-revision', baseUrl: 'https://example.invalid/v1', temperature: 0.7, maxTokens: 0, systemPrompt: PRODUCT_SYSTEM_PROMPT }
const pages = ['Introduction\nIntro body.\nMethods\nOur method uses lasers.', 'Results\nLasers succeed.\nConclusion\nDone.']
const document = { pages, layoutLines: [], outline: ['Introduction', 'Methods', 'Results', 'Conclusion'].map((title, i) => ({ id: `${i}`, title, page: i < 2 ? 0 : 1, children: [] })) }
function input(patch: Partial<ProductRunArgs> = {}): ProductRunArgs {
  const pdfBytes = syntheticPdf()
  const hash = sha256(pdfBytes)
  return { pdfBytes, title: 'Synthetic study', synthetic: true, task: 'all', questions: [{ question: 'What method?', referenceAnswers: ['lasers'], referencePages: [0] }],
    profile, embedder: smokeEmbedder, gitSha: 'test-sha', dirty: true, packageVersion: 'test',
    extractedInput: { sourceSha256: hash, document }, doclingInput: { sourceSha256: hash, document: smokeDocling },
    complete: async () => 'What method?', chat: async () => 'lasers', summaryCompletion: async () => ({ content: '摘要 {{cite:text-1-s1}}', truncated: false }), ...patch }
}
describe('product benchmark runner contracts', () => {
  it('uses the production E-k5 index, exact source ranges and production summary citations', async () => {
    const messages: Array<{ role: string; content: string }[]> = []
    const result = await runProductBenchmark(input({ chat: async value => { messages.push(value); return 'lasers' }, summaryCompletion: async value => { messages.push(value); return { content: '摘要 {{cite:text-1-s1}}', truncated: false } } }))
    expect(result.errors).toEqual([])
    expect(result.index?.totalLeaves).toBe(4)
    expect(result.qa[0].retrieval.selectedLeaves).toHaveLength(4)
    expect(result.qa[0].retrieval.leafCoverage).toBe(1)
    expect(result.qa[0].retrieval.hitPages).toEqual([0, 1])
    expect(result.qa[0].metrics).toEqual({ pageRecall: 1, answerF1: 1 })
    expect(messages[0][0].role).toBe('system')
    expect(messages[0][0].content).toContain(PRODUCT_SYSTEM_PROMPT)
    expect(messages[0].at(-1)).toEqual({ role: 'user', content: 'What method?' })
    expect(messages[1][0].content.startsWith(PRODUCT_SYSTEM_PROMPT + '\n\n')).toBe(true)
    expect(result.summary?.content).toContain('paper-source:')
    expect(result.summary?.runKey).toMatch(/^[a-f0-9]{64}$/)
  })
  it('rejects hash-mismatched raw and normalized inputs before model calls', async () => {
    expect(() => readDoclingInput({ sourceSha256: 'wrong', document: smokeDocling }, 'right')).toThrow('sourceSha256')
    expect(() => readExtractedInput({ sourceSha256: 'wrong', document }, 'right')).toThrow('sourceSha256')
    const chat = vi.fn()
    await expect(runProductBenchmark(input({ chat, extractedInput: { sourceSha256: 'wrong', document } }))).rejects.toThrow('sourceSha256')
    expect(chat).not.toHaveBeenCalled()
  })
  it('keeps retrieval measurements when generation fails, and reports a non-success outcome', async () => {
    const result = await runProductBenchmark(input({ chat: async () => { throw new Error('offline model') } }))
    expect(result.qa[0].retrieval.hitPages).toEqual([0, 1])
    expect(result.qa[0].answer).toBeUndefined()
    expect(result.errors).toContainEqual({ stage: 'generation', message: 'offline model' })
  })
  it('uses the product character budget error instead of truncating or falling back to legacy', async () => {
    const chat = vi.fn()
    const result = await runProductBenchmark(input({ maxContextChars: 1, chat }))
    expect(result.errors[0].stage).toBe('retrieval')
    expect(result.errors[0].message).toContain('超出上下文预算')
    expect(chat).not.toHaveBeenCalled()
    expect(result.qa).toEqual([])
  })
  it('uses history-based product query rewriting and forwards history roles', async () => {
    const complete = vi.fn(async () => 'Standalone laser method question')
    const chat = vi.fn(async (_messages: { role: string; content: string }[]) => 'lasers')
    const history = [{ role: 'user' as const, content: 'What is this study?' }, { role: 'assistant' as const, content: 'A laser study.' }]
    const result = await runProductBenchmark(input({ task: 'qa', complete, chat, questions: [{ question: 'How does it work?', history }] }))
    expect(complete).toHaveBeenCalledOnce()
    expect(result.qa[0].retrieval.rewritten).toBe(true)
    expect(result.qa[0].retrieval.query).toBe('Standalone laser method question')
    expect(chat.mock.calls[0][0].slice(1, 3)).toEqual(history)
  })
  it('accepts a raw Docling document with a matching original PDF hash', () => {
    const parsed = readDoclingInput({ sourceSha256: 'right', document: { texts: [{ self_ref: '#/texts/0', label: 'text', text: 'Raw text.', prov: [{ page_no: 1 }] }], body: { children: [{ $ref: '#/texts/0' }] } } }, 'right')
    expect(parsed.items[0].text).toBe('Raw text.')
  })
})

describe('product-parameter benchmark transport', () => {
  it('sends exact system/user roles, product default temperature, no unlimited token cap and records truncation', async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ choices: [{ message: { content: 'partial' }, finish_reason: 'length' }] }))
    const model = createProductModel(profile, 'test-key', request)
    const messages = [{ role: 'system', content: 'system' }, { role: 'user', content: 'question' }]
    expect(await model.completion(messages)).toEqual({ content: 'partial', truncated: true })
    const body = JSON.parse(String(request.mock.calls[0][1]?.body))
    expect(body).toEqual({ model: profile.model, messages, temperature: 0.7 })
  })
  it('sends Ollama profile sampling options and positive output caps', async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ message: { content: 'answer' }, done_reason: 'stop' }))
    const model = createProductModel({ ...profile, provider: 'ollama', maxTokens: 100 }, '', request)
    await model.completion([{ role: 'user', content: 'question' }])
    expect(String(request.mock.calls[0][0])).toBe(profile.baseUrl + '/api/chat')
    expect(JSON.parse(String(request.mock.calls[0][1]?.body)).options).toEqual({ num_predict: 100, temperature: 0.7 })
  })
  it('rejects native Anthropic and reasoning models whose wire protocol differs', () => {
    expect(() => createProductModel({ ...profile, provider: 'anthropic' } as unknown as ProductProfile, '')).toThrow('Anthropic')
    expect(() => createProductModel({ ...profile, model: 'openai/gpt-6' }, '')).toThrow('推理模型')
  })
})
