import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { usePaperStore } from '../stores/paper'

describe('usePaperStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    ;(globalThis as any).mockDb.paper.list.mockResolvedValue([])
    ;(globalThis as any).mockDb.kb.list.mockResolvedValue([
      { id: 'default', name: '默认知识库', description: '', color: '#409EFF', createdAt: 0 },
    ])
  })

  it('init loads knowledge bases and papers', async () => {
    const store = usePaperStore()
    await store.init()
    expect(store.knowledgeBases).toHaveLength(1)
    expect(store.knowledgeBases[0].id).toBe('default')
    expect(store.papers).toHaveLength(0)
    expect(store.loaded).toBe(true)
  })

  it('init is idempotent', async () => {
    const store = usePaperStore()
    await store.init()
    const callCount = (globalThis as any).mockDb.kb.list.mock.calls.length
    await store.init() // loaded === true, short-circuits
    expect((globalThis as any).mockDb.kb.list.mock.calls.length).toBe(callCount)
  })

  it('addPaper strips fileData from in-memory state', async () => {
    const store = usePaperStore()
    await store.init()
    const id = await store.addPaper({
      title: 'Test Paper', authors: ['Alice'], abstract: 'abc', year: 2024,
      tags: [], status: 'unread', fileName: 'test.pdf', fileHash: 'h-test', knowledgeBaseId: 'default',
      fileData: 'base64data',
    })
    expect(id).toBeTruthy()
    const paper = store.getPaper(id)
    expect(paper).toBeDefined()
    expect((paper as any).fileData).toBeUndefined()
  })

  it('addKnowledgeBase appends to list', async () => {
    const store = usePaperStore()
    await store.init()
    await store.addKnowledgeBase('ML Papers', 'Machine learning', '#3db8a0')
    expect(store.knowledgeBases).toHaveLength(2)
    expect(store.knowledgeBases[1].name).toBe('ML Papers')
  })

  it('removePaper filters from papers array', async () => {
    ;(globalThis as any).mockDb.paper.list.mockResolvedValue([
      { id: 'p1', title: 'A', authors: [], abstract: '', year: 0, tags: [], status: 'unread', fileName: 'a.pdf', addedAt: 1, knowledgeBaseId: 'default' },
    ])
    const store = usePaperStore()
    await store.init()
    await store.removePaper('p1')
    expect(store.papers).toHaveLength(0)
  })

  it('updatePaper merges patch into local state', async () => {
    ;(globalThis as any).mockDb.paper.list.mockResolvedValue([
      { id: 'p1', title: 'Old', authors: [], abstract: '', year: 0, tags: [], status: 'unread', fileName: 'a.pdf', addedAt: 1, knowledgeBaseId: 'default' },
    ])
    const store = usePaperStore()
    await store.init()
    await store.updatePaper('p1', { status: 'done', title: 'New' })
    const p = store.getPaper('p1')!
    expect(p.status).toBe('done')
    expect(p.title).toBe('New')
  })

  it('getPapersByKb returns only matching papers', async () => {
    ;(globalThis as any).mockDb.paper.list.mockResolvedValue([
      { id: 'p1', title: 'A', authors: [], abstract: '', year: 0, tags: [], status: 'unread', fileName: 'a.pdf', addedAt: 1, knowledgeBaseId: 'kb1' },
      { id: 'p2', title: 'B', authors: [], abstract: '', year: 0, tags: [], status: 'unread', fileName: 'b.pdf', addedAt: 2, knowledgeBaseId: 'default' },
    ])
    const store = usePaperStore()
    await store.init()
    expect(store.getPapersByKb('kb1').value).toHaveLength(1)
    expect(store.getPapersByKb('default').value).toHaveLength(1)
  })

  it('addHighlight persists via IPC and returns the highlight', async () => {
    const store = usePaperStore()
    await store.init()
    const h = await store.addHighlight({
      paperId: 'p1', text: 'important', pageNum: 2, color: '#c9a84c',
      note: '', startOffset: 10, endOffset: 19,
    })
    expect(h.id).toBeTruthy()
    expect((globalThis as any).mockDb.highlight.create).toHaveBeenCalledWith(
      expect.objectContaining({ paperId: 'p1', startOffset: 10, endOffset: 19 }),
    )
  })

  it('getHighlights returns highlights for a paper', async () => {
    ;(globalThis as any).mockDb.highlight.listByPaper.mockResolvedValue([
      { id: 'h1', paperId: 'p1', text: 'x', pageNum: 1, color: '#c9a84c', note: '', startOffset: 0, endOffset: 1, createdAt: 0 },
    ])
    const store = usePaperStore()
    await store.init()
    const list = await store.getHighlights('p1')
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe('h1')
  })

  it('loadHighlights populates the reactive highlights list', async () => {
    ;(globalThis as any).mockDb.highlight.listByPaper.mockResolvedValue([
      { id: 'h1', paperId: 'p1', text: 'x', pageNum: 1, color: '#c9a84c', note: '', startOffset: 0, endOffset: 1, createdAt: 0 },
    ])
    const store = usePaperStore()
    await store.init()
    await store.loadHighlights('p1')
    expect(store.highlights).toHaveLength(1)
    expect(store.highlights[0].id).toBe('h1')
  })

  it('updateHighlight calls IPC and merges locally', async () => {
    ;(globalThis as any).mockDb.highlight.listByPaper.mockResolvedValue([
      { id: 'h1', paperId: 'p1', text: 'x', pageNum: 1, color: '#c9a84c', note: '', startOffset: 0, endOffset: 1, createdAt: 0 },
    ])
    const store = usePaperStore()
    await store.init()
    await store.loadHighlights('p1')
    await store.updateHighlight('h1', { note: 'my note' })
    expect((globalThis as any).mockDb.highlight.update).toHaveBeenCalledWith('h1', { note: 'my note' })
    expect(store.highlights[0].note).toBe('my note')
  })

  it('removeHighlight filters the reactive list', async () => {
    ;(globalThis as any).mockDb.highlight.listByPaper.mockResolvedValue([
      { id: 'h1', paperId: 'p1', text: 'x', pageNum: 1, color: '#c9a84c', note: '', startOffset: 0, endOffset: 1, createdAt: 0 },
    ])
    const store = usePaperStore()
    await store.init()
    await store.loadHighlights('p1')
    await store.removeHighlight('h1')
    expect((globalThis as any).mockDb.highlight.remove).toHaveBeenCalledWith('h1')
    expect(store.highlights).toHaveLength(0)
  })
})
