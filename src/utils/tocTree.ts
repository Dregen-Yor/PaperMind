import type { ContextGroup, ContextPiece } from './contextTrace'
import { assertJudgeOutput, type EvidenceJudge, type JudgeNode } from './evidenceJudge'

/**
 * 树节点。`pages` 是该节点内容实际落在的页号（升序），由构造器**量出**而非推导——
 * 因此不存在「空区间」「负区间」这两个概念，空就是空数组。
 *
 * 父子、兄弟之间的 `pages` 可以重叠：父节的引导正文与其子节常在同一页，
 * 同页兄弟也常见。重叠不是缺陷，`materializeContext` 的 `pageOrder` 按首次
 * 出现去重，不会污染检索指标。
 */
export interface TocNode {
  id: string
  title: string
  /** 从根到父节点的标题路径；根层为空数组 */
  path: string[]
  /** 根的子节点为 0 */
  depth: number
  /** 该节点占用的页号，升序。为空表示它不携带任何页内容（合成的导航节点或空节） */
  pages: number[]
  children: TocNode[]
}

/**
 * 把节点的页展开成带页码的片段。首片是首页原文，后续每页带 `\n\n` 前缀
 * ——与 `pages.slice(start, end + 1).join('\n\n')` 逐字一致，也与
 * `pageIndex.ts` 的 `nodeToContextGroup` 同一口径，因此物化器从上下文反推出的
 * pageOrder 在两条路径上语义相同，指标可横向比较。
 *
 * 页号越界直接抛错：静默产出 `undefined` 文本会在物化器的 `text.trim()` 上炸掉，
 * 错误离现场很远；而越界是构造器的编程错误，不是运行时数据问题。
 */
export function tocNodePageSpan(node: TocNode, pages: string[]): ContextPiece[] {
  return [...node.pages]
    .sort((a, b) => a - b)
    .map((page, index) => {
      if (!Number.isInteger(page) || page < 0 || page >= pages.length) {
        // 带上节点 id 与页号：这条错误会在批处理里滚过上百篇论文，
        // 只有 `toc-page-out-of-range` 时无法定位是哪个节点、哪一页越了界。
        throw new Error(`toc-page-out-of-range: ${node.id}#${page}`)
      }
      return { page, text: index === 0 ? pages[page] : `\n\n${pages[page]}` }
    })
}

/** 选中节点 → 上下文分组，每个节点一组。`pages` 为空的节点被跳过，不产生空组。 */
export function tocSelectionToContextGroups(selected: TocNode[], pages: string[]): ContextGroup[] {
  const groups: ContextGroup[] = []
  for (const node of selected) {
    const pieces = tocNodePageSpan(node, pages)
    if (pieces.length > 0) groups.push({ pieces })
  }
  return groups
}

export interface TraverseOptions {
  /** 层内相对阈值系数 α ∈ [0,1]。θ_层 = α × 层内最高分。 */
  alpha: number
  /** 每层最多下探的存活节点数 */
  topN: number
}

/** 逐层诊断。调用方据此统计阈值行为，指标不读它。 */
export interface LayerDiagnostic {
  depth: number
  candidates: number
  maxScore: number
  threshold: number
  /** 通过层内阈值的节点数（top-N 截断**之前**） */
  survivors: number
  /** 阈值存活后再截 top-N 留下的节点数；**含叶子**，不表示「下探过」 */
  kept: number
}

export interface TocSelection {
  /** 收为证据的节点，按首个页号升序 */
  selected: TocNode[]
  /**
   * 每个判定调用一条，按 DFS 先序排列——**不是**按深度索引。同一 `depth` 可能出现
   * 多条（多个存活分支各自下探一层），这些条目相邻与不相邻都常见：两层树上根层两个
   * 存活分支都只带叶子时，得到的就是相邻的 `[0, 1, 1]`。拿下标当层号会错，
   * 调用方要按 `depth` 自行聚合。
   */
  layers: LayerDiagnostic[]
  /** 因 pages 为空被排除出 selected 的节点数 */
  emptyContentSkipped: number
  /** 存活节点全无内容、于是回落到文档首个非空节点时置位 */
  emptySelectionFallback: boolean
}

/** 一次层内筛选的结果：留下的节点，以及阈值存活数（切片前）。 */
interface SurvivorResult {
  nodes: TocNode[]
  survivingCount: number
}

