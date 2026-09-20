/**
 * 单轮树路由与原文取证（方案 §9）。
 *
 * 关键约束：整棵小树在**一次**检索判断里使用，不逐层调用 LLM。
 * 树检索因此与平面 scoreAndSelect 消耗同样数量的串行调用（§2 / §10.1）。
 *
 * 取证原则：节点描述只帮助路由，绝不进入最终上下文；上下文一律由被选中节点
 * 引用的 {@link EvidenceBlock}.rawText 重新读取拼成，来源使用原文页码（§4 / §9）。
 *
 * 降级原则（§9 / §9 阶段 D 第 4 步）：树取证失败必须能退回现有平面检索。
 * 做法是**不追加调用**——同一次判断里连平面叶节点一起打分，树给不出证据时
 * 就地改用平面打分；打分整体不可用时取第一个平面候选，与 scoreAndSelect 的
 * 降级动作一致。两条路径的查询阶段串行调用数因此始终相同。
 */
import {
  indexBlocksById,
  collectWithNeighbours,
  type EvidenceBlock,
} from './evidenceBlock'
import { parseAndValidateScores, nodeToContextGroup, type IndexNode, type NodeScore, type RetrievalResult } from './pageIndex'
import { CONTEXT_GROUP_SEPARATOR, type ContextGroup } from './contextTrace'
import { flattenSemanticTree, type SemanticNode, type SemanticTree } from './semanticTree'
import type { LLMFn } from './llm'

/**
 * 进入回答上下文的默认字符预算。与 bench 各配置的 `maxContextChars` 同值，
 * 保证产品与评测的「统一预算」是同一个数（§9）。
 */
export const DEFAULT_SEMANTIC_CONTEXT_CHARS = 24000

export interface SemanticRouteOptions {
  /** 最多选取几个候选（语义节点或平面叶节点），默认 2 */
  topK?: number
  /** 除最高分节点外，其余节点纳入所需的最低分，默认 4 */
  minScore?: number
  /** 是否纳入被引用证据块的相邻块以补齐上下文，默认 true */
  includeNeighbours?: boolean
  /**
   * 上下文预算（字符）。超出即按「节点直接引用的块优先、相邻块其次」停止纳入，
   * 块要么完整进入要么整块丢弃——绝不从中间截断原文。
   */
  maxContextChars?: number
  /**
   * 平面检索候选（`paper.tree` 的叶节点与逐页原文）。
   * 提供时与语义节点共用**同一次**打分调用（id 接在语义节点之后），
   * 树取证失败即可就地回落，不需要第二次调用。
   */
  flat?: { leaves: IndexNode[]; pages: string[] }
}

/** 树路由专属诊断（§11.4）。 */
export interface SemanticRouteDiagnostics {
  selectedNodeCount: number
  selectedNodeIds: string[]
  /** 选中节点直接引用的证据块（去重、按原文顺序） */
  evidenceBlockIds: string[]
  /** 实际进入上下文的块（含相邻扩展，且已按预算裁剪） */
  expandedBlockIds: string[]
  /** 选中节点未能提供任何有效证据（§9）；此时若给了平面候选就已就地回落 */
  insufficientEvidence: boolean
  /** 树中参与路由判断的节点总数 */
  routableNodeCount: number
  /** 本次取证是否来自平面回落而非语义树 */
  usedFlatFallback: boolean
  /** 因上下文预算被丢弃的证据块数 */
  droppedBlockCount: number
}

export interface SemanticRouteResult extends RetrievalResult {
  semantic: SemanticRouteDiagnostics
}

/**
 * 把整棵树渲染成检索判断的输入。节点描述在提示里被明确标注为**导航用途**，
 * 避免模型把描述当事实直接背诵（§9）。
 *
 * `flatLeaves` 提供时接在语义节点之后列出：它们是同一篇论文的平面章节候选，
 * 模型在同一次判断里一并打分，树给不出证据时才有就地回落的依据（§9）。
 */
