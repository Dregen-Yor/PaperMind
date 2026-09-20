import { collectLeafNodes, scoreAndSelect, type IndexNode, type RetrievalResult, type ScoreOptions } from './pageIndex'
import { rewriteQuery, type ChatTurn } from './queryRewrite'
import {
  routeWithSemanticTree,
  type SemanticRouteDiagnostics,
} from './semanticRoute'
import { CONTEXT_GROUP_SEPARATOR, type ContextGroup, type MaterializedContext } from './contextTrace'
import type { EvidenceBlock } from './evidenceBlock'
import type { SemanticTree } from './semanticTree'
import type { ChatLLMFn, LLMFn } from './llm'
import { buildAnswerMessages } from './answerMessages'

export { buildAnswerMessages, MATH_FORMAT_INSTRUCTION } from './answerMessages'

/** 触发查询改写所需的最少历史轮数。 */
const REWRITE_MIN_HISTORY = 2
/** 改写时参考的最近历史轮数。 */
const REWRITE_HISTORY_WINDOW = 3

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

/**
 * 注入式依赖：`now` 供单测注入单调时钟（返回预设序列而非真实 sleep）；生产默认 Date.now。
 * `materialize` 供 benchmark 注入受控 token 预算（§5）；生产不注入时上下文沿用字符预算。
 */
export interface RagPipelineDeps {
  now?: () => number
  materialize?: (groups: ContextGroup[]) => MaterializedContext
}

/**
 * 检索阶段的产物：改写到上下文构造为止的全部结果与计时。
 * 生成失败时该对象依然完整，runner 可据此先落盘检索指标再进入生成（§6.2 / §6.3）。
 */
export interface RagRetrievalStage {
  /** 每篇论文一份检索结果，顺序与入参 papers 一致 */
  retrievals: PipelineRetrieval[]
  /** 实际用于检索的查询（未改写时等于原始 query） */
  retrievalQuery: string
  /** 是否发生了查询改写 */
  rewritten: boolean
  /** 合并后的参考内容；无可用索引时为空串 */
  context: string
  /** 最终上下文的来源页首次出现顺序；仅在注入 `materialize` 时产出（§3.1） */
  contextPageOrder?: number[]
  /** 最终上下文的实际 token 数；仅在注入 `materialize` 时产出 */
  contextTokenCount?: number
  /** 上下文是否被预算截断：字符预算路径按 maxContextChars 判定，materializer 路径取自物化结果 */
  contextTruncated: boolean
  /** 各篇检索来源汇总 */
  sources: string[]
  /** 检索阶段（改写 + 逐篇评分）实际发出的 LLM 请求数，不含生成 */
  llmCalls: number
  /** 本次检索是否至少有一篇论文走了轻量语义树路由 */
  treeRouted: boolean
  queryRewriteLatencyMs: number
  retrievalLatencyMs: number
  /**
   * 整问的起点时刻（同一进程内的绝对 epoch 毫秒），供生成阶段计算端到端时长。
   * `queryEndToEndLatencyMs` 只在**同进程连续调用**下有意义：经由 `runRagPipeline`
   * 两阶段共享同一个时钟且紧邻执行，结果精确。§6.5 允许 runner 从「仅完成检索」的
   * checkpoint 恢复生成——此时若把本字段持久化后在新进程/新时钟里重放，
   * 端到端时长会变成数小时（注入时钟下甚至为负），因此断点续跑的调用方必须自行测量
   * 端到端时长，不能依赖这里回传的值。
   */
  pipelineStartedAt: number
}

/** 生成阶段的产物。 */
export interface RagGenerationStage {
  answer: string
  answerGenerationLatencyMs: number
  queryEndToEndLatencyMs: number
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
  /**
   * 上下文是否被预算截断，单位随生效的预算路径而变：
   * 未注入 `materialize` 时为字符截断（超过 `maxContextChars`），
   * 注入 `materialize` 时为 token 截断（物化结果超出受控 token 预算）。
   */
  contextTruncated: boolean
  /** 最终上下文的来源页首次出现顺序；仅在注入 `materialize` 时产出（§3.1） */
  contextPageOrder?: number[]
  /** 最终上下文的实际 token 数；仅在注入 `materialize` 时产出 */
  contextTokenCount?: number
  /** 本问热路径的时延分阶段口径 */
  timing: PipelineTiming
}

/**
 * 检索阶段（纯函数）：查询改写 → 逐篇评分多选 → 合并上下文。
 *
 * 不注入 `deps.materialize` 时完全沿用产品的字符预算路径（`maxContextChars` 截断）；
 * 注入时改用 materializer 在受控 token 预算内物化上下文，并同步产出页序与 token 数。
 * 传入 `opts.externalContext`（用户划选原文）时优先级最高：跳过改写与检索，
 * 直接以该文本作为上下文，`deps.materialize` 随之失效、页序/token 数不产出。
 * 所有时长经 Math.max(0, value) 钳制，以兼容测试注入时钟与系统时间回拨。
 */
