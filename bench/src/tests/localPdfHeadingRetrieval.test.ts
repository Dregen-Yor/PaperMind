import { expect, it, vi } from 'vitest'
import { buildTocTree } from '../localPdf/tocTree'
import { expandHeadingPaths, prepareHeadingRetrieval, E_METHOD_CONFIGS } from '../localPdf/headingRetrieval'

const pages = ['METHOD BODY', 'TRAINING BODY', 'RARE OBJECTIVE EVIDENCE', 'EXPERIMENT BODY', 'RESULT BODY']
const tree = buildTocTree({
  paperId: 'p', pageCount: pages.length, headingCandidates: [], tocCandidates: [],
  outline: [
    { id: 'm', title: '3 Method', page: 0, children: [
      { id: 't', title: '3.2 Training', page: 1, children: [
        { id: 'o', title: '3.2.1 Training Objective', page: 2, children: [] },
      ] },
    ] },
    { id: 'e', title: '4 Experiments', page: 3, children: [] },
  ],
})
const embedder = () => ({
  id: 'fixture@1',
  embedPassages: vi.fn(async (texts: string[]) => texts.map(text => new Float32Array(text.includes('Objective') ? [0, 1] : text === 'Experiments' ? [-1, 0] : [1, 0]))),
  embedQuery: vi.fn(async () => new Float32Array([0, 1])),
})

it('expands every title into its full root-to-node path without numbering', () => {
  expect(expandHeadingPaths(tree).map(node => node.path)).toEqual([
    'Method', 'Method > Training', 'Method > Training > Training Objective', 'Experiments',
  ])
})

it('embeds heading paths during preparation and retrieves original evidence without routing', async () => {
  const vectors = embedder()
  const prepared = await prepareHeadingRetrieval(tree, pages, { countTokens: s => s.length, embedder: vectors }, E_METHOD_CONFIGS['E-dense-k3'])
  expect(vectors.embedPassages).toHaveBeenCalledWith(expandHeadingPaths(tree).map(node => node.path))
  expect(vectors.embedQuery).not.toHaveBeenCalled()
  const result = await prepared.retrieve('training goal')
  expect(vectors.embedPassages).toHaveBeenCalledTimes(1)
  expect(vectors.embedQuery).toHaveBeenCalledWith('training goal')
  expect(result.heading.selectedNodeIds).toContain('n0.0.0')
  expect(result.heading.selectedNodeIds).not.toContain('n0')
  expect(result.text).toContain('RARE OBJECTIVE EVIDENCE')
  expect(result.trace.find(t => t.source?.page === 2)?.source).toEqual({ page: 2, start: 0, end: pages[2].length })
  expect(prepared.index.embedderId).toBe('fixture@1')
})

it('BM25 uses original section text and works without a dense model', async () => {
  const prepared = await prepareHeadingRetrieval(tree, pages, { countTokens: s => s.length }, E_METHOD_CONFIGS['E-bm25-k3'])
  const result = await prepared.retrieve('RARE OBJECTIVE EVIDENCE')
  expect(result.heading.ranking[0].nodeId).toBe('n0.0.0')
  expect(result.heading.ranking[0].bm25Score).toBeGreaterThan(0)
  expect(prepared.index.vectors).toEqual([])
})

it('hybrid excludes zero-match BM25 rank credit and applies k before parent pruning', async () => {
  const prepared = await prepareHeadingRetrieval(tree, pages, { countTokens: s => s.length, embedder: embedder() }, E_METHOD_CONFIGS['E-hybrid-k1'])
  const result = await prepared.retrieve('unseenword')
  expect(result.heading.selectedNodeIds).toEqual(['n0.0.0'])
  expect(result.heading.ranking[0].score).toBeCloseTo(1 / 61)
  expect(result.heading.ranking.every(r => r.bm25Score === 0)).toBe(true)
})

