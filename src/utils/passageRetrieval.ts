/**
 * 段落级混合检索（方案 §4）：三路加权 RRF 融合 → 4096 预算填充 + 同小节邻段扩展
 * → 原文顺序组装。查询阶段零 LLM 调用（`llmCalled: false`）。
 *
 * 关键口径：预算判定必须与 `materializeContext` 的计法一致——「已用 + 新组分隔符 +
 * 段落 token ≤ 预算」，这样最终物化永不截断（`contextTruncated === false`）。
 */
import { cosineSimilarity, type Embedder } from './embedder'
import { CONTEXT_GROUP_SEPARATOR, type ContextGroup } from './contextTrace'
import type { IndexNode, RetrievalResult } from './pageIndex'
import type { Passage } from './passages'
import type { PassageIndex } from './passageIndex'
import { createMaxHeap } from './priorityQueue'
import { reciprocalRankFusion, type RankedItem } from './rrf'

export type RetrievalMode = 'bm25' | 'bm25+dense' | 'full' | 'full-title-fallback' | 'bm25+card-lexical'

export interface PassageCandidate {
  order: number
  score: number
  /** 由邻段扩展进入（方案 §4.4 的邻段系数路径） */
  fromNeighbour: boolean
}

export interface FusePassageCandidatesArgs {
  passages: Passage[]
  query: string
  /** 段落 BM25 打分器；返回全部段落的分数 */
  bm25: (query: string) => RankedItem[]
  /** 段落向量路；向量不可用时为 undefined */
  dense?: ((query: string) => RankedItem[]) | undefined
  /** 卡片先验路（向量或词法）；卡片不可用时为 undefined */
  card?: ((query: string) => RankedItem[]) | undefined
  rrfK: number
  sectionWeight: number
  /** 占位参数：调用方已决定各路的可用性，这里只做融合 */
  queryVector?: Float32Array
  passagesCannotUseVectors: boolean
}

/** 三路（可少路）加权 RRF，返回按分数降序、同分按 order 升序的候选。 */
export function fusePassageCandidates(args: FusePassageCandidatesArgs): PassageCandidate[] {
  const lists: RankedItem[][] = [args.bm25(args.query)]
  const weights: number[] = [1]
  if (args.dense) {
    lists.push(args.dense(args.query))
    weights.push(1)
  }
  if (args.card) {
    lists.push(args.card(args.query))
    weights.push(args.sectionWeight)
  }
  const fused = reciprocalRankFusion(lists, args.rrfK, weights)
  const candidates = fused.map(item => ({
    order: item.id,
    score: item.score,
    fromNeighbour: false,
  }))
  return candidates
}
