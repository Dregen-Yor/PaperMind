import { describe, it, expect, vi } from 'vitest'
import { extractPdfDocument, extractPages, reconstructTextLines } from '../utils/pdfDocument'

// pdfDocument.ts pulls in pdfjs-dist at module scope (worker init + getDocument +
// isValidExplicitDest). Node/jsdom lacks DOMMatrix for the real getDocument, so mock it.
// `isValidExplicitDest` is stubbed to the array check this module relies on.
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  default: {},
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(),
  isValidExplicitDest: (dest: unknown) => Array.isArray(dest) && dest.length >= 2,
}))

/** A document-like adapter with per-test overrides, all methods spies. */
function makeDoc(overrides: Record<string, unknown> = {}) {
  const base = {
    numPages: 1,
    getPage: vi.fn(async (_page: number) => ({
      getTextContent: async () => ({
        items: [{ str: 'p', transform: [1, 0, 0, 1, 0, 0], hasEOL: true }],
      }),
    })),
    getOutline: vi.fn(async (): Promise<unknown> => null),
    getDestination: vi.fn(async (_id: string): Promise<unknown> => null),
    getPageIndex: vi.fn(async (_ref: unknown): Promise<number> => 0),
    destroy: vi.fn(async (): Promise<void> => {}),
  }
  return Object.assign(base, overrides)
}

function load(doc: ReturnType<typeof makeDoc>) {
  return { loadDocument: async () => doc }
}

