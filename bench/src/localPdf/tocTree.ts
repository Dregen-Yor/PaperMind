import type { PdfOutlineEntry } from '../../../src/utils/pdfOutline'
import type { TocCandidate } from './tocCandidates'
import { hashCanonical, requireThat } from './contract'

export type TocTreeSource = 'native-outline' | 'toc-page' | 'heading'

export interface TocTreeInput {
  paperId: string
  pageCount: number
  outline: PdfOutlineEntry[]
  tocCandidates: TocCandidate[]
  headingCandidates: TocCandidate[]
}

export interface TocTreeNode {
  id: string
  title: string
  depth: number
  startPage: number
  endPage: number
  source: TocTreeSource
  children: TocTreeNode[]
}

export interface TocTreeArtifact {
  version: 'toc-tree-v1'
  paperId: string
  source: TocTreeSource
  inputSha256: string
  roots: TocTreeNode[]
}

const CONFIG = {
  version: 'toc-tree-v1',
  nativeMinimumNodes: 2,
  nativeMinimumDistinctPages: 2,
  minimumSelectableNodes: 2,
  samePageRangesOverlap: true,
  visualConflict: 'shallower',
} as const

export const TOC_TREE_CONFIG_SHA256 = hashCanonical(CONFIG)

interface DraftNode {
  title: string
  depth: number
  startPage: number
  children: DraftNode[]
}

function countOutline(entries: PdfOutlineEntry[]): { count: number; pages: Set<number> } {
  const pages = new Set<number>(); let count = 0
  const visit = (nodes: PdfOutlineEntry[]) => {
    for (const node of nodes) {
      count++
      if (node.page !== null) pages.add(node.page)
      visit(node.children)
    }
  }
  visit(entries)
  return { count, pages }
}

function nativeDraft(entries: PdfOutlineEntry[], depth = 0): DraftNode[] {
  return entries.map(entry => {
    requireThat(typeof entry.title === 'string' && entry.title.trim(), 'invalid native title')
    requireThat(Number.isInteger(entry.page), 'invalid native page')
    return { title: entry.title.trim(), depth, startPage: entry.page!, children: nativeDraft(entry.children, depth + 1) }
  })
}

function visualDepth(candidate: TocCandidate, fontSizes: number[], indents: number[]): number {
  const fontDepth = fontSizes.indexOf(candidate.fontSize)
  const indentDepth = indents.indexOf(candidate.indent)
  return Math.min(fontDepth < 0 ? 0 : fontDepth, indentDepth < 0 ? 0 : indentDepth)
}

function candidateDraft(candidates: TocCandidate[]): DraftNode[] {
  const fontSizes = [...new Set(candidates.map(item => item.fontSize))].sort((a, b) => b - a)
  const indents = [...new Set(candidates.map(item => item.indent))].sort((a, b) => a - b)
  const roots: DraftNode[] = []
  const stack: DraftNode[] = []
  for (const candidate of candidates) {
    let depth = candidate.numbering ? Math.max(0, candidate.numbering.length - 1) : visualDepth(candidate, fontSizes, indents)
    depth = Math.min(depth, stack.length)
    const node: DraftNode = { title: candidate.title.trim(), depth, startPage: candidate.page, children: [] }
    if (depth === 0) roots.push(node)
    else stack[depth - 1].children.push(node)
    stack.length = depth
    stack.push(node)
  }
  return roots
}

function materialize(roots: DraftNode[], source: TocTreeSource, pageCount: number): TocTreeNode[] {
  if (roots.length) roots[0].startPage = 0
  const flat: DraftNode[] = []
  const visit = (nodes: DraftNode[]) => { for (const node of nodes) { flat.push(node); visit(node.children) } }
  visit(roots)
  const ends = flat.map((node, index) => {
    const boundary = flat.slice(index + 1).find(next => next.depth <= node.depth)?.startPage ?? pageCount
    return Math.max(node.startPage, boundary - 1)
  })
  let cursor = 0
  const build = (nodes: DraftNode[], prefix = ''): TocTreeNode[] => nodes.map((node, index) => {
    const flatIndex = cursor++
    const id = prefix ? `${prefix}.${index}` : `n${index}`
    return {
      id,
      title: node.title,
      depth: node.depth,
      startPage: node.startPage,
      endPage: ends[flatIndex],
      source,
      children: build(node.children, id),
    }
  })
  return build(roots)
}

export function flattenTocTree(tree: TocTreeArtifact): TocTreeNode[] {
  const out: TocTreeNode[] = []
  const visit = (nodes: TocTreeNode[]) => { for (const node of nodes) { out.push(node); visit(node.children) } }
  visit(tree.roots)
  return out
}

