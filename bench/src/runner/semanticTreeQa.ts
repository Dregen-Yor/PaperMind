/**
 * 轻量语义树 QA runner（方案 §11.2 的第二个对照组）。
 *
 * 与 `papermind` 走的是**同一条**生产 RAG 管线（`runQaTask` → `runRagPipeline`），
 * 唯一变量是每篇论文多挂一棵语义树索引：建树一次 LLM 调用，
 * 提问时整棵树进入同一次检索判断，最终上下文仍来自原文证据块。
 *
 * 建树失败只是没有树——本篇退回平面检索并在诊断里如实计失败，评测不中断（§8.2）。
 */
import { buildEvidenceBlocks } from '../../../src/utils/evidenceBlock'
import { buildSemanticTree, SemanticTreeBuildError, type SemanticTreeBuildMeta } from '../../../src/utils/semanticTree'
import type { LlmClient } from '../llmClient'
import type { EvalSample, PaperMindConfig, SemanticTreeParams, BenchResult } from '../types'
import type { SemanticTreeHook, SemanticTreeHookResult } from '../metrics/treeDiagnostics'
import { runQaTask, type QaTaskArgs } from './qa'

export interface SemanticTreeHookOptions {
  params: SemanticTreeParams
  /** 建树用的客户端；通常就是索引模型，与平面索引共用配置 */
  client: LlmClient
  /** 测试注入单调时钟；生产默认 Date.now */
  now?: () => number
  deps?: {
    buildBlocks?: typeof buildEvidenceBlocks
    buildTree?: typeof buildSemanticTree
  }
}

/** 只保留诊断字段，避免把建树内部的 LLM 次数等成本口径混进结构诊断。 */
function diagnosticsOf(meta: SemanticTreeBuildMeta): SemanticTreeHookResult['diagnostics'] {
  return {
    nodeCount: meta.nodeCount,
    depth: meta.depth,
    level1Count: meta.level1Count,
    level2Count: meta.level2Count,
    referencedBlockCount: meta.referencedBlockCount,
    evidenceCoverage: meta.evidenceCoverage,
    sharedBlockCount: meta.sharedBlockCount,
    crossSectionNodeCount: meta.crossSectionNodeCount,
  }
}

export function createSemanticTreeHook(opts: SemanticTreeHookOptions): SemanticTreeHook {
  const now = opts.now ?? Date.now
  const buildBlocks = opts.deps?.buildBlocks ?? buildEvidenceBlocks
  const buildTree = opts.deps?.buildTree ?? buildSemanticTree

  return async (sample: EvalSample): Promise<SemanticTreeHookResult> => {
    const started = now()
    const before = opts.client.stats()
    const cacheDelta = () => {
      const after = opts.client.stats()
      return { cacheHits: after.hits - before.hits, cacheMisses: after.misses - before.misses }
    }
    let evidenceBlockCount: number | undefined

    try {
      const blocks = buildBlocks(sample.pages, opts.params.evidence)
      evidenceBlockCount = blocks.length
      const { tree, meta } = await buildTree(blocks, opts.client.complete, {
        maxInputChars: opts.params.maxInputChars,
        now,
      })
      return {
        semantic: { tree, blocks },
        diagnostics: diagnosticsOf(meta),
        evidenceBlockCount,
        llmCalls: meta.llmCalls,
        inputTokens: meta.inputTokens,
        outputTokens: meta.outputTokens,
        latencyMs: Math.max(0, now() - started),
        ...cacheDelta(),
      }
    } catch (error) {
      // 失败也分两种：调用前就被拒（无证据块 / 输入超限）成本为 0；
      // 模型已经返回、只是输出不可用，这一次调用与 token 就是真实成本，必须照记
      const cost = error instanceof SemanticTreeBuildError ? error.cost : undefined
      return {
        ...(evidenceBlockCount !== undefined ? { evidenceBlockCount } : {}),
        llmCalls: cost?.llmCalls ?? 0,
        inputTokens: cost?.inputTokens ?? 0,
        outputTokens: cost?.outputTokens ?? 0,
        latencyMs: Math.max(0, now() - started),
        failed: true,
        ...cacheDelta(),
      }
    }
  }
}

export interface SemanticTreeQaArgs extends Omit<QaTaskArgs, 'semanticTree' | 'config'> {
  config: PaperMindConfig
}

export async function runSemanticTreeQaTask(args: SemanticTreeQaArgs): Promise<BenchResult> {
  const params = args.config.semanticTree
  if (!params) throw new Error('semantic-tree 配置缺少 semanticTree 参数块')
  return runQaTask({
    ...args,
    semanticTree: createSemanticTreeHook({ params, client: args.client, now: args.now }),
  })
}
