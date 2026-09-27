import { describe, it, expect, vi } from 'vitest'
import { resolvePdfOutline, buildPdfOutlineIndex, pdfOutlinePassages, PdfOutlineIndexError } from '../utils/pdfOutline'
import type { PdfDestResolver, PdfJsOutlineEntry, PdfOutlineEntry, PdfOutlineNode } from '../utils/pdfOutline'
import type { Passage } from '../utils/passages'

/** A raw PDF.js outline entry shaped like `getOutline()` output. */
function raw(title: unknown, dest: unknown, items: PdfJsOutlineEntry[] = [], url: unknown = null): PdfJsOutlineEntry {
  return { title, dest, items, url }
}

/** Build a resolver from a map of named destinations to 0-based pages. */
function namedResolver(pages: Record<string, number>): ReturnType<typeof vi.fn> & PdfDestResolver {
  return vi.fn(async (dest: string | unknown[]) => {
    if (typeof dest !== 'string') throw new Error(`expected a named destination, got ${JSON.stringify(dest)}`)
    if (!(dest in pages)) throw new Error(`unknown destination ${dest}`)
    return pages[dest]
  }) as ReturnType<typeof vi.fn> & PdfDestResolver
}

describe('resolvePdfOutline', () => {
  it('reports a missing outline for null or empty input', async () => {
    const resolve = namedResolver({})

    await expect(resolvePdfOutline(null, resolve, 10)).resolves.toEqual({
      ok: false, reason: 'missing-outline', entryCount: 0,
    })
    await expect(resolvePdfOutline(undefined, resolve, 10)).resolves.toEqual({
      ok: false, reason: 'missing-outline', entryCount: 0,
    })
    await expect(resolvePdfOutline([], resolve, 10)).resolves.toEqual({
      ok: false, reason: 'missing-outline', entryCount: 0,
    })
    expect(resolve).not.toHaveBeenCalled()
  })

  it('resolves a nested outline in source order with DFS index-path ids', async () => {
    const outline = [
      raw('Introduction', 'intro', [
        raw('Motivation', 'mot'),
        raw('Contributions', 'contrib'),
      ]),
      raw('Methods', 'methods', [
        raw('Model', 'model', [raw('Attention', 'attn')]),
      ]),
    ]
    const result = await resolvePdfOutline(outline, namedResolver({
      intro: 0, mot: 0, contrib: 1, methods: 2, model: 2, attn: 3,
    }), 10)

    expect(result).toEqual({
      ok: true,
      entryCount: 6,
      roots: [
        {
          id: '0', title: 'Introduction', page: 0,
          children: [
            { id: '0.0', title: 'Motivation', page: 0, children: [] },
            { id: '0.1', title: 'Contributions', page: 1, children: [] },
          ],
        },
        {
          id: '1', title: 'Methods', page: 2,
          children: [
            {
              id: '1.0', title: 'Model', page: 2,
              children: [{ id: '1.0.0', title: 'Attention', page: 3, children: [] }],
            },
          ],
        },
      ],
    })
  })

  it('keeps duplicate titles distinct via positional ids', async () => {
    const result = await resolvePdfOutline(
      [raw('Appendix', 'a'), raw('Appendix', 'b')],
      namedResolver({ a: 4, b: 5 }),
      10,
    )

    expect(result).toEqual({
      ok: true,
      entryCount: 2,
      roots: [
        { id: '0', title: 'Appendix', page: 4, children: [] },
        { id: '1', title: 'Appendix', page: 5, children: [] },
      ],
    })
  })

  it('passes a named destination string straight to resolvePage', async () => {
    const resolve = namedResolver({ intro: 3 })
    const result = await resolvePdfOutline([raw('Intro', 'intro')], resolve, 10)

    expect(resolve).toHaveBeenCalledTimes(1)
    expect(resolve).toHaveBeenCalledWith('intro')
    expect(result).toEqual({ ok: true, entryCount: 1, roots: [{ id: '0', title: 'Intro', page: 3, children: [] }] })
  })

  it('passes an indirect (array) destination straight to resolvePage', async () => {
    const dest = [{ num: 3, gen: 0 }, { name: 'Fit' }]
    const resolve = vi.fn(async () => 5)

    const result = await resolvePdfOutline([raw('X', dest)], resolve, 10)

    expect(resolve).toHaveBeenCalledWith(dest)
    expect(result).toEqual({ ok: true, entryCount: 1, roots: [{ id: '0', title: 'X', page: 5, children: [] }] })
  })

  it('accepts siblings and children that share the same page', async () => {
    const result = await resolvePdfOutline(
      [raw('A', 'a', [raw('A1', 'a1')]), raw('B', 'b')],
      namedResolver({ a: 2, a1: 2, b: 2 }),
      10,
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.roots.map(root => root.page)).toEqual([2, 2])
      expect(result.roots[0].children[0].page).toBe(2)
    }
  })

  it('omits external URL entries and their subtrees without counting them', async () => {
    const resolve = namedResolver({ i: 0, a: 1 })

    const result = await resolvePdfOutline([
      raw('Internal', 'i'),
      raw('External', null, [raw('Child', 'c')], 'https://example.com'),
      raw('After', 'a'),
    ], resolve, 10)

    expect(result).toEqual({
      ok: true,
      entryCount: 2,
      roots: [
        { id: '0', title: 'Internal', page: 0, children: [] },
        { id: '1', title: 'After', page: 1, children: [] },
      ],
    })
    // The external entry's subtree must not be walked or resolved.
    expect(resolve).not.toHaveBeenCalledWith('c')
  })

  it('reports an outline made only of external entries as empty', async () => {
    const result = await resolvePdfOutline(
      [raw('Home', null, [], 'https://example.com')],
      namedResolver({}),
      10,
    )

    expect(result).toEqual({ ok: true, entryCount: 0, roots: [] })
  })

  it('rejects the whole outline when any title is empty', async () => {
    await expect(resolvePdfOutline([raw('A', 'a'), raw('   ', 'b')], namedResolver({ a: 0, b: 1 }), 10))
      .resolves.toEqual({ ok: false, reason: 'invalid-title', entryCount: 2 })
    await expect(resolvePdfOutline([raw(42, 'a')], namedResolver({ a: 0 }), 10))
      .resolves.toEqual({ ok: false, reason: 'invalid-title', entryCount: 1 })
  })

  it('rejects the outline when an internal destination is null', async () => {
    const result = await resolvePdfOutline([raw('A', 'a'), raw('B', null)], namedResolver({ a: 0 }), 10)

    expect(result).toEqual({ ok: false, reason: 'unresolved-destination', entryCount: 2 })
  })

  it('maps a resolvePage rejection to unresolved-destination', async () => {
    const result = await resolvePdfOutline([raw('A', 'a'), raw('B', 'b')], namedResolver({ a: 0 }), 10)

    expect(result).toEqual({ ok: false, reason: 'unresolved-destination', entryCount: 2 })
  })

  it('does not delegate a non-string, non-array destination', async () => {
    const resolve = vi.fn(async () => 0)

    const result = await resolvePdfOutline([raw('A', 7)], resolve, 10)

    expect(result).toEqual({ ok: false, reason: 'unresolved-destination', entryCount: 1 })
    expect(resolve).not.toHaveBeenCalled()
  })

  it('rejects resolved pages outside the document range or not integers', async () => {
    for (const page of [-1, 10, 1.5, Number.NaN]) {
      await expect(resolvePdfOutline([raw('A', 'a')], vi.fn(async () => page), 10))
        .resolves.toEqual({ ok: false, reason: 'page-out-of-range', entryCount: 1 })
    }
    // The last valid page is pageCount - 1.
    await expect(resolvePdfOutline([raw('A', 'a')], vi.fn(async () => 9), 10))
      .resolves.toEqual({ ok: true, entryCount: 1, roots: [{ id: '0', title: 'A', page: 9, children: [] }] })
  })

  it('rejects a child that resolves before its parent', async () => {
    const result = await resolvePdfOutline(
      [raw('Parent', 'p', [raw('Child', 'c')])],
      namedResolver({ p: 5, c: 3 }),
      10,
    )

    expect(result).toEqual({ ok: false, reason: 'invalid-order', entryCount: 2 })
  })

  it('rejects sibling pages that decrease', async () => {
    const result = await resolvePdfOutline([raw('A', 'a'), raw('B', 'b')], namedResolver({ a: 3, b: 1 }), 10)

    expect(result).toEqual({ ok: false, reason: 'invalid-order', entryCount: 2 })
  })
})

