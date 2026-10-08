// Replacement for the retired staged-passage store contract: E-k5 is now exclusive.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '../stores/chat'
import { extractPdfDocument } from '../utils/pdfDocument'
import { createTransformersEmbedder } from '../utils/transformersEmbedder'
import { ek5Doc, ek5Embedder } from './fixtures/ek5'
import { buildEk5Index } from '../utils/ek5/index'

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ GlobalWorkerOptions: {} }))
vi.mock('../utils/pdfDocument', () => ({ extractPdfDocument: vi.fn() }))
vi.mock('../utils/transformersEmbedder', () => ({ createTransformersEmbedder: vi.fn() }))
const records = new Map<string, { indexJson: string; pagesJson: string }>()
const sse = () => ({ ok: true, status: 200, body: new Response('data: {"choices":[{"delta":{"content":"Answer"}}]}\n\ndata: [DONE]\n\n').body })
beforeEach(() => {
  setActivePinia(createPinia()); vi.clearAllMocks(); records.clear()
  vi.mocked(extractPdfDocument).mockResolvedValue(ek5Doc)
  vi.mocked(createTransformersEmbedder).mockResolvedValue(ek5Embedder)
  vi.mocked(window.db.paper.list).mockResolvedValue([{ id: 'p', title: 'Paper A' }, { id: 'q', title: 'Paper B' }] as any)
  vi.mocked(window.db.paper.readFile).mockResolvedValue('PDF')
  vi.mocked(window.db.index.get).mockImplementation(async id => records.get(id) ?? null as any)
  vi.mocked(window.db.index.set).mockImplementation(async (id, indexJson, pagesJson) => { records.set(id, { indexJson, pagesJson }) })
  vi.mocked(window.db.settings.get).mockResolvedValue(null)
  vi.mocked(window.db.chat.listConversations).mockResolvedValue([])
  global.fetch = vi.fn(async () => sse()) as any
})
describe('E-k5 product index lifecycle', () => {
  it('migrates legacy indexes atomically and reuses cached data', async () => {
    records.set('p', { indexJson: '{"version":2}', pagesJson: '["old"]' })
    const store = useChatStore()
    const conv = await store.newConversation('t', ['p'])
    const a = await store.collectIndexedPapers(conv), b = await store.collectIndexedPapers(conv)
    expect(a.papers[0].ek5).toBe(b.papers[0].ek5)
    expect(a.papers[0].passageIndex).toBeUndefined()
    expect(a.papers[0].semantic).toBeUndefined()
    expect(extractPdfDocument).toHaveBeenCalledTimes(1)
    expect(JSON.parse(records.get('p')!.indexJson).version).toBe('ek5-product-v1')
  })
  it('deduplicates concurrent import and question builds', async () => {
    const store = useChatStore(), conv = await store.newConversation('t', ['p'])
    await Promise.all([store.indexPaper('p'), store.collectIndexedPapers(conv), store.indexPaper('p')])
    expect(extractPdfDocument).toHaveBeenCalledTimes(1)
    expect(window.db.index.set).toHaveBeenCalledTimes(1)
    expect(store.indexingPapers.size).toBe(0)
  })
  it('does not overwrite legacy data or generate an answer when rebuilding fails', async () => {
    const old = { indexJson: '{"version":2}', pagesJson: '["old"]' }; records.set('p', old)
    vi.mocked(extractPdfDocument).mockRejectedValue(new Error('bad PDF'))
    const store = useChatStore(), conv = await store.newConversation('t', ['p'])
    await expect(store.sendMessage(conv.id, 'question')).rejects.toThrow('bad PDF')
    expect(records.get('p')).toBe(old)
    expect(fetch).not.toHaveBeenCalled()
    expect(store.indexingPapers.size).toBe(0)
  })
  it('waits for the hybrid model rather than silently using BM25', async () => {
    let resolve!: (e: typeof ek5Embedder) => void
    vi.mocked(createTransformersEmbedder).mockReturnValue(new Promise(r => { resolve = r }))
    const store = useChatStore()
    const job = store.indexPaper('p')
    await Promise.resolve()
    expect(window.db.index.set).not.toHaveBeenCalled()
    resolve(ek5Embedder); await job
    expect(window.db.index.set).toHaveBeenCalledTimes(1)
  })
  it('reports model failure and permits retry', async () => {
    vi.mocked(createTransformersEmbedder).mockRejectedValueOnce(new Error('offline'))
    const store = useChatStore()
    await expect(store.indexPaper('p')).rejects.toThrow('本地检索模型')
    await store.indexPaper('p')
    expect(store.indexedPapers.has('p')).toBe(true)
  })
  it('reuses persisted indexes across store instances without PDF parsing', async () => {
    const index = await buildEk5Index('p', ek5Doc, ek5Embedder)
    records.set('p', { indexJson: JSON.stringify(index), pagesJson: JSON.stringify(ek5Doc.pages) })
    await useChatStore().indexPaper('p')
    setActivePinia(createPinia()); await useChatStore().indexPaper('p')
    expect(extractPdfDocument).not.toHaveBeenCalled()
  })
  it('rebuilds damaged records and never revives deleted cache entries', async () => {
    const store = useChatStore()
    await store.indexPaper('p'); records.delete('p'); await store.indexPaper('p')
    records.set('p', { indexJson: 'broken', pagesJson: 'broken' }); await store.indexPaper('p')
    expect(extractPdfDocument).toHaveBeenCalledTimes(3)
  })
  it('sends distinct paper labels and preserves source paper/page identities', async () => {
    const store = useChatStore(), conv = await store.newConversation('t', ['p', 'q'])
    await store.sendMessage(conv.id, 'lasers')
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)
    expect(body.messages[0].content).toContain('[Paper: Paper A]')
    expect(body.messages[0].content).toContain('[Paper: Paper B]')
    const sources = conv.messages.at(-1)!.sources!
    expect(new Set(sources.map(s => s.paperId))).toEqual(new Set(['p', 'q']))
    expect(sources.every(s => typeof s.startPage === 'number' && typeof s.endPage === 'number')).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('continues with E-k5 and retains the previous answer', async () => {
    const store = useChatStore(), conv = await store.newConversation('t', ['p'])
    await store.sendMessage(conv.id, 'lasers')
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'continued' } }] }) })) as any
    await store.continueMessage(conv.id, conv.messages.at(-1)!.id)
    expect(conv.messages.at(-1)!.content).toBe('Answercontinued')
    const call = vi.mocked(fetch).mock.calls.at(-1)!
    expect(JSON.parse(call[1]!.body as string).messages[0].content).toContain('[Evidence G')
  })
  it('keeps selected-text questions independent of index/model readiness', async () => {
    vi.mocked(createTransformersEmbedder).mockRejectedValue(new Error('offline'))
    const store = useChatStore(), conv = await store.newConversation('t', ['p'])
    await store.sendMessage(conv.id, 'question', 'Selected evidence')
    expect(extractPdfDocument).not.toHaveBeenCalled()
    expect(conv.messages.at(-1)!.content).toBe('Answer')
  })
})

