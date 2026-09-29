// @vitest-environment node
import { expect, it } from 'vitest'
import { PreTrainedTokenizer } from '@huggingface/transformers'
import { optimizeUnigram } from '../localPdf/unigram'
const create = () => new PreTrainedTokenizer({
  normalizer: null, post_processor: null, decoder: null, added_tokens: [],
  model: { type: 'Unigram', unk_id: 0, vocab: [['<unk>', 0], ['a', -2], ['b', -2], ['ab', -1], ['▁', -1], ['🧪', -2], ['🧪a', -1]] },
  pre_tokenizer: { type: 'Metaspace', replacement: '▁', prepend_scheme: 'always' },
}, { eos_token: '</s>' })
it('preserves stock Unigram tokens including unknown, Unicode and tie cases', () => {
  const stock = create(); const optimized = create()
  optimizeUnigram(optimized.model)
  const alphabet = ['a', 'b', ' ', '🧪', '?', 'é']
  for (const a of alphabet) for (const b of alphabet) for (const c of alphabet) {
    const text = a + b + c
    expect(optimized.tokenize(text)).toEqual(stock.tokenize(text))
  }
  expect(optimized.tokenize('ab 🧪a ? '.repeat(100))).toEqual(stock.tokenize('ab 🧪a ? '.repeat(100)))
})
it('bounds every trie query by the longest vocabulary token, independent of input length', () => {
  const tokenizer = create()
  const model = tokenizer.model as unknown as { trie: { commonPrefixSearch: (s: string) => Iterable<string> } }
  const original = model.trie.commonPrefixSearch.bind(model.trie)
  const lengths: number[] = []
  model.trie.commonPrefixSearch = s => { lengths.push(Array.from(s).length); return original(s) }
  optimizeUnigram(tokenizer.model)
  tokenizer.tokenize('ab '.repeat(1000))
  expect(Math.max(...lengths)).toBeLessThanOrEqual(5)
})
it('fails clearly if the dependency no longer supplies the expected model', () => {
  expect(() => optimizeUnigram({})).toThrow(/Unigram/)
})