function cleanTitle(title: string): string {
  return title.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim()
}

export function validateTocTree(value: unknown, pageCount: number): TocTreeArtifact {
  const tree = value as TocTreeArtifact
  requireThat(Number.isInteger(pageCount) && pageCount > 0, 'invalid page count')
  requireThat(tree?.version === 'toc-tree-v1' && typeof tree.paperId === 'string' && tree.paperId.length > 0, 'invalid tree identity')
  requireThat(['native-outline', 'toc-page', 'heading'].includes(tree.source), 'invalid tree source')
  requireThat(/^[a-f0-9]{64}$/.test(tree.inputSha256) && Array.isArray(tree.roots), 'invalid tree artifact')
  const ids = new Set<string>(); const titles = new Set<string>(); let previousStart = -1; let count = 0
  const visit = (nodes: TocTreeNode[], depth: number, parent?: TocTreeNode, prefix = '') => {
    requireThat(Array.isArray(nodes), 'invalid tree children')
    nodes.forEach((node, index) => {
      count++
      const expectedId = prefix ? `${prefix}.${index}` : `n${index}`
      requireThat(node && node.id === expectedId && !ids.has(node.id), 'invalid or duplicate node ID'); ids.add(node.id)
      requireThat(typeof node.title === 'string' && node.title.trim().length > 0, 'empty node title')
      requireThat(!/^(figure|fig\.|table|algorithm)\b/i.test(node.title), 'caption is not a tree node')
      const normalized = cleanTitle(node.title); requireThat(!titles.has(normalized), 'duplicate node title'); titles.add(normalized)
      requireThat(node.depth === depth && node.source === tree.source, 'invalid node hierarchy')
      requireThat(Number.isInteger(node.startPage) && Number.isInteger(node.endPage) && node.startPage >= 0 && node.startPage <= node.endPage && node.endPage < pageCount, 'invalid node range')
      requireThat(node.startPage >= previousStart, 'decreasing tree page order'); previousStart = node.startPage
      if (parent) requireThat(node.startPage >= parent.startPage && node.endPage <= parent.endPage, 'child outside parent')
      visit(node.children, depth + 1, node, node.id)
    })
  }
  visit(tree.roots, 0)
  requireThat(count >= CONFIG.minimumSelectableNodes, 'tree needs at least two selectable nodes')
  requireThat(tree.roots.length > 0 && tree.roots[0].startPage === 0 && tree.roots.at(-1)!.endPage === pageCount - 1, 'top-level tree does not cover document')
  return tree
}

function tryBuild(roots: DraftNode[], source: TocTreeSource, inputSha256: string, paperId: string, pageCount: number): TocTreeArtifact | undefined {
  try {
    return validateTocTree({ version: 'toc-tree-v1', paperId, source, inputSha256, roots: materialize(roots, source, pageCount) }, pageCount)
  } catch {
    return undefined
  }
}

export function buildTocTree(input: TocTreeInput): TocTreeArtifact {
  requireThat(typeof input.paperId === 'string' && input.paperId.length > 0, 'invalid paper ID')
  requireThat(Number.isInteger(input.pageCount) && input.pageCount > 0, 'invalid page count')
  const identityInput = {
    paperId: input.paperId,
    pageCount: input.pageCount,
    outline: input.outline,
    tocCandidates: input.tocCandidates,
    headingCandidates: input.headingCandidates,
  }
  const inputSha256 = hashCanonical(identityInput)
  const native = countOutline(input.outline)
  if (native.count >= CONFIG.nativeMinimumNodes && native.pages.size >= CONFIG.nativeMinimumDistinctPages) {
    const tree = tryBuild(nativeDraft(input.outline), 'native-outline', inputSha256, input.paperId, input.pageCount)
    if (tree) return tree
  }
  if (input.tocCandidates.length >= CONFIG.minimumSelectableNodes && input.tocCandidates.every(item => item.source === 'toc-page')) {
    const tree = tryBuild(candidateDraft(input.tocCandidates), 'toc-page', inputSha256, input.paperId, input.pageCount)
    if (tree) return tree
  }
  if (input.headingCandidates.length >= CONFIG.minimumSelectableNodes && input.headingCandidates.every(item => item.source === 'heading')) {
    const tree = tryBuild(candidateDraft(input.headingCandidates), 'heading', inputSha256, input.paperId, input.pageCount)
    if (tree) return tree
  }
  throw new Error('no-valid-toc-tree')
}