it('loads WASM assets from the application URL, never the Vite dependency directory', async () => {
  await useChatStore().indexPaper('p')
  expect(createTransformersEmbedder).toHaveBeenCalledWith({ wasmPaths: new URL('./ort/', window.location.href).href })
})

it('a requested forced rebuild waits for the in-flight build and then rebuilds', async () => {
  const { createEk5Store } = await import('../utils/ek5/store')
  let release!: (doc: typeof ek5Doc) => void
  vi.mocked(extractPdfDocument).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const service = createEk5Store(async () => ek5Embedder)
  const initial = service.load('p')
  await vi.waitFor(() => expect(extractPdfDocument).toHaveBeenCalledTimes(1))
  const forced = service.load('p', true)
  release(ek5Doc)
  await Promise.all([initial, forced])
  expect(extractPdfDocument).toHaveBeenCalledTimes(2)
})

it('keeps sources bound to the submitted paper selection while indexing is pending', async () => {
  let release!: (doc: typeof ek5Doc) => void
  vi.mocked(extractPdfDocument).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const store = useChatStore(), conv = await store.newConversation('t', ['p'])
  const collecting = store.collectIndexedPapers(conv)
  await vi.waitFor(() => expect(extractPdfDocument).toHaveBeenCalledTimes(1))
  await store.syncPaperIds(conv.id, ['q'])
  release(ek5Doc)
  const result = await collecting
  expect(result.paperIds).toEqual(['p'])
  expect(result.papers[0].ek5!.paperId).toBe('p')
})
