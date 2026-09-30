import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'
import { resolvePdfOutline, type PdfDestResolver, type PdfJsOutlineEntry, type PdfOutlineEntry, type PdfOutlineResult } from './pdfOutline'

// Worker setup stays here so this module can load a document on its own.
pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.min.mjs'

export interface PdfTextItem {
  str?: string
  transform?: number[]
  hasEOL?: boolean
  fontName?: string
}

export interface PdfTextLine {
  page: number
  text: string
  x: number
  y: number
  fontSize: number
  bold: boolean
}

type PageTextLine = Omit<PdfTextLine, 'page'>

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function itemLayout(item: PdfTextItem) {
  const transform = item.transform ?? []
  const primary = Math.hypot(finite(transform[2]), finite(transform[3]))
  const fallback = Math.hypot(finite(transform[0]), finite(transform[1]))
  return {
    x: finite(transform[4]),
    y: finite(transform[5]),
    fontSize: primary > 0 ? primary : fallback,
    bold: /bold/i.test(item.fontName ?? ''),
  }
}

/** Build layout lines separately so column boundaries never change the legacy page string. */
function reconstructLayoutLines(items: PdfTextItem[]): PageTextLine[] {
  const lines: Array<{ y: number; items: Array<{ x: number; text: string; fontSize: number; bold: boolean }> }> = []
  let current: (typeof lines)[number] | undefined
  let previousX = 0
  let previousFontSize = 0
  const flush = () => { current = undefined }
  for (const item of items) {
    const text = item.str?.trim()
    if (!text) continue
    const layout = itemLayout(item)
    const gapLimit = Math.max(80, 4 * Math.max(previousFontSize, layout.fontSize))
    if (!current || Math.abs(current.y - layout.y) > 2 || layout.x < previousX || layout.x - previousX > gapLimit) {
      current = { y: layout.y, items: [] }
      lines.push(current)
    }
    current.items.push({ x: layout.x, text, fontSize: layout.fontSize, bold: layout.bold })
    previousX = layout.x
    previousFontSize = layout.fontSize
    if (item.hasEOL) flush()
  }
  return lines.map(line => {
    const sorted = line.items.sort((a, b) => a.x - b.x)
    return {
      text: sorted.map(item => item.text).join(' '),
      x: Math.min(...sorted.map(item => item.x)),
      y: line.y,
      fontSize: Math.max(...sorted.map(item => item.fontSize)),
      bold: sorted.some(item => item.bold),
    }
  })
}

/** Rebuild the legacy page text and expose a separate layout view for TOC inference. */
export function reconstructTextPage(items: PdfTextItem[]): { text: string; lines: PageTextLine[] } {
  const lines: Array<{ y: number; items: Array<{ x: number; text: string }> }> = []
  let current: { y: number; items: Array<{ x: number; text: string }> } | undefined
  const flush = () => { current = undefined }
  for (const item of items) {
    const text = item.str?.trim()
    if (!text) continue
    // Preserve the legacy page-string grouping exactly; finite normalization belongs only
    // to the separate layout view consumed by the benchmark tree builder.
    const x = item.transform?.[4] ?? 0
    const y = item.transform?.[5] ?? 0
    if (!current || Math.abs(current.y - y) > 2) {
      current = { y, items: [] }
      lines.push(current)
    }
    current.items.push({ x, text })
    if (item.hasEOL) flush()
  }
  const text = lines
    .map(line => line.items.sort((a, b) => a.x - b.x).map(item => item.text).join(' '))
    .join('\n')
  return { text, lines: reconstructLayoutLines(items) }
}

/** Rebuild visual text lines from PDF.js items so line-anchored headings survive extraction. */
export function reconstructTextLines(items: PdfTextItem[]): string {
  return reconstructTextPage(items).text
}

export interface PdfPageLike {
  getTextContent(): Promise<{ items: unknown }>
}

/**
 * The slice of `PDFDocumentProxy` this module uses, behind an injectable adapter so tests
 * need no real PDF. `destroy` is the teardown seam: the real implementation routes to
 * `doc.loadingTask.destroy()` because `PDFDocumentProxy` has no `destroy()` in pdfjs 6.
 */
export interface PdfDocumentLike {
  numPages: number
  getPage(page: number): Promise<PdfPageLike>
  getOutline(): Promise<unknown | null>
  getDestination(id: string): Promise<unknown>
  getPageIndex(ref: unknown): Promise<number>
  destroy(): Promise<void>
}