export function buildSemanticRoutePrompt(
  tree: SemanticTree,
  query: string,
  flatLeaves: IndexNode[] = [],
  includeTree = true,
): string {
  const flat = flattenSemanticTree(tree)
  const treeLines = includeTree
    ? flat.map(({ node, depth }, index) => {
        const indent = '  '.repeat(depth)
        const relation = node.relationToParent ? `${node.relationToParent}: ` : ''
        return `${indent}[${index}] ${relation}${node.label} — ${node.description}`
      })
    : []
  const offset = treeLines.length
  const flatLines = flatLeaves.map((leaf, index) =>
    `[${offset + index}] Pages ${leaf.startPage + 1}–${leaf.endPage + 1}: ${leaf.title} — ${leaf.summary}`)
  const total = offset + flatLines.length

  const treeBlock = treeLines.length > 0
    ? `下面是一篇论文的语义导航树。节点标签与描述只用于判断相关性（导航/路由用途），**不是事实依据**；回答必须以原文证据块为准。

${treeLines.join('\n')}
`
    : ''
  const flatBlock = flatLines.length > 0
    ? `
下面是同一篇论文的常规章节候选（平面索引），作为备用取证位置：

${flatLines.join('\n')}
`
    : ''

  return `用户问题：${query}

${treeBlock}${flatBlock}
请判断哪些候选与该问题相关，为**每个**候选给出 0-10 分（共 ${total} 个），不要遗漏：
- 0 = 完全不相关；10 = 必须阅读该候选对应的原文才能回答。
- 多分支问题请**全部**标出相关候选。

只输出 JSON 数组，不要任何解释： [{"id":0,"score":8},{"id":1,"score":0},...]`
}

/** 与 pageIndex.formatSource 同格式，保证两种检索路径的来源串口径一致。 */
function formatSource(node: IndexNode): string {
  return `Pages ${node.startPage + 1}–${node.endPage + 1}: ${node.title}`
}

/**
 * 与 scoreAndSelect 相同的选点规则：最高分候选无条件纳入，其余需达到 minScore，
 * 至多 topK 个。
 */
function pickByScore<T>(candidates: T[], scores: NodeScore[], topK: number, minScore: number): T[] {
  if (candidates.length === 0 || scores.length === 0) return []
  const sorted = [...scores].sort((a, b) => b.score - a.score || a.id - b.id)
  const picked: T[] = [candidates[sorted[0].id]]
  for (const score of sorted.slice(1, topK)) {
    if (score.score >= minScore) picked.push(candidates[score.id])
  }
  return picked.filter((candidate): candidate is T => candidate !== undefined)
}

/**
 * 按「先纳入节点直接引用的块，再纳入相邻块」的顺序消耗预算，
 * 最后按原文顺序返回。块内文本绝不截断。
 */
function applyBudget(
  owned: EvidenceBlock[],
  neighbours: EvidenceBlock[],
  maxChars: number,
): { blocks: EvidenceBlock[]; dropped: number } {
  const ownedIds = new Set(owned.map(block => block.id))
  const priority = [...owned, ...neighbours.filter(block => !ownedIds.has(block.id))]
  const kept: EvidenceBlock[] = []
  let length = 0
  for (const block of priority) {
    const next = kept.length === 0 ? block.rawText.length : length + 7 + block.rawText.length
    if (next > maxChars) continue
    kept.push(block)
    length = next
  }
  return {
    blocks: kept.sort((a, b) => a.order - b.order),
    dropped: priority.length - kept.length,
  }
}

/**
 * 把连续的块合并成一个页区间。相隔很远的多个块必须拆成多个区间——
 * 用 min/max 合成一个跨度会把中间没进上下文的页也报成已选中，
 * 让 evidenceRecall / contextPrecision 与来源展示一起失真（§9）。
 */
