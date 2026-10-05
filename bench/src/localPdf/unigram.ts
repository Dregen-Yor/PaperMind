import { requireThat } from './contract'
interface Lattice {
  chars: string[]
  insert: (start: number, length: number, score: number, id: number) => void
}
interface UnigramModel {
  vocab: string[]
  scores: number[]
  tokens_to_ids: Map<string, number>
  trie: { commonPrefixSearch: (text: string) => Iterable<string> }
  unk_score: number
  unk_token_id: number
  populateNodes: (lattice: Lattice) => void
}
/**
 * Transformers.js 3.x Unigram copies the entire remaining suffix at each position.
 * Trie matches cannot exceed the longest vocabulary token: bound that copy without
 * changing nodes, insertion order, scores, unknown handling or Viterbi decoding.
 * Scoped to this benchmark's tokenizer instance; no dependency files are modified.
 */
export function optimizeUnigram(value: unknown): void {
  const model = value as UnigramModel
  requireThat(model && Array.isArray(model.vocab) && Array.isArray(model.scores)
    && model.tokens_to_ids instanceof Map && typeof model.trie?.commonPrefixSearch === 'function'
    && typeof model.populateNodes === 'function' && Number.isFinite(model.unk_score)
    && Number.isInteger(model.unk_token_id), 'Unsupported Unigram model internals; check Transformers.js version')
  const lengths = new Map(model.vocab.map(token => [token, Array.from(token).length]))
  let maxLength = 0
  for (const length of lengths.values()) maxLength = Math.max(maxLength, length)
  requireThat(maxLength > 0, 'Empty Unigram vocabulary')
  model.populateNodes = lattice => {
    for (let start = 0; start < lattice.chars.length; start++) {
      let single = false
      const prefix = lattice.chars.slice(start, start + maxLength).join('')
      for (const token of model.trie.commonPrefixSearch(prefix)) {
        const id = model.tokens_to_ids.get(token)!
        const length = lengths.get(token)!
        lattice.insert(start, length, model.scores[id], id)
        if (length === 1) single = true
      }
      if (!single) lattice.insert(start, 1, model.unk_score, model.unk_token_id)
    }
  }
}
