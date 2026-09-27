import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'
import { resolvePdfOutline, type PdfDestResolver, type PdfJsOutlineEntry, type PdfOutlineEntry } from './pdfOutline'

// Worker setup stays here so this module can load a document on its own.
pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.min.mjs'

export interface PdfTextItem {
  str?: string
  transform?: number[]
  hasEOL?: boolean
}

/** Rebuild visual text lines from PDF.js items so line-anchored headings survive extraction. */
export function reconstructTextLines(items: PdfTextItem[]): string {
  const lines: Array<{ y: number; items: Array<{ x: number; text: string }> }> = []
  let current: { y: number; items: Array<{ x: number; text: string }> } | undefined
  const flush = () => { current = undefined }
  for (const item of items) {
    const text = item.str?.trim()
    if (!text) continue
    const x = item.transform?.[4] ?? 0
    const y = item.transform?.[5] ?? 0
    if (!current || Math.abs(current.y - y) > 2) {
      current = { y, items: [] }
      lines.push(current)
    }
    current.items.push({ x, text })
    if (item.hasEOL) flush()
  }
  return lines
    .map(line => line.items.sort((a, b) => a.x - b.x).map(item => item.text).join(' '))
    .join('\n')
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
}

export interface ExtractedPdfDocument {
  pages: string[]
  /** Empty when the PDF has no usable outline. */
  outline: PdfOutlineEntry[]
}

async function defaultLoadDocument(bytes: Uint8Array): Promise<PdfDocumentLike> {
  const doc = await pdfjsLib.getDocument({ data: bytes.buffer as ArrayBuffer }).promise
  const bare = doc as unknown as {
    getOutline?: () => Promise<unknown>
    loadingTask?: { destroy?: () => Promise<void> }
  }
  return {
    numPages: doc.numPages,
    getPage: page => doc.getPage(page),
    // Only documents that actually carry an outline need to expose one.
    getOutline: () => (typeof bare.getOutline === 'function' ? bare.getOutline() : Promise.resolve(null)),
    getDestination: id => doc.getDestination(id),
    getPageIndex: ref => doc.getPageIndex(ref as Parameters<typeof doc.getPageIndex>[0]),
    destroy: async () => {
      if (bare.loadingTask && typeof bare.loadingTask.destroy === 'function') await bare.loadingTask.destroy()
    },
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
 * yields no outline rather than throwing — page text extraction must stay reliable.
 */
async function readOutline(doc: PdfDocumentLike): Promise<PdfOutlineEntry[]> {
  try {
    const raw = await doc.getOutline()
    const result = await resolvePdfOutline(
      Array.isArray(raw) ? (raw as PdfJsOutlineEntry[]) : null,
      buildResolvePage(doc),
      doc.numPages,
    )
    return result.ok ? result.roots : []
  } catch {
    return []
  }
}

/**
 * Load one PDF.js document, extract every page's reconstructed text and its resolved
 * native outline, then tear the document down. Teardown runs on success and on failure.
 */
export async function extractPdfDocument(base64: string, deps: PdfDocumentDeps = {}): Promise<ExtractedPdfDocument> {
  const loadDocument = deps.loadDocument ?? defaultLoadDocument
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)

  const doc = await loadDocument(bytes)
  try {
    const pages: string[] = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      pages.push(reconstructTextLines(content.items as PdfTextItem[]))
    }
    return { pages, outline: await readOutline(doc) }
  } finally {
    // Best-effort teardown: never mask the original success/failure.
    try {
      await doc.destroy()
    } catch { /* ignore teardown errors */ }
  }
}

/** Page text only, via the shared document helper. Signature preserved for existing callers. */
export async function extractPages(base64: string): Promise<string[]> {
  return (await extractPdfDocument(base64)).pages
}
