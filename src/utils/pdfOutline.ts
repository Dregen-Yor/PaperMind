/**
 * Pure resolution of a PDF.js outline tree into a page-anchored structure.
 *
 * Deliberately free of any `pdfjs-dist` import: destination resolution arrives as
 * an injected callback, so this module can be unit tested without a PDF fixture
 * (and imported in the renderer without pulling in PDF.js at module scope).
 */

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
