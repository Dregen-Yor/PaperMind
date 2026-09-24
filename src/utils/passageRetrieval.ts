/**
 * 段落级混合检索（方案 §4）：三路加权 RRF 融合 → 4096 预算填充 + 同小节邻段扩展
 * → 原文顺序组装。查询阶段零 LLM 调用（`llmCalled: false`）。
 *
 * 关键口径：预算判定与 `materializeContext` 的计法一致——「已用 + 新组分隔符 +
 * 段落 token ≤ 预算」。**这个等式只在计数同源时成立**，成立时最终物化永不截断
 * （`contextTruncated === false`）。
 *
 * 同源不是自动的：填充读的是**建索引时**写下的 `Passage.tokenCount` 与
 * `PassageIndex.separatorTokens`，填充自己不分词；而 `materializeContext` 只认
 * **调用方传进去的那个分词器**。`PassageIndex` 上没有任何字段记录当时用的计数器
 * （`separatorTokens` 只是数目，不是计数器身份），所以拿估算器建的索引配冻结的
 * BGE-M3 分词器物化时，填充按估算数超额放段、物化真实截断——不报错，静默丢原文。
 * 调用方必须让三者同源：建索引的计数器 → 落盘的 `Passage.tokenCount` /
 * `separatorTokens` → 交给 `materializeContext` 的分词器（见 `PassageRetrievalOptions.countTokens`）。
 */
import { buildBm25Scorer } from './bm25'
import { cardEmbedText, cosineSimilarity, type Embedder } from './embedder'
import { CONTEXT_GROUP_SEPARATOR, type ContextGroup } from './contextTrace'
import type { IndexNode, RetrievalResult } from './pageIndex'
import type { Passage, TokenCounter } from './passages'
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

/**
 * 词法路名次：正分按分数排位；零分（没命中任何查询词）的段落**并列末位**，
 * 不按排序位置递增——否则同分按 id 排位会把「前部段落」系统性抬高。
 */
export function rankWithTiedZeros(items: RankedItem[]): RankedItem[] {
  const positive = items.filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.id - b.id)
  const tailRank = positive.length + 1
  return [
    ...positive.map((item, index) => ({ ...item, rank: index + 1 })),
    ...items.filter(item => !(item.score > 0)).map(item => ({ ...item, rank: tailRank })),
  ]
}

/**
 * 卡片先验路：先对**卡片**排名次，段落继承所属卡片的名次（方案 §4.2）。
 * 同一卡片下的段落共享名次；未被任何卡片覆盖的段落、以及无效分（非有限 / 词法零分）
 * 的卡片并列末位。
 */
