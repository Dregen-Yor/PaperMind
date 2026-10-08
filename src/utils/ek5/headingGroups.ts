import type { ContextTrace, SourceRange } from './types'
import { hashCanonical, requireThat, uniqueIds } from './contract'
import { flattenTocTree, type TocTreeArtifact, type TocTreeNode } from './tocTree'

export interface ContextMetadata { contextStart: number; contextEnd: number; text: string }
export interface HeadingGroup {
  id: string
  nodeId: string
  path: string
  ranges: SourceRange[]
  text: string
  textSha256: string
}
export interface HeadingGroups {
  version: 'leaf-groups-v1'
  sourceSha256: string
  groups: HeadingGroup[]
  unlocatedNodeIds: string[]
  ambiguousNodeIds: string[]
  fallbackNodeIds: string[]
  excludedSourceCharacters: number
}

const normalize = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
const stripNumber = (s: string) => s.trim().replace(/^(?:\d+(?:\.\d+)*[.)]?|[IVXLCDM]+[-.][A-Z]\d*|[IVXLCDM]+[.)]?|[A-Z]\d*[.)])\s+/, '')

/** Locate real heading text, not a page-level approximation. Prefer complete lines. */
function locate(node: TocTreeNode, pages: string[], used: Set<string>, after?: { page: number; start: number }, before?: { page: number; start: number }) {
  const target = normalize(stripNumber(node.title))
  const candidates: Array<{ page: number; start: number; exact: boolean; numbered: boolean }> = []
  const numbered = (line: string) => stripNumber(node.title) !== node.title.trim() && normalize(line).startsWith(normalize(node.title))
  // The tree expands its first root to page zero; search that root's range for its actual heading.
  const last = node.id === 'n0' ? node.endPage : node.startPage
  for (let page = node.startPage; page <= last; page++) {
    const lines = [...pages[page].matchAll(/[^\n]+/g)]
    for (let i = 0; i < lines.length; i++) {
      for (let length = 1; length <= 4 && i + length <= lines.length; length++) {
        const line = lines.slice(i, i + length).map(m => m[0]).join(' ')
        if (normalize(stripNumber(line)) === target) candidates.push({ page, start: lines[i].index!, exact: true, numbered: numbered(line) })
      }
      // PDF layout can merge a heading and following text into one line. Require a word boundary.
      const line = stripNumber(lines[i][0])
      let normalized = ''
      for (const char of line) {
        normalized += normalize(char)
        if (normalized.length >= target.length) break
      }
      if (target.length >= 4 && normalized === target && normalize(line).startsWith(target)) {
        const words = line.match(/\S+/g) ?? []
        if (words.some((_, end) => normalize(words.slice(0, end + 1).join(' ')) === target)) {
          candidates.push({ page, start: lines[i].index!, exact: false, numbered: numbered(lines[i][0]) })
        }
      }
    }
  }
  return candidates.sort((a, b) => Number(b.numbered) - Number(a.numbered) || Number(b.exact) - Number(a.exact) || a.page - b.page || a.start - b.start)
    .find(c => !used.has(`${c.page}:${c.start}`)
      && (!after || c.page > after.page || (c.page === after.page && c.start > after.start))
      && (!before || c.page < before.page || (c.page === before.page && c.start < before.start)))
}

