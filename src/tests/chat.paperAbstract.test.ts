import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ GlobalWorkerOptions: { workerSrc: '' } }))
vi.mock('../utils/transformersEmbedder', () => ({ createTransformersEmbedder: vi.fn().mockRejectedValue(new Error('offline test')) }))
vi.mock('../utils/visualSummaryPdf', () => ({ renderSummaryPdf: vi.fn().mockResolvedValue([{ page: 0, width: 100, height: 100, data: 'data:image/png;base64,YQ==' }]) }))
vi.mock('../utils/visualSummary', async original => ({ ...await original<object>(), hashVisualSource: vi.fn().mockResolvedValue('visual-test-hash') }))

import { useVisualSummaryStore } from '../stores/visualSummary'
import { useChatStore } from '../stores/chat'
import { normalizeDoclingDocument } from '../utils/doclingDocument'
import type { PaperAbstractReport } from '../utils/paperAbstract'

const db = () => (globalThis as any).mockDb
const response = (content: string, reason = 'stop') => ({ ok: true, json: async () => ({ choices: [{ message: { content }, finish_reason: reason }] }) })

beforeEach(() => {
  setActivePinia(createPinia())
  db().paper.readFile.mockResolvedValue('YQ==')
  db().documentSummary.get.mockReset().mockImplementation(async (_kind: string, _id: string, slot: string) => slot === 'materials' ? {
    sourceHash: 'visual-test-hash', payload: JSON.stringify({ version: 1, sourceHash: 'visual-test-hash', protocol: 'visual-materials-v2-padded-crops', items: [], coveredPages: [0], usage: [] }),
  } : null)
  db().documentSummary.save.mockReset().mockResolvedValue({})
  db().settings.get.mockResolvedValue(null)
  db().chat.listConversations.mockResolvedValue([])
  db().index.list.mockResolvedValue([])
  db().paper.get.mockResolvedValue({ id: 'paper', title: 'A paper' })
  db().paperAbstract.get.mockReset().mockResolvedValue(null)
  db().paperAbstract.save.mockReset().mockImplementation(async (report: Omit<PaperAbstractReport, 'updatedAt'>) => ({ ...report, updatedAt: 1 }))
  db().chat.addMessage.mockClear()
  db().docling.convert.mockReset().mockResolvedValue({
    document: normalizeDoclingDocument({ texts: [{ text: 'Original evidence', prov: [{ page_no: 1 }] }] }),
    sourceHash: 'a'.repeat(64), configHash: 'b'.repeat(64), cached: true,
  })
})