/** A validated outline entry, shaped exactly like Task 1's `resolvePdfOutline` output. */
function entry(id: string, title: string, page: number | null, children: PdfOutlineEntry[] = []): PdfOutlineEntry {
  return { id, title, page, children }
}

/** A `Passage` whose page membership is carried solely by `pieces` — the only fields index building reads. */
function passage(order: number, pages: number[]): Passage {
  const pieces = pages.map((page, index) => ({ page, text: index === 0 ? `P${order}` : `\n\nP${order}` }))
  return {
    id: `P${String(order + 1).padStart(2, '0')}`,
    order,
    pieces,
    text: pieces.map(piece => piece.text).join(''),
    searchText: `P${order}`,
    tokenCount: 1,
    prevId: null,
    nextId: null,
    subsection: '',
  }
}

/** Preorder flattening — the same order every map value and `passageOrders` must follow. */
function flattenNodes(nodes: PdfOutlineNode[]): PdfOutlineNode[] {
  return nodes.flatMap(node => [node, ...flattenNodes(node.children)])
}

function expectRejection(run: () => unknown, reason: PdfOutlineIndexError['reason']): void {
  let error: unknown
  try {
    run()
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(PdfOutlineIndexError)
  expect((error as PdfOutlineIndexError).reason).toBe(reason)
}

describe('passage ranges', () => {
  //   page:          0  1  2  3  4  5  6  7  8  9 10 11
  //   Introduction (0) · Motivation (1) · Contributions (3)
  //   Methods (5) · Model (5) · Training (7)
  //   Results (9) · Conclusion (10)   <- last entry starts before the last page (11)
  const RICH: PdfOutlineEntry[] = [
    entry('0', 'Introduction', 0, [
      entry('0.0', 'Motivation', 1),
      entry('0.1', 'Contributions', 3),
    ]),
    entry('1', 'Methods', 5, [
      entry('1.0', 'Model', 5),
      entry('1.1', 'Training', 7),
    ]),
    entry('2', 'Results', 9),
    entry('3', 'Conclusion', 10),
  ]
  const RICH_PAGES = 12

  const rangesOf = (roots: PdfOutlineEntry[], pageCount: number): Record<string, number[]> => {
    const nodes = flattenNodes(buildPdfOutlineIndex(roots, [], pageCount))
    return Object.fromEntries(nodes.map(node => [node.id, [node.startPage, node.endPage]]))
  }

  it('runs each entry from its own start page through the next non-descendant start page, inclusive', () => {
    // `0.1` ends on page 5 because the next non-descendant `1` starts there — the boundary page is shared.
    // `0` also ends on 5: its descendant subtree runs through `0.1`, whose boundary is again `1`.
    expect(rangesOf(RICH, RICH_PAGES)).toEqual({
      '0': [0, 5],
      '0.0': [1, 3],
      '0.1': [3, 5],
      '1': [5, 9],
      '1.0': [5, 7],
      '1.1': [7, 9],
      '2': [9, 10],
      '3': [10, 11],
    })
  })

  it('lets a parent range cover introductory text that precedes its first child', () => {
    const index = buildPdfOutlineIndex(RICH, [], RICH_PAGES)
    const byId = new Map(flattenNodes(index).map(node => [node.id, node]))
    const parent = byId.get('0')!
    const firstChild = byId.get('0.0')!

    // The parent's own start page (0) precedes its first child's (1), so page 0 is intro-only.
    expect(parent.startPage).toBe(0)
    expect(firstChild.startPage).toBe(1)
    expect(firstChild.startPage).toBeGreaterThan(parent.startPage)
  })

  it('spans a parent range across its whole descendant subtree', () => {
    const index = buildPdfOutlineIndex(RICH, [], RICH_PAGES)
    const parent = flattenNodes(index).find(node => node.id === '0')!

    // `0.0` sits at page 1, `0.1` at page 3 — both inside [0, 5].
    expect(parent.startPage).toBeLessThanOrEqual(1)
    expect(parent.endPage).toBeGreaterThanOrEqual(3)
  })

  it('allows same-page siblings and parent/child ranges to overlap', () => {
    const roots = [entry('0', 'Section', 2, [entry('0.0', 'First', 2), entry('0.1', 'Second', 2)])]
    const index = buildPdfOutlineIndex(roots, [], 6)
    const nodes = flattenNodes(index)
    const byId = new Map(nodes.map(node => [node.id, node]))

    // Both siblings claim their shared start page; the parent overlaps both.
    expect(byId.get('0.0')!.startPage).toBe(2)
    expect(byId.get('0.0')!.endPage).toBe(2)
    expect(byId.get('0.1')!.startPage).toBe(2)
    expect(byId.get('0')!.startPage).toBe(2)
    expect(byId.get('0')!.endPage).toBe(5)

    const covers = pdfOutlinePassages(index, [passage(0, [2])])
    expect(covers.get(0)!.map(node => node.id)).toEqual(['0', '0.0', '0.1'])
  })

  it('extends the final entry through the final page', () => {
    const ranges = rangesOf(RICH, RICH_PAGES)
    // Conclusion starts at 10, strictly before the last page (11). Only the `pageCount - 1`
    // fallback makes the range [10, 11]; a regression to `endPage = startPage` would yield [10, 10].
    expect(ranges['3']).toEqual([10, RICH_PAGES - 1])

    // The end of the range is real, not just an arithmetic coincidence: a passage on the final
    // page associates with the last entry.
    const lastPage = RICH_PAGES - 1
    const passages = [passage(0, [lastPage])]
    const map = pdfOutlinePassages(buildPdfOutlineIndex(RICH, passages, RICH_PAGES), passages)
    expect(map.get(0)!.map(node => node.id)).toContain('3')
  })

  it('leaves passages before the first outline entry without any outline membership', () => {
    const roots = [entry('0', 'Body', 4)]
    const passages = [passage(0, [0]), passage(1, [1, 3]), passage(2, [4]), passage(3, [6, 7])]

    const index = buildPdfOutlineIndex(roots, passages, 8)
    const map = pdfOutlinePassages(index, passages)

    // Preamble pages (0 and 1–3) are uncovered: they stay in the global BM25/dense lists only.
    expect(map.has(0)).toBe(false)
    expect(map.has(1)).toBe(false)
    expect(map.get(2)!.map(node => node.id)).toEqual(['0'])
    for (const node of flattenNodes(index)) {
      expect(node.passageOrders).not.toContain(0)
      expect(node.passageOrders).not.toContain(1)
    }
  })

  it('associates a passage crossing a page boundary with a node covering only one of its pages', () => {
    const roots = [entry('0', 'Body', 4)]
    // Page 4 is inside [4, 7]; page 3 is not. Overlap of any piece is enough.
    const passages = [passage(0, [3, 4]), passage(1, [2, 3])]
    const map = pdfOutlinePassages(buildPdfOutlineIndex(roots, passages, 8), passages)

    expect(map.get(0)!.map(node => node.id)).toEqual(['0'])
    expect(map.has(1)).toBe(false)
  })

  it('records ancestor titles as path and the ancestor count as depth', () => {
    const nodes = flattenNodes(buildPdfOutlineIndex(RICH, [], RICH_PAGES))
    const byId = new Map(nodes.map(node => [node.id, node]))

    for (const node of nodes) expect(node.path.length).toBe(node.depth)
    expect(byId.get('0')!.path).toEqual([])
    expect(byId.get('0')!.depth).toBe(0)
    // The node's own title is excluded from `path`.
    expect(byId.get('0.0')!.path).toEqual(['Introduction'])
    expect(byId.get('0.0')!.depth).toBe(1)
    expect(byId.get('1.0')!.path).toEqual(['Methods'])
  })

  it('keeps passageOrders ascending and exactly in step with pdfOutlinePassages', () => {
    const passages = [passage(0, [0]), passage(1, [1]), passage(2, [3, 4]), passage(3, [5]), passage(4, [9, 11]), passage(5, [2])]
    const index = buildPdfOutlineIndex(RICH, passages, RICH_PAGES)
    const nodes = flattenNodes(index)
    const map = pdfOutlinePassages(index, passages)

    for (const node of nodes) {
      expect(node.passageOrders).toEqual([...node.passageOrders].sort((a, b) => a - b))
      const expected = passages
        .map(p => p.order)
        .filter(order => map.get(order)?.some(n => n.id === node.id) ?? false)
      expect(node.passageOrders).toEqual(expected)
    }
    for (const p of passages) {
      const ids = map.get(p.order)?.map(node => node.id) ?? []
      const fromNodes = nodes.filter(node => node.passageOrders.includes(p.order)).map(node => node.id)
      expect(ids).toEqual(fromNodes)
      expect(map.has(p.order)).toBe(fromNodes.length > 0)
    }
    // Map values are deterministic preorder.
    expect(map.get(3)!.map(node => node.id)).toEqual(['0', '0.1', '1', '1.0'])
  })

  it('rejects the whole index when a computed range would invert', () => {
    // Parent at page 5, child at page 7, but the parent's next sibling starts at page 6:
    // the child's next non-descendant ends it at 6, before it begins. Task 1 permits this shape.
    const roots = [entry('0', 'Parent', 5, [entry('0.0', 'Child', 7)]), entry('1', 'Sibling', 6)]

    expectRejection(() => buildPdfOutlineIndex(roots, [], 12), 'invalid-range')
  })

  it('rejects an entry whose page is null', () => {
    expectRejection(() => buildPdfOutlineIndex([entry('0', 'A', null)], [], 10), 'null-page')
  })

  it('rejects a range that reaches past the document and a non-positive page count', () => {
    expectRejection(() => buildPdfOutlineIndex([entry('0', 'A', 4), entry('1', 'B', 6)], [], 5), 'page-out-of-range')
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expectRejection(() => buildPdfOutlineIndex([entry('0', 'A', 0)], [], bad), 'invalid-page-count')
    }
  })

  it('returns an empty index for a PDF with no outline, without throwing', () => {
    expect(buildPdfOutlineIndex([], [passage(0, [0])], 10)).toEqual([])
    expect(pdfOutlinePassages([], [passage(0, [0])])).toEqual(new Map())
  })

  it('does not mutate its inputs', () => {
    const roots = [entry('0', 'A', 0, [entry('0.0', 'A1', 1)])]
    const passages = [passage(0, [0, 1])]
    const rootsSnapshot = JSON.stringify(roots)
    const passagesSnapshot = JSON.stringify(passages)

    const index = buildPdfOutlineIndex(roots, passages, 10)
    pdfOutlinePassages(index, passages)

    expect(JSON.stringify(roots)).toBe(rootsSnapshot)
    expect(JSON.stringify(passages)).toBe(passagesSnapshot)
  })
})
