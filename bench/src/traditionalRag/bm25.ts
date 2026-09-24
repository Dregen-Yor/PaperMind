import { buildBm25Scorer } from '../../../src/utils/bm25'
import type { BenchChunk, BuiltRetriever, ScoredChunk } from './types'

/** BM25 原语已移入 `src/utils/bm25.ts`（生产段落检索与传统 RAG 基线共用同一份打分）。 */
export { buildBm25Scorer, type Bm25Options, type ScoredDoc } from '../../../src/utils/bm25'

/**
 * bench 侧包装（保持既有调用点与 BenchChunk 形状不变）：`buildBm25Scorer` 按文本下标
 * 返回分数，这里映射回 `chunk.id`——chunk 的 id 不等于它的数组下标，不能直接透传。
 */
export function buildBm25Retriever(chunks: BenchChunk[], options: { k1: number; b: number } = { k1: 1.2, b: 0.75 }): BuiltRetriever {
  const scorer = buildBm25Scorer(chunks.map(chunk => chunk.text), options)
  return { chunks, score(query: string): ScoredChunk[] {
    return scorer(query).map(item => ({ id: chunks[item.id].id, score: item.score }))
  } }
}
