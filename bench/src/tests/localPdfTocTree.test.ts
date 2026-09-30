import { describe, expect, it } from 'vitest'
import type { PdfOutlineEntry } from '../../../src/utils/pdfOutline'
import type { TocCandidate } from '../localPdf/tocCandidates'
import { buildTocTree, flattenTocTree, validateTocTree } from '../localPdf/tocTree'

const candidate = (title: string, page: number, numbering: number[] | null, indent = 20, fontSize = 16, source: TocCandidate['source'] = 'heading'): TocCandidate => ({
  title, page, numbering, indent, fontSize, bold: true, source,
})

const outline = (title: string, page: number, children: PdfOutlineEntry[] = []): PdfOutlineEntry => ({ id: title, title, page, children })

describe('title-only TOC tree source selection', () => {
  it('prefers a valid native hierarchy over fallback candidates', () => {
    const tree = buildTocTree({
      paperId: 'p', pageCount: 6,
      outline: [outline('Introduction', 1), outline('Methods', 2, [outline('Model', 3)])],
      tocCandidates: [candidate('Wrong TOC A', 1, null, 20, 10, 'toc-page'), candidate('Wrong TOC B', 4, null, 20, 10, 'toc-page')],
      headingCandidates: [candidate('Wrong Heading A', 1, null), candidate('Wrong Heading B', 4, null)],
    })
    expect(tree.source).toBe('native-outline')
    expect(flattenTocTree(tree).map(node => [node.id, node.title, node.startPage, node.endPage])).toEqual([
      ['n0', 'Introduction', 0, 1],
      ['n1', 'Methods', 2, 5],
      ['n1.0', 'Model', 3, 5],
    ])
  })

  it('falls through invalid native and TOC inputs before failing explicitly', () => {
    const base = { paperId: 'p', pageCount: 5, outline: [outline('Only', 1)] }
    const toc = [candidate('TOC A', 1, null, 20, 10, 'toc-page'), candidate('TOC B', 3, null, 20, 10, 'toc-page')]
    expect(buildTocTree({ ...base, tocCandidates: toc, headingCandidates: [] }).source).toBe('toc-page')
    const headings = [candidate('Heading A', 1, null), candidate('Heading B', 3, null)]
    expect(buildTocTree({ ...base, tocCandidates: toc.slice(0, 1), headingCandidates: headings }).source).toBe('heading')
    expect(() => buildTocTree({ ...base, tocCandidates: [], headingCandidates: headings.slice(0, 1) })).toThrow('no-valid-toc-tree')
  })
})

describe('title-only TOC tree hierarchy and ranges', () => {
  const input = {
    paperId: 'p', pageCount: 6, outline: [], tocCandidates: [],
    headingCandidates: [
      candidate('2 Methods', 1, [2], 20, 16),
      candidate('2.1 Model', 2, [2, 1], 40, 12),
      candidate('Ablation Study', 3, null, 40, 12),
      candidate('3 Results', 4, [3], 20, 16),
      candidate('Conflict Section', 4, null, 40, 16),
    ],
  }

  it('uses numbering then the shallower visual signal and keeps same-page ranges valid', () => {
    const tree = buildTocTree(input)
    expect(tree.roots.map(node => node.id)).toEqual(['n0', 'n1', 'n2'])
    expect(tree.roots[0].children.map(node => node.id)).toEqual(['n0.0', 'n0.1'])
    expect(flattenTocTree(tree).map(node => [node.title, node.depth, node.startPage, node.endPage])).toEqual([
      ['2 Methods', 0, 0, 3],
      ['2.1 Model', 1, 2, 2],
      ['Ablation Study', 1, 3, 3],
      ['3 Results', 0, 4, 4],
      ['Conflict Section', 0, 4, 5],
    ])
  })

  it('keeps a parent covering its child when the next root starts on the child page', () => {
    const tree = buildTocTree({
      paperId: 'p', pageCount: 4, tocCandidates: [], headingCandidates: [],
      outline: [outline('1 Intro', 0), outline('2 Model', 1, [outline('2.1 Details', 2)]), outline('3 Results', 2)],
    })
    expect(tree.roots[1]).toMatchObject({ startPage: 1, endPage: 2 })
    expect(tree.roots[1].children[0]).toMatchObject({ startPage: 2, endPage: 2 })
    expect(tree.roots[2]).toMatchObject({ startPage: 2, endPage: 3 })
  })

  it('promotes a numbered child when its required numbered parent is absent', () => {
    const tree = buildTocTree({
      paperId: 'p', pageCount: 4, outline: [], tocCandidates: [],
      headingCandidates: [
        candidate('1 Introduction', 0, [1]),
        candidate('2.1 Orphan model', 1, [2, 1]),
        candidate('3 Results', 2, [3]),
      ],
    })
    expect(tree.roots.map(node => node.title)).toEqual(['1 Introduction', '2.1 Orphan model', '3 Results'])
    expect(tree.roots.every(node => node.depth === 0)).toBe(true)
  })

  it('hashes only allowed tree inputs', () => {
    const original = buildTocTree(input).inputSha256
    expect(buildTocTree({ ...input, pageCount: 7 }).inputSha256).not.toBe(original)
    expect(buildTocTree({ ...input, headingCandidates: input.headingCandidates.map((item, i) => i ? item : { ...item, title: 'Changed' }) }).inputSha256).not.toBe(original)
    expect(buildTocTree({ ...input, outline: [outline('Ignored invalid native', 1)] }).inputSha256).not.toBe(original)
    expect(buildTocTree({ ...input, bodyPages: ['secret'], question: 'gold?' } as typeof input).inputSha256).toBe(original)
  })
})

describe('title-only TOC tree validation', () => {
  const valid = () => buildTocTree({
    paperId: 'p', pageCount: 4, outline: [], tocCandidates: [],
    headingCandidates: [candidate('Introduction', 1, null), candidate('Methods', 2, null)],
  })

  it('rejects malformed ranges, identities, titles, hierarchy, and undersized trees', () => {
    const mutations: Array<(tree: ReturnType<typeof valid>) => void> = [
      tree => { tree.roots[1].id = tree.roots[0].id },
      tree => { tree.roots[0].title = '' },
      tree => { tree.roots[0].startPage = -1 },
      tree => { tree.roots[0].endPage = 9 },
      tree => { tree.roots[0].endPage = -1 },
      tree => { tree.roots[0].children = [{ ...tree.roots[1], id: 'n0.0', depth: 1, startPage: 3, endPage: 3 }] },
      tree => {
        tree.roots[0].endPage = 2
        tree.roots[0].children = [{
          ...tree.roots[1],
          id: 'n0.0',
          title: 'Child',
          depth: 1,
          startPage: 2,
          endPage: 2,
        }]
        tree.roots[1].startPage = 1
      },
      tree => { tree.roots = [tree.roots[0]] },
      tree => { tree.roots[0].title = 'Figure 1 Accuracy' },
    ]
    for (const mutate of mutations) {
      const tree = structuredClone(valid()); mutate(tree)
      expect(() => validateTocTree(tree, 4)).toThrow()
    }
  })
})
