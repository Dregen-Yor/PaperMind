import { describe, expect, it } from 'vitest'
import { chunkPages } from '../traditionalRag/chunker'

const tokenizer = { tokenize: (text: string) => text.split(' ') }

describe('chunkPages', () => {
  it('uses sliding windows, preserves a final short chunk, and maps pages', () => {
    const chunks = chunkPages(['a b c', 'd e f g h'], tokenizer, { chunkSize: 4, overlap: 1 })
    expect(chunks.map(c => c.tokenCount)).toEqual([4, 4, 2])
    expect(chunks.map(c => c.startPage)).toEqual([0, 1, 1])
    expect(chunks.map(c => c.endPage)).toEqual([1, 1, 1])
  })

  it('removes SentencePiece metaspace markers and inserts page separators', () => {
    const chunks = chunkPages(['We propose', 'a method'], { tokenize: text => text === 'We propose' ? ['▁We', '▁propose'] : ['▁a', '▁method'] }, { chunkSize: 4, overlap: 0 })
    expect(chunks[0].text).toBe('We propose\n a method')
    expect(chunks[0]).toMatchObject({ startPage: 0, endPage: 1 })
  })

  it('keeps exact page pieces inside a cross-page chunk', () => {
    const chunks = chunkPages(['a b', 'c d'], tokenizer, { chunkSize: 4, overlap: 0 })
    expect(chunks[0].pieces.map(piece => piece.page)).toEqual([0, 1])
    expect(chunks[0].pieces.map(piece => piece.text).join('')).toBe(chunks[0].text)
  })

  it('keeps pieces an exact partition of every chunk, including mid-page starts', () => {
    const chunks = chunkPages(['alpha beta gamma', 'delta epsilon zeta'], tokenizer, { chunkSize: 3, overlap: 1 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.pieces.map(piece => piece.text).join('')).toBe(chunk.text)
      // 分片页号单调不减，且首/末页与 chunk 的页区间一致
      const pages = chunk.pieces.map(piece => piece.page)
      expect([...pages].sort((a, b) => a - b)).toEqual(pages)
      expect(pages[0]).toBe(chunk.startPage)
      expect(pages.at(-1)).toBe(chunk.endPage)
    }
  })
})
