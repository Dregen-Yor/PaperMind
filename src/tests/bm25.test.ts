import { describe, expect, it } from 'vitest'
import { buildBm25Scorer } from '../utils/bm25'

describe('buildBm25Scorer', () => {
  const texts = [
    'We evaluate on Europarl and MultiUN datasets.',
    'The model uses a transformer encoder with attention.',
    'Attention is all you need for sequence transduction.',
  ]

  it('给含查询词的文档更高分，并返回全部文档的分数', () => {
    const scores = buildBm25Scorer(texts)('Europarl datasets')
    expect(scores).toHaveLength(texts.length)
    expect(scores[0].score).toBeGreaterThan(scores[1].score)
  })

  it('id 即输入下标，便于回填候选', () => {
    const scores = buildBm25Scorer(texts)('attention')
    expect(scores.map(item => item.id)).toEqual([0, 1, 2])
    expect(scores[2].score).toBeGreaterThan(scores[0].score)
  })

  it('空文档集合返回全零而不抛错', () => {
    expect(buildBm25Scorer([])('anything')).toEqual([])
  })

  it('查询词完全不在文档中时全零', () => {
    expect(buildBm25Scorer(texts)('zzzqqq').every(item => item.score === 0)).toBe(true)
  })
})
