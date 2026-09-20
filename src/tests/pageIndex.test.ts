import { describe, it, expect, vi } from 'vitest'
import { scoreAndSelect, buildPageIndex, detectSectionBoundaries, reconstructTextLines, extractPages } from '../utils/pageIndex'
import type { IndexNode } from '../utils/pageIndex'

// pdfjs-dist 在 pageIndex.ts 顶层导入，测试中需要 mock
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  default: {},
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(),
}))

function makeRoot(): IndexNode {
  return {
    title: 'Paper',
    nodeId: 'root',
    startPage: 0,
    endPage: 5,
    summary: 'A test paper about deep learning.',
    nodes: [
      { title: 'Introduction', nodeId: '0', startPage: 0, endPage: 1, summary: 'Motivates the problem.', nodes: [] },
      { title: 'Methods',      nodeId: '1', startPage: 2, endPage: 3, summary: 'Describes the approach.', nodes: [] },
      { title: 'Results',      nodeId: '2', startPage: 4, endPage: 5, summary: 'Shows experimental results.', nodes: [] },
    ],
  }
}

const pages = ['p0 text', 'p1 text', 'p2 text', 'p3 text', 'p4 text', 'p5 text']

describe('scoreAndSelect', () => {
  it('returns the top-scored node when second score is below threshold (< 4)', async () => {
    const llm = vi.fn().mockResolvedValue('[{"id":1,"score":9},{"id":0,"score":2},{"id":2,"score":1}]')
    const result = await scoreAndSelect(makeRoot(), pages, 'how was the study conducted?', llm)

    expect(result.sources).toHaveLength(1)
    expect(result.sources[0]).toContain('Methods')
    expect(result.context).toBe('p2 text\n\np3 text')
    expect(llm).toHaveBeenCalledTimes(1)
  })

  it('returns top-2 nodes in document order when second score >= 4', async () => {
    const llm = vi.fn().mockResolvedValue('[{"id":2,"score":8},{"id":1,"score":5},{"id":0,"score":1}]')
    const result = await scoreAndSelect(makeRoot(), pages, 'methods and results?', llm)

    expect(result.sources).toHaveLength(2)
    // Document order: Methods (pages 2-3) before Results (pages 4-5)
    expect(result.sources[0]).toContain('Methods')
    expect(result.sources[1]).toContain('Results')
    expect(result.context).toContain('---')
    // Methods context comes first
    expect(result.context.indexOf('p2')).toBeLessThan(result.context.indexOf('p4'))
  })

  it('excludes second node when score is exactly 3 (below threshold)', async () => {
    const llm = vi.fn().mockResolvedValue('[{"id":0,"score":7},{"id":1,"score":3},{"id":2,"score":1}]')
    const result = await scoreAndSelect(makeRoot(), pages, 'introduction overview', llm)

    expect(result.sources).toHaveLength(1)
    expect(result.sources[0]).toContain('Introduction')
  })

  it('falls back to first leaf node on JSON parse failure', async () => {
    const llm = vi.fn().mockResolvedValue('this is not valid json at all')
    const result = await scoreAndSelect(makeRoot(), pages, 'anything', llm)

    expect(result.sources).toHaveLength(1)
    expect(result.sources[0]).toContain('Introduction')
  })

  it('returns single node directly when root has no children', async () => {
    const singleRoot: IndexNode = {
      title: 'Short Paper', nodeId: 'root',
      startPage: 0, endPage: 2,
      summary: 'A very short paper.', nodes: [],
    }
    const llm = vi.fn()
    const result = await scoreAndSelect(singleRoot, ['a', 'b', 'c'], 'anything', llm)

    expect(llm).not.toHaveBeenCalled()
    expect(result.sources).toHaveLength(1)
    expect(result.context).toBe('a\n\nb\n\nc')
  })
})

