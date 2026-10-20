import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { usePaperStore, type Highlight } from '../stores/paper'

const first: Highlight = {
  id: 'a-note', paperId: 'a', text: 'Paper A', pageNum: 1, color: '#ffe66a',
  note: 'initial note', startOffset: 0, endOffset: 5, createdAt: 1,
}
const second: Highlight = { ...first, id: 'b-note', paperId: 'b', text: 'Paper B' }
const { id: _id, createdAt: _createdAt, ...firstInput } = first
const db = (globalThis as any).mockDb.highlight
let stored: Highlight[]

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(finish => { resolve = finish })
  return { promise, resolve }
}

beforeEach(() => {
  setActivePinia(createPinia())
  stored = [{ ...first }, { ...second }]
  db.listByPaper.mockReset().mockImplementation(async (paperId: string) =>
    stored.filter(h => h.paperId === paperId).map(h => ({ ...h })))
  db.remove.mockReset().mockImplementation(async (id: string) => { stored = stored.filter(h => h.id !== id) })
  db.create.mockReset().mockImplementation(async (h: Highlight) => { stored.push({ ...h }); return h })
  db.update.mockReset().mockImplementation(async (id: string, patch: { note: string }) => {
    stored = stored.map(h => h.id === id ? { ...h, ...patch } : h)
  })
})

describe('paper-scoped highlight synchronization', () => {
  it('treats a paper ID matching an object property as an empty pending bucket', async () => {
    const store = usePaperStore()
    const read = deferred<Highlight[]>()
    db.listByPaper.mockImplementationOnce(() => read.promise)
    const pending = store.loadHighlights('constructor')
    expect(store.highlights).toEqual([])
    read.resolve([])
    await pending
    expect(store.highlights).toEqual([])
  })

  it('exposes a directly created first mark through the legacy highlights view', async () => {
    const store = usePaperStore()
    await store.addHighlight(firstInput)
    expect(store.highlights.map(h => h.text)).toEqual(['Paper A'])
  })

  it('exposes a directly restored first mark through the legacy highlights view', async () => {
    stored = []
    const store = usePaperStore()
    await store.restoreHighlight(first)
    expect(store.highlights).toEqual([first])
  })

  it('does not resurrect a deleted mark from a read started before deletion', async () => {
    const store = usePaperStore()
    await store.loadHighlights('a')
    const stale = deferred<Highlight[]>()
    db.listByPaper.mockImplementationOnce(() => stale.promise)
    const loading = store.loadHighlights('a')
    await store.removeHighlight(first.id)
    stale.resolve([{ ...first }])
    await loading
    expect(store.highlights).toEqual([])
    expect(await store.getHighlights('a')).toEqual([])
  })

  it('does not lose a restored mark to an older empty read', async () => {
    stored = [{ ...second }]
    const store = usePaperStore()
    await store.loadHighlights('a')
    const stale = deferred<Highlight[]>()
    db.listByPaper.mockImplementationOnce(() => stale.promise)
    const loading = store.loadHighlights('a')
    await store.restoreHighlight(first)
    stale.resolve([])
    await loading
    expect(store.highlights).toEqual([first])
  })

  it('does not overwrite a saved note with a read started before the update', async () => {
    const store = usePaperStore()
    await store.loadHighlights('a')
    const stale = deferred<Highlight[]>()
    db.listByPaper.mockImplementationOnce(() => stale.promise)
    const loading = store.loadHighlights('a')
    await store.updateHighlight(first.id, { note: 'saved note' })
    stale.resolve([{ ...first }])
    await loading
    expect(store.highlights[0].note).toBe('saved note')
  })

  it.each(['create', 'restore', 'remove', 'update'] as const)('keeps a pending A %s scoped to A after B loads', async (operation) => {
    const store = usePaperStore()
    await store.loadHighlights('a')
    const write = deferred<void>()
    if (operation === 'create' || operation === 'restore') {
      db.create.mockImplementationOnce(async (h: Highlight) => { await write.promise; stored.push(h); return h })
    } else if (operation === 'remove') {
      db.remove.mockImplementationOnce(async (id: string) => { await write.promise; stored = stored.filter(h => h.id !== id) })
    } else {
      db.update.mockImplementationOnce(async (id: string, patch: { note: string }) => {
        await write.promise
        stored = stored.map(h => h.id === id ? { ...h, ...patch } : h)
      })
    }
    const pending = operation === 'create' ? store.addHighlight({ ...firstInput, text: 'New A mark' })
      : operation === 'restore' ? store.restoreHighlight({ ...first, id: 'restored-a' })
      : operation === 'remove' ? store.removeHighlight(first.id)
      : store.updateHighlight(first.id, { note: 'New A note' })
    await store.loadHighlights('b')
    write.resolve()
    await pending
    expect(store.highlights).toEqual([second])
    const aRows = await store.getHighlights('a')
    if (operation === 'remove') expect(aRows).toEqual([])
    else if (operation === 'update') expect(aRows[0].note).toBe('New A note')
    else expect(aRows).toHaveLength(2)
  })

  it('shares a pending read between simultaneous consumers of one paper', async () => {
    const store = usePaperStore()
    const read = deferred<Highlight[]>()
    db.listByPaper.mockImplementationOnce(() => read.promise)
    const one = store.getHighlights('a')
    const two = store.loadHighlights('a')
    read.resolve([{ ...first }])
    expect(await one).toEqual([first])
    expect(await two).toEqual([first])
    expect(db.listByPaper).toHaveBeenCalledTimes(1)
  })

  it('leaves cached records intact after failed deletion or restore', async () => {
    const store = usePaperStore()
    await store.loadHighlights('a')
    db.remove.mockRejectedValueOnce(new Error('disk failure'))
    await expect(store.removeHighlight(first.id)).rejects.toThrow('disk failure')
    db.create.mockRejectedValueOnce(new Error('disk failure'))
    await expect(store.restoreHighlight({ ...first, id: 'new' })).rejects.toThrow('disk failure')
    expect(store.highlights).toEqual([first])
  })
})
