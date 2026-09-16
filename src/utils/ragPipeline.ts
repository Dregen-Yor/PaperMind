import { collectLeafNodes, scoreAndSelect, type IndexNode, type RetrievalResult, type ScoreOptions } from './pageIndex'
import { rewriteQuery, type ChatTurn } from './queryRewrite'
import {
  routeWithSemanticTree,
  type SemanticRouteDiagnostics,
} from './semanticRoute'
import type { EvidenceBlock } from './evidenceBlock'
import type { SemanticTree } from './semanticTree'
import type { ChatLLMFn, LLMFn } from './llm'

/** 数学公式格式约束，追加在 system 提示词之后。 */
export const MATH_FORMAT_INSTRUCTION =
  '数学公式请使用 LaTeX：行内公式使用 $...$，独立公式使用 $$...$$。不要使用 \\(...\\) 或 \\[...\\] 包裹公式。'

/** 触发查询改写所需的最少历史轮数。 */
const REWRITE_MIN_HISTORY = 2
/** 改写时参考的最近历史轮数。 */
const REWRITE_HISTORY_WINDOW = 3
/** 生成回答时携带的最近历史轮数（不含当前提问）。 */
const GENERATE_HISTORY_WINDOW = 19

/**
 * 已构建好的轻量语义树索引（§4：语义树与原文证据块分离保存）。
 * 树缺失或未就绪时该字段为 undefined，检索退回平面路径。
 */
export interface SemanticPaperIndex {
  tree: SemanticTree
  blocks: EvidenceBlock[]
}

/**
 * 单篇论文的检索结果。走语义树路由时额外带 `semantic` 诊断，
 * 评测据此统计 `treeUsed` / `treeDegraded` / `selectedNodeCount`（§11.4）。
 */
export type PipelineRetrieval = RetrievalResult & { semantic?: SemanticRouteDiagnostics }

/** 已建好索引的单篇论文。 */
export interface IndexedPaper {
  tree: IndexNode
  pages: string[]
  /**
   * 轻量语义树索引。提供时检索走单轮树路由（§9），否则走平面 scoreAndSelect。
   * 两者消耗同样数量的串行 LLM 调用。
   */
  semantic?: SemanticPaperIndex
}

export interface RagOptions extends ScoreOptions {
  /** 是否启用查询改写，默认 true（仍需历史轮数达标才实际触发） */
  enableRewrite?: boolean
  /**
   * 外部直接提供的参考内容（如用户划选文本）。
   * 提供时跳过改写与检索，直接用它作为上下文生成回答。
   */
  externalContext?: string
  /** Hard cap for the combined retrieval context sent to the generation model. */
  maxContextChars?: number
}

/**
 * 单次 RAG 问答的时延分阶段口径（毫秒）。阶段边界统一由 pipeline 定义，
 * 避免产品与 benchmark 各自计时造成口径漂移。
 */
export interface PipelineTiming {
  queryRewriteLatencyMs: number
  retrievalLatencyMs: number
  answerGenerationLatencyMs: number
  queryEndToEndLatencyMs: number
}

/** 注入式依赖：`now` 供单测注入单调时钟（返回预设序列而非真实 sleep）；生产默认 Date.now。 */
export interface RagPipelineDeps {
  now?: () => number
}

export interface RagResult {
  answer: string
  /**
   * 每篇论文一份检索结果，顺序与入参 papers 一致。
   * 走语义树路由的论文额外带 `semantic` 诊断字段（§11.4）。
   */
  retrievals: PipelineRetrieval[]
  /** 实际用于检索的查询（未改写时等于原始 query） */
  retrievalQuery: string
  /** 是否发生了查询改写 */
  rewritten: boolean
  /** 合并后的参考内容；无可用索引时为空串 */
  context: string
  /** 各篇检索来源汇总 */
  sources: string[]
  /** 本次问答实际发出的 LLM 请求数 */
  llmCalls: number
  /** 本次检索是否至少有一篇论文走了轻量语义树路由 */
  treeRouted: boolean
  /** Whether retrieval context was clipped to maxContextChars. */
  contextTruncated: boolean
  /** 本问热路径的时延分阶段口径 */
  timing: PipelineTiming
}

