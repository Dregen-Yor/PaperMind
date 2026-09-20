import { describe, expect, it } from 'vitest'
import { selectContext } from '../traditionalRag/context'
import type { BenchChunk, ScoredChunk } from '../traditionalRag/types'

const chunk = (id: number, text: string, tokenCount: number, startPage: number, endPage: number): BenchChunk => ({ id, text, tokenCount, startPage, endPage, pieces: [{ page: startPage, text }] })

describe('context selection', () => {
  it('uses stable ranking and keeps the retrieval window and top-K', () => {
    const chunks = [chunk(0, 'A', 2, 0, 0), chunk(1, 'B', 2, 1, 1)]
    const out = selectContext(chunks, [{ id: 1, score: 1 }, { id: 0, score: 1 }], { retrievalTopK: 2, topK: 2 })
    // 平分时按 id 升序稳定排序
    expect(out.selected.map(c => c.id)).toEqual([0, 1])
    expect(out.tokenCount).toBe(4)
    expect(out.context).toBe('A\n\n---\n\nB')
  })

  it('returns context groups in relevance order without applying a second budget', () => {
    const chunks = [chunk(0, 'A', 2, 0, 0), chunk(1, 'B', 2, 1, 1)]
    const ranked: ScoredChunk[] = [{ id: 1, score: 5 }, { id: 0, score: 1 }]
    const out = selectContext(chunks, ranked, { retrievalTopK: 10, topK: 2 })
    expect(out.contextGroups).toEqual([
      { pieces: chunks[ranked[0].id].pieces },
      { pieces: chunks[ranked[1].id].pieces },
    ])
    // 已无 maxTokens 选项：两个 2-token 候选全进，不做整段预算停止
    expect(out.selected.map(c => c.id)).toEqual([1, 0])
  })

  it('skips an unknown scored id instead of discarding valid later context', () => {
    const chunks = [chunk(0, 'A', 1, 0, 0)]
    const out = selectContext(chunks, [{ id: 99, score: 2 }, { id: 0, score: 1 }], { retrievalTopK: 2, topK: 1 })
    expect(out.selected.map(c => c.id)).toEqual([0])
    expect(out.contextGroups).toEqual([{ pieces: chunks[0].pieces }])
  })
})