describe('scoreAndSelect structured result (benchmark hooks)', () => {
  it('exposes selected nodes with page ranges, avoiding source-string parsing', async () => {
    const llm = vi.fn().mockResolvedValue('[{"id":1,"score":9},{"id":2,"score":6},{"id":0,"score":1}]')
    const result = await scoreAndSelect(makeRoot(), pages, 'methods and results?', llm)

    expect(result.selected.map(n => n.title)).toEqual(['Methods', 'Results'])
    expect(result.selected.map(n => [n.startPage, n.endPage])).toEqual([[2, 3], [4, 5]])
  })

  it('exposes the raw scores returned by the LLM', async () => {
    const llm = vi.fn().mockResolvedValue('[{"id":1,"score":9},{"id":0,"score":2},{"id":2,"score":1}]')
    const result = await scoreAndSelect(makeRoot(), pages, 'how was the study conducted?', llm)

    expect(result.scores).toEqual([
      { id: 1, score: 9 },
      { id: 0, score: 2 },
      { id: 2, score: 1 },
    ])
    expect(result.degraded).toBe(false)
  })

  it('flags degraded=true when the LLM response is unparseable', async () => {
    const llm = vi.fn().mockResolvedValue('this is not valid json at all')
    const result = await scoreAndSelect(makeRoot(), pages, 'anything', llm)

    expect(result.degraded).toBe(true)
    expect(result.scores).toEqual([])
    expect(result.selected.map(n => n.title)).toEqual(['Introduction'])
  })

  it('flags degraded=false on the single-node short circuit', async () => {
    const singleRoot: IndexNode = {
      title: 'Short Paper', nodeId: 'root',
      startPage: 0, endPage: 2,
      summary: 'A very short paper.', nodes: [],
    }
    const result = await scoreAndSelect(singleRoot, ['a', 'b', 'c'], 'anything', vi.fn())

    expect(result.degraded).toBe(false)
    expect(result.selected.map(n => n.title)).toEqual(['Short Paper'])
  })
})

describe('scoreAndSelect context provenance (benchmark hooks)', () => {
  it('exposes one page-attributed group per selected node', async () => {
    const llm = vi.fn().mockResolvedValue('[{"id":1,"score":9},{"id":2,"score":6},{"id":0,"score":1}]')
    const result = await scoreAndSelect(makeRoot(), pages, 'methods and results?', llm)

    expect(result.contextGroups).toEqual([
      { pieces: [{ page: 2, text: pages[2] }, { page: 3, text: `\n\n${pages[3]}` }] },
      { pieces: [{ page: 4, text: pages[4] }, { page: 5, text: `\n\n${pages[5]}` }] },
    ])
  })

  it('concatenating group pieces with the group separator reproduces the legacy context', async () => {
    const llm = vi.fn().mockResolvedValue('[{"id":1,"score":9},{"id":2,"score":6},{"id":0,"score":1}]')
    const result = await scoreAndSelect(makeRoot(), pages, 'methods and results?', llm)

    const rebuilt = result.contextGroups
      .map(group => group.pieces.map(piece => piece.text).join(''))
      .join('\n\n---\n\n')
    expect(rebuilt).toBe(result.context)
  })

  it('carries context groups on the single-node short circuit', async () => {
    const singleRoot: IndexNode = {
      title: 'Short Paper', nodeId: 'root',
      startPage: 0, endPage: 2,
      summary: 'A very short paper.', nodes: [],
    }
    const result = await scoreAndSelect(singleRoot, ['a', 'b', 'c'], 'anything', vi.fn())

    expect(result.contextGroups).toEqual([
      { pieces: [{ page: 0, text: 'a' }, { page: 1, text: '\n\nb' }, { page: 2, text: '\n\nc' }] },
    ])
  })

  it('carries context groups on the degraded fallback path too', async () => {
    const llm = vi.fn().mockResolvedValue('this is not valid json at all')
    const result = await scoreAndSelect(makeRoot(), pages, 'anything', llm)

    expect(result.contextGroups).toEqual([
      { pieces: [{ page: 0, text: pages[0] }, { page: 1, text: `\n\n${pages[1]}` }] },
    ])
  })
})