export function buildHeadingGroups(tree: TocTreeArtifact, pages: string[]): HeadingGroups {
  const nodes = flattenTocTree(tree)
  const paths = new Map<string, string>()
  const visit = (ns: TocTreeNode[], parents: string[]) => {
    for (const n of ns) {
      const path = [...parents, stripNumber(n.title)]
      paths.set(n.id, path.join(' > ')); visit(n.children, path)
    }
  }
  visit(tree.roots, [])
  const used = new Set<string>()
  const unlocatedNodeIds: string[] = []
  const fallbackNodeIds: string[] = []
  const ambiguousNodeIds: string[] = []
  let after: { page: number; start: number } | undefined
  const anchors = nodes.flatMap((node, nodeIndex) => {
    // Repeated leaf titles may not borrow a later parent's complete-line heading.
    const repeated = nodes.some(n => n.id !== node.id && normalize(stripNumber(n.title)) === normalize(stripNumber(node.title)))
    const nextBoundary = repeated && !node.children.length ? nodes.slice(nodeIndex + 1).find(n => normalize(stripNumber(n.title)) !== normalize(stripNumber(node.title))) : undefined
    const before = nextBoundary ? locate(nextBoundary, pages, used, after) : undefined
    const position = locate(node, pages, used, after, before)
    if (!position) { unlocatedNodeIds.push(node.id); return [] }
    after = position
    if (!position.exact) fallbackNodeIds.push(node.id)
    used.add(`${position.page}:${position.start}`)
    return [{ ...position, node, nodeIndex }]
  }).sort((a, b) => a.page - b.page || a.start - b.start)
  const groups: HeadingGroup[] = []
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i]
    if (a.node.children.length) continue
    // An unknown intervening boundary cannot safely be treated as part of this leaf.
    if ((anchors[i + 1]?.nodeIndex ?? nodes.length) > a.nodeIndex + 1) {
      ambiguousNodeIds.push(a.node.id)
      continue
    }
    const end = anchors[i + 1] ?? { page: pages.length - 1, start: pages.at(-1)!.length }
    const ranges: SourceRange[] = []
    for (let page = a.page; page <= end.page; page++) {
      const start = page === a.page ? a.start : 0
      const stop = page === end.page ? end.start : pages[page].length
      if (stop > start) ranges.push({ page, start, end: stop })
    }
    const text = ranges.map(r => pages[r.page].slice(r.start, r.end)).join('\n\n')
    if (!text.trim()) continue
    groups.push({ id: `G${String(groups.length + 1).padStart(4, '0')}`, nodeId: a.node.id, path: paths.get(a.node.id)!, ranges, text, textSha256: hashCanonical(text) })
  }
  requireThat(groups.length > 0, 'no locatable leaf heading groups')
  return {
    version: 'leaf-groups-v1', sourceSha256: hashCanonical(pages), groups, unlocatedNodeIds, ambiguousNodeIds, fallbackNodeIds,
    excludedSourceCharacters: pages.reduce((n, p) => n + p.length, 0) - groups.flatMap(g => g.ranges).reduce((n, r) => n + r.end - r.start, 0),
  }
}

/** Only string concatenation on the query path: no tokenizer, summary or clipping. */
export function materializeHeadingGroups(groups: HeadingGroup[], selectedNodeIds: string[]) {
  uniqueIds(selectedNodeIds)
  let text = ''
  const trace: ContextTrace[] = []
  const metadata: ContextMetadata[] = []
  const append = (raw: string, passageId: string, source: SourceRange | null, label = false) => {
    const contextStart = text.length
    text += raw
    trace.push({ passageId, contextStart, contextEnd: text.length, source })
    if (label) metadata.push({ contextStart, contextEnd: text.length, text: raw })
  }
  for (const nodeId of selectedNodeIds) {
    const g = groups.find(group => group.nodeId === nodeId)
    requireThat(g, 'unknown heading group')
    if (text) append('\n\n---\n\n', g.id, null)
    const first = g.ranges[0].page + 1; const last = g.ranges.at(-1)!.page + 1
    append(`[Evidence ${g.id} | Heading: ${g.path.replace(/[\r\n]/g, ' ')} | PDF pages: ${first}-${last}]\n`, g.id, null, true)
    let offset = 0
    for (const [index, range] of g.ranges.entries()) {
      if (index) { append('\n\n', g.id, null); offset += 2 }
      const length = range.end - range.start
      append(g.text.slice(offset, offset + length), g.id, range)
      offset += length
    }
    requireThat(offset === g.text.length, 'group text/ranges mismatch')
  }
  return { text, trace, metadata }
}