export interface PdfDocumentDeps {
  /** Default: `pdfjsLib.getDocument({ data: bytes }).promise`, adapted to `PdfDocumentLike`. */
  loadDocument?: (bytes: Uint8Array) => Promise<PdfDocumentLike>
  /**
   * When false, the outline is not read at all — `getOutline` is never called.
   * Default: true (the document helper's job is to read the outline).
   */
  readOutline?: boolean
}

export interface ExtractedPdfDocument {
  pages: string[]
  layoutLines: PdfTextLine[][]
  /** Empty when the PDF has no usable outline (or when `readOutline: false`). */
  outline: PdfOutlineEntry[]
  /** Present only when outline reading ran; carries the rejection reason and entry count. */
  outlineResult?: PdfOutlineResult
}

async function defaultLoadDocument(bytes: Uint8Array): Promise<PdfDocumentLike> {
  const doc = await pdfjsLib.getDocument({ data: bytes.buffer as ArrayBuffer }).promise
  return {
    numPages: doc.numPages,
    getPage: page => doc.getPage(page),
    getOutline: () => doc.getOutline(),
    getDestination: id => doc.getDestination(id),
    getPageIndex: ref => doc.getPageIndex(ref as Parameters<typeof doc.getPageIndex>[0]),
    // pdfjs 6 has no `PDFDocumentProxy.destroy()`; teardown lives on the loading task.
    destroy: () => doc.loadingTask.destroy(),
  }
}

/** Named destinations resolve through `getDestination` first; explicit arrays are used as-is. */
function buildResolvePage(doc: PdfDocumentLike): PdfDestResolver {
  return async dest => {
    let resolved: unknown = dest
    if (typeof dest === 'string') {
      resolved = await doc.getDestination(dest)
      if (resolved === null || resolved === undefined) throw new Error('named destination did not resolve')
    }
    // Guard before touching dest[0]: isValidExplicitDest accepts a page ref or integer page.
    if (!pdfjsLib.isValidExplicitDest(resolved)) throw new Error('not a valid explicit destination')
    return doc.getPageIndex((resolved as unknown[])[0])
  }
}

/**
 * Read the outline as a retrieval prior. Any failure (missing, malformed, unresolvable)
 * yields no outline rather than throwing — page text extraction must stay reliable — but the
 * rejection reason and entry count are still reported so callers can tell the cases apart.
 */
async function readDocumentOutline(doc: PdfDocumentLike): Promise<{ outline: PdfOutlineEntry[]; outlineResult: PdfOutlineResult }> {
  let raw: unknown
  try {
    raw = await doc.getOutline()
  } catch {
    // `getOutline` throwing is an abnormal path with no dedicated reason in the pinned
    // union — `'missing-outline'` is the closest available; no entry count was seen.
    return { outline: [], outlineResult: { ok: false, reason: 'missing-outline', entryCount: 0 } }
  }
  const outlineResult = await resolvePdfOutline(
    Array.isArray(raw) ? (raw as PdfJsOutlineEntry[]) : null,
    buildResolvePage(doc),
    doc.numPages,
  )
  return { outline: outlineResult.ok ? outlineResult.roots : [], outlineResult }
}

/**
 * Load one PDF.js document, extract every page's reconstructed text — and, unless
 * `readOutline: false`, its resolved native outline — then tear the document down.
 * Teardown runs on success and on failure.
 */
export async function extractPdfDocument(base64: string, deps: PdfDocumentDeps = {}): Promise<ExtractedPdfDocument> {
  const loadDocument = deps.loadDocument ?? defaultLoadDocument
  const shouldReadOutline = deps.readOutline ?? true
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)

  const doc = await loadDocument(bytes)
  try {
    const pages: string[] = []
    const layoutLines: PdfTextLine[][] = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      const reconstructed = reconstructTextPage(content.items as PdfTextItem[])
      pages.push(reconstructed.text)
      layoutLines.push(reconstructed.lines.map(line => ({ ...line, page: i - 1 })))
    }
    if (!shouldReadOutline) return { pages, layoutLines, outline: [] }
    const { outline, outlineResult } = await readDocumentOutline(doc)
    return { pages, layoutLines, outline, outlineResult }
  } finally {
    // Best-effort teardown: never mask the original success/failure.
    try {
      await doc.destroy()
    } catch { /* ignore teardown errors */ }
  }
}