describe('scoreAndSelect topK / minScore options', () => {
  it('selects three nodes in document order when topK is 3', async () => {
    const llm = vi.fn().mockResolvedValue('[{"id":2,"score":9},{"id":1,"score":7},{"id":0,"score":5}]')
    const result = await scoreAndSelect(makeRoot(), pages, 'everything', llm, { topK: 3 })

    expect(result.selected.map(n => n.title)).toEqual(['Introduction', 'Methods', 'Results'])
  })

  it('still honours minScore when topK is 3', async () => {
    const llm = vi.fn().mockResolvedValue('[{"id":2,"score":9},{"id":1,"score":7},{"id":0,"score":3}]')
    const result = await scoreAndSelect(makeRoot(), pages, 'everything', llm, { topK: 3 })

    // id 0 scores 3, below the default minScore of 4
    expect(result.selected.map(n => n.title)).toEqual(['Methods', 'Results'])
  })

  it('admits a low-scoring second node when minScore is lowered', async () => {
    const llm = vi.fn().mockResolvedValue('[{"id":0,"score":7},{"id":1,"score":3},{"id":2,"score":1}]')
    const result = await scoreAndSelect(makeRoot(), pages, 'introduction overview', llm, { minScore: 2 })

    expect(result.selected.map(n => n.title)).toEqual(['Introduction', 'Methods'])
  })

  it('always keeps the top node even when it scores below minScore', async () => {
    const llm = vi.fn().mockResolvedValue('[{"id":1,"score":1},{"id":0,"score":0},{"id":2,"score":0}]')
    const result = await scoreAndSelect(makeRoot(), pages, 'unrelated question', llm, { minScore: 4 })

    expect(result.selected.map(n => n.title)).toEqual(['Methods'])
  })

  it('selects only the top node when topK is 1', async () => {
    const llm = vi.fn().mockResolvedValue('[{"id":0,"score":9},{"id":1,"score":9},{"id":2,"score":9}]')
    const result = await scoreAndSelect(makeRoot(), pages, 'everything', llm, { topK: 1 })

    expect(result.selected.map(n => n.title)).toEqual(['Introduction'])
  })
})

describe('buildPageIndex range coverage', () => {
  it('does not drop pages before the first detected section heading', async () => {
    // pages 0-1: preamble (no heading), page 2: first heading, pages 3-4: more content
    const pages = [
      'preamble page one, no heading here',
      'preamble page two, still no heading',
      '1. Introduction\nFirst real section starts here',
      'Introduction content continues here.',
      '2. Methods\nSecond section begins.',
    ]
    const llm = vi.fn().mockResolvedValue('{"title":"Test","summary":"A test paper"}')
    const tree = await buildPageIndex(pages, llm)

    // The root node must span the full page range
    expect(tree.endPage).toBe(4)
    // Pre-heading pages (0-1) must be covered by some leaf
    const allLeaves = tree.nodes.length > 0 ? tree.nodes : [tree]
    const coversPage0 = allLeaves.some(n => n.startPage === 0)
    expect(coversPage0).toBe(true)
  })

  it('splits a long semantic section to maxSectionPages and labels the parts', async () => {
    const pages = ['1. Introduction', 'a', 'b', 'c', 'd', 'e', '2. Methods', 'f']
    const tree = await buildPageIndex(pages, vi.fn().mockResolvedValue('{"title":"Section","summary":""}'), {
      minSectionPages: 1,
      maxSectionPages: 3,
    })
    expect(tree.nodes.map(node => [node.startPage, node.endPage])).toEqual([[0, 2], [3, 5], [6, 7]])
    expect(tree.nodes[0].title).toContain('Part 1')
    expect(tree.nodes[1].title).toContain('Part 2')
  })

  it('rejects an invalid maxSectionPages instead of producing fractional page ranges', async () => {
    await expect(buildPageIndex(['a', 'b'], vi.fn(), { maxSectionPages: 1.5 })).rejects.toThrow(/maxSectionPages/)
  })
})

