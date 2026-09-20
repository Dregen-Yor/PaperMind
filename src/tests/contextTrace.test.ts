import { describe, expect, it } from 'vitest'
import { materializeContext, type ContextGroup } from '../utils/contextTrace'

const tokenizer = {
  tokenize: (text: string) => text.split(/\s+/).filter(Boolean).map(word => `▁${word}`),
}

describe('materializeContext', () => {
  it('keeps prompt text and first-occurrence page order in the same result', () => {
    const groups: ContextGroup[] = [
      { pieces: [{ page: 2, text: 'alpha beta' }, { page: 3, text: 'gamma' }] },
      { pieces: [{ page: 2, text: 'alpha again' }, { page: 5, text: 'delta' }] },
    ]
    const out = materializeContext(groups, tokenizer, 20)
    expect(out.text).toContain('---')
    expect(out.pageOrder).toEqual([2, 3, 5])
    expect(out.tokenCount).toBeLessThanOrEqual(20)
    expect(out.truncated).toBe(false)
  })

  it('counts a partially emitted page and drops pages wholly beyond the budget', () => {
    const out = materializeContext([
      { pieces: [{ page: 0, text: 'a b' }, { page: 1, text: 'c d e' }, { page: 2, text: 'f' }] },
    ], tokenizer, 4)
    expect(out.pageOrder).toEqual([0, 1])
    expect(out.text).not.toContain('f')
    expect(out.tokenCount).toBe(4)
    expect(out.truncated).toBe(true)
  })

  it('does not leave a group separator when no token from the next group fits', () => {
    const out = materializeContext([
      { pieces: [{ page: 0, text: 'a b' }] },
      { pieces: [{ page: 1, text: 'c' }] },
    ], tokenizer, 2)
    expect(out.text).toBe('a b')
    expect(out.pageOrder).toEqual([0])
  })

  it('treats an exactly full 4096-token context as untruncated', () => {
    const text = Array.from({ length: 4096 }, (_, i) => `t${i}`).join(' ')
    const out = materializeContext([{ pieces: [{ page: 7, text }] }], tokenizer, 4096)
    expect(out.tokenCount).toBe(4096)
    expect(out.pageOrder).toEqual([7])
    expect(out.truncated).toBe(false)
  })

  it('returns an empty stable result for empty groups', () => {
    expect(materializeContext([], tokenizer, 4096)).toEqual({
      text: '', pageOrder: [], tokenCount: 0, truncated: false,
    })
  })

  it('stops before the group separator when the separator plus content cannot fit', () => {
    const out = materializeContext([
      { pieces: [{ page: 0, text: 'a b' }] },
      { pieces: [{ page: 1, text: 'c' }] },
    ], tokenizer, 3)
    expect(out.text).toBe('a b')
    expect(out.text).not.toContain('---')
    expect(out.pageOrder).toEqual([0])
    expect(out.tokenCount).toBe(2)
    expect(out.truncated).toBe(true)
  })

  it('rejects an invalid token budget', () => {
    expect(() => materializeContext([], tokenizer, 0)).toThrow('maxTokens 必须为正整数')
    expect(() => materializeContext([], tokenizer, 1.5)).toThrow('maxTokens 必须为正整数')
  })
})
