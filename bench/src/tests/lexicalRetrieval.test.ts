import { describe, expect, it } from 'vitest'
import { lexicalTokenize } from '../traditionalRag/lexicalTokenizer'
import { buildBm25Retriever } from '../traditionalRag/bm25'
import { buildJaccardRetriever } from '../traditionalRag/jaccard'

const chunks = [{ id: 0, text: 'Cat cat dog', tokenCount: 3, startPage: 0, endPage: 0, pieces: [{ page: 0, text: 'Cat cat dog' }] }, { id: 1, text: 'dog bird', tokenCount: 2, startPage: 1, endPage: 1, pieces: [{ page: 1, text: 'dog bird' }] }]
describe('lexical retrievers', () => {
  it('normalizes words and scores repeated BM25 query terms', async () => {
    expect(lexicalTokenize('Ｃat CAT')).toEqual(['cat', 'cat'])
    const score = await buildBm25Retriever(chunks).score('cat cat')
    expect(score[0].score).toBeGreaterThan(score[1].score)
  })
  it('uses token sets for Jaccard', async () => {
    expect((await buildJaccardRetriever(chunks).score('cat cat'))[0].score).toBeCloseTo(1 / 2)
    expect((await buildJaccardRetriever(chunks).score(''))[0].score).toBe(0)
  })
})
