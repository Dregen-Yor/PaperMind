/**
 * 冷首问 runner（Task 7）——产品头部速度声明的冷启动测量：
 * 从「打开 PDF」到「首个流式回答 token」的 t0 相对时延，索引与本地模型初始化都算在冷启动里。
 *
 * 两条策略：
 * - `ready-before-query`：等请求的索引阶段全部就绪（与热 `--speed` 的 `await handle.ready` 一致）；
 * - `ask-at-lexical-ready`：阶段① 词法快照一落盘就回答，向量/目录在后台继续，回答后再 settle。
 *
 * 每个时长都从**同一篇论文自己的 t0**（重新打开 PDF 字节之前）起算；回答路径复用生产
 * `retrieveRagContext`（受控物化器）与 `generateSpeedAnswer`（流式）。冷 t0 先被 stamp，随后取
 * token 快照、再 `startQueryTimeline` 记录它自己的 `startedAt`（比 t0 略晚的一瞬）——三者都发生在
 * 任何冷工作（读 PDF / 初始化本地模型 / 建索引）之前，因此 TTFT / Full Answer 实际以 t0 为基准。
 * 不写 SQLite，不写结果文件，返回纯内存结果。
 */
import { retrieveRagContext, type RagRetrievalStage } from '../../../src/utils/ragPipeline'
import { DEFAULT_HYBRID_OPTIONS } from '../../../src/utils/passageRetrieval'
import type { ContextGroup, MaterializedContext } from '../../../src/utils/contextTrace'
import type { Embedder } from '../../../src/utils/embedder'
import type { TokenCounter } from '../../../src/utils/passages'
import type { StreamingLlmClient } from '../llmClient'
import type {
  ColdFirstQueryRecord,
  ColdFirstQueryResult,
  ColdStrategy,
  PassageMode,
  PdfStudySample,
} from '../types'
import type { PassageIndexHandle, PassageIndexHook, PassageIndexInfo } from './passageIndexHook'
import { toOutlineScoringNodes } from './passageIndexHook'
import { generateSpeedAnswer } from '../speed/generate'
import { assertCompletedSpeedRecord, startQueryTimeline } from '../speed/queryTimeline'
import { aggregateColdFirstQueryMetrics } from '../metrics/coldFirstQuery'
import { newSampleRecord } from './support'

export const COLD_FIRST_QUERY_DEFINITION = 'cold-first-query-v1' as const

export interface ColdFirstQueryArgs {
  samples: PdfStudySample[]
  mode: PassageMode
  strategy: ColdStrategy
  client: StreamingLlmClient
  /** 最终生效的 system prompt（含语言覆盖指令），逐字进入回答报文。 */
  systemPrompt: string
  materialize: (groups: ContextGroup[]) => MaterializedContext
  /** 在 t0 之后重新打开 PDF 字节并抽取页文本（唯一一次抽取）。 */
  readPdf: (sample: PdfStudySample) => Promise<string[]>
  /** 在 t0 之后初始化本地稠密模型；lexical（A）臂返回 undefined。 */
  initLocalModel: (sample: PdfStudySample) => Promise<Embedder | undefined>
  /** 用刚初始化的 embedder 产出一个段落索引 hook（每篇调用一次）。 */
  createHook: (embedder: Embedder | undefined) => PassageIndexHook
  countTokens: TokenCounter
  contextBudgetTokens: number
  rrfK?: number
  sectionWeight?: number
  neighbourFactor?: number
  skipLimit?: number
  now?: () => number
  streamAnswer?: StreamingLlmClient['chatStream']
  deps?: {
    retrieveContext?: typeof retrieveRagContext
  }
}

export async function runColdFirstQuery(args: ColdFirstQueryArgs): Promise<ColdFirstQueryResult> {
  const now = args.now ?? Date.now
  const records: ColdFirstQueryRecord[] = []
  for (const sample of args.samples) {
    records.push(await measureColdPaper(sample, args, now))
  }
  return {
    definition: COLD_FIRST_QUERY_DEFINITION,
    mode: args.mode,
    strategy: args.strategy,
    records,
    metrics: aggregateColdFirstQueryMetrics(records, { mode: args.mode, strategy: args.strategy }),
  }
}