export async function retrieveRagContext(
  papers: IndexedPaper[],
  query: string,
  history: ChatTurn[],
  llm: LLMFn,
  opts: RagOptions = {},
  deps: RagPipelineDeps = {},
): Promise<RagRetrievalStage> {
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

  let context: string
  let contextPageOrder: number[] | undefined
  let contextTokenCount: number | undefined
  let contextTruncated: boolean
  if (!skipRetrieval && deps.materialize) {
    // benchmark 受控预算：上下文文本与页序从同一次物化产出，禁止事后反推（§3.1 / §4.1）
    const materialized = deps.materialize(retrievals.flatMap(r => r.contextGroups))
    context = materialized.text
    contextPageOrder = materialized.pageOrder
    contextTokenCount = materialized.tokenCount
    contextTruncated = materialized.truncated
  } else {
    const unboundedContext = skipRetrieval
      ? (externalContext as string)
      : retrievals.map(r => r.context).join(CONTEXT_GROUP_SEPARATOR)
    contextTruncated = maxContextChars !== undefined && unboundedContext.length > maxContextChars
    context = contextTruncated ? unboundedContext.slice(0, maxContextChars) : unboundedContext
  }
  const sources = retrievals.flatMap(r => r.sources)
  const retrievalLatencyMs = Math.max(0, now() - retrievalStartedAt)

  return {
    retrievals,
    retrievalQuery,
    rewritten,
    context,
    ...(contextPageOrder !== undefined ? { contextPageOrder } : {}),
    ...(contextTokenCount !== undefined ? { contextTokenCount } : {}),
    contextTruncated,
    sources,
    llmCalls,
    treeRouted,
    queryRewriteLatencyMs,
    retrievalLatencyMs,
    pipelineStartedAt,
  }
}

/**
 * 生成阶段（纯函数）：按检索阶段已算好的上下文组装提示词并调用回答模型。
 *
 * `generate` 抛错时直接向上抛出，不改写传入的 `retrieval`——
 * 调用方据此在生成之前落盘检索指标，生成失败也不丢（§6.3）。
 *
 * 依赖只取 `now`：`materialize` 在检索阶段就已生效，生成阶段不会（也不能）再改上下文，
 * 因此这里不接受它，避免调用方误以为注入 materializer 能左右提示词。
 */
export async function generateRagAnswer(
  retrieval: RagRetrievalStage,
  query: string,
  history: ChatTurn[],
  generate: ChatLLMFn,
  systemPrompt: string,
  deps: Pick<RagPipelineDeps, 'now'> = {},
): Promise<RagGenerationStage> {
  const now = deps.now ?? Date.now
  const messages = buildAnswerMessages(retrieval.context, query, history, systemPrompt)
  const generationStartedAt = now()
  const answer = await generate(messages)
  const answerGenerationLatencyMs = Math.max(0, now() - generationStartedAt)

  return {
    answer,
    answerGenerationLatencyMs,
    // 总计时直接量测起止，不要以子阶段相加替代：本地消息组装的差异留给总账
    queryEndToEndLatencyMs: Math.max(0, now() - retrieval.pipelineStartedAt),
  }
}

/**
 * 论文问答 RAG 主流程（纯函数）：检索阶段 → 生成阶段。
 *
 * 不依赖 store / IPC / DOM，供渲染层与离线评测复用同一份实现；
 * 现有应用调用方继续走这个组合封装，未注入 `materialize` 时行为与拆分前逐字一致。
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
  const retrieval = await retrieveRagContext(papers, query, history, llm, opts, deps)
  const generation = await generateRagAnswer(retrieval, query, history, generate, systemPrompt, deps)

  const timing: PipelineTiming = {
    queryRewriteLatencyMs: retrieval.queryRewriteLatencyMs,
    retrievalLatencyMs: retrieval.retrievalLatencyMs,
    answerGenerationLatencyMs: generation.answerGenerationLatencyMs,
    queryEndToEndLatencyMs: generation.queryEndToEndLatencyMs,
  }

  return {
    answer: generation.answer,
    retrievals: retrieval.retrievals,
    retrievalQuery: retrieval.retrievalQuery,
    rewritten: retrieval.rewritten,
    context: retrieval.context,
    sources: retrieval.sources,
    // 生成必定发出一次调用，检索阶段不计入
    llmCalls: retrieval.llmCalls + 1,
    treeRouted: retrieval.treeRouted,
    contextTruncated: retrieval.contextTruncated,
    ...(retrieval.contextPageOrder !== undefined ? { contextPageOrder: retrieval.contextPageOrder } : {}),
    ...(retrieval.contextTokenCount !== undefined ? { contextTokenCount: retrieval.contextTokenCount } : {}),
    timing,
  }
}