describe('PDF line reconstruction and semantic sections', () => {
  it('keeps visual lines when a title sits in the middle of a PDF page', () => {
    const text = reconstructTextLines([
      { str: 'body', transform: [1, 0, 0, 1, 20, 700] },
      { str: 'text', transform: [1, 0, 0, 1, 55, 700], hasEOL: true },
      { str: '2. Methods', transform: [1, 0, 0, 1, 120, 500], hasEOL: true },
      { str: 'more body', transform: [1, 0, 0, 1, 20, 480] },
    ])
    expect(text).toBe('body text\n2. Methods\nmore body')
    expect(detectSectionBoundaries([text, 'INTRODUCTION\ncontent', '第3节 实验设置\n正文'])).toEqual([0, 1, 2])
  })

  it('collapses adjacent repeated running headers to one section boundary', () => {
    expect(detectSectionBoundaries([
      '1 Introduction\nfirst page',
      '1 Introduction\ncontinued text',
      '2 Methods\nmethod text',
      '2 Methods\ncontinued methods',
    ])).toEqual([0, 2])
  })

  it('extractPages through buildPageIndex uses heading ranges instead of fixed chunks', async () => {
    const pdf = {
      numPages: 6,
      getPage: vi.fn(async (page: number) => ({
        getTextContent: async () => ({ items: [{ str: page === 2 ? '1. Introduction' : page === 5 ? '2. Methods' : `body ${page}`, transform: [1, 0, 0, 1, 30, 500], hasEOL: true }] }),
      })),
    }
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs') as any
    pdfjs.getDocument.mockReturnValue({ promise: pdf })
    const extracted = await extractPages(btoa('fixture'))
    const tree = await buildPageIndex(extracted, vi.fn().mockResolvedValue('{"title":"S","summary":""}'), { minSectionPages: 1 })
    expect(tree.nodes.map(node => [node.startPage, node.endPage])).toEqual([[0, 0], [1, 3], [4, 5]])
  })
})

describe('score response validation', () => {
  for (const raw of [
    '[{"id":3,"score":1},{"id":1,"score":2},{"id":2,"score":3}]',
    '[{"id":"0","score":1},{"id":1,"score":2},{"id":2,"score":3}]',
    '[{"id":0,"score":1},{"id":1},{"id":2,"score":3}]',
    '[{"id":0,"score":1},{"id":0,"score":2},{"id":2,"score":3}]',
  ]) {
    it(`degrades malformed score output: ${raw}`, async () => {
      const result = await scoreAndSelect(makeRoot(), pages, 'q', vi.fn().mockResolvedValue(raw))
      expect(result).toMatchObject({ degraded: true, degradedReason: 'invalid-score-schema' })
      expect(result.selected.map(node => node.title)).toEqual(['Introduction'])
    })
  }

  it('labels missing score coverage separately from malformed schema', async () => {
    const result = await scoreAndSelect(makeRoot(), pages, 'q', vi.fn().mockResolvedValue('[]'))
    expect(result).toMatchObject({ degraded: true, degradedReason: 'incomplete-score-coverage' })
  })

  it('retains a score request failure rather than mislabelling it as bad schema', async () => {
    const result = await scoreAndSelect(makeRoot(), pages, 'q', vi.fn().mockRejectedValue(new Error('timeout')))
    expect(result).toMatchObject({ degraded: true, degradedReason: 'score-request-failed' })
  })

  it('accepts fenced and prose-wrapped valid JSON', async () => {
    const result = await scoreAndSelect(makeRoot(), pages, 'q', vi.fn().mockResolvedValue('Here:\n```JSON\n[{"id":1,"score":9},{"id":0,"score":1},{"id":2,"score":2}]\n```\nThanks'))
    expect(result.degraded).toBe(false)
    expect(result.selected.map(node => node.title)).toEqual(['Methods'])
  })
})