export function inheritCardRanks(
  passages: Passage[],
  cardScores: number[],
  cardByPassage: Map<number, number>,
  zeroIsMiss: boolean,
): RankedItem[] {
  const valid = (score: number) => Number.isFinite(score) && (!zeroIsMiss || score > 0)
  const ranked = cardScores
    .map((score, cardIndex) => ({ score, cardIndex }))
    .filter(card => valid(card.score))
    .sort((a, b) => b.score - a.score || a.cardIndex - b.cardIndex)
  const rankByCard = new Map(ranked.map((card, index) => [card.cardIndex, index + 1]))
  const tailRank = ranked.length + 1
  return passages.map(passage => {
    const cardIndex = cardByPassage.get(passage.order)
    const rank = cardIndex === undefined ? undefined : rankByCard.get(cardIndex)
    return {
      id: passage.order,
      score: cardIndex === undefined ? 0 : cardScores[cardIndex],
      rank: rank ?? tailRank,
    }
  })
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

export interface HybridPassageDiagnostics {
  retrievalMode: RetrievalMode
  selectedPassageIds: string[]
  /** 入队值来自邻段扩展（「该段分 × neighbourFactor」压过了它自己的融合分）的段落 */
  neighbourSelectedIds: string[]
  candidateCount: number
  skippedCount: number
}

export type PassageRetrievalResult = RetrievalResult & { hybrid: HybridPassageDiagnostics }

export interface PassageRetrievalOptions {
  embedder?: Embedder
  /**
   * 段落 token 计数器。**填充阶段不读这个选项**：预算判定只用索引里建库时写下的
   * `Passage.tokenCount` 与 `PassageIndex.separatorTokens`，二者才是权威口径
   * （填充自己不做任何分词）。这个选项存在，是为了让调用方（bench 注入冻结的
   * BGE-M3 分词器）与建索引共用同一个计数器，并把同一个计数器交给
   * `materializeContext`；三者不同源时「物化永不截断」不成立（见文件头注释）。
   */
  countTokens?: TokenCounter
  maxTokens?: number
  rrfK?: number
  sectionWeight?: number
  neighbourFactor?: number
  skipLimit?: number
}

export const DEFAULT_HYBRID_OPTIONS: Required<Pick<PassageRetrievalOptions, 'maxTokens' | 'rrfK' | 'sectionWeight' | 'neighbourFactor' | 'skipLimit'>> = {
  maxTokens: 4096,
  rrfK: 60,
  sectionWeight: 0.5,
  neighbourFactor: 0.5,
  skipLimit: 20,
}

export interface FillPassageBudgetArgs {
  passages: Passage[]
  candidates: PassageCandidate[]
  /** 组间分隔符的 token 数；与 materializeContext 同口径 */
  separatorTokens: number
  maxTokens: number
  neighbourFactor: number
  skipLimit: number
}

export interface FillPassageBudgetResult {
  /** 按原文 order 升序 */
  selectedOrders: number[]
  neighbourOrders: number[]
  skippedCount: number
}

/**
 * 预算填充（方案 §4.4）。**「放得下」的判定必须与 materializeContext 同口径**：
 * 已用 + 新开一组的组间分隔符 + 本段 token ≤ 预算。这样物化时
 * `used + prefix >= maxTokens` 的截断守卫永远不会触发，`contextTruncated === false`。
 *
 * 连续跳过上限只约束「连续」：一旦有一段成功放入，计数归零——
 * 否则一段小段落就能把后续所有候选挡在门外。
 */
export function fillPassageBudget(args: FillPassageBudgetArgs): FillPassageBudgetResult {
  const { passages, candidates, separatorTokens, maxTokens, neighbourFactor, skipLimit } = args
  const totalTokens = passages.reduce((sum, passage) => sum + passage.tokenCount, 0)
  if (totalTokens <= maxTokens) {
    return { selectedOrders: passages.map(passage => passage.order), neighbourOrders: [], skippedCount: 0 }
  }

  const heap = createMaxHeap<{ score: number; order: number }>()
  const queued = new Map<number, number>()
  const offered = new Map<number, boolean>()
  const selected = new Set<number>()
  const neighbourSelected = new Set<number>()

  const offer = (order: number, score: number, fromNeighbour: boolean) => {
    if (order < 0 || order >= passages.length || selected.has(order)) return
    if ((queued.get(order) ?? Number.NEGATIVE_INFINITY) >= score) return
    queued.set(order, score)
    offered.set(order, fromNeighbour)
    heap.push({ score, order })
  }

  for (const candidate of candidates) offer(candidate.order, candidate.score, candidate.fromNeighbour)

  const runCount = (chosen: number[]): number => {
    const sorted = [...chosen].sort((a, b) => a - b)
    let runs = 0
    for (let i = 0; i < sorted.length; i++) if (i === 0 || sorted[i] !== sorted[i - 1] + 1) runs++
    return runs
  }
  const usedTokens = (chosen: number[]): number =>
    chosen.reduce((sum, order) => sum + passages[order].tokenCount, 0) + Math.max(0, runCount(chosen) - 1) * separatorTokens

  let consecutiveSkips = 0
  let skippedCount = 0
  while (heap.size > 0 && consecutiveSkips < skipLimit) {
    const entry = heap.pop() as { score: number; order: number }
    if (selected.has(entry.order)) continue
    // 惰性删除：堆里可能留着同一段落的旧（较低）分数
    if ((queued.get(entry.order) ?? Number.NEGATIVE_INFINITY) > entry.score) continue
    if (usedTokens([...selected, entry.order]) > maxTokens) {
      consecutiveSkips++
      skippedCount++
      continue
    }
    selected.add(entry.order)
    consecutiveSkips = 0
    if (offered.get(entry.order)) neighbourSelected.add(entry.order)
    // 邻段扩展：同一小节内的前后邻段以「本段分 × neighbourFactor」入队，取较大值
    const current = passages[entry.order]
    for (const neighbour of [passages[entry.order - 1], passages[entry.order + 1]]) {
      if (neighbour && neighbour.subsection === current.subsection) {
        offer(neighbour.order, entry.score * neighbourFactor, true)
      }
    }
  }

  return {
    selectedOrders: [...selected].sort((a, b) => a - b),
    neighbourOrders: [...neighbourSelected].sort((a, b) => a - b),
    skippedCount,
  }
}

/** 卡片标题查询表：段落 order → 卡片标题。卡片覆盖连续区间，线性扫一遍即可。 */
function cardTitlesByOrder(index: PassageIndex): Map<number, string> {
  const titles = new Map<number, string>()
  if (!index.cards) return titles
  const orderById = new Map(index.passages.map(passage => [passage.id, passage.order]))
  for (const card of index.cards) {
    const start = orderById.get(card.range[0])
    const end = orderById.get(card.range[1])
    if (start === undefined || end === undefined) continue
    for (let order = start; order <= end; order++) titles.set(order, card.title)
  }
  return titles
}

function emptyResult(mode: RetrievalMode): PassageRetrievalResult {
  return {
    context: '',
    contextGroups: [],
    sources: [],
    selected: [],
    scores: [],
    degraded: false,
    llmCalled: false,
    hybrid: { retrievalMode: mode, selectedPassageIds: [], neighbourSelectedIds: [], candidateCount: 0, skippedCount: 0 },
  }
}

/**
 * 段落级混合检索。降级顺序严格按方案 §4 的表：
 * `full` → `full-title-fallback` → `bm25+dense` → `bm25+card-lexical` → `bm25`。
 */
export async function retrievePassageContext(
  index: PassageIndex,
  query: string,
  opts: PassageRetrievalOptions = {},
): Promise<PassageRetrievalResult> {
  const maxTokens = opts.maxTokens ?? DEFAULT_HYBRID_OPTIONS.maxTokens
  const rrfK = opts.rrfK ?? DEFAULT_HYBRID_OPTIONS.rrfK
  const sectionWeight = opts.sectionWeight ?? DEFAULT_HYBRID_OPTIONS.sectionWeight
  const neighbourFactor = opts.neighbourFactor ?? DEFAULT_HYBRID_OPTIONS.neighbourFactor
  const skipLimit = opts.skipLimit ?? DEFAULT_HYBRID_OPTIONS.skipLimit
  // `opts.countTokens` 在这里**故意不读**（填充只用索引里落盘的计数），别再引入一个本地计数器
  const passages = index.passages
  if (passages.length === 0) return emptyResult('bm25')

  const cards = index.cards
  const cardByPassage = cards ? mapCardsToPassageIndexes(index) : undefined

  // 查询向量是唯一需要 await 的一步。模型不可用**不发异常给调用方**：
  // 这一次提问按可用信号降级即可，下一次模型就绪后自然恢复（方案 §8）
  //
  // 判定里带上数组长度与维度：`cosineSimilarity` 对维度不符会抛错，而 dense 路是在
  // 上面的 try/catch **之后**才执行的——手搓或损坏的索引若在这里抛出去，调用方看到的
  // 是异常，而不是契约承诺的「降级到词法模式」。产品路径由 `parsePassageIndex` 拦住
  // 这两种不自洽，但本模块的入参类型不保证它来过。
  //
  // 还要查**来源**（R31）：记录写了 `embedderId` 就必须与本次的模型一致。只查维度与
  // 数组长度挡不住同维模型互换——两边向量各自成型、点积有值，排名看似合理实为乱序。
  // 来源不一致时连 `embedQuery` 都不该发出（省下这次模型调用，直接按词法降级）；
  // 记录没写 `embedderId`（阶段① 记录、手搓 fixture）时保持原判据不变。
  const vectorDim = index.vectorDim ?? 0
  const embedderMatches = index.embedderId === undefined || opts.embedder?.id === index.embedderId
  const passagesUsable = embedderMatches
    && index.passageVectors !== undefined
    && vectorDim > 0
    && index.passageVectors.length === passages.length
  let queryVector: Float32Array | undefined
  if (opts.embedder && passagesUsable) {
    try {
      queryVector = await opts.embedder.embedQuery(query)
    } catch {
      queryVector = undefined
    }
  }
  const denseAvailable = queryVector !== undefined && passagesUsable && queryVector.length === vectorDim

  const bm25 = buildBm25Scorer(passages.map(passage => passage.searchText))

  let dense: ((query: string) => RankedItem[]) | undefined
  let card: ((query: string) => RankedItem[]) | undefined
  let mode: RetrievalMode

  if (denseAvailable) {
    const vector = queryVector as Float32Array
    const passageVectors = index.passageVectors as Float32Array[]
    dense = () => passages.map(passage => ({
      id: passage.order,
      score: cosineSimilarity(vector, passageVectors[passage.order]),
    }))
    let cardScores: number[] | undefined
    if (cards && index.cardVectors) {
      const cardVectors = index.cardVectors
      cardScores = cards.map((_, cardIndex) => vector.length === cardVectors[cardIndex].length
        ? cosineSimilarity(vector, cardVectors[cardIndex])
        : Number.NEGATIVE_INFINITY)
    }
    if (cardScores && cardByPassage) {
      const scores = cardScores
      card = () => inheritCardRanks(passages, scores, cardByPassage, false)
      mode = index.structureFallback ? 'full-title-fallback' : 'full'
    } else {
      mode = 'bm25+dense'
    }
  } else if (cards && cards.length > 0) {
    // 向量不可用但卡片已生成：卡片先验退化为卡片文本的词法匹配（方案 §4 的表）
    const scoreCards = buildBm25Scorer(cards.map(card => cardEmbedText(card)))
    card = text => {
      const scores = scoreCards(text)
      return inheritCardRanks(passages, cards.map((_, cardIndex) => scores[cardIndex]?.score ?? 0), cardByPassage!, true)
    }
    mode = 'bm25+card-lexical'
  } else {
    mode = 'bm25'
  }

  const candidates = fusePassageCandidates({
    passages,
    query,
    bm25: text => rankWithTiedZeros(bm25(text)),
    ...(dense ? { dense } : {}),
    ...(card ? { card } : {}),
    rrfK,
    sectionWeight,
    passagesCannotUseVectors: !denseAvailable,
  })

  const fill = fillPassageBudget({
    passages,
    candidates,
    separatorTokens: index.separatorTokens,
    maxTokens,
    neighbourFactor,
    skipLimit,
  })

  return assembleResult(index, fill, candidates, mode)
}

/** 选中段落 → 原文顺序组装。组与组的页序即 materializeContext 的输入。 */
function assembleResult(
  index: PassageIndex,
  fill: FillPassageBudgetResult,
  candidates: PassageCandidate[],
  mode: RetrievalMode,
): PassageRetrievalResult {
  const passages = index.passages
  if (fill.selectedOrders.length === 0) {
    return {
      ...emptyResult(mode),
      hybrid: {
        retrievalMode: mode,
        selectedPassageIds: [],
        neighbourSelectedIds: [],
        candidateCount: candidates.length,
        skippedCount: fill.skippedCount,
      },
    }
  }

  // 原文连续的段落合为一个 ContextGroup；pieces 直接拼接，页号天然正确
  const runs: Passage[][] = []
  for (const order of fill.selectedOrders) {
    const last = runs.at(-1)
    if (last && last[last.length - 1].order + 1 === order) last.push(passages[order])
    else runs.push([passages[order]])
  }
  const contextGroups: ContextGroup[] = runs.map(run => ({ pieces: run.flatMap(passage => passage.pieces) }))
  const context = runs.map(run => run.map(passage => passage.text).join('')).join(CONTEXT_GROUP_SEPARATOR)

  // selected：按真实连续页区间拆分。相邻但不连续（中间缺页）必须分成两段，
  // 否则 sources 会声称读了一页其实没读的原文
  const titles = cardTitlesByOrder(index)
  interface Span { startPage: number; endPage: number; startOrder: number }
  const spans: Span[] = []
  for (const order of fill.selectedOrders) {
    const passage = passages[order]
    const startPage = passage.pieces[0].page
    const endPage = passage.pieces[passage.pieces.length - 1].page
    const last = spans.at(-1)
    if (last && startPage <= last.endPage + 1) last.endPage = Math.max(last.endPage, endPage)
    else spans.push({ startPage, endPage, startOrder: order })
  }

  const selectedNodes: IndexNode[] = spans.map(span => ({
    title: titles.get(span.startOrder) ?? `段落 ${passages[span.startOrder].id}`,
    nodeId: `R${span.startOrder}`,
    startPage: span.startPage,
    endPage: span.endPage,
    summary: '',
    nodes: [],
  }))

  return {
    context,
    contextGroups,
    sources: selectedNodes.map(node => `Pages ${node.startPage + 1}–${node.endPage + 1}: ${node.title}`),
    selected: selectedNodes,
    // 段落路径复用该字段装融合名次（`IndexNode` 打分的替代品），不是 LLM 返回的打分
    scores: candidates.map(candidate => ({ id: candidate.order, score: candidate.score })),
    degraded: false,
    llmCalled: false,
    hybrid: {
      retrievalMode: mode,
      selectedPassageIds: fill.selectedOrders.map(order => passages[order].id),
      neighbourSelectedIds: fill.neighbourOrders.map(order => passages[order].id),
      candidateCount: candidates.length,
      skippedCount: fill.skippedCount,
    },
  }
}

/** 段落 order → 卡片下标（查询卡片向量时用） */
function mapCardsToPassageIndexes(index: PassageIndex): Map<number, number> {
  const map = new Map<number, number>()
  if (!index.cards) return map
  const orderById = new Map(index.passages.map(passage => [passage.id, passage.order]))
  index.cards.forEach((card, cardIndex) => {
    const start = orderById.get(card.range[0])
    const end = orderById.get(card.range[1])
    if (start === undefined || end === undefined) return
    for (let order = start; order <= end; order++) map.set(order, cardIndex)
  })
  return map
}