it('hybrid lets a strong lexical section match change the dense ranking', async () => {
  const vectors = embedder()
  vectors.embedQuery.mockResolvedValue(new Float32Array([-1, 0]))
  const deps = { countTokens: (s: string) => s.length, embedder: vectors }
  const dense = await prepareHeadingRetrieval(tree, pages, deps, E_METHOD_CONFIGS['E-dense-k3'])
  const hybrid = await prepareHeadingRetrieval(tree, pages, deps, E_METHOD_CONFIGS['E-hybrid-k3'])
  expect((await dense.retrieve('RARE OBJECTIVE EVIDENCE')).heading.ranking[0].nodeId).toBe('n1')
  expect((await hybrid.retrieve('RARE OBJECTIVE EVIDENCE')).heading.ranking[0].nodeId).toBe('n0.0.0')
})

it('deduplicates same-page siblings and changes selections when k changes', async () => {
  const shared = buildTocTree({ paperId: 'p', pageCount: 2, headingCandidates: [], tocCandidates: [], outline: [
    { id: 'a', title: '1 Intro', page: 0, children: [] },
    { id: 'b', title: '2 Objective', page: 1, children: [] },
    { id: 'c', title: '3 Results', page: 1, children: [] },
  ] })
  const deps = { countTokens: (s: string) => s.length, embedder: embedder() }
  const one = await prepareHeadingRetrieval(shared, ['intro', 'unique evidence'], deps, E_METHOD_CONFIGS['E-hybrid-k1'])
  const five = await prepareHeadingRetrieval(shared, ['intro', 'unique evidence'], deps, E_METHOD_CONFIGS['E-hybrid-k5'])
  expect((await one.retrieve('Objective')).heading.selectedNodeIds).toHaveLength(1)
  const result = await five.retrieve('Objective')
  expect(result.heading.selectedNodeIds).toHaveLength(3)
  expect(result.text.match(/unique evidence/g)).toHaveLength(1)
  expect(result.trace.filter(t => t.source?.page === 1)).toHaveLength(1)
})

it('uses the shared budget and emits each overlapping page once', async () => {
  const prepared = await prepareHeadingRetrieval(tree, pages, { countTokens: s => s.length, embedder: embedder() }, { ...E_METHOD_CONFIGS['E-dense-k3'], contextBudget: 26 })
  const result = await prepared.retrieve('q')
  expect(result.text.length).toBeLessThanOrEqual(26)
  const original = result.trace.filter(t => t.source)
  expect(new Set(original.map(t => t.source!.page)).size).toBe(original.length)
  for (const t of original) expect(result.text.slice(t.contextStart, t.contextEnd)).toBe(pages[t.source!.page].slice(t.source!.start, t.source!.end))
})

it('fails explicitly on missing, malformed, or zero vectors and invalid configuration', async () => {
  const deps = { countTokens: (s: string) => s.length, embedder: embedder() }
  await expect(prepareHeadingRetrieval(tree, pages, { countTokens: deps.countTokens }, E_METHOD_CONFIGS['E-hybrid-k3'])).rejects.toThrow(/embedder/)
  deps.embedder.embedPassages.mockResolvedValue([new Float32Array([1, 0])])
  await expect(prepareHeadingRetrieval(tree, pages, deps, E_METHOD_CONFIGS['E-hybrid-k3'])).rejects.toThrow(/vectors/)
  const ready = await prepareHeadingRetrieval(tree, pages, { countTokens: deps.countTokens, embedder: embedder() }, E_METHOD_CONFIGS['E-hybrid-k3'])
  await expect(prepareHeadingRetrieval(tree, pages, deps, { ...E_METHOD_CONFIGS['E-hybrid-k3'], topK: 0 })).rejects.toThrow(/topK/)
  const badQuery = embedder()
  badQuery.embedQuery.mockResolvedValue(new Float32Array([0, 0]))
  const bad = await prepareHeadingRetrieval(tree, pages, { countTokens: deps.countTokens, embedder: badQuery }, E_METHOD_CONFIGS['E-hybrid-k3'])
  await expect(bad.retrieve('q')).rejects.toThrow(/query vector/)
  expect(ready.index.nodes.length).toBe(4)
})
