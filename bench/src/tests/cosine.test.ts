import { describe, expect, it } from 'vitest'
import { buildCosineRetriever } from '../traditionalRag/cosine'

describe('cosine retriever', () => {
  it('batches index embeddings, prefixes queries, and normalizes vectors', async () => {
    const calls: string[][] = []
    const provider = { embed: async (texts: string[]) => { calls.push(texts); return texts.length === 2 ? [[3, 4], [0, 1]] : [[6, 8]] } }
    const retriever = await buildCosineRetriever([{ id: 0, text: 'a', tokenCount: 1, startPage: 0, endPage: 0, pieces: [{ page: 0, text: 'a' }] }, { id: 1, text: 'b', tokenCount: 1, startPage: 1, endPage: 1, pieces: [{ page: 1, text: 'b' }] }], provider, { queryPrefix: 'prefix: ', maxLength: 10 })
    expect((await retriever.score('q')).map(x => x.score)).toEqual([1, 0.8])
    expect(calls).toEqual([['a', 'b'], ['prefix: q']])
  })
})