describe('extractPdfDocument', () => {
  it('extracts page text byte-for-byte as reconstructTextLines over the items', async () => {
    const items1 = [
      { str: 'body', transform: [1, 0, 0, 1, 20, 700] },
      { str: 'text', transform: [1, 0, 0, 1, 55, 700], hasEOL: true },
      { str: '2. Methods', transform: [1, 0, 0, 1, 120, 500], hasEOL: true },
    ]
    const items2 = [{ str: 'second page', transform: [1, 0, 0, 1, 10, 10], hasEOL: true }]
    const doc = makeDoc({
      numPages: 2,
      getPage: vi.fn(async (page: number) => ({
        getTextContent: async () => ({ items: page === 1 ? items1 : items2 }),
      })),
    })

    const { pages } = await extractPdfDocument(btoa('ignored'), load(doc))

    expect(pages).toEqual([reconstructTextLines(items1), reconstructTextLines(items2)])
    expect(pages).toEqual(['body text\n2. Methods', 'second page'])
  })

  it('resolves the outline from the same document instance it destroys', async () => {
    const doc = makeDoc({
      numPages: 4,
      getOutline: vi.fn(async () => [
        { title: 'Intro', dest: 'intro', items: [], url: null },
        { title: 'Methods', dest: 'methods', items: [], url: null },
      ]),
      getDestination: vi.fn(async (id: string) =>
        id === 'intro' ? [{ num: 0, gen: 0 }, { name: 'Fit' }] : [{ num: 2, gen: 0 }, { name: 'Fit' }]),
      getPageIndex: vi.fn(async (ref: { num: number }) => ref.num),
    })

    const { outline } = await extractPdfDocument(btoa('ignored'), load(doc))

    expect(outline).toEqual([
      { id: '0', title: 'Intro', page: 0, children: [] },
      { id: '1', title: 'Methods', page: 2, children: [] },
    ])
    // Named (string) destinations resolve through getDestination first.
    expect(doc.getDestination).toHaveBeenCalledWith('intro')
    expect(doc.getPageIndex).toHaveBeenCalledWith({ num: 0, gen: 0 })
    // getOutline and destroy run against the one document instance we loaded.
    expect(doc.getOutline).toHaveBeenCalledTimes(1)
    expect(doc.destroy).toHaveBeenCalledTimes(1)
  })

  it('maps an indirect destination array through getPageIndex without getDestination', async () => {
    const dest = [{ num: 1, gen: 0 }, { name: 'Fit' }]
    const doc = makeDoc({
      numPages: 3,
      getOutline: vi.fn(async () => [{ title: 'Direct', dest, items: [], url: null }]),
      getDestination: vi.fn(async () => null),
      getPageIndex: vi.fn(async (ref: { num: number }) => ref.num),
    })

    const { outline } = await extractPdfDocument(btoa('ignored'), load(doc))

    expect(outline).toEqual([{ id: '0', title: 'Direct', page: 1, children: [] }])
    expect(doc.getDestination).not.toHaveBeenCalled()
    expect(doc.getPageIndex).toHaveBeenCalledWith({ num: 1, gen: 0 })
    expect(doc.destroy).toHaveBeenCalledTimes(1)
  })

  it('destroys the document when page extraction rejects', async () => {
    const doc = makeDoc({
      numPages: 1,
      getPage: vi.fn(async () => { throw new Error('boom') }),
    })

    await expect(extractPdfDocument(btoa('ignored'), load(doc))).rejects.toThrow('boom')
    expect(doc.destroy).toHaveBeenCalledTimes(1)
  })

  it('returns an empty outline but keeps pages and destroys when there is no outline', async () => {
    const doc = makeDoc({ numPages: 1, getOutline: vi.fn(async () => null) })

    const { pages, outline } = await extractPdfDocument(btoa('ignored'), load(doc))

    expect(pages).toEqual(['p'])
    expect(outline).toEqual([])
    expect(doc.destroy).toHaveBeenCalledTimes(1)
  })

  it('swallows an unresolvable outline, keeping pages, and still destroys', async () => {
    const doc = makeDoc({
      numPages: 5,
      getOutline: vi.fn(async () => [{ title: 'Bad', dest: 'missing', items: [], url: null }]),
      getDestination: vi.fn(async () => null),
    })

    const { pages, outline } = await extractPdfDocument(btoa('ignored'), load(doc))

    expect(pages).toEqual(['p', 'p', 'p', 'p', 'p'])
    expect(outline).toEqual([])
    expect(doc.destroy).toHaveBeenCalledTimes(1)
  })

  it('treats a getOutline rejection as no outline and still destroys', async () => {
    const doc = makeDoc({
      getOutline: vi.fn(async () => { throw new Error('outline boom') }),
    })

    const { outline } = await extractPdfDocument(btoa('ignored'), load(doc))

    expect(outline).toEqual([])
    expect(doc.destroy).toHaveBeenCalledTimes(1)
  })

  it('drops an outline whose resolved page is out of range', async () => {
    const doc = makeDoc({
      numPages: 2,
      getOutline: vi.fn(async () => [{ title: 'Late', dest: 'late', items: [], url: null }]),
      getDestination: vi.fn(async () => [{ num: 5, gen: 0 }, { name: 'Fit' }]),
      getPageIndex: vi.fn(async () => 5),
    })

    const { outline } = await extractPdfDocument(btoa('ignored'), load(doc))

    expect(outline).toEqual([])
  })
})

describe('extractPages delegation', () => {
  it('returns only the page array from the shared document helper', async () => {
    const loadingTaskDestroy = vi.fn(async () => {})
    const doc = makeDoc({
      numPages: 2,
      getPage: vi.fn(async (page: number) => ({
        getTextContent: async () => ({
          items: [{ str: `page ${page}`, transform: [1, 0, 0, 1, 0, 0], hasEOL: true }],
        }),
      })),
      // The default adapter tears down via loadingTask.destroy(), not doc.destroy().
      loadingTask: { destroy: loadingTaskDestroy },
    })
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs') as unknown as { getDocument: { mockReturnValue: (value: unknown) => void } }
    pdfjs.getDocument.mockReturnValue({ promise: Promise.resolve(doc) })

    const pages = await extractPages(btoa('fixture'))

    expect(pages).toEqual(['page 1', 'page 2'])
    expect(doc.getOutline).toHaveBeenCalledTimes(1)
    expect(loadingTaskDestroy).toHaveBeenCalledTimes(1)
  })
})
