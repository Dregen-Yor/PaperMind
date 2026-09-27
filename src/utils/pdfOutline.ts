/**
 * Pure resolution of a PDF.js outline tree into a page-anchored structure.
 *
 * Deliberately free of any `pdfjs-dist` import: destination resolution arrives as
 * an injected callback, so this module can be unit tested without a PDF fixture
 * (and imported in the renderer without pulling in PDF.js at module scope).
 */
import type { Passage } from './passages'

export interface PdfOutlineEntry {
  /** DFS index path, e.g. root `"0"`, its second child `"0.1"`, that child's first child `"0.1.0"`. */
  id: string
  title: string
  /** 0-based page index. Always resolved on success; `null` is reserved by the public shape. */
  page: number | null
  children: PdfOutlineEntry[]
}

export type PdfOutlineFailureReason =
  | 'missing-outline'
  | 'invalid-title'
  | 'external-destination'
  | 'unresolved-destination'
  | 'page-out-of-range'
  | 'invalid-order'

export type PdfOutlineResult =
  | { ok: true; roots: PdfOutlineEntry[]; entryCount: number }
  | { ok: false; reason: PdfOutlineFailureReason; entryCount: number }

/** The subset of a `getOutline()` node this resolver reads. */
export interface PdfJsOutlineEntry {
  title?: unknown
  dest?: unknown
  url?: unknown
  items?: unknown
}

/** Resolves a raw PDF.js destination (named string or explicit array) to a 0-based page index. */
export type PdfDestResolver = (dest: string | unknown[]) => Promise<number>

/** Internal control-flow error carrying the rejection reason. */
class OutlineRejection extends Error {
  constructor(readonly reason: PdfOutlineFailureReason) {
    super(reason)
    this.name = 'OutlineRejection'
  }
}

function isExternal(node: PdfJsOutlineEntry): boolean {
  return Boolean(node.url)
}

/**
 * Resolve a raw PDF.js outline into a `PdfOutlineEntry` tree.
 *
 * Rejects the *whole* outline on any invalid internal entry — the caller never gets a
 * silently pruned tree. External (URL) entries and their subtrees are omitted and are
 * not counted as internal entries; they are not an error. `entryCount` is always the
 * number of internal entries encountered before (and including) a rejection.
 *
 * Note: `'external-destination'` is part of the failure union for API completeness but
 * is never produced — external entries are skipped, not rejected.
 */
export async function resolvePdfOutline(
  raw: PdfJsOutlineEntry[] | null | undefined,
  resolvePage: PdfDestResolver,
  pageCount: number,
): Promise<PdfOutlineResult> {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, reason: 'missing-outline', entryCount: 0 }
  }
  const state = { entryCount: 0 }
  try {
    const roots = await resolveSiblings(raw, undefined, '', resolvePage, pageCount, state)
    return { ok: true, roots, entryCount: state.entryCount }
  } catch (error) {
    const reason = error instanceof OutlineRejection ? error.reason : 'unresolved-destination'
    return { ok: false, reason, entryCount: state.entryCount }
  }
}

async function resolveSiblings(
  siblings: unknown[],
  parentPage: number | undefined,
  idPrefix: string,
  resolvePage: PdfDestResolver,
  pageCount: number,
  state: { entryCount: number },
): Promise<PdfOutlineEntry[]> {
  const kept: PdfOutlineEntry[] = []
  let previousPage: number | undefined
  for (const item of siblings) {
    const node: PdfJsOutlineEntry = item && typeof item === 'object' ? (item as PdfJsOutlineEntry) : {}
    // External links carry no usable internal destination — skip the entry and its subtree.
    if (isExternal(node)) continue

    state.entryCount += 1

    const title = typeof node.title === 'string' ? node.title.trim() : ''
    if (title.length === 0) throw new OutlineRejection('invalid-title')

    const dest = node.dest
    if (typeof dest !== 'string' && !Array.isArray(dest)) throw new OutlineRejection('unresolved-destination')

    let page: number
    try {
      page = await resolvePage(dest)
    } catch {
      throw new OutlineRejection('unresolved-destination')
    }
    if (!Number.isInteger(page) || page < 0 || page >= pageCount) throw new OutlineRejection('page-out-of-range')

    if (parentPage !== undefined && page < parentPage) throw new OutlineRejection('invalid-order')
    if (previousPage !== undefined && page < previousPage) throw new OutlineRejection('invalid-order')
    previousPage = page

    // Position among the *kept* siblings, so a skipped external entry never leaves a gap.
    const id = idPrefix === '' ? String(kept.length) : `${idPrefix}.${kept.length}`
    const children = await resolveSiblings(
      Array.isArray(node.items) ? node.items : [],
      page,
      id,
      resolvePage,
      pageCount,
      state,
    )
    kept.push({ id, title, page, children })
  }
  return kept
}