describe('paper summary tab generation', () => {
  it('uses a saved report without invoking Docling or the model', async () => {
    const saved = { paperId: 'paper', content: '# Cached', sources: [], truncated: false, updatedAt: 1 }
    db().paperAbstract.get.mockResolvedValue(saved)
    const store = useChatStore()
    await store.init()
    expect(await store.generatePaperAbstract('paper')).toEqual(saved)
    expect(db().docling.convert).not.toHaveBeenCalled()
    expect(db().paperAbstract.save).not.toHaveBeenCalled()
  })

  it('regenerates a saved report when explicitly requested', async () => {
    db().paperAbstract.get.mockResolvedValue({ paperId: 'paper', content: '# Old report', sources: [], truncated: false, updatedAt: 1 })
    const store = useChatStore()
    await store.init()
    await store.updateProfile(store.chatProfileId, { apiKey: 'test', model: 'summary-model' })
    global.fetch = vi.fn().mockResolvedValue(response('## New report'))
    const result = await store.generatePaperAbstract('paper', true)
    expect(result.content).toContain('New report')
    expect(result.content).not.toContain('Old report')
    expect(db().docling.convert).not.toHaveBeenCalled()
  })

  it('reads original pages on demand and saves a report without creating a chat message', async () => {
    const store = useChatStore()
    await store.init()
    await store.updateProfile(store.chatProfileId, { apiKey: 'test', model: 'summary-model' })
    global.fetch = vi.fn().mockResolvedValue(response('## 解读\nEvidence {{cite:text-1}}'))
    const result = await store.generatePaperAbstract('paper')
    expect(result.content).toContain('Evidence')
    expect(db().docling.convert).not.toHaveBeenCalled()
    expect(db().paperAbstract.save).toHaveBeenCalledWith(expect.objectContaining({ paperId: 'paper', truncated: false }))
    expect(db().chat.addMessage).not.toHaveBeenCalled()
    expect(store.abstractProgress['paper-abstract:paper']).toBeUndefined()
  })

  it('does not reuse a native report after the original PDF changes', async () => {
    db().paperAbstract.get.mockResolvedValue({ paperId: 'paper', content: '# Stale source', sources: [], truncated: false, updatedAt: 1 })
    const nativeGet = db().documentSummary.get.getMockImplementation()
    db().documentSummary.get.mockImplementation(async (kind: string, id: string, slot: string) => slot === 'report'
      ? { sourceHash: 'old-source-hash', payload: JSON.stringify({ content: '# Stale source', sourceHash: 'old-source-hash', truncated: false }) }
      : nativeGet(kind, id, slot))
    const store = useChatStore(); await store.init()
    await store.updateProfile(store.chatProfileId, { apiKey: 'test', model: 'summary-model' })
    global.fetch = vi.fn().mockResolvedValue(response('# Updated source'))
    expect((await store.generatePaperAbstract('paper')).content).toBe('# Updated source')
    expect(global.fetch).toHaveBeenCalledOnce()
  })
  it('stops before a pending cache read can start a new model job', async () => {
    let finishCache!: (value: null) => void
    db().paperAbstract.get.mockImplementationOnce(() => new Promise(resolve => { finishCache = resolve }))
    const store = useChatStore(); await store.init()
    const generate = vi.spyOn(useVisualSummaryStore(), 'generatePaper')
    const job = store.generatePaperAbstract('paper')
    const cancelled = expect(job).rejects.toThrow(/取消|停止/)
    store.stopPaperAbstract('paper')
    finishCache(null)
    await cancelled
    expect(generate).not.toHaveBeenCalled()
    expect(db().paperAbstract.save).not.toHaveBeenCalled()
    expect(store.paperAbstractStates.paper.generating).toBe(false)
  })
  it('keeps the full historical report in its first native continuation cache', async () => {
    const full = '# ORIGINAL OPENING\n' + 'Historical evidence. '.repeat(700)
    db().paperAbstract.get.mockResolvedValue({ paperId: 'paper', content: full, sources: [], truncated: true, updatedAt: 1 })
    const store = useChatStore(); await store.init()
    await store.updateProfile(store.chatProfileId, { apiKey: 'test', model: 'summary-model' })
    global.fetch = vi.fn().mockResolvedValue(response('New ending'))
    const result = await store.generatePaperAbstract('paper')
    const native = db().documentSummary.save.mock.calls.find(([row]: any[]) => row.slot === 'report')[0]
    expect(JSON.parse(native.payload).content).toBe(full + '\n\nNew ending')
    expect(result.content).toBe(full + '\n\nNew ending')
    db().paperAbstract.get.mockResolvedValue(result)
    const originalGet = db().documentSummary.get.getMockImplementation()
    db().documentSummary.get.mockImplementation((kind: string, id: string, slot: string) => slot === 'report' ? native : originalGet(kind, id, slot))
    expect((await store.generatePaperAbstract('paper')).content).toBe(result.content)
    expect(global.fetch).toHaveBeenCalledOnce()
  })
  it('keeps a partial cache intact when continuation fails', async () => {
    const partial = { paperId: 'paper', content: '# Beginning', sources: [], truncated: true, updatedAt: 1 }
    db().paperAbstract.get.mockResolvedValue(partial)
    const store = useChatStore()
    await store.init()
    await store.updateProfile(store.chatProfileId, { apiKey: 'test', model: 'summary-model' })
    global.fetch = vi.fn().mockRejectedValue(new Error('model unavailable'))
    await expect(store.generatePaperAbstract('paper')).rejects.toThrow('model unavailable')
    expect(db().paperAbstract.save).not.toHaveBeenCalled()
  })
})
