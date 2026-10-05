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

  it('tokenizes each group first piece once and reuses the separator within the call', () => {
    const calls = new Map<string, number>()
    const countingTokenizer = {
      tokenize: (text: string) => {
        calls.set(text, (calls.get(text) ?? 0) + 1)
        return text.split(/\s+/).filter(Boolean).map(word => `▁${word}`)
      },
    }
    const out = materializeContext([
      { pieces: [{ page: 1, text: 'alpha beta' }, { page: 2, text: 'gamma' }] },
      { pieces: [{ page: 3, text: 'delta' }, { page: 4, text: 'epsilon' }] },
      { pieces: [{ page: 5, text: 'café 東京' }] },
    ], countingTokenizer, 20)

    expect(out).toEqual({
      text: 'alpha beta gamma --- delta epsilon --- café 東京',
      pageOrder: [1, 2, 3, 4, 5],
      tokenCount: 9,
      truncated: false,
    })
    expect(calls.get('alpha beta')).toBe(1)
    expect(calls.get('delta')).toBe(1)
    expect(calls.get('café 東京')).toBe(1)
    expect(calls.get('\n\n---\n\n')).toBe(1)
  })

  it('preserves fitting, truncation, empty groups, and tokenizer edge behavior', () => {
    const specialTokenizer = {
      tokenize: (text: string) => {
        if (text === '') return ['empty-prefix']
        if (text === 'zero') return []
        if (text === 'a b') return ['▁a', '▁b']
        if (text === 'partial') return ['▁p', '▁q']
        if (text === 'later') return ['▁l']
        if (text === '\n\n---\n\n') return ['▁---']
        return text.trim() ? [`▁${text.trim()}`] : []
      },
    }

    expect(materializeContext([
      { pieces: [{ page: 0, text: 'a b' }] },
      { pieces: [{ page: 1, text: 'zero' }] },
    ], specialTokenizer, 2)).toEqual({
      text: 'a b', pageOrder: [0], tokenCount: 2, truncated: true,
    })

    expect(materializeContext([
      { pieces: [{ page: 0, text: 'a b' }] },
      { pieces: [{ page: 1, text: 'later' }] },
    ], specialTokenizer, 3)).toEqual({
      text: 'a b', pageOrder: [0], tokenCount: 2, truncated: true,
    })

    expect(materializeContext([
      { pieces: [{ page: 8, text: '   ' }] },
      { pieces: [{ page: 0, text: 'zero' }] },
      { pieces: [{ page: 2, text: 'partial' }] },
      { pieces: [{ page: 3, text: 'later' }] },
    ], specialTokenizer, 2)).toEqual({
      text: 'p q', pageOrder: [2], tokenCount: 2, truncated: true,
    })

    let laterPieceCalls = 0
    const lazyTokenizer = {
      tokenize: (text: string) => {
        if (text === 'later') laterPieceCalls++
        return specialTokenizer.tokenize(text)
      },
    }
    expect(materializeContext([{ pieces: [
      { page: 4, text: 'partial' },
      { page: 5, text: 'zero' },
      { page: 6, text: 'later' },
    ] }], lazyTokenizer, 5)).toEqual({
      text: 'p q', pageOrder: [4], tokenCount: 2, truncated: false,
    })
    expect(laterPieceCalls).toBe(0)

    expect(materializeContext([
      { pieces: [{ page: 0, text: 'a b' }] },
      { pieces: [{ page: 1, text: 'partial' }] },
    ], specialTokenizer, 4)).toEqual({
      text: 'a b --- p', pageOrder: [0, 1], tokenCount: 4, truncated: true,
    })
  })

  it('keeps tokenizer reuse local to a materialization call and tokenizer instance', () => {
    const makeCountingTokenizer = () => {
      const calls = new Map<string, number>()
      return {
        calls,
        tokenizer: {
          tokenize: (text: string) => {
            calls.set(text, (calls.get(text) ?? 0) + 1)
            return text.split(/\s+/).filter(Boolean).map(word => `▁${word}`)
          },
        },
      }
    }
    const first = makeCountingTokenizer()
    const second = makeCountingTokenizer()
    const groups: ContextGroup[] = [
      { pieces: [{ page: 0, text: 'one' }] },
      { pieces: [{ page: 1, text: 'two' }] },
    ]

    materializeContext(groups, first.tokenizer, 10)
    materializeContext(groups, first.tokenizer, 10)
    materializeContext(groups, second.tokenizer, 10)

    expect(first.calls.get('one')).toBe(2)
    expect(first.calls.get('\n\n---\n\n')).toBe(2)
    expect(second.calls.get('one')).toBe(1)
    expect(second.calls.get('\n\n---\n\n')).toBe(1)
  })
})