/**
 * A validated outline entry carrying a conservative page range and its passage membership.
 *
 * `startPage` / `endPage` are 0-based inclusive. The range is a *candidate* section span, not an
 * exact one: a PDF outline records only start pages, so an end is approximated by the start page
 * of the next later non-descendant entry — which is why same-page siblings and parent/child ranges
 * legitimately overlap rather than partition the document.
 *
 * `path` and `depth` follow `TocNode`'s convention (`src/utils/tocTree.ts`): `path` is the ancestor
 * titles only (the node's own title excluded, `[]` at the top level) and `depth` is the ancestor
 * count, so `path.length === depth` always holds. Task 5 composes embedding text as `[...path, title]`.
 */
export interface PdfOutlineNode {
  id: string
  title: string
  /** Ancestor titles from the root down to the parent; empty at the top level. */
  path: string[]
  /** Number of ancestors; 0 for top-level entries. Equal to `path.length`. */
  depth: number
  startPage: number
  endPage: number
  /** `order` of every passage whose page span overlaps this node's range, ascending. */
  passageOrders: number[]
  children: PdfOutlineNode[]
}

/** Why the whole outline index was rejected — never a partial result. */
export type PdfOutlineIndexFailure =
  | 'invalid-page-count'
  | 'null-page'
  | 'invalid-range'
  | 'page-out-of-range'

/**
 * An unrecoverable outline-index failure. Mirrors {@link SemanticTreeBuildError}: the caller must
 * fall back to the outline-free retrieval arm rather than guess a fix or clamp a broken range.
 */
export class PdfOutlineIndexError extends Error {
  constructor(readonly reason: PdfOutlineIndexFailure, message: string) {
    super(message)
    this.name = 'PdfOutlineIndexError'
  }
}

/** Preorder flattening of a node tree — the order every association map and `passageOrders` follows. */
function flattenOutlineNodes(roots: PdfOutlineNode[]): PdfOutlineNode[] {
  const out: PdfOutlineNode[] = []
  const walk = (nodes: PdfOutlineNode[]) => {
    for (const node of nodes) {
      out.push(node)
      walk(node.children)
    }
  }
  walk(roots)
  return out
}

/**
 * Build the node tree with validated page ranges.
 *
 * An entry's range ends on the start page of the next later **non-descendant** entry, inclusive;
 * the last entry reaches `pageCount - 1`. In preorder an entry's descendants occupy the contiguous
 * block `[i, i + subtreeSize)`, so that boundary is simply `flat[i + subtreeSize]`. Nothing is
 * clamped: a null page, an inverted range (reachable when a parent's sibling starts before the
 * parent's own child, see `PdfOutlineIndexError` tests), or a range past the document rejects the
 * entire index.
 */
