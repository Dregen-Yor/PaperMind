/**
 * 分阶段构建管线（方案 §6.1）：① 段落（本地，<1 秒）→ ② 段落向量 → ③ 卡片 + 卡片向量。
 *
 * 「阶段① 完成即返回」是本模块的核心契约：调用方（`indexPaper`）拿到能用的索引之后，
 * 可以决定是 `await rest` 还是继续在后台跑。② 与 ③ 的 LLM 调用并行启动，
 * 卡片向量在两者都完成后计算。
 *
 * 代次保护不在这里：`persist` 回调由调用方提供，它负责「写盘前比对代次」。
 * 这样构建器不需要知道 store 的任何状态，单测可以只注入一个记账数组。
 */
import { cardEmbedText, type Embedder } from './embedder'
import { CONTEXT_GROUP_SEPARATOR } from './contextTrace'
import type { LLMFn } from './llm'
import {
  buildPassages, createEstimatingTokenCounter,
  type Passage, type PassageOptions, type TokenCounter,
} from './passages'
import {
  PASSAGE_INDEX_VERSION, planPassageIndexRebuild,
  type PassageIndex, type PassageIndexBuildPlan,
} from './passageIndex'
import { DEFAULT_MAX_INPUT_CHARS } from './semanticTree'
import {
  buildStructureCards, buildTitleCards, cardsToIndexNodes, StructureCardError,
  type StructureCard, type StructureFallbackReason,
} from './structureCards'

export type PassageStageEvent =
  | { stage: 'passages'; latencyMs: number; passageCount: number }
  | { stage: 'passage-vectors'; latencyMs: number }
  | { stage: 'structure'; latencyMs: number; cardCount: number; fallback?: StructureFallbackReason; cacheHit?: boolean }
  | { stage: 'card-vectors'; latencyMs: number }

export interface PassagePipelineDeps {
  /** 索引 profile 的卡片调用入口；恰好调用一次（复用时不调用） */
  llm: LLMFn
  countTokens?: TokenCounter
  embedder?: Embedder
  /**
   * 切段参数。产品不传（用 `DEFAULT_PASSAGE_OPTIONS`，且它的 `passageConfigHash`
   * 正是由那份默认值算出）；bench 必须传，否则消融实验改了
   * `minTokens`/`maxTokens` 只会换掉指纹、切段却仍按默认值走——指纹会声称一个
   * 索引并不具备的口径。
   */
  segmentation?: PassageOptions
  /** 逐阶段落盘；实现方负责代次校验，过期结果直接返回而不写盘 */
  persist: (index: PassageIndex, stage: 1 | 2 | 3) => Promise<void> | void
  passageConfigHash: string
  structureHash: string
  maxInputChars?: number
  now?: () => number
  /** 阶段耗时观测（bench 冷启动成本）；产品不传 */
  onStage?: (event: PassageStageEvent) => void
}

export interface PassagePipelineStart {
  /** 阶段① 的索引（返回时已产出并落盘） */
  index: PassageIndex
  /** 阶段②③ 的完成信号；调用方决定 await 还是后台继续 */
  rest: Promise<PassageIndex>
}

function buildInitialIndex(
  pages: string[],
  countTokens: TokenCounter,
  segmentation: PassageOptions,
  passageConfigHash: string,
  now: () => number,
  onStage?: (event: PassageStageEvent) => void,
): PassageIndex {
  const startedAt = now()
  const passages = buildPassages(pages, countTokens, segmentation)
  const cards = buildTitleCards(passages)
  const tree = cardsToIndexNodes(cards, passages)
  onStage?.({ stage: 'passages', latencyMs: Math.max(0, now() - startedAt), passageCount: passages.length })
  return {
    version: PASSAGE_INDEX_VERSION,
    stage: 1,
    passages,
    tree,
    passageConfigHash,
    separatorTokens: countTokens(CONTEXT_GROUP_SEPARATOR),
  }
}

/** 复用存量索引的阶段① 成果；不满足复用条件时返回 undefined。 */
function reuseStage1(existing: PassageIndex | undefined, plan: PassageIndexBuildPlan): { passages: Passage[]; tree: PassageIndex['tree']; separatorTokens: number } | undefined {
  if (!existing || plan.passages) return undefined
  return { passages: existing.passages, tree: existing.tree, separatorTokens: existing.separatorTokens }
}

