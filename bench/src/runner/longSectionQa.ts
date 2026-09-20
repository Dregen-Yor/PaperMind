/**
 * long-section-rag 结构化阅读基线 runner（计划 §2.3）：
 * 确定性章节边界（无 LLM）→ BM25 锚点段召回 top-K →
 * 取最高排名锚点，在所属章节内以锚点为中心连续扩展，直到 4096 token 预算或章节边界。
 * 连续区域是单一上下文单元；最佳锚点不可用时按排名取下一个（确定性 fallback），
 * 绝不组合无关章节，绝不使用 gold evidence。
 */
import type { BenchResult, LongSectionRagConfig } from '../types'
import type { ScoredChunk, TextTokenizer } from '../traditionalRag/types'
import { buildBm25Retriever } from '../traditionalRag/bm25'
import { sortScoredChunks } from '../traditionalRag/context'
import { createBgeM3Tokenizer } from '../traditionalRag/embedding'
import { chunkTokenStream, buildTokenStream, type StreamPassage } from '../baselines/tokenStream'
import { detectSections, type Section } from '../baselines/sections'
import { expandWithinSection } from '../baselines/contiguous'
import { benchPath } from '../paths'
import { runStrongBaselineQaTask, type StrongBaselineQaArgs, type StrongRetrievalRuntime } from './strongBaselineQa'

const modelCacheDir = () => benchPath(import.meta.url, '../../cache/models/')

export interface LongSectionQaArgs extends Omit<StrongBaselineQaArgs, 'retrieval' | 'meta'> {
  config: LongSectionRagConfig
  deps?: {
    tokenizer?: TextTokenizer
    /** 测试注入章节边界；生产走确定性 detectSections */
    detectSections?: (pages: string[], tokenizer: TextTokenizer) => Section[]
  }
}

export async function createLongSectionRetrieval(config: LongSectionRagConfig, deps: LongSectionQaArgs['deps'] = {}): Promise<StrongRetrievalRuntime> {
  const tokenizer = deps.tokenizer ?? await createBgeM3Tokenizer({ model: 'BAAI/bge-m3', revision: 'main', cacheDir: modelCacheDir() })
  const detect = deps.detectSections ?? detectSections
  return {
    granularity: 'contiguous section region',
    async build(sample) {
      const { tokens } = buildTokenStream(sample.pages, tokenizer)
      const sections = detect(sample.pages, tokenizer)
      // 锚点段与整篇 token 流共享下标，扩展阶段无需二次定位
      const anchors: StreamPassage[] = chunkTokenStream(tokens, { chunkSize: config.anchors.chunkSize, overlap: config.anchors.overlap })
      const bm25 = buildBm25Retriever(anchors, { k1: config.retrieval.k1, b: config.retrieval.b })
      const maxTokens = config.generationContext.maxTokens
      return {
        leafCount: anchors.length,
        async retrieve(question: string) {
          const ranked: ScoredChunk[] = sortScoredChunks(await bm25.score(question)).slice(0, config.retrieval.topK)
          if (!ranked.length) throw new Error('BM25 锚点召回为空')
          // 按排名逐个尝试：第一个能解析出章节区域的锚点胜出（确定性 fallback）
          for (const anchor of ranked) {
            const region = expandWithinSection(tokens, sections, { startToken: anchors[anchor.id].startToken, endToken: anchors[anchor.id].endToken }, maxTokens)
            if (!region) continue
            // 连续区域是单一上下文单元：其逐页分片即物化输入，页区间即诊断包络。
            // 最终 4096 预算仍由公共 materializer 统一施加（允许在边界处部分进入）。
            return {
              contextGroups: [{ pieces: region.pieces }],
              selected: [{ startPage: region.startPage, endPage: region.endPage }],
            }
          }
          throw new Error('所有召回锚点均无法解析出有效章节区域')
        },
      }
    },
  }
}

export async function runLongSectionQaTask(args: LongSectionQaArgs): Promise<BenchResult> {
  const retrieval = await createLongSectionRetrieval(args.config, args.deps)
  return runStrongBaselineQaTask({
    ...args,
    retrieval,
    meta: { retrievalAlgorithm: 'long-section-rag', baselineFamily: 'strong', config: args.config },
  })
}