function buildOutlineNodes(roots: PdfOutlineEntry[], pageCount: number): PdfOutlineNode[] {
  if (!Number.isInteger(pageCount) || pageCount <= 0) {
    throw new PdfOutlineIndexError('invalid-page-count', `pageCount 必须是正整数，收到 ${String(pageCount)}`)
  }
  if (roots.length === 0) return []

  // Pass 1: preorder flattening, plus null-page validation (Task 1 resolves every page on success;
  // this is defensive) and an entry→index map for the subtree-size pass.
  const flat: PdfOutlineEntry[] = []
  const position = new Map<PdfOutlineEntry, number>()
  const visit = (entries: PdfOutlineEntry[]): void => {
    for (const item of entries) {
      if (item.page === null) {
        throw new PdfOutlineIndexError('null-page', `目录条目 ${item.id}「${item.title}」没有解析到页码`)
      }
      position.set(item, flat.length)
      flat.push(item)
      visit(item.children)
    }
  }
  visit(roots)

  // Subtree sizes, computed back-to-front so a node's children are always already sized.
  const size = new Array<number>(flat.length).fill(1)
  for (let i = flat.length - 1; i >= 0; i--) {
    let total = 1
    for (const child of flat[i].children) total += size[position.get(child)!]
    size[i] = total
  }

  // Pass 2: materialize fresh nodes (never the inputs) with ranges and ancestor paths.
  let cursor = 0
  const build = (entries: PdfOutlineEntry[], path: string[], depth: number): PdfOutlineNode[] =>
    entries.map(item => {
      const index = cursor++
      const startPage = item.page as number
      const boundaryIndex = index + size[index]
      const endPage = boundaryIndex < flat.length ? (flat[boundaryIndex].page as number) : pageCount - 1
      if (endPage < startPage) {
        throw new PdfOutlineIndexError('invalid-range', `目录条目 ${item.id}「${item.title}」的范围 ${startPage}–${endPage} 倒置`)
      }
      if (endPage >= pageCount) {
        throw new PdfOutlineIndexError('page-out-of-range', `目录条目 ${item.id}「${item.title}」的范围终点 ${endPage} 超出文档页数 ${pageCount}`)
      }
      return {
        id: item.id,
        title: item.title,
        path: [...path],
        depth,
        startPage,
        endPage,
        passageOrders: [],
        children: build(item.children, [...path, item.title], depth + 1),
      }
    })
  return build(roots, [], 0)
}

/**
 * The single passage↔node association pass, exposed as two views so they can never drift apart:
 * `byPassage` (preorder node lists) backs {@link pdfOutlinePassages}; `byNode` (ascending passage
 * orders) fills {@link PdfOutlineNode.passageOrders}. A passage belongs to a node iff *any* of its
 * `pieces[].page` values falls inside `[startPage, endPage]` inclusive, so a passage spanning pages
 * 3–4 associates with a node covering only page 4. Passages no node covers are simply absent.
 */
function associatePassages(roots: PdfOutlineNode[], passages: Passage[]): {
  byPassage: Map<number, PdfOutlineNode[]>
  byNode: Map<PdfOutlineNode, number[]>
} {
  const nodes = flattenOutlineNodes(roots)
  const byPassage = new Map<number, PdfOutlineNode[]>()
  const byNode = new Map<PdfOutlineNode, number[]>()
  for (const item of passages) {
    for (const node of nodes) {
      const covered = item.pieces.some(piece => piece.page >= node.startPage && piece.page <= node.endPage)
      if (!covered) continue
      const nodeList = byPassage.get(item.order)
      if (nodeList) nodeList.push(node)
      else byPassage.set(item.order, [node])
      const orderList = byNode.get(node)
      if (orderList) orderList.push(item.order)
      else byNode.set(node, [item.order])
    }
  }
  return { byPassage, byNode }
}

/**
 * Turn a validated outline into a page-ranged node tree with passage membership attached.
 *
 * `roots === []` is the legitimate "this PDF has no outline" case and yields `[]` — distinct from a
 * rejection, which throws {@link PdfOutlineIndexError}. Inputs are never mutated; the returned tree
 * is freshly constructed.
 */
export function buildPdfOutlineIndex(
  roots: PdfOutlineEntry[],
  passages: Passage[],
  pageCount: number,
): PdfOutlineNode[] {
  const nodes = buildOutlineNodes(roots, pageCount)
  if (nodes.length === 0) return []
  const { byNode } = associatePassages(nodes, passages)
  for (const node of flattenOutlineNodes(nodes)) {
    node.passageOrders = [...(byNode.get(node) ?? [])].sort((a, b) => a - b)
  }
  return nodes
}

/**
 * Invert the same association pass into `passageOrder → nodes` (preorder). Passages covered by no
 * node are **absent** — callers use `map.get(order) ?? []`. A passage shared by a parent and its
 * child appears under both; Task 5's max-similarity dedup, not this layer, is what prevents
 * double-scoring.
 */
export function pdfOutlinePassages(
  roots: PdfOutlineNode[],
  passages: Passage[],
): Map<number, PdfOutlineNode[]> {
  return associatePassages(roots, passages).byPassage
}