/**
 * 无 embedder 时把存量段落向量的三元组（`passageVectors` / `vectorDim` / `embedderId`）原样带过去。
 *
 * 场景：模型还没下载完、或会话暂时拿不到 → `deps.embedder` 缺席。此时
 * `planPassageIndexRebuild` 看到的是 `stored.embedderId ('x') !== undefined`，据此判定
 * 「向量要重算」（`vectors: true`），而阶段② 在「没有 embedder」时第一行就返回、一条都没算：
 * 最终记录会丢掉已经付过费、且与段落逐条对应的向量，检索静默退化成 `bm25+card-lexical`
 * （`passageRetrieval` 的 `passagesUsable` 为假），要等下一次模型就绪才恢复。段落没重切时
 * （`plan.passages === false`，即 `reuseStage1` 原样搬的 `existing.passages`——最终记录的段落
 * 与向量所依据的段落是同一个数组）这些向量依然有效，不该扔。
 *
 * 三元组必须**一起**搬，不能只搬数组：少了 `embedderId` 记录就自相矛盾（有向量却说不出是谁
 * 算的），而且下次换一个 embedder 构建时 `planPassageIndexRebuild` 是拿 `undefined` 去比 id，
 * 判断纯属撞运气。任何一处不自洽都不搬——向量数 ≠ 段落数、某条向量长度不等于 `vectorDim`
 * （落盘格式不带每行长度，错位的向量只会在检索时静默算错）——降级到词法检索是可接受的代价。
 */
function carryStoredPassageVectors(
  existing: PassageIndex | undefined,
  plan: PassageIndexBuildPlan,
  embedder: Embedder | undefined,
): { passageVectors: Float32Array[]; vectorDim: number; embedderId: string } | undefined {
  // 有 embedder 时由阶段② 按 `plan.vectors` 决定复用还是重算（`canReusePassageVectors`），不走这里
  if (embedder || plan.passages || !existing) return undefined
  const { passageVectors, embedderId } = existing
  const vectorDim = existing.vectorDim ?? 0
  if (!passageVectors || vectorDim <= 0 || !embedderId) return undefined
  if (passageVectors.length !== existing.passages.length) return undefined
  if (passageVectors.some(vector => vector.length !== vectorDim)) return undefined
  return { passageVectors, vectorDim, embedderId }
}

export async function startPassagePipeline(
  pages: string[],
  deps: PassagePipelineDeps,
  opts: { existing?: PassageIndex; force?: boolean } = {},
): Promise<PassagePipelineStart> {
  const now = deps.now ?? Date.now
  const countTokens = deps.countTokens ?? createEstimatingTokenCounter()
  const embedder = deps.embedder
  // force 的语义是「重来一遍」：直接给出全量重建计划，与三个指纹各自的失效范围无关。
  // 同时丢弃存量索引，避免任何字段被误复用
  const plan: PassageIndexBuildPlan = opts.force
    ? { passages: true, vectors: true, structure: true }
    : planPassageIndexRebuild({
        ...(opts.existing ? { stored: opts.existing } : {}),
        passageConfigHash: deps.passageConfigHash,
        structureHash: deps.structureHash,
        ...(embedder ? { embedderId: embedder.id } : {}),
      })
  const existing = opts.force ? undefined : opts.existing

  const reused = reuseStage1(existing, plan)
  let index: PassageIndex
  if (reused) {
    // 只搬阶段① 的成果，其余字段一概不继承：向量与卡片由阶段②③ 按 plan 重新填
    index = {
      version: PASSAGE_INDEX_VERSION,
      stage: 1,
      passages: reused.passages,
      tree: reused.tree,
      separatorTokens: reused.separatorTokens,
      passageConfigHash: deps.passageConfigHash,
      structureHash: deps.structureHash,
    }
  } else {
    index = buildInitialIndex(pages, countTokens, deps.segmentation ?? {}, deps.passageConfigHash, now, deps.onStage)
  }

  // 阶段① 立即落盘：此后提问即可用 BM25，不等待任何模型
  await deps.persist(index, 1)

  const rest = runRemainingStages(
    { ...deps, countTokens },
    { existing, plan, stage1: index, now },
  )
  return { index, rest }
}

