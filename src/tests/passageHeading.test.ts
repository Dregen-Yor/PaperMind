import { afterEach, describe, expect, it, vi } from 'vitest'
import * as bm25Module from '../utils/bm25'
import type { Embedder } from '../utils/embedder'
import { PASSAGE_INDEX_VERSION, type PassageIndex } from '../utils/passageIndex'
import type { Passage } from '../utils/passages'
import { DEFAULT_HYBRID_OPTIONS, retrievePassageContext } from '../utils/passageRetrieval'

afterEach(() => vi.restoreAllMocks())

function headingIndex(titles = ['Background', 'Needle navigation', 'Discussion']): PassageIndex {
  const passages: Passage[] = titles.map((subsection, order) => {
    const pieces = order === 1
      ? [{ page: 2, text: 'Exact evidence\n' }, { page: 3, text: 'continues here.' }]
      : [{ page: order * 2, text: order === 0 ? 'needle evidence' : 'unrelated body' }]
    const text = pieces.map(piece => piece.text).join('')
    return {
      id: `P${order + 1}`, order, pieces, text, searchText: text,
      tokenCount: 40, subsection,
      prevId: order > 0 ? `P${order}` : null,
      nextId: order < titles.length - 1 ? `P${order + 2}` : null,
    }
  })
  return {
    version: PASSAGE_INDEX_VERSION, stage: 1, passages,
    passageConfigHash: 'heading-test', separatorTokens: 2,
    tree: { title: 'Paper', nodeId: 'root', startPage: 0, endPage: 5, summary: '', nodes: [] },
  }
}

const onePassage = { maxTokens: 40, neighbourFactor: 0 }

describe('optional heading navigation prior', () => {
  it('a positive title hit lifts its region without inserting navigation text or changing page pieces', async () => {
    const index = headingIndex()
    const original = structuredClone(index.passages)
    const off = await retrievePassageContext(index, 'needle', onePassage)
    const on = await retrievePassageContext(index, 'needle', { ...onePassage, headingWeight: 0.25 })

    expect(off.hybrid.selectedPassageIds).toEqual(['P1'])
    expect(on.hybrid.selectedPassageIds).toEqual(['P2'])
    expect(on.context).toBe(index.passages[1].text)
    expect(on.contextGroups).toEqual([{ pieces: index.passages[1].pieces }])
    expect(on.sources).toEqual(['Pages 3–4: 段落 P2'])
    expect(on.context).not.toContain('Needle navigation')
    expect(on.llmCalled).toBe(false)
    expect(on.hybrid.candidateCount).toBe(off.hybrid.candidateCount)
    expect(index.passages).toEqual(original)
  })

  it('omitted or zero weight and a positive weight without any title hit exactly preserve the baseline', async () => {
    const index = headingIndex()
    const baseline = await retrievePassageContext(index, 'evidence', onePassage)
    expect(DEFAULT_HYBRID_OPTIONS.headingWeight).toBe(0)
    expect(await retrievePassageContext(index, 'evidence', { ...onePassage, headingWeight: 0 })).toEqual(baseline)
    expect(await retrievePassageContext(index, 'evidence', { ...onePassage, headingWeight: 0.5 })).toEqual(baseline)
    const hitBaseline = await retrievePassageContext(index, 'needle', onePassage)
    expect(await retrievePassageContext(index, 'needle', { ...onePassage, headingWeight: 0 })).toEqual(hitBaseline)
  })

  it('a strong unhit passage remains selectable and every original candidate remains scored', async () => {
    const index = headingIndex()
    const result = await retrievePassageContext(index, 'needle', { ...onePassage, headingWeight: 0.001 })
    expect(result.hybrid.selectedPassageIds).toEqual(['P1'])
    expect(result.hybrid.candidateCount).toBe(index.passages.length)
    expect(result.scores.map(item => item.id).sort()).toEqual([0, 1, 2])
  })

  it('repeated separated titles form distinct contiguous ranges and blank titles fabricate no prior', async () => {
    const index = headingIndex(['Target', 'Target', 'Other', 'Target', 'Target', '', '   '])
    index.passages.forEach(passage => { passage.searchText = 'neutral' })
    const result = await retrievePassageContext(index, 'target', { ...onePassage, headingWeight: 0.5 })
    const byId = new Map(result.scores.map(item => [item.id, item.score]))
    expect(byId.get(0)).toBe(1 / 61 + 0.5 / 61)
    expect(byId.get(1)).toBe(byId.get(0))
    expect(byId.get(3)).toBe(1 / 61 + 0.5 / 62)
    expect(byId.get(4)).toBe(byId.get(3))
    for (const id of [2, 5, 6]) expect(byId.get(id)).toBe(1 / 61)
  })

  it('prepares heading BM25 lazily, reuses it, and invalidates on stage or subsection changes', async () => {
    const build = vi.spyOn(bm25Module, 'buildBm25Scorer')
    const index = headingIndex()
    await retrievePassageContext(index, 'needle', onePassage)
    await retrievePassageContext(index, 'needle', { ...onePassage, headingWeight: 0 })
    expect(build).toHaveBeenCalledTimes(1)
    const opts = { ...onePassage, headingWeight: 0.25 }
    await retrievePassageContext(index, 'needle', opts)
    await retrievePassageContext(index, 'needle', opts)
    expect(build).toHaveBeenCalledTimes(2)
    index.stage = 2
    await retrievePassageContext(index, 'needle', opts)
    expect(build).toHaveBeenCalledTimes(4)
    index.passages[1].subsection = 'Unrelated'
    index.passages[2].subsection = 'Needle navigation'
    const changed = await retrievePassageContext(index, 'needle', opts)
    expect(build).toHaveBeenCalledTimes(6)
    expect(changed.hybrid.selectedPassageIds).toEqual(['P3'])
    expect(changed).toEqual(await retrievePassageContext({ ...index }, 'needle', opts))
  })

  it('revalidates subsection mutations after embedding and scores captured arrays when arrays are replaced', async () => {
    const index = headingIndex()
    index.stage = 2
    index.vectorDim = 2
    index.passageVectors = index.passages.map(() => new Float32Array([1, 0]))
    const embedder: Embedder = {
      id: 'fake', embedPassages: vi.fn(),
      embedQuery: vi.fn(async () => {
        index.passages[1].subsection = 'Unrelated'
        index.passages[2].subsection = 'Needle navigation'
        return new Float32Array([1, 0])
      }),
    }
    const opts = { ...onePassage, headingWeight: 1, embedder }
    const updated = await retrievePassageContext(index, 'needle', opts)
    expect(updated.hybrid.selectedPassageIds).toEqual(['P3'])
    expect(updated).toEqual(await retrievePassageContext({ ...index }, 'needle', opts))

    const before = await retrievePassageContext(index, 'needle', { ...opts, embedder: undefined })
    vi.mocked(embedder.embedQuery).mockImplementationOnce(async () => {
      index.passages = index.passages.map((passage, order) => ({ ...passage, subsection: order === 1 ? 'Needle navigation' : 'Other' }))
      throw new Error('offline')
    })
    const replaced = await retrievePassageContext(index, 'needle', opts)
    expect(replaced.scores).toEqual(before.scores)
    expect(replaced.hybrid.selectedPassageIds).toEqual(['P3'])
    expect((await retrievePassageContext(index, 'needle', { ...opts, embedder: undefined })).hybrid.selectedPassageIds).toEqual(['P2'])
  })

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid heading weight %s', async headingWeight => {
    await expect(retrievePassageContext(headingIndex(), 'needle', { headingWeight })).rejects.toThrow(/headingWeight/)
  })
})