function toPageSpans(
  blocks: EvidenceBlock[],
  owners: SemanticNode[],
): IndexNode[] {
  const runs: EvidenceBlock[][] = []
  for (const block of blocks) {
    const current = runs[runs.length - 1]
    const previous = current?.[current.length - 1]
    if (previous && block.startPage <= previous.endPage + 1) current.push(block)
    else runs.push([block])
  }
  return runs.map(run => {
    const first = run[0]
    const last = run[run.length - 1]
    const owner = owners.find(node => run.some(block => node.evidenceRefs.includes(block.id)))
    return {
      title: owner?.label ?? `证据块 ${first.id}–${last.id}`,
      nodeId: first.id,
      startPage: first.startPage,
      endPage: last.endPage,
      summary: owner?.description ?? '',
      nodes: [],
    }
  })
}

/**
 * 用整棵树做一次检索判断，并按节点引用回到原文取证。
 *
 * 降级语义（§9）：
 * - 树给不出有效证据 → 用**同一次**判断里拿到的平面打分就地回落（`usedFlatFallback`）。
 * - 打分整体不可用 → 取第一个平面候选，与 `scoreAndSelect` 的降级动作一致。
 * - 平面候选也没有时退回根节点证据（且此时已无候可选，不发请求）。
 * 任何情况都**不额外发起第二次 LLM 调用**——§10.1 要求查询阶段维持现有调用数量。
 */
