/**
 * QASPER 节结构 → TocNode 树。
 *
 * 这是 bench 专属物：它读的是 QASPER 的 `section_name`（` ::: ` 分隔层级）与
 * 伪页布局。产品若将来要从 PDF 目录建树，会配一个兄弟模块，`src/utils/tocTree.ts`
 * 一行不改。
 */
import type { TocNode } from '../../../src/utils/tocTree'

/** 节层级上限。QASPER 实测最深 3 层，留一倍余量。 */
export const MAX_TOC_DEPTH = 6

/** 父路径与层名的连接符。用 NUL 避免与节名里的任何字符冲突。 */
const KEY_SEP = '\u0000'
const PATH_SEP = ' ::: '

export interface QasperSectionInput {
  sectionNames: string[]
  sectionPages: number[][]
}

export type SectionValidation =
  | { ok: true }
  | { ok: false; reason: 'too-deep' | 'cyclic-path' | 'non-adjacent-repeat' }

export interface QasperTreeResult {
  tree: TocNode[]
  /** 只作导航、自身无内容的父节点数 */
  synthesizedParents: number
  /** 因标题为空被丢弃的节数 */
  droppedSections: number
}

/** 把节名切成层级路径；全空的层名被剔除，因此空标题返回空数组。 */
function pathOf(sectionName: string): string[] {
  return sectionName
    .split(PATH_SEP)
    .map(part => part.trim())
    .filter(part => part.length > 0)
}

/**
 * 同一路径多次出现时，各次的页区间必须首尾相接（并集连续）。
 *
 * 为什么必须校验：`tocNodePageSpan` 用与「相邻两页」**完全相同**的 `\n\n` 拼接
 * 片段，因此 `pages: [1, 5]` 渲染出的文本与 `[1, 2]` 形状毫无区别——中间
 * 2–4 页被无声吞掉，读上下文的人和答题模型都看不出断层。指标（`pageOrder`
 * 取自 `piece.page`）仍然诚实，所以这不会表现为数字异常，只会表现为**召回
 * 静默损失**。这类「指标正常、内容悄悄少一段」正是本设计要避免的失效形态。
 *
 * 这是本模块**唯一**可能造出空隙的地方：打包循环只顺序追加，单节区间恒连续
 * （每次 append 至多封一页，页号每次至多 +1）。
 */
function mergedRunsAreContiguous(input: QasperSectionInput): boolean {
  const byPath = new Map<string, number[]>()
  for (let i = 0; i < input.sectionNames.length; i++) {
    const parts = pathOf(input.sectionNames[i])
    if (parts.length === 0) continue
    const key = parts.join(KEY_SEP)
    byPath.set(key, [...(byPath.get(key) ?? []), ...(input.sectionPages[i] ?? [])])
  }
  for (const pages of byPath.values()) {
    const sorted = [...new Set(pages)].sort((a, b) => a - b)
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] !== sorted[i - 1] + 1) return false
    }
  }
  return true
}

/**
 * 节结构合法性校验。**整棵作废，不修补**——沿用 `validateSemanticTree` 的口径：
 * 猜一个修复方案比直接回落更容易产出看不出错的坏结果。
 *
 * 空标题刻意**不算**非法：它是可丢弃的局部噪声（跳过该节即可），不该让整篇回落。
 */
export function validateSections(input: QasperSectionInput): SectionValidation {
  for (const name of input.sectionNames) {
    const parts = pathOf(name)
    if (parts.length > MAX_TOC_DEPTH) return { ok: false, reason: 'too-deep' }
    // `A ::: A` 会造出 A → A 的自嵌套
    if (new Set(parts).size !== parts.length) return { ok: false, reason: 'cyclic-path' }
  }
  if (!mergedRunsAreContiguous(input)) return { ok: false, reason: 'non-adjacent-repeat' }
  return { ok: true }
}

/**
 * 建树。按节的**首次出现顺序**决定节点顺序，与原文一致。
 *
 * 父节点通常自带独立条目（实测 `Approach` 与 `Approach ::: Masked LM` 并存），
 * 但不保证每篇都如此；缺条目时合成一个 `pages` 为空的导航节点，
 * 它只承担下探职责，不会被收为证据（见 `traverseWithJudge` 的空内容过滤）。
 *
 * **先校验再建树**：校验放在函数内部而非交给调用方，是为了让「产出带断层的树」
 * 在类型上没有出口——调用方忘了校验就会静默拿到坏树，这正是要防的。
 */
export function buildQasperTree(input: QasperSectionInput): QasperTreeResult {
  const validation = validateSections(input)
  if (!validation.ok) throw new Error(`invalid-section-structure: ${validation.reason}`)

  const byPath = new Map<string, TocNode>()
  const roots: TocNode[] = []
  let droppedSections = 0
  let counter = 0

  for (let i = 0; i < input.sectionNames.length; i++) {
    const parts = pathOf(input.sectionNames[i])
    if (parts.length === 0) {
      droppedSections += 1
      continue
    }
    const pages = input.sectionPages[i] ?? []

    for (let depth = 0; depth < parts.length; depth++) {
      const path = parts.slice(0, depth)
      const key = [...path, parts[depth]].join(KEY_SEP)
      const existing = byPath.get(key)
      const isLeafOfThisSection = depth === parts.length - 1

      if (existing) {
        // 同一路径重复出现（如父节点条目排在子节点之后）：合并页，不新建节点
        if (isLeafOfThisSection) {
          existing.pages = [...new Set([...existing.pages, ...pages])].sort((a, b) => a - b)
        }
        continue
      }

      const node: TocNode = {
        id: `S${String(counter++).padStart(3, '0')}`,
        title: parts[depth],
        path,
        depth,
        pages: isLeafOfThisSection ? [...pages].sort((a, b) => a - b) : [],
        children: [],
      }
      byPath.set(key, node)
      if (depth === 0) roots.push(node)
      else byPath.get(path.join(KEY_SEP))!.children.push(node)
    }
  }

  let synthesizedParents = 0
  const countEmptyParents = (nodes: TocNode[]): void => {
    for (const node of nodes) {
      if (node.children.length > 0 && node.pages.length === 0) synthesizedParents += 1
      countEmptyParents(node.children)
    }
  }
  countEmptyParents(roots)

  return { tree: roots, synthesizedParents, droppedSections }
}
