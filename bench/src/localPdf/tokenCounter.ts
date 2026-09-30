import { PreTrainedTokenizer } from '@huggingface/transformers'

/** Fast count for the ordinary single-section Unigram pipeline only. */
export function createUnigramTokenCounter(value: unknown, countNormalized: (text: string) => number): (text: string) => number {
  const tokenizer = value as {
    tokenize: (text: string) => string[]
    _encode_text: unknown
    remove_space?: boolean
    do_lowercase_and_remove_accent?: boolean
    added_tokens_splitter: { split: (text: string) => string[] }
    added_tokens_map: Map<string, unknown>
    normalizer: null | ((text: string) => string)
    pre_tokenizer: null | ((text: string, options: { section_index: number }) => string[])
    post_processor: null | { config?: { type?: string }; single?: Array<{ Sequence?: { id: string }; SpecialToken?: unknown }> }
  }
  const post = tokenizer.post_processor
  // Without added special tokens, this template emits sequence A exactly once.
  const identityPost = post === null || post.config?.type === 'TemplateProcessing'
    && post.single?.filter(item => item.Sequence).length === 1
    && post.single?.some(item => item.Sequence?.id === 'A')
  const supported = tokenizer._encode_text === PreTrainedTokenizer.prototype._encode_text
    && !tokenizer.remove_space && !tokenizer.do_lowercase_and_remove_accent && identityPost
  return text => {
    const fallback = () => tokenizer.tokenize(text).length
    if (!supported) return fallback()
    const sections = tokenizer.added_tokens_splitter.split(text)
    // Added tokens have stripping and section-boundary semantics: keep upstream.
    if (sections.length !== 1 || sections[0] !== text || tokenizer.added_tokens_map.has(text)) return fallback()
    const normalized = tokenizer.normalizer ? tokenizer.normalizer(text) : text
    if (!normalized.length) return 0
    const pieces = tokenizer.pre_tokenizer ? tokenizer.pre_tokenizer(normalized, { section_index: 0 }) : [normalized]
    // Unknown fusion can span pieces, so never sum independent piece counts.
    return pieces.length === 1 ? countNormalized(pieces[0]) : fallback()
  }
}