export async function routeWithSemanticTree(
  tree: SemanticTree,
  blocks: EvidenceBlock[],
  query: string,
  llm: LLMFn,
  opts: SemanticRouteOptions = {},
): Promise<SemanticRouteResult> {
  const {
    topK = 2,
    minScore = 4,
    includeNeighbours = true,
    maxContextChars = DEFAULT_SEMANTIC_CONTEXT_CHARS,
  } = opts
  const flatLeaves = opts.flat?.leaves ?? []
  const pages = opts.flat?.pages ?? []
  const flat = flattenSemanticTree(tree)
  const blocksById = indexBlocksById(blocks)
  // 只有根节点的树没有可选分支，判断权整个交给平面候选
  const nodeCandidates = flat.length > 1 ? flat.map(entry => entry.node) : []
  const candidateCount = nodeCandidates.length + flatLeaves.length

  let nodeScores: NodeScore[] = []
  let flatScores: NodeScore[] = []
  let degraded = false
  let degradedReason: RetrievalResult['degradedReason']
  let pickedNodes: SemanticNode[] = []
  let pickedLeaves: IndexNode[] = []
  // 单候选时没有可判断的余地，与 scoreAndSelect 的单叶节点短路口径一致：不发请求
  const llmCalled = candidateCount > 1

  if (llmCalled) {
    try {
      const raw = parseAndValidateScores(
        await llm(buildSemanticRoutePrompt(tree, query, flatLeaves, nodeCandidates.length > 0)),
        candidateCount,
      )
      nodeScores = raw.filter(score => score.id < nodeCandidates.length)
      // 平面候选的 id 平移回叶节点下标，MRR 才能与平面路径同域比较
      flatScores = raw
        .filter(score => score.id >= nodeCandidates.length)
        .map(score => ({ id: score.id - nodeCandidates.length, score: score.score }))
      pickedNodes = pickByScore(nodeCandidates, nodeScores, topK, minScore)
    } catch (error) {
      degraded = true
      degradedReason = error instanceof Error
        && ['invalid-json', 'invalid-score-schema', 'incomplete-score-coverage'].includes(error.message)
        ? error.message as RetrievalResult['degradedReason']
        : 'score-request-failed'
      // 没有平面候选可退时只能取根节点证据（有平面候选则在下文回落平面，与 scoreAndSelect 同动作）
      if (flatLeaves.length === 0) pickedNodes = [tree.root]
    }
  } else if (flatLeaves.length === 1) {
    pickedLeaves = [flatLeaves[0]]
  } else if (flat.length === 1) {
    pickedNodes = [flat[0].node]
  }

  // ---- 树域取证 ----
  let selectedNodeIds: string[] = []
  let evidenceBlockIds: string[] = []
  let contextBlocks: EvidenceBlock[] = []
  let droppedBlockCount = 0
  let insufficientEvidence = false

  if (pickedNodes.length > 0) {
    const owned = [...new Set(pickedNodes.flatMap(node => node.evidenceRefs))]
      .filter(id => blocksById.has(id))
      .sort((a, b) => blocksById.get(a)!.order - blocksById.get(b)!.order)
    if (owned.length === 0) {
      insufficientEvidence = true
    } else {
      evidenceBlockIds = owned
      const ownedBlocks = owned.map(id => blocksById.get(id)!)
      const neighbours = includeNeighbours ? collectWithNeighbours(blocks, owned, 1) : ownedBlocks
      const budgeted = applyBudget(ownedBlocks, neighbours, maxContextChars)
      contextBlocks = budgeted.blocks
      droppedBlockCount = budgeted.dropped
      // 预算把整棵子树的证据都挤掉时同样算取证失败，交给平面回落
      if (contextBlocks.length === 0) insufficientEvidence = true
      else selectedNodeIds = pickedNodes.filter(node => node.evidenceRefs.length > 0).map(node => node.id)
    }
  } else {
    insufficientEvidence = true
  }

  // ---- 平面回落：§9 要求的退路，且不再追加调用（打分已在同一次判断里拿到）----
  let usedFlatFallback = false
  if (insufficientEvidence && flatLeaves.length > 0) {
    usedFlatFallback = true
    // 单候选短路没有跑打分，flatScores 必为空：此时 pickByScore 只会返回 []，
    // 会把唯一可用的平面叶节点丢掉、让回落形同虚设。与降级路径一致，直接用首个叶节点。
    pickedLeaves = degraded || flatScores.length === 0
      ? [flatLeaves[0]]
      : pickByScore(flatLeaves, flatScores, topK, minScore)
    // 树域打分会被下游按平面叶节点下标解释，绝不能写进 scores；
    // 没有回落时宁可不报 MRR，也不能报一个映射错位的
    evidenceBlockIds = []
    contextBlocks = []
  }

  let context: string
  let contextGroups: ContextGroup[]
  let sources: string[]
  let selected: IndexNode[]
  if (pickedLeaves.length > 0) {
    // 平面回落的上下文完全按平面路径的方式拼：两种路径的指标才可比
    context = pickedLeaves
      .map(leaf => pages.slice(leaf.startPage, leaf.endPage + 1).join('\n\n'))
      .join(CONTEXT_GROUP_SEPARATOR)
    // 逐页来源沿用平面路径的展开方式，回落样本与被比较的平面样本同口径
    contextGroups = pickedLeaves.map(leaf => nodeToContextGroup(leaf, pages))
    selected = pickedLeaves
    sources = selected.map(formatSource)
  } else if (contextBlocks.length > 0) {
    context = contextBlocks.map(block => block.rawText).join(CONTEXT_GROUP_SEPARATOR)
    // 一个证据块一组，组内直接复用块的逐页分区；只报真正进入上下文的块
    contextGroups = contextBlocks.map(block => ({ pieces: block.pieces }))
    selected = toPageSpans(contextBlocks, pickedNodes)
    sources = selected.map(formatSource)
  } else {
    context = ''
    contextGroups = []
    selected = []
    sources = []
  }

  return {
    context,
    contextGroups,
    sources,
    selected,
    // 只有平面域的打分能进 scores：树域 id 与下游的叶节点下标不是同一个坐标系
    scores: usedFlatFallback && !degraded ? flatScores : [],
    degraded: degraded || (insufficientEvidence && !usedFlatFallback),
    llmCalled,
    ...(degradedReason ? { degradedReason } : {}),
    semantic: {
      selectedNodeCount: selectedNodeIds.length,
      selectedNodeIds,
      evidenceBlockIds,
      expandedBlockIds: contextBlocks.map(block => block.id),
      insufficientEvidence,
      routableNodeCount: flat.length,
      usedFlatFallback,
      droppedBlockCount,
    },
  }
}
