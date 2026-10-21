import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
vi.mock('../utils/visualSummary', async importOriginal => ({ ...(await importOriginal<object>()), requestVisualCompletion: vi.fn(), cropVisualMaterial: vi.fn().mockResolvedValue('data:image/png;base64,YQ==') }))
import { requestVisualCompletion } from '../utils/visualSummary'
vi.mock('../utils/visualSummaryPdf', () => ({ renderSummaryPdf: vi.fn() }))
import { renderSummaryPdf } from '../utils/visualSummaryPdf'
import { useVisualSummaryStore } from '../stores/visualSummary'
const input = { kind: 'paper' as const, sourceId: 'p', title: 'paper', sourceHash: 'hash', pages: [{ page: 0, width: 10, height: 10, data: 'data:image/png;base64,YQ==' }] }
const profile = { id: 'p', name: '', provider: 'openai' as const, model: 'deepseek-flash', apiKey: 'key', baseUrl: 'https://test', temperature: 1, maxTokens: 0, topK: 0, systemPrompt: '' }
beforeEach(() => {
  setActivePinia(createPinia())
  vi.mocked(requestVisualCompletion).mockReset()
  Object.assign(window.db, { documentSummary: { get: vi.fn().mockResolvedValue(null), save: vi.fn().mockResolvedValue({}), saveAsset: vi.fn().mockResolvedValue('a'.repeat(64)) } })
})
describe('background visual summaries', () => {
  it('shares preparation and saves empty material libraries without Docling', async () => {
    vi.mocked(requestVisualCompletion).mockResolvedValue({ content: '{"materials":[]}', truncated: false, usage: null, elapsedMs: 1 })
    const store = useVisualSummaryStore()
    await Promise.all([store.prepare(input, profile), store.prepare(input, profile)])
    expect(requestVisualCompletion).toHaveBeenCalledTimes(1)
    expect(store.states['paper:p'].preparing).toBe(false)
    expect(window.db.documentSummary.save).toHaveBeenCalledWith(expect.objectContaining({ slot: 'materials', sourceHash: 'hash' }))
  })
  it('persists complete report and reuses it across calls', async () => {
    vi.mocked(requestVisualCompletion).mockResolvedValueOnce({ content: '{"materials":[]}', truncated: false, usage: null, elapsedMs: 1 }).mockResolvedValueOnce({ content: '# Result', truncated: false, usage: { total_tokens: 3 }, elapsedMs: 5 })
    const store = useVisualSummaryStore()
    expect(await store.generate(input, profile)).toMatchObject({ content: '# Result' })
    expect(await store.generate(input, profile)).toMatchObject({ content: '# Result' })
    expect(requestVisualCompletion).toHaveBeenCalledTimes(2)
  })
  it('serializes automatic paper rendering together with localization', async () => {
    let finishFirst!: (value: any) => void
    vi.mocked(renderSummaryPdf).mockReset().mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve }))
      .mockResolvedValue(input.pages)
    vi.mocked(window.db.paper.get).mockResolvedValue({ id: 'p', title: 'paper' } as any)
    vi.mocked(window.db.paper.readFile).mockResolvedValue('YQ==')
    vi.mocked(requestVisualCompletion).mockResolvedValue({ content: '{"materials":[]}', truncated: false, usage: null, elapsedMs: 1 })
    const store = useVisualSummaryStore()
    const first = store.preparePaper('p', profile)
    const second = store.preparePaper('other', profile)
    await vi.waitFor(() => expect(finishFirst).toBeTypeOf('function'))
    expect(renderSummaryPdf).toHaveBeenCalledTimes(1)
    finishFirst(input.pages)
    await Promise.all([first, second])
    expect(renderSummaryPdf).toHaveBeenCalledTimes(2)
  })
  it('keeps the full report when chat supplies only the last continuation window', async () => {
    const full = 'Original opening\n' + 'x'.repeat(10_000)
    const dbGet = vi.mocked(window.db.documentSummary.get)
    dbGet.mockImplementation(async (_kind, _id, slot) => slot === 'report' ? { sourceHash: 'hash', payload: JSON.stringify({ content: full, truncated: true, sourceHash: 'hash' }) } as any : null)
    vi.mocked(requestVisualCompletion).mockResolvedValueOnce({ content: '{"materials":[]}', truncated: false, usage: null, elapsedMs: 1 })
      .mockResolvedValueOnce({ content: 'Ending', truncated: false, usage: null, elapsedMs: 1 })
    const store = useVisualSummaryStore()
    const result = await store.generate(input, profile, false, full.slice(-9000))
    expect(result.content).toBe(full + '\n\nEnding')
    const saved = vi.mocked(window.db.documentSummary.save).mock.calls.find(([row]) => row.slot === 'report')![0]
    expect(JSON.parse(saved.payload).content).toBe(full + '\n\nEnding')
  })
  it('refuses oversized documents before any paid localization request', async () => {
    const store = useVisualSummaryStore()
    await expect(store.prepare({ ...input, pages: Array.from({ length: 121 }, (_, page) => ({ ...input.pages[0], page })) }, profile)).rejects.toThrow(/上限/)
    expect(requestVisualCompletion).not.toHaveBeenCalled()
    expect(window.db.documentSummary.save).not.toHaveBeenCalled()
  })
  it('invalidates an active old source version before allowing a new version to persist', async () => {
    let resolveOld!: (result: any) => void
    vi.mocked(requestVisualCompletion).mockImplementationOnce(() => new Promise(r => { resolveOld = r }))
      .mockResolvedValue({ content: '{"materials":[]}', truncated: false, usage: null, elapsedMs: 1 })
    const store = useVisualSummaryStore()
    const old = store.prepare(input, profile)
    const rejected = expect(old).rejects.toThrow(/取消|版本/)
    await vi.waitFor(() => expect(resolveOld).toBeTypeOf('function'))
    const fresh = store.prepare({ ...input, sourceHash: 'new-hash' }, profile)
    resolveOld({ content: '{"materials":[]}', truncated: false, usage: null, elapsedMs: 1 })
    await rejected
    await fresh
    const writes = vi.mocked(window.db.documentSummary.save).mock.calls.map(([row]) => row)
    expect(writes.filter(row => row.slot === 'materials').map(row => row.sourceHash)).toEqual(['new-hash'])
  })
  it('cancelled late response cannot save materials or a report', async () => {
    let resolve!: (result: any) => void
    vi.mocked(requestVisualCompletion).mockImplementation(() => new Promise(r => { resolve = r }))
    const store = useVisualSummaryStore()
    const job = store.prepare(input, profile)
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
    store.cancel('paper', 'p')
    resolve({ content: '{"materials":[]}', truncated: false, usage: null, elapsedMs: 1 })
    await expect(job).rejects.toThrow(/取消/)
    expect(vi.mocked(window.db.documentSummary.save).mock.calls.some(([row]) => row.slot === 'materials')).toBe(false)
  })
})
