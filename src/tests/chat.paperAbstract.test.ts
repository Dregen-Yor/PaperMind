import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ GlobalWorkerOptions: { workerSrc: '' } }))
vi.mock('../utils/transformersEmbedder', () => ({ createTransformersEmbedder: vi.fn().mockRejectedValue(new Error('offline test')) }))
import { useChatStore } from '../stores/chat'
import { normalizeDoclingDocument } from '../utils/doclingDocument'
import type { PaperAbstractReport } from '../utils/paperAbstract'

const db = () => (globalThis as any).mockDb
const response = (content: string, reason = 'stop') => ({ ok: true, json: async () => ({ choices: [{ message: { content }, finish_reason: reason }] }) })

beforeEach(() => {
  setActivePinia(createPinia())
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
    expect(db().docling.convert).toHaveBeenCalledWith('paper')
  })

  it('runs Docling on demand and saves a report without creating a chat message', async () => {
    const store = useChatStore()
    await store.init()
    await store.updateProfile(store.chatProfileId, { apiKey: 'test', model: 'summary-model' })
    global.fetch = vi.fn().mockResolvedValue(response('## 解读\nEvidence {{cite:text-1}}'))
    const result = await store.generatePaperAbstract('paper')
    expect(result.content).toContain('Evidence')
    expect(db().docling.convert).toHaveBeenCalledWith('paper')
    expect(db().paperAbstract.save).toHaveBeenCalledWith(expect.objectContaining({ paperId: 'paper', truncated: false }))
    expect(db().chat.addMessage).not.toHaveBeenCalled()
    expect(store.abstractProgress['paper-abstract:paper']).toBeUndefined()
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
