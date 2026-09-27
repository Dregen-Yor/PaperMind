import { describe, it, expect, vi } from 'vitest'
import { resolvePdfOutline } from '../utils/pdfOutline'
import type { PdfDestResolver, PdfJsOutlineEntry } from '../utils/pdfOutline'

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
