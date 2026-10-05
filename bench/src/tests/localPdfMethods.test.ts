import { it, expect, vi } from 'vitest'
import * as bm25 from '../../../src/utils/bm25'
import { prepareMethod } from '../localPdf/methods'
import type { PdfTextLine } from '../../../src/utils/pdfDocument'
const corpus = { paperId: 'p', pages: ['This is a complete original paragraph.'], outline: [], layoutLines: [[]] }
it('A avoids embedding and R keeps whole text', async () => {
  const embedder = { id: 'test', embedQuery: vi.fn(), embedPassages: vi.fn() }
  const a = await prepareMethod('A', corpus, { countTokens: s => s.length, embedder })
  expect((await a.retrieve!('paragraph')).text).toContain('original')
  expect(embedder.embedPassages).not.toHaveBeenCalled()
  const r = await prepareMethod('R', corpus, { countTokens: s => s.length })
  expect(r.fullText).toBe(corpus.pages[0]); expect(r.retrieve).toBeUndefined()
})
it('C missing outline falls back to B and dense failure is explicit', async () => {
  const embedder = { id: 'test', embedQuery: vi.fn(async () => new Float32Array([1, 0])), embedPassages: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array([1, 0]))) }
  const deps = { countTokens: (s: string) => s.length, embedder }
  const b = await prepareMethod('B', corpus, deps); const c = await prepareMethod('C', corpus, deps)
  expect(c.fallbackReason).toBe('missing-outline')
  expect(await b.retrieve!('paragraph')).toEqual(await c.retrieve!('paragraph'))
  expect(embedder.embedQuery).toHaveBeenCalledTimes(2)
  await expect(prepareMethod('B', corpus, { countTokens: s => s.length })).rejects.toThrow(/embedder/)
  embedder.embedQuery.mockRejectedValue(new Error('broken'))
  await expect(b.retrieve!('q')).rejects.toThrow(/dense/)
})

it('builds BM25 before timed queries and reuses it', async () => {
  const build = vi.spyOn(bm25, 'buildBm25Scorer')
  const a = await prepareMethod('A', corpus, { countTokens: s => s.length })
  expect(build).toHaveBeenCalledTimes(1)
  await a.retrieve!('first'); await a.retrieve!('second')
  expect(build).toHaveBeenCalledTimes(1)
  build.mockRestore()
})

it('prepares D before retrieval and routes without embeddings or body text in the prompt', async () => {
  const line = (page: number, text: string): PdfTextLine => ({ page, text, x: 10, y: 700, fontSize: 18, bold: true })
  const dCorpus = {
    paperId: 'p', pages: ['SECRET INTRO BODY', 'SECRET METHOD BODY'], outline: [],
    layoutLines: [[line(0, '1 Introduction')], [line(1, '2 Methods')]],
  }
  const routeToc = vi.fn(async (prompt: string) => {
    expect(prompt).not.toContain('SECRET')
    return '{"reasoning":"methods","node_ids":["n1"]}'
  })
  const embedder = { id: 'test', embedQuery: vi.fn(), embedPassages: vi.fn() }
  const build = vi.spyOn(bm25, 'buildBm25Scorer')
  const d = await prepareMethod('D', dCorpus, { countTokens: s => s.length, embedder, routeToc })
  expect(d.tree?.roots.map(node => node.title)).toEqual(['1 Introduction', '2 Methods'])
  expect(routeToc).not.toHaveBeenCalled()
  const result = await d.retrieve!('What method?')
  expect(result.text).toBe('SECRET METHOD BODY')
  expect(result.trace[0].source).toEqual({ page: 1, start: 0, end: 18 })
  expect(result.routing?.selectedNodeIds).toEqual(['n1'])
  expect(embedder.embedPassages).not.toHaveBeenCalled()
  expect(build).not.toHaveBeenCalled()
  build.mockRestore()
})

it('fails D explicitly when routing or a valid tree is unavailable', async () => {
  const line: PdfTextLine = { page: 0, text: '1 Introduction', x: 0, y: 1, fontSize: 18, bold: true }
  await expect(prepareMethod('D', { ...corpus, layoutLines: [[line]] }, { countTokens: s => s.length }))
    .rejects.toThrow(/rout/i)
  const deps = { countTokens: (s: string) => s.length, routeToc: async () => 'invalid' }
  await expect(prepareMethod('D', { ...corpus, layoutLines: [[line]] }, deps)).rejects.toThrow(/no-valid-toc-tree/)
  const lines = [[line], [{ ...line, page: 1, text: '2 Methods' }]]
  const d = await prepareMethod('D', { ...corpus, pages: ['one', 'two'], layoutLines: lines }, deps)
  await expect(d.retrieve!('q')).rejects.toThrow(/two invalid/i)
})

it('prepares E with hierarchy vectors and no generative routing call', async () => {
  const eCorpus = { ...corpus, pages: ['intro', 'objective body'], outline: [
    { id: 'i', title: '1 Introduction', page: 0, children: [] },
    { id: 'm', title: '2 Method', page: 1, children: [{ id: 'o', title: '2.1 Objective', page: 1, children: [] }] },
  ], layoutLines: [[], []] }
  const embedder = { id: 'test', embedQuery: vi.fn(async () => new Float32Array([0, 1])), embedPassages: vi.fn(async (texts: string[]) => texts.map(s => new Float32Array(s.includes('Objective') ? [0, 1] : [1, 0]))) }
  const routeToc = vi.fn(async () => { throw new Error('unexpected generative routing') })
  const e = await prepareMethod('E-hybrid-k3', eCorpus, { countTokens: s => s.length, embedder, routeToc })
  expect(embedder.embedPassages).toHaveBeenCalledWith(['Introduction', 'Method', 'Method > Objective'])
  const result = await e.retrieve!('objective')
  expect(result.heading?.selectedNodeIds).toContain('n1.0')
  expect(e.headingIndex?.nodes.map(n => n.path)).toContain('Method > Objective')
  expect(routeToc).not.toHaveBeenCalled()
})
