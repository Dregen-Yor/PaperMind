/**
 * hybrid-rerank 强基线 runner（计划 §2.2）：
 * 固定分块 → BM25 与 BGE-M3 各自独立召回 → RRF(k=60) 融合 →
 * 交叉编码器（bge-reranker-v2-m3 权重）重排 → 4096 token 预算内选段。
 * 全程无查询改写、无 LLM 重排；BM25/dense/rerank 失败必须带具体阶段消息抛出，
 * 绝不静默回退到另一路检索。
 */
import type { BenchResult, HybridRerankConfig } from '../types'
import type { ScoredChunk, TextTokenizer } from '../traditionalRag/types'
import { chunkPages } from '../traditionalRag/chunker'
import { buildBm25Retriever } from '../traditionalRag/bm25'
import { buildCosineRetriever } from '../traditionalRag/cosine'
import { createBgeM3Provider, createBgeM3Tokenizer } from '../traditionalRag/embedding'
import { sortScoredChunks, selectContext } from '../traditionalRag/context'
import { reciprocalRankFusion } from '../baselines/rrf'
import { createCrossEncoderProvider, type RerankerProvider } from '../baselines/reranker'
import { benchPath } from '../paths'
import { runStrongBaselineQaTask, type StrongBaselineQaArgs, type StrongRetrievalRuntime } from './strongBaselineQa'
import type { StreamingLlmClient } from '../llmClient'
import { assertStrongSpeedPolicy } from '../speed/policy'

export interface HybridRerankQaArgs extends Omit<StrongBaselineQaArgs, 'retrieval' | 'meta'> {
  config: HybridRerankConfig
  deps?: {
    tokenizer?: TextTokenizer
    denseProvider?: Awaited<ReturnType<typeof createBgeM3Provider>>['provider']
    reranker?: RerankerProvider
  }
}

const modelCacheDir = () => benchPath(import.meta.url, '../../cache/models/')

/** 把最终排序编码为「分数单调于名次」的打分序列，保证指标层重排序后仍还原本次序。 */
function rankScores(ids: number[]): ScoredChunk[] {
  return ids.map((id, index) => ({ id, score: ids.length - index }))
}

export async function createHybridRetrieval(config: HybridRerankConfig, deps: HybridRerankQaArgs['deps'] = {}): Promise<StrongRetrievalRuntime> {
  const tokenizer = deps.tokenizer ?? await createBgeM3Tokenizer({ model: 'BAAI/bge-m3', revision: 'main', cacheDir: modelCacheDir() })
  const denseProvider = deps.denseProvider ?? (await createBgeM3Provider({ ...config.retrieval.dense.embedding, cacheDir: modelCacheDir() })).provider
  const reranker = deps.reranker ?? await createCrossEncoderProvider({ ...config.retrieval.reranker, cacheDir: modelCacheDir() })

  return {
    granularity: `${config.chunking.chunkSize}-token passage (overlap ${config.chunking.overlap})`,
    async build(sample) {
      const chunks = chunkPages(sample.pages, tokenizer, config.chunking)
      const byId = new Map(chunks.map(c => [c.id, c]))
      const bm25 = buildBm25Retriever(chunks, { k1: config.retrieval.bm25.k1, b: config.retrieval.bm25.b })
      const dense = await buildCosineRetriever(chunks, denseProvider, { queryPrefix: config.retrieval.dense.embedding.queryPrefix, maxLength: config.retrieval.dense.embedding.maxLength })
      return {
        leafCount: chunks.length,
        async retrieve(question: string) {
          let bm25Top: ScoredChunk[]
          try {
            bm25Top = sortScoredChunks(await bm25.score(question)).slice(0, config.retrieval.bm25.topK)
          } catch (e) { throw new Error(`bm25 检索失败：${e instanceof Error ? e.message : String(e)}`) }
          let denseTop: ScoredChunk[]
          try {
            denseTop = sortScoredChunks(await dense.score(question)).slice(0, config.retrieval.dense.topK)
          } catch (e) { throw new Error(`dense 检索失败：${e instanceof Error ? e.message : String(e)}`) }
          // RRF 只消费两路的秩；融合窗口 topK 截断后进入重排
          const fused = reciprocalRankFusion([bm25Top, denseTop], config.retrieval.rrf.k).slice(0, config.retrieval.rrf.topK)
          if (!fused.length) throw new Error('RRF 融合后没有候选')
          let rerankOrdered: ScoredChunk[]
          try {
            const pairs = fused.map(f => ({ query: question, document: byId.get(f.id)!.text }))
            const scores = await reranker.score(pairs)
            if (scores.length !== pairs.length) throw new Error(`重排返回 ${scores.length} 个分数，期望 ${pairs.length}`)
            // 重排只作用于融合窗口内：按重排分降序，平分时保持融合次序
            rerankOrdered = fused
              .map((f, i) => ({ id: f.id, score: scores[i] }))
              .sort((a, b) => b.score - a.score || fused.findIndex(f => f.id === a.id) - fused.findIndex(f => f.id === b.id))
          } catch (e) { throw new Error(`rerank 失败：${e instanceof Error ? e.message : String(e)}`) }
          // 最终排序 = 重排前缀 + 融合尾部；MRR 在该完整最终次序上计算
          const rerankedIds = rerankOrdered.slice(0, config.retrieval.reranker.topK).map(r => r.id)
          const tailIds = fused.map(f => f.id).filter(id => !rerankedIds.includes(id))
          const finalOrdering = [...rerankedIds, ...tailIds]
          const ctx = selectContext(chunks, rankScores(finalOrdering), {
            retrievalTopK: config.retrieval.reranker.topK,
            topK: config.generationContext.topK,
          })
          // 最终 4096 预算由公共 materializer 统一施加：单个候选允许在预算边界被截断，
          // 部分进入的页仍计入页序（设计 §5）。runner 只负责给出候选与逐页分片。
          // selectContext 返回 BenchChunk，此处显式映射成只含页区间的 PageSpan 诊断包络，
          // 让上下文组之外只透出真正被消费的字段（startPage/endPage）。
          return {
            contextGroups: ctx.contextGroups,
            selected: ctx.selected.map(chunk => ({ startPage: chunk.startPage, endPage: chunk.endPage })),
          }
        },
      }
    },
  }
}

export async function runHybridRerankQaTask(args: HybridRerankQaArgs): Promise<BenchResult> {
  assertStrongSpeedPolicy({
    speed: args.speed !== undefined,
    checkpointPath: args.checkpointPath,
    client: args.client as StreamingLlmClient,
  })
  const retrieval = await createHybridRetrieval(args.config, args.deps)
  return runStrongBaselineQaTask({
    ...args,
    retrieval,
    meta: { retrievalAlgorithm: 'hybrid-rerank', baselineFamily: 'strong', config: args.config },
  })
}
