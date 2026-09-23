import { describe, expect, it, vi } from 'vitest'
import { createMaxHeap } from '../utils/priorityQueue'
import { buildPassages, createEstimatingTokenCounter } from '../utils/passages'
import { buildTitleCards, cardsToIndexNodes, type StructureCard } from '../utils/structureCards'
import { PASSAGE_INDEX_VERSION, passageConfigHash, type PassageIndex } from '../utils/passageIndex'
import { fusePassageCandidates } from '../utils/passageRetrieval'
import type { Embedder } from '../utils/embedder'

const counter = createEstimatingTokenCounter()

describe('createMaxHeap', () => {
  it('按分数降序出队', () => {
    const heap = createMaxHeap<{ score: number; order: number }>()
    heap.push({ score: 1, order: 0 })
    heap.push({ score: 5, order: 1 })
    heap.push({ score: 3, order: 2 })
    expect([heap.pop()!.score, heap.pop()!.score, heap.pop()!.score]).toEqual([5, 3, 1])
  })

  it('同分按 order 升序出队（确定性）', () => {
    const heap = createMaxHeap<{ score: number; order: number }>()
    heap.push({ score: 2, order: 5 })
    heap.push({ score: 2, order: 1 })
    heap.push({ score: 2, order: 3 })
    expect([heap.pop()!.order, heap.pop()!.order, heap.pop()!.order]).toEqual([1, 3, 5])
  })

  it('空堆 pop 返回 undefined', () => {
    expect(createMaxHeap<{ score: number; order: number }>().pop()).toBeUndefined()
  })
})

describe('fusePassageCandidates', () => {
  const pages = [
    'Abstract\nRetrieval study on Europarl.',
    'Methods\nWe use BM25.',
    'Experiments\nWe evaluate on Europarl and MultiUN.',
  ]
  const passages = buildPassages(pages, counter, { minTokens: 1 })
  const cards: StructureCard[] = [{ id: 'S1', range: [passages[0].id, passages[passages.length - 1].id], title: 'Datasets', summary: '', keyTerms: [] }]

  it('三路齐全时按加权 RRF 排序，卡片路权重生效', () => {
    const fused = fusePassageCandidates({
      passages,
      query: 'europarl datasets',
      bm25: query => passages.map(passage => ({ id: passage.order, score: passage.order === 2 ? 1 : 0 })),
      dense: () => passages.map(passage => ({ id: passage.order, score: passage.order === 0 ? 1 : 0 })),
      card: () => passages.map(passage => ({ id: passage.order, score: 0.5 })),
      rrfK: 60,
      sectionWeight: 0,
      queryVector: undefined,
      passagesCannotUseVectors: false,
    })
    expect(fused[0].order).toBe(0)
  })

  it('缺向量路时只用 BM25 名次', () => {
    const fused = fusePassageCandidates({
      passages,
      query: 'bm25',
      bm25: () => passages.map(passage => ({ id: passage.order, score: passage.order === 2 ? 9 : 1 })),
      dense: undefined,
      card: undefined,
      rrfK: 60,
      sectionWeight: 0.5,
      queryVector: undefined,
      passagesCannotUseVectors: true,
    })
    expect(fused[0].order).toBe(2)
    expect(fused.map(candidate => candidate.order)).toEqual([2, 0, 1])
  })

  it('并列时按 order 升序', () => {
    const fused = fusePassageCandidates({
      passages,
      query: 'x',
      bm25: () => passages.map(passage => ({ id: passage.order, score: 1 })),
      dense: undefined,
      card: undefined,
      rrfK: 60,
      sectionWeight: 0.5,
      queryVector: undefined,
      passagesCannotUseVectors: true,
    })
    expect(fused.map(candidate => candidate.order)).toEqual([0, 1, 2])
  })
})
