import { requireThat } from './contract'

interface UnigramModel {
  vocab: string[]
  scores: number[]
  tokens_to_ids: Map<string, number>
  trie: { commonPrefixSearch: (text: string) => Iterable<string> }
  unk_token_id: number
  unk_score: number
  tokenize: (normalized: string) => string[]
}
interface Node {
  start: number
  end: number
  score: number
  previous: Node | null
  count: number
  unknown: boolean
}

/**
 * Reuse the exact lattice for prefixes of one normalized input. Normalization,
 * special-token splitting and unknown fusion remain in Transformers.js. No
 * assumption about raw-text prefixes or monotonic token counts is needed.
 *
 * Incoming edges retain populateNodes' start/trie insertion order. Each outgoing
 * edge compares predecessor.score + its own score (not merely predecessor.score):
 * floating-point rounding can create ties, for which stock chooses the first edge.
 */
export function optimizeUnigramPrefixes(value: unknown): (normalized: string) => number {
  const model = value as UnigramModel
  requireThat(model && Array.isArray(model.vocab) && Array.isArray(model.scores)
    && model.tokens_to_ids instanceof Map && typeof model.trie?.commonPrefixSearch === 'function'
    && typeof model.tokenize === 'function' && Number.isFinite(model.unk_score) && Number.isInteger(model.unk_token_id),
  'Unsupported Unigram model internals; check Transformers.js version')
  const lengths = new Map(model.vocab.map(token => [token, Array.from(token).length]))
  let maxLength = 0
  for (const length of lengths.values()) maxLength = Math.max(maxLength, length)
  requireThat(maxLength > 0 && model.scores.every(Number.isFinite), 'Invalid Unigram vocabulary')
  let cached = ''
  let offsets = new Map<number, number>()
  let ends: Node[][] = []

  const best = (incoming: Node[], score: number): { node: Node; score: number } => {
    let winner = incoming[0]
    let total = winner.score + score
    for (let i = 1; i < incoming.length; i++) {
      const candidate = incoming[i].score + score
      if (candidate > total) { winner = incoming[i]; total = candidate }
    }
    return { node: winner, score: total }
  }

  const rebuild = (normalized: string): void => {
    cached = normalized
    const chars = Array.from(normalized)
    const positions = [0]
    for (const char of chars) positions.push(positions[positions.length - 1] + char.length)
    offsets = new Map(positions.map((offset, index) => [offset, index]))
    ends = Array.from({ length: chars.length + 1 }, () => [])
    ends[0].push({ start: 0, end: 0, score: 0, previous: null, count: 0, unknown: false })
    for (let start = 0; start < chars.length; start++) {
      const insert = (length: number, score: number): void => {
        const winner = best(ends[start], score)
        const piece = normalized.slice(positions[start], positions[start + length])
        const unknown = (model.tokens_to_ids.get(piece) ?? model.unk_token_id) === model.unk_token_id
        ends[start + length].push({
          start: positions[start], end: positions[start + length], score: winner.score, previous: winner.node,
          unknown, count: winner.node.count + (unknown && winner.node.unknown ? 0 : 1),
        })
      }
      let single = false
      for (const token of model.trie.commonPrefixSearch(chars.slice(start, start + maxLength).join(''))) {
        const length = lengths.get(token)!
        insert(length, model.scores[model.tokens_to_ids.get(token)!])
        if (length === 1) single = true
      }
      if (!single) insert(1, model.unk_score)
    }
  }

  const endpoint = (normalized: string): Node => {
    if (!cached.startsWith(normalized) || !offsets.has(normalized.length)) rebuild(normalized)
    // An EOS node has score zero and chooses among incoming nodes in this order.
    // Edges crossing this endpoint cannot occur in its predecessor chain.
    return best(ends[offsets.get(normalized.length)!], 0).node
  }
  model.tokenize = normalized => {
    if (!normalized.length) return []
    let node: Node | null = endpoint(normalized)
    const pieces: string[] = []
    while (node?.previous) {
      pieces.push(cached.slice(node.start, node.end))
      node = node.previous
    }
    return pieces.reverse()
  }
  return normalized => normalized.length ? endpoint(normalized).count : 0
}
