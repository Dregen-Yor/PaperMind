import type { ContextGroup, ContextPiece } from './contextTrace'

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
        throw new Error('toc-page-out-of-range')
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