async function measureColdPaper(
  sample: PdfStudySample,
  args: ColdFirstQueryArgs,
  now: () => number,
): Promise<ColdFirstQueryRecord> {
  const question = sample.questions[0]
  const base: ColdFirstQueryRecord = {
    id: question?.id ?? sample.paperId,
    paperId: sample.paperId,
    strategy: args.strategy,
    inputKind: 'pdf-bytes',
    pdfLoadMs: 0,
    localModelInitMs: 0,
    lexicalReadyMs: 0,
    actualPassageStage: 0,
    completionStatus: 'skipped',
  }
  if (!question) return base

  const t0 = now()
  // t0 先 stamp，随后取 token 快照、再 startQueryTimeline 记录它自己的 startedAt（比 t0 略晚）。
  // 三者都在任何冷工作（读 PDF / 初始化本地模型 / 建索引）之前完成，故 TTFT / Full Answer 以 t0 为基准。
  const before = args.client.tokenSnapshot()
  const timeline = startQueryTimeline(now, before)
  const retrieveContext = args.deps?.retrieveContext ?? retrieveRagContext

  let pages: string[]
  try {
    const started = now()
    pages = await args.readPdf(sample)
    base.pdfLoadMs = Math.max(0, now() - started)
  } catch {
    base.completionStatus = 'failed'
    base.failureStage = 'pdf-load'
    return base
  }

  let embedder: Embedder | undefined
  try {
    const started = now()
    embedder = await args.initLocalModel(sample)
    base.localModelInitMs = Math.max(0, now() - started)
  } catch {
    base.completionStatus = 'failed'
    base.failureStage = 'local-model-init'
    return base
  }

  let handle: PassageIndexHandle
  try {
    handle = await args.createHook(embedder)({ ...sample, pages })
  } catch {
    base.completionStatus = 'failed'
    base.failureStage = 'index'
    return base
  }
  base.lexicalReadyMs = Math.max(0, now() - t0)

  let passageInfo: PassageIndexInfo
  if (args.strategy === 'ready-before-query') {
    try {
      passageInfo = await handle.ready
    } catch {
      base.completionStatus = 'failed'
      base.failureStage = 'index'
      return base
    }
    base.actualPassageStage = passageInfo.index.stage
    if (passageInfo.index.passageVectors) base.denseReadyMs = Math.max(0, now() - t0)
    if (passageInfo.outline) base.outlineReadyMs = Math.max(0, now() - t0)
  } else {
    // ask-at-lexical-ready：只拿阶段① 快照，向量/目录仍在后台跑
    passageInfo = handle.lexicalReady
    base.actualPassageStage = passageInfo.index.stage
  }

  const outlineScoringNodes = passageInfo.outline?.available
    ? toOutlineScoringNodes(passageInfo.outline)
    : undefined
  const outlineWeight = args.sectionWeight ?? DEFAULT_HYBRID_OPTIONS.sectionWeight

  let retrieval: RagRetrievalStage
  try {
    retrieval = await retrieveContext(
      [{
        tree: passageInfo.index.tree,
        pages,
        passageIndex: passageInfo.index,
        ...(outlineScoringNodes && outlineScoringNodes.length > 0
          ? { outline: { nodes: outlineScoringNodes, weight: outlineWeight } }
          : {}),
      }],
      question.question,
      [],
      args.client.complete,
      {},
      {
        now,
        materialize: args.materialize,
        passage: {
          ...(embedder ? { embedder } : {}),
          countTokens: args.countTokens,
          maxTokens: args.contextBudgetTokens,
          ...(args.rrfK !== undefined ? { rrfK: args.rrfK } : {}),
          ...(args.sectionWeight !== undefined ? { sectionWeight: args.sectionWeight } : {}),
          ...(args.neighbourFactor !== undefined ? { neighbourFactor: args.neighbourFactor } : {}),
          ...(args.skipLimit !== undefined ? { skipLimit: args.skipLimit } : {}),
        },
      },
    )
    timeline.markEvidenceReady()
  } catch {
    base.completionStatus = 'failed'
    base.failureStage = 'retrieve'
    await settleBackground(handle, args, base, now, t0)
    return base
  }

  // 检索期事实只在 retrieveContext 真的成功后才写入：未走到这里的记录（pdf-load / index /
  // retrieve 失败或被跳过）两个字段整体缺席，绝不冒充「用了 bm25」或「没用目录」。
  const first = retrieval.retrievals[0]
  base.retrievalMode = first?.hybrid?.retrievalMode
  base.outlineUsed = first?.hybrid?.outlineUsed
  // `available:true` 却给不出齐全的节点向量（畸形产物）时 `toOutlineScoringNodes` 返回 undefined：
  // 本篇整份目录作废、按 B 回落，与 qa.ts 同口径显式记 `outline-embed-failed`，绝不静默变成 '—'。
  const outlineVectorsIncomplete =
    passageInfo.outline?.available === true && outlineScoringNodes === undefined
  const outlineFallback = outlineVectorsIncomplete
    ? 'outline-embed-failed'
    : passageInfo.outline?.fallbackReason ?? first?.hybrid?.outlineFallbackReason
  if (outlineFallback !== undefined) base.outlineFallbackReason = outlineFallback

  const speedRecord = newSampleRecord(sample, question)
  try {
    await generateSpeedAnswer({
      context: retrieval.context,
      question: question.question,
      history: [],
      systemPrompt: args.systemPrompt,
      timeline,
      client: args.client,
      record: speedRecord,
      streamAnswer: args.streamAnswer,
      evidenceRequired: true,
    })
  } catch (error) {
    // 流异常由 adapter 附 partial；没有 partial 说明 complete() 的时间线不变量失败，整轮失效
    if (speedRecord.speed === undefined) throw error
    base.completionStatus = 'failed'
    base.failureStage = 'stream'
    await settleBackground(handle, args, base, now, t0)
    return base
  }
  const speed = speedRecord.speed
  if (speed === undefined) throw new Error('冷首问流式回答完成但缺少速度观测')
  assertCompletedSpeedRecord(speed, true)
  base.timeToFirstTokenMs = speed.timeToFirstTokenMs
  base.fullAnswerLatencyMs = speed.fullAnswerLatencyMs
  base.completionStatus = 'completed'

  // ask-at-lexical-ready：回答后 settle 后台就绪（向量/目录计时），保证下一篇冷启动互不污染
  await settleBackground(handle, args, base, now, t0)
  return base
}

async function settleBackground(
  handle: PassageIndexHandle,
  args: ColdFirstQueryArgs,
  base: ColdFirstQueryRecord,
  now: () => number,
  t0: number,
): Promise<void> {
  if (args.strategy !== 'ask-at-lexical-ready') return
  try {
    const info = await handle.ready
    if (info.index.passageVectors) base.denseReadyMs = Math.max(0, now() - t0)
    if (info.outline) base.outlineReadyMs = Math.max(0, now() - t0)
  } catch {
    // 后台就绪失败不改变回答结果：dense/outline 计时缺席即可
  }
}