async function runRemainingStages(
  deps: PassagePipelineDeps,
  ctx: { existing?: PassageIndex; plan: PassageIndexBuildPlan; stage1: PassageIndex; now: () => number },
): Promise<PassageIndex> {
  const { plan, stage1, now } = ctx
  const embedder = deps.embedder
  // 无 embedder（模型没就绪）时存量向量在这里带回；`embedderId` 与它同源，三元组一起写才自洽
  // （见 `carryStoredPassageVectors`）。carried 非空 ⇒ embedder 为空 ⇒ 阶段② 第一行就返回，
  // 下面这两个初值不可能被它覆盖。
  const carried = carryStoredPassageVectors(ctx.existing, plan, embedder)
  const embedderId = embedder?.id ?? carried?.embedderId
  // 阶段② 与 ③ 各写一份自己的产物，最后由下面的 merge 合成，避免两条并行分支互相覆盖
  let passageVectors: Float32Array[] | undefined = carried?.passageVectors
  let vectorDim: number | undefined = carried?.vectorDim
  let cards: StructureCard[] | undefined
  let paper: { title: string; summary: string } | undefined
  let structureFallback: { reason: StructureFallbackReason } | undefined
  let cardVectors: Float32Array[] | undefined

  const canReusePassageVectors = !plan.vectors
    && ctx.existing?.passageVectors !== undefined
    && (ctx.existing.vectorDim ?? 0) > 0
    && ctx.existing.embedderId === embedder?.id

  // 阶段②：段落向量。与阶段③ 并行启动
  const stage2 = (async (): Promise<void> => {
    if (!embedder) return
    if (canReusePassageVectors && ctx.existing?.passageVectors) {
      passageVectors = ctx.existing.passageVectors
      vectorDim = ctx.existing.vectorDim
      return
    }
    const startedAt = now()
    try {
      const vectors = await embedder.embedPassages(stage1.passages.map(passage => passage.searchText))
      if (vectors.length !== stage1.passages.length) throw new Error('段落向量数量与段落数不一致')
      passageVectors = vectors
      vectorDim = vectors[0]?.length
      deps.onStage?.({ stage: 'passage-vectors', latencyMs: Math.max(0, now() - startedAt) })
      await deps.persist({ ...stage1, stage: 2, passageVectors, vectorDim, embedderId: embedder.id }, 2)
    } catch {
      // 向量模型不可用：停留阶段①，卡片仍然生成（检索退化为 bm25+card-lexical）。
      // 不 rethrow：没有向量是可用性降级，不是构建失败
      deps.onStage?.({ stage: 'passage-vectors', latencyMs: Math.max(0, now() - startedAt) })
    }
  })()

  // 阶段③：卡片（唯一一次 LLM 调用）
  const stage3 = (async (): Promise<void> => {
    if (!plan.structure && ctx.existing?.cards) {
      cards = ctx.existing.cards
      paper = ctx.existing.paper
      structureFallback = ctx.existing.structureFallback
      deps.onStage?.({ stage: 'structure', latencyMs: 0, cardCount: cards.length, cacheHit: true })
      return
    }
    const startedAt = now()
    try {
      const result = await buildStructureCards(stage1.passages, deps.llm, {
        maxInputChars: deps.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS,
        now,
      })
      cards = result.cards
      paper = result.paper
      deps.onStage?.({ stage: 'structure', latencyMs: result.meta.latencyMs, cardCount: result.cards.length })
    } catch (error) {
      if (!(error instanceof StructureCardError)) throw error
      // 失败即标题卡片回落，不重试不修补（方案 §2.4）
      cards = buildTitleCards(stage1.passages)
      structureFallback = { reason: error.reason }
      // 失败也要记成本：模型已返回、只是输出不可用时那次调用与 token 是真实成本；
      // 只有调用前就被拒（无段落 / input-too-large）才是零成本，此时 cost 为 undefined
      deps.onStage?.({
        stage: 'structure',
        latencyMs: error.cost?.latencyMs ?? Math.max(0, now() - startedAt),
        cardCount: cards.length,
        fallback: error.reason,
      })
    }
  })()

  await Promise.all([stage2, stage3])

  // 卡片向量：必须在 ②③ 都完成之后（方案 §6.1）——两个输入一个来自阶段②（维度），
  // 一个来自阶段③（卡片文本）。条件**刻意不看 `plan.vectors`**：`plan.vectors` 只描述
  // 「段落向量要不要重算」，而卡片一旦变化（哪怕只有 structureHash 变了、段落向量照旧），
  // 卡片向量就必须按新卡片重算，否则会挂上一份与卡片文本无对应关系的旧向量。
  if (embedder && passageVectors && cards && cards.length > 0 && (vectorDim ?? 0) > 0) {
    const startedAt = now()
    try {
      const vectors = await embedder.embedPassages(cards.map(card => cardEmbedText(card)))
      if (vectors.length === cards.length) {
        cardVectors = vectors
        deps.onStage?.({ stage: 'card-vectors', latencyMs: Math.max(0, now() - startedAt) })
      }
    } catch {
      deps.onStage?.({ stage: 'card-vectors', latencyMs: Math.max(0, now() - startedAt) })
    }
  }

  // stage 是「已完成的最高阶段」：卡片落盘即 3（哪怕向量因模型不可用而缺席，
  // 那种情况由检索时的 retrievalMode 报告，不靠 stage 表达）
  const stage: 1 | 2 | 3 = cards && cards.length > 0 ? 3 : passageVectors ? 2 : 1
  const final: PassageIndex = {
    version: PASSAGE_INDEX_VERSION,
    stage,
    passages: stage1.passages,
    tree: cards && cards.length > 0
      ? cardsToIndexNodes(cards, stage1.passages, {
          ...(paper ? { title: paper.title, summary: paper.summary } : {}),
        })
      : stage1.tree,
    passageConfigHash: deps.passageConfigHash,
    structureHash: deps.structureHash,
    separatorTokens: stage1.separatorTokens,
    ...(passageVectors ? { passageVectors } : {}),
    ...(vectorDim ? { vectorDim } : {}),
    ...(embedderId ? { embedderId } : {}),
    ...(cards ? { cards } : {}),
    ...(cardVectors ? { cardVectors } : {}),
    ...(paper ? { paper } : {}),
    ...(structureFallback ? { structureFallback } : {}),
  }
  await deps.persist(final, stage)
  return final
}
