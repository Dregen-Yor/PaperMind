import { describe, expect, it } from 'vitest'
import { createParsedPaperCache } from '../utils/parsedPaperCache'
import { serializePassageIndex, type PassageIndex, type PassageIndexRecord } from '../utils/passageIndex'
import { buildPassages, createEstimatingTokenCounter } from '../utils/passages'
import { buildTitleCards, cardsToIndexNodes } from '../utils/structureCards'

function record(stage: 1 | 2 | 3 = 3): PassageIndexRecord {
  const pages = ['Methods\nWe use BM25.', 'Results\nBM25 finds relevant passages.']
  const passages = buildPassages(pages, createEstimatingTokenCounter(), { minTokens: 1 })
  const cards = buildTitleCards(passages)
  const index: PassageIndex = {
    version: 2,
    stage,
    passages,
    tree: cardsToIndexNodes(cards, passages),
    passageConfigHash: 'test-config',
    separatorTokens: 2,
    ...(stage >= 2 ? {
      embedderId: 'test-embedder',
      vectorDim: 2,
      passageVectors: passages.map(() => new Float32Array([1, 0])),
    } : {}),
    ...(stage === 3 ? {
      cards,
      cardVectors: cards.map(() => new Float32Array([0, 1])),
    } : {}),
  }
  return { indexJson: JSON.stringify(serializePassageIndex(index)), pagesJson: JSON.stringify(pages) }
}