/**
 * 论文问答 RAG 主流程（纯函数）：查询改写 → 逐篇评分多选 → 生成回答。
 *
 * 不依赖 store / IPC / DOM，供渲染层与离线评测复用同一份实现。
 * 所有时长经 Math.max(0, value) 钳制，以兼容测试注入时钟与系统时间回拨。
 */
export async function runRagPipeline(
  papers: IndexedPaper[],
  query: string,
  history: ChatTurn[],
  llm: LLMFn,
  generate: ChatLLMFn,
  systemPrompt: string,
  opts: RagOptions = {},
  deps: RagPipelineDeps = {},
): Promise<RagResult> {
  const now = deps.now ?? Date.now
  const pipelineStartedAt = now()
  const { enableRewrite = true, externalContext, maxContextChars, ...scoreOpts } = opts
  if (maxContextChars !== undefined && (!Number.isInteger(maxContextChars) || maxContextChars <= 0)) {
    throw new Error('maxContextChars must be a positive integer')
  }
  let llmCalls = 0
  const skipRetrieval = externalContext !== undefined && externalContext !== ''

  // 检索阶段起点放在改写之前：改写 + 逐篇评分 + 上下文合并/截断都计入
  // retrievalLatencyMs，保证「首次提问热路径」口径包含改写开销。
  const retrievalStartedAt = now()
  let queryRewriteLatencyMs = 0

  // Call 1（条件）：查询改写
  const recentHistory = history.slice(-REWRITE_HISTORY_WINDOW)
  let retrievalQuery = query
  let rewritten = false
  if (!skipRetrieval && enableRewrite && recentHistory.length >= REWRITE_MIN_HISTORY) {
    llmCalls++
    const rewriteStartedAt = now()
    retrievalQuery = await rewriteQuery(query, recentHistory, llm)
    queryRewriteLatencyMs = Math.max(0, now() - rewriteStartedAt)
    rewritten = retrievalQuery !== query
  }

  // Call 2（每篇论文，单叶节点或单节点树时短路不发请求）：评分多选
  const retrievals: PipelineRetrieval[] = []
  let treeRouted = false
  if (!skipRetrieval) {
    for (const paper of papers) {
      // 有语义树时整棵小树在一次判断里用掉，调用数与平面路径相同（§10.1）。
      // 平面叶节点一并交给树路由打分：树取不到证据时才能在同一次调用里就地回落（§9）。
      const result = paper.semantic
        ? await routeWithSemanticTree(paper.semantic.tree, paper.semantic.blocks, retrievalQuery, llm, {
            ...scoreOpts,
            ...(maxContextChars !== undefined ? { maxContextChars } : {}),
            flat: { leaves: collectLeafNodes(paper.tree), pages: paper.pages },
          })
        : await scoreAndSelect(paper.tree, paper.pages, retrievalQuery, llm, scoreOpts)
      if (paper.semantic) treeRouted = true
      if (result.llmCalled) llmCalls++
      retrievals.push(result)
    }
  }

  const unboundedContext = skipRetrieval
    ? (externalContext as string)
    : retrievals.map(r => r.context).join('\n\n---\n\n')
  const contextTruncated = maxContextChars !== undefined && unboundedContext.length > maxContextChars
  const context = contextTruncated ? unboundedContext.slice(0, maxContextChars) : unboundedContext
  const sources = retrievals.flatMap(r => r.sources)
  const retrievalLatencyMs = Math.max(0, now() - retrievalStartedAt)

  // Call 3：生成回答
  const messages = [
    {
      role: 'system',
      content:
        `${systemPrompt}\n\n${MATH_FORMAT_INSTRUCTION}` +
        (context ? `\n\n参考内容：\n${context}` : ''),
    },
    ...history.slice(-GENERATE_HISTORY_WINDOW),
    { role: 'user', content: query },
  ]
  llmCalls++
  const generationStartedAt = now()
  const answer = await generate(messages)
  const answerGenerationLatencyMs = Math.max(0, now() - generationStartedAt)

  const timing: PipelineTiming = {
    queryRewriteLatencyMs,
    retrievalLatencyMs,
    answerGenerationLatencyMs,
    // 总计时直接量测起止，不要以子阶段相加替代：本地消息组装的差异留给总账
    queryEndToEndLatencyMs: Math.max(0, now() - pipelineStartedAt),
  }

  return { answer, retrievals, retrievalQuery, rewritten, context, sources, llmCalls, treeRouted, contextTruncated, timing }
}
