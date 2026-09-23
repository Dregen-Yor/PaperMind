/**
 * 向量模型接口（方案 §3）。真实实现（`transformersEmbedder.ts`）动态 import
 * `@huggingface/transformers`，因此 jsdom 单测永远不加载它；测试注入假实现。
 */
import type { Passage } from './passages'

/** 卡片只用标题建向量时的输入构造（回落卡片没有 summary / keyTerms）。 */
export interface EmbeddableCard {
  title: string
  summary: string
  keyTerms: string[]
}

export interface Embedder {
  /** 模型 + revision + 量化方式；进入索引缓存身份（`passageIndex.embedderId`） */
  readonly id: string
  embedQuery(text: string): Promise<Float32Array>
  embedPassages(texts: string[]): Promise<Float32Array[]>
}

export const BGE_SMALL_MODEL = 'Xenova/bge-small-en-v1.5'
export const BGE_SMALL_REVISION = 'main'
export const BGE_SMALL_DTYPE = 'q8'
export const BGE_SMALL_DIM = 384

/** bge 系列检索是非对称的：查询侧必须带指令前缀，段落 / 卡片侧不加。 */
export const QUERY_INSTRUCTION = 'Represent this sentence for searching relevant passages: '

export function embedderId(model: string, revision: string, dtype: string): string {
  return `${model}@${revision}#${dtype}`
}

/** 段落向量输入：清洗后的段落文本，不加前缀。 */
export function passageEmbedText(passage: Passage): string {
  return passage.searchText
}

/** 卡片向量输入：title + ". " + summary + " Key terms: " + keyTerms。 */
export function cardEmbedText(card: EmbeddableCard): string {
  const terms = card.keyTerms.length > 0 ? ` Key terms: ${card.keyTerms.join(', ')}` : ''
  const summary = card.summary ? `${card.summary}` : ''
  return `${card.title}. ${summary}${terms}`.trim().replace(/\s+/g, ' ')
}

export function createEmbedder(deps: {
  id: string
  embed: (texts: string[]) => Promise<Float32Array[]>
}): Embedder {
  return {
    id: deps.id,
    async embedQuery(text: string): Promise<Float32Array> {
      const [vector] = await deps.embed([QUERY_INSTRUCTION + text])
      if (!vector) throw new Error('向量模型未返回查询向量')
      return vector
    },
    embedPassages: (texts: string[]): Promise<Float32Array[]> =>
      texts.length === 0 ? Promise.resolve([]) : deps.embed(texts),
  }
}

/** 余弦相似度；零向量返回 0（不产生 NaN 污染排序）。 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error('向量维度不一致')
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB)
  return denominator === 0 ? 0 : dot / denominator
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** 一组等长向量 → base64（Float32Array 原始字节，小端）。落盘前统一走这里。 */
export function encodeVectors(vectors: Float32Array[]): string {
  const dim = vectors[0]?.length ?? 0
  const flat = new Float32Array(vectors.length * dim)
  vectors.forEach((vector, index) => flat.set(vector, index * dim))
  return toBase64(new Uint8Array(flat.buffer, flat.byteOffset, flat.byteLength))
}

/** base64 → 等长向量；长度不是 dim 的整数倍时返回 undefined（视为索引损坏）。 */
export function decodeVectors(value: string, dim: number): Float32Array[] | undefined {
  if (dim <= 0) return undefined
  let bytes: Uint8Array
  try {
    bytes = fromBase64(value)
  } catch {
    return undefined
  }
  if (bytes.byteLength % (dim * 4) !== 0) return undefined
  const count = bytes.byteLength / (dim * 4)
  const flat = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  const vectors: Float32Array[] = []
  for (let i = 0; i < count; i++) vectors.push(flat.slice(i * dim, (i + 1) * dim))
  return vectors
}