describe('parsed paper cache', () => {
  it('reuses valid parsed pages, tree, passages and decoded vectors for the same raw record', () => {
    const cache = createParsedPaperCache()
    const stored = record()
    const first = cache.get('paper-1', stored)!
    const repeated = cache.get('paper-1', { ...stored })!

    expect(first.passageIndex?.passageVectors?.[0]).toEqual(new Float32Array([1, 0]))
    expect(first.passageIndex?.cardVectors?.[0]).toEqual(new Float32Array([0, 1]))
    expect(repeated).toBe(first)
    expect(repeated.pages).toBe(first.pages)
    expect(repeated.passageIndex?.tree).toBe(first.passageIndex?.tree)
    expect(repeated.passageIndex?.passages).toBe(first.passageIndex?.passages)
    expect(repeated.passageIndex?.passageVectors?.[0]).toBe(first.passageIndex?.passageVectors?.[0])
    expect(repeated.passageIndex?.cardVectors?.[0]).toBe(first.passageIndex?.cardVectors?.[0])
  })

  it('keeps papers with identical JSON separate', () => {
    const cache = createParsedPaperCache()
    const stored = record()
    const first = cache.get('paper-1', stored)!
    const other = cache.get('paper-2', stored)!

    expect(other.passageIndex).not.toBe(first.passageIndex)
    expect(other.pages).not.toBe(first.pages)
    expect(cache.get('paper-1', stored)).toBe(first)
    expect(cache.get('paper-2', stored)).toBe(other)
  })

  it('invalidates on any exact index JSON change, including whitespace', () => {
    const cache = createParsedPaperCache()
    const stored = record()
    const first = cache.get('paper-1', stored)!
    const changed = { ...stored, indexJson: ` ${stored.indexJson}` }
    const replacement = cache.get('paper-1', changed)!

    expect(replacement.passageIndex).toEqual(first.passageIndex)
    expect(replacement.passageIndex).not.toBe(first.passageIndex)
    expect(replacement.pages).not.toBe(first.pages)
    expect(cache.get('paper-1', changed)).toBe(replacement)
    expect(cache.get('paper-1', stored)?.passageIndex).not.toBe(first.passageIndex)
  })

  it('invalidates on changed page text and exact page JSON whitespace', () => {
    const cache = createParsedPaperCache()
    const stored = record()
    const first = cache.get('paper-1', stored)!
    const changed = { ...stored, pagesJson: JSON.stringify(['Updated page']) }
    const replacement = cache.get('paper-1', changed)!
    const whitespace = cache.get('paper-1', { ...changed, pagesJson: ` ${changed.pagesJson}` })!

    expect(replacement.pages).toEqual(['Updated page'])
    expect(replacement.passageIndex).not.toBe(first.passageIndex)
    expect(whitespace.pages).toEqual(replacement.pages)
    expect(whitespace.pages).not.toBe(replacement.pages)
    expect(whitespace.passageIndex).not.toBe(replacement.passageIndex)
  })

  it('replaces stage 1 with decoded stage 2 vectors and then stage 3 cards', () => {
    const cache = createParsedPaperCache()
    const first = cache.get('paper-1', record(1))!
    const second = cache.get('paper-1', record(2))!
    const thirdRecord = record(3)
    const third = cache.get('paper-1', thirdRecord)!

    expect(first.passageIndex?.stage).toBe(1)
    expect(first.passageIndex?.passageVectors).toBeUndefined()
    expect(second.passageIndex?.stage).toBe(2)
    expect(second.passageIndex?.passageVectors?.[0]).toEqual(new Float32Array([1, 0]))
    expect(second.passageIndex?.cards).toBeUndefined()
    expect(second.passageIndex).not.toBe(first.passageIndex)
    expect(third.passageIndex?.stage).toBe(3)
    expect(third.passageIndex?.cards?.length).toBeGreaterThan(0)
    expect(third.passageIndex?.cardVectors?.[0]).toEqual(new Float32Array([0, 1]))
    expect(third.passageIndex).not.toBe(second.passageIndex)
    expect(cache.get('paper-1', thirdRecord)).toBe(third)
  })

  it.each([null, undefined])('invalidates a missing record (%s) before it reappears', missing => {
    const cache = createParsedPaperCache()
    const stored = record()
    const first = cache.get('paper-1', stored)!

    expect(cache.get('paper-1', missing)).toBeUndefined()
    expect(cache.get('paper-1', stored)?.passageIndex).not.toBe(first.passageIndex)
  })

  it('retains eight recent papers, promotes hits, and parses an evicted paper afresh', () => {
    const cache = createParsedPaperCache()
    const stored = record()
    const loaded = Array.from({ length: 8 }, (_, i) => cache.get(`paper-${i}`, stored)!)
    expect(cache.get('paper-0', stored)).toBe(loaded[0])

    cache.get('paper-8', stored)
    expect(cache.get('paper-0', stored)).toBe(loaded[0])
    const reloaded = cache.get('paper-1', stored)!
    expect(reloaded.passageIndex).toEqual(loaded[1].passageIndex)
    expect(reloaded.passageIndex).not.toBe(loaded[1].passageIndex)
    expect(reloaded.pages).not.toBe(loaded[1].pages)
    expect(reloaded.passageIndex?.passageVectors?.[0]).not.toBe(loaded[1].passageIndex?.passageVectors?.[0])
    // Reloading the evicted paper consumes one slot and evicts the next oldest.
    expect(cache.get('paper-2', stored)?.passageIndex).not.toBe(loaded[2].passageIndex)
  })

  it.each([
    { title: 'Legacy flat tree', nodes: [] },
    { version: 2, stage: 1, passages: [], tree: {} },
    undefined,
  ])('leaves legacy or malformed indexes uncached (%j)', rawIndex => {
    const cache = createParsedPaperCache()
    const stored = { indexJson: rawIndex === undefined ? '{broken' : JSON.stringify(rawIndex), pagesJson: '["page"]' }
    const first = cache.get('paper-1', stored)!
    const repeated = cache.get('paper-1', stored)!

    expect(first.passageIndex).toBeUndefined()
    expect(first.rawIndex).toEqual(rawIndex)
    expect(repeated.pages).toEqual(first.pages)
    expect(repeated.pages).not.toBe(first.pages)
    expect(repeated).not.toBe(first)
  })

  it('does not let malformed indexes consume a cache slot', () => {
    const cache = createParsedPaperCache()
    const stored = record()
    const loaded = Array.from({ length: 8 }, (_, i) => cache.get(`paper-${i}`, stored)!)
    cache.get('broken-paper', { ...stored, indexJson: '{broken' })

    loaded.forEach((parsed, i) => expect(cache.get(`paper-${i}`, stored)).toBe(parsed))
  })

  it('invalidates a previously valid entry when replacement index parsing fails', () => {
    const cache = createParsedPaperCache()
    const stored = record()
    const first = cache.get('paper-1', stored)!

    expect(cache.get('paper-1', { ...stored, indexJson: '{broken' })?.passageIndex).toBeUndefined()
    expect(cache.get('paper-1', stored)?.passageIndex).not.toBe(first.passageIndex)
  })

  it('propagates page JSON errors on every read, even when the index is malformed', () => {
    const cache = createParsedPaperCache()
    const stored = record()
    const first = cache.get('paper-1', stored)!
    const broken = { ...stored, pagesJson: '{broken' }

    expect(() => cache.get('paper-1', broken)).toThrow(SyntaxError)
    expect(() => cache.get('paper-1', broken)).toThrow(SyntaxError)
    expect(() => cache.get('broken-index', { ...broken, indexJson: '{broken' })).toThrow(SyntaxError)
    expect(cache.get('paper-1', stored)?.passageIndex).not.toBe(first.passageIndex)
  })

  it('isolates parsed objects between cache instances', () => {
    const stored = record()
    const first = createParsedPaperCache().get('paper-1', stored)!
    const other = createParsedPaperCache().get('paper-1', stored)!

    expect(other.passageIndex).not.toBe(first.passageIndex)
    expect(other.pages).not.toBe(first.pages)
  })
})
