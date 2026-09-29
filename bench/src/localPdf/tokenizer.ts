import { optimizeUnigram } from './unigram'
import { applyHfEndpoint } from '../hub'
export async function createBgeM3Tokenizer(cacheDir: string): Promise<{ tokenize: (text: string) => string[] }> {
  const t = await import('@huggingface/transformers')
  applyHfEndpoint(t)
  t.env.cacheDir = cacheDir
  const tokenizer = await t.AutoTokenizer.from_pretrained('BAAI/bge-m3', { revision: 'main' })
  optimizeUnigram(tokenizer.model)
  return { tokenize: text => tokenizer.tokenize(text) }
}
