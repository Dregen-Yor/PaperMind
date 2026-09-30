// @vitest-environment node
import { expect, it } from 'vitest'
import { PreTrainedTokenizer } from '@huggingface/transformers'
import { optimizeUnigramPrefixes } from '../localPdf/unigramPrefix'
import { createUnigramTokenCounter } from '../localPdf/tokenCounter'

function create(scores: number[] = [-2, -2, -1]) {
  return new PreTrainedTokenizer({
    normalizer: { type: 'NFKC' }, post_processor: null, decoder: null,
    added_tokens: [{ id: 9, content: '<special>', special: true, single_word: false, lstrip: false, rstrip: false, normalized: false }],
    model: { type: 'Unigram', unk_id: 0, vocab: [['<unk>', 0], ['a', scores[0]], ['b', scores[1]], ['ab', scores[2]], ['▁', -1], ['🧪', -2], ['🧪a', -1], ['é', -2], ['e', -2], ['<special>', 0]] },
    pre_tokenizer: { type: 'Metaspace', replacement: '▁', prepend_scheme: 'always' },
  }, { eos_token: '</s>' })
}
it('matches stock tokens for all prefixes, normalization, unknown fusion and special tokens', () => {
  const stock = create(); const fast = create()
  optimizeUnigramPrefixes(fast.model)
  const samples = ['ab 🧪a ??? é e\u0301 ﬁ', 'a<special>🧪??b', '', '👩‍🔬aba', 'a  b\n\tab', 'a\ud800b']
  const alphabet = ['a', 'b', ' ', '🧪', '?', 'é']
  for (const a of alphabet) for (const b of alphabet) for (const c of alphabet) samples.push(a + b + c)
  for (const text of samples) {
    expect(fast.tokenize(text)).toEqual(stock.tokenize(text))
    for (const { index } of new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text)) {
      expect(fast.tokenize(text.slice(0, index))).toEqual(stock.tokenize(text.slice(0, index)))
    }
  }
})
it('preserves exact tie order including floating-point rounded ties', () => {
  for (const scores of [[-1, -1, -2], [-1e16, -1, -1e16], [0, 0, 0]]) {
    const stock = create(scores); const fast = create(scores)
    optimizeUnigramPrefixes(fast.model)
    for (const text of ['ababab', 'ababa', '🧪abab', 'baab', 'ab'.repeat(50)]) {
      fast.tokenize(text)
      for (let i = text.length; i >= 0; i--) expect(fast.tokenize(text.slice(0, i))).toEqual(stock.tokenize(text.slice(0, i)))
    }
  }
})
it('reuses lattice traversal for normalized prefixes and rebuilds for other inputs', () => {
  const tokenizer = create()
  const model = tokenizer.model as unknown as { trie: { commonPrefixSearch: (s: string) => Iterable<string> } }
  const original = model.trie.commonPrefixSearch.bind(model.trie)
  let calls = 0
  model.trie.commonPrefixSearch = s => { calls++; return original(s) }
  optimizeUnigramPrefixes(model)
  tokenizer.tokenize('ab'.repeat(100))
  const initial = calls
  for (let i = 199; i > 0; i--) tokenizer.tokenize('ab'.repeat(100).slice(0, i))
  expect(calls).toBe(initial)
  tokenizer.tokenize('ba')
  expect(calls).toBeGreaterThan(initial)
})
it('fails clearly for unsupported model internals', () => {
  expect(() => optimizeUnigramPrefixes({})).toThrow(/Unigram/)
})

it('counts fused unknown prefixes from the same Viterbi paths as stock tokens', () => {
  const stock = create(); const fast = create()
  const count = optimizeUnigramPrefixes(fast.model)
  for (const text of ['ab???🧪', '???a??b', 'ab'.repeat(40), '', '<unk>??']) {
    const pieces = (stock.model as unknown as { tokenize: (s: string) => string[] }).tokenize(text)
    // Count through the public model call, which applies unknown fusion.
    const expected = (stock.model as unknown as (s: string[]) => string[])([text]).length
    expect(count(text)).toBe(expected)
    expect((fast.model as unknown as { tokenize: (s: string) => string[] }).tokenize(text)).toEqual(pieces)
  }
})

it('uses exact counts with normalization and falls back for special tokens or multiple sections', () => {
  const stock = create(); const fast = create()
  const count = createUnigramTokenCounter(fast, optimizeUnigramPrefixes(fast.model))
  for (const text of ['', 'a???b', 'e\u0301  ﬁ', 'a<special>??b', '<special>']) {
    expect(count(text)).toBe(stock.tokenize(text).length)
  }
  const multi = create()
  const original = multi.pre_tokenizer
  multi.pre_tokenizer = ((text: string) => [text.slice(0, 1), text.slice(1)]) as typeof original
  const multiCount = createUnigramTokenCounter(multi, optimizeUnigramPrefixes(multi.model))
  expect(multiCount('???ab')).toBe(multi.tokenize('???ab').length)
})
