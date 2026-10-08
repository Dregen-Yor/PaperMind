import { describe, expect, it } from 'vitest'
import { buildEk5Index, retrieveEk5, parseEk5Index } from '../utils/ek5/index'
import golden from './fixtures/ek5-golden.json'
import type { Embedder } from '../utils/embedder'

const embedder = { id: 'test', embedPassages: async (xs: string[]) => xs.map((_, i) => new Float32Array([i + 1, 1])), embedQuery: async () => new Float32Array([1, 2]) } as Embedder
const pages = ['Introduction\nIntro body.\nMethods\nOur method uses lasers.', 'Results\nLasers succeed.\nConclusion\nDone.']
const outline = [
  { id: '0', title: 'Introduction', page: 0, children: [] },
  { id: '1', title: 'Methods', page: 0, children: [] },
  { id: '2', title: 'Results', page: 1, children: [] },
  { id: '3', title: 'Conclusion', page: 1, children: [] },
]
const doc = { pages, outline, layoutLines: [] }
describe('product E-k5', () => {
  it.each(golden.fixtures)('matches frozen benchmark groups and complete context ($pages.length pages)', async (fixture) => {
    const index = await buildEk5Index('p', { pages: fixture.pages, outline: fixture.outline, layoutLines: [] }, embedder)
    const actual = await retrieveEk5(index, fixture.query, embedder)
    expect(actual.context).toBe(fixture.expectedContext)
    expect(actual.selected.map(x => x.nodeId)).toEqual(fixture.expectedSelectedNodeIds)
    expect(actual.selected).toHaveLength(Math.min(5, fixture.outline.length))
  })
  it('round trips and rejects corrupted or legacy indexes', async () => {
    const index = await buildEk5Index('p', doc, embedder)
    expect(parseEk5Index(JSON.stringify(index), pages, embedder.id)).toEqual(index)
    expect(parseEk5Index(JSON.stringify(index), ['changed'], embedder.id)).toBeUndefined()
    expect(parseEk5Index(JSON.stringify(index), pages, 'another-model')).toBeUndefined()
    expect(parseEk5Index('{"version":2}', pages, embedder.id)).toBeUndefined()
    index.vectors[0] = [0, 0]
    expect(parseEk5Index(JSON.stringify(index), pages, embedder.id)).toBeUndefined()
  })
  it('does not silently fall back when headings or vectors are unavailable', async () => {
    await expect(buildEk5Index('p', { pages: ['unstructured'], outline: [], layoutLines: [] }, embedder)).rejects.toThrow()
    const index = await buildEk5Index('p', doc, embedder)
    await expect(retrieveEk5(index, 'lasers', { ...embedder, embedQuery: async () => { throw new Error('offline') } })).rejects.toThrow()
  })
})

import { hashCanonical as browserHash } from '../utils/ek5/contract'
import { retrieveRagContext } from '../utils/ragPipeline'
it('has the same SHA-256 identities as the frozen benchmark, including Unicode and long inputs', () => {
  const values = ['', '你好🚀', 'a'.repeat(100000), { z: 1, a: ['é', { b: 2 }] }]
  expect(values.map(browserHash)).toEqual(golden.hashes)
})
it('rejects combined multi-paper overflow instead of clipping complete groups', async () => {
  const index = await buildEk5Index('p', doc, embedder)
  const paper = { ek5: index, pages, tree: { nodeId: 'r', title: '', summary: '', startPage: 0, endPage: 1, nodes: [] } }
  const result = await retrieveRagContext([paper], 'lasers', [], async () => '', { retrievalMode: 'ek5' }, { passage: { embedder } })
  await expect(retrieveRagContext([paper, paper], 'lasers', [], async () => '', { retrievalMode: 'ek5', maxContextChars: result.context.length + 1 }, { passage: { embedder } })).rejects.toThrow('超出上下文预算')
  expect(result.contextTruncated).toBe(false)
})
it('refuses a legacy index under the product-only retrieval contract', async () => {
  await expect(retrieveRagContext([{ pages, tree: { nodeId: 'r', title: '', summary: '', startPage: 0, endPage: 1, nodes: [] } }], 'query', [], async () => '', { retrievalMode: 'ek5' })).rejects.toThrow('章节索引未就绪')
})
