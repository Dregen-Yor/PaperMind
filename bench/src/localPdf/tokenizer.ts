import { optimizeUnigram } from './unigram'
import { optimizeUnigramPrefixes } from './unigramPrefix'
import { createUnigramTokenCounter } from './tokenCounter'
import { applyHfEndpoint } from '../hub'
export async function createBgeM3Tokenizer(cacheDir: string): Promise<{ tokenize: (text: string) => string[]; countTokens: (text: string) => number }> {
  const t = await import('@huggingface/transformers')
  applyHfEndpoint(t)
  t.env.cacheDir = cacheDir
  const tokenizer = await t.AutoTokenizer.from_pretrained('BAAI/bge-m3', { revision: 'main' })
  optimizeUnigram(tokenizer.model)
  const countNormalized = optimizeUnigramPrefixes(tokenizer.model)
  return { tokenize: text => tokenizer.tokenize(text), countTokens: createUnigramTokenCounter(tokenizer, countNormalized) }
}
