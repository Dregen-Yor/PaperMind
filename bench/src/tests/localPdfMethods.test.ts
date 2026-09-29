import { it, expect, vi } from 'vitest'
import { prepareMethod } from '../localPdf/methods'
const corpus = { paperId: 'p', pages: ['This is a complete original paragraph.'], outline: [] }
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