const toJudgeNode = (n: TocNode): JudgeNode => ({ id: n.id, title: n.title, path: n.path })

/**
 * 稳定排序取前 topN：同分保持原有文档顺序。
 *
 * 一并返回 `survivingCount`（过滤后、切片前的长度）：诊断里的 `survivors` 与
 * 这里留下的节点出自**同一次** `>= threshold` 判定。若让调用方另写一遍这个比较，
 * 日后比较式改了、或这里加了分数下限/去重，诊断就会悄悄报出一个不再描述该阶段的数字。
 */
function topNSurvivors(nodes: TocNode[], scores: number[], threshold: number, topN: number): SurvivorResult {
  const surviving = nodes
    .map((node, i) => ({ node, score: scores[i], order: i }))
    .filter(s => s.score >= threshold)
  const survivingCount = surviving.length
  if (survivingCount <= topN) return { nodes: surviving.map(s => s.node), survivingCount }
  return {
    nodes: surviving
      .sort((a, b) => (b.score - a.score) || (a.order - b.order))
      .slice(0, topN)
      .map(s => s.node),
    survivingCount,
  }
}

/**
 * 按文档顺序（先序）找第一个 `pages` 非空的节点。
 * 只要树里还有一个带内容的节点就必有结果——供空选择时兜底。
 *
 * 本模块内部使用（Task 4 的空选择回落），刻意不导出：调用方一律经
 * `traverseWithJudge` 走完整条链路，不需要单独拿到这个查找。
 */
function firstNodeWithContent(nodes: TocNode[]): TocNode | undefined {
  for (const node of nodes) {
    if (node.pages.length > 0) return node
    const found = firstNodeWithContent(node.children)
    if (found) return found
  }
  return undefined
}

/**
 * 逐层判定并收集证据。
 *
 * **阈值是层内相对的**（θ = α × 本层最高分），不是绝对值：实测本地决策模型的
 * 概率整体压在 0.03–0.39，任何固定绝对阈值都会把整层滤光。相对阈值同时对
 * 未校准的概率免疫——这正好对症该 checkpoint 的温度被 clamp 那条警告。
 *
 * 空内容过滤必须发生在**递归内部**，不能放到最后统一过滤：放到最后的话，
 * 下探会「看起来有收获」（返回一批马上要被丢掉的空节点）而父节点兜底永不触发，
 * 最终静默产出空上下文。
 */
export async function traverseWithJudge(
  tree: TocNode[],
  query: string,
  judge: EvidenceJudge,
  opts: TraverseOptions,
): Promise<TocSelection> {
  const layers: LayerDiagnostic[] = []
  let emptyContentSkipped = 0

  const descend = async (nodes: TocNode[], depth: number): Promise<TocNode[]> => {
    if (nodes.length === 0) return []
    // assertJudgeOutput 可能抛错。调用方按 spec §4 把「判定器输出非法」
    // 作为该篇回落的依据，不在这里吞掉。
    const scores = assertJudgeOutput(await judge.judge({ query, nodes: nodes.map(toJudgeNode) }), nodes.length)
    const maxScore = Math.max(...scores)
    const threshold = opts.alpha * maxScore
    const { nodes: survivors, survivingCount } = topNSurvivors(nodes, scores, threshold, opts.topN)
    layers.push({
      depth,
      candidates: nodes.length,
      maxScore,
      threshold,
      survivors: survivingCount,
      kept: survivors.length,
    })

    const collected: TocNode[] = []
    for (const node of survivors) {
      if (node.children.length === 0) {
        // `pages` 为空的节点不携带任何内容，收进来只会产出一个被物化器丢掉的空组
        if (node.pages.length === 0) emptyContentSkipped += 1
        else collected.push(node)
        continue
      }
      const fromChildren = await descend(node.children, depth + 1)
      if (fromChildren.length > 0) collected.push(...fromChildren)
      else if (node.pages.length === 0) emptyContentSkipped += 1
      else collected.push(node)   // 兜底：下探颗粒无收时用父节点正文
    }
    return collected
  }

  let selected = (await descend(tree, 0)).sort((a, b) => a.pages[0] - b.pages[0])
  let emptySelectionFallback = false
  if (selected.length === 0) {
    const first = firstNodeWithContent(tree)
    if (first) {
      selected = [first]
      emptySelectionFallback = true
    }
  }

  return { selected, layers, emptyContentSkipped, emptySelectionFallback }
}
