import { describe, expect, it, vi } from 'vitest'
import type { TocTreeArtifact } from '../localPdf/tocTree'
import {
  buildTocRoutingPrompt,
  materializePageRanges,
  parseTocRoutingResponse,
  resolveTocNodeIds,
  routeTocQuestion,
} from '../localPdf/tocRouting'

const tree: TocTreeArtifact = {
  version: 'toc-tree-v1',
  paperId: 'paper',
  source: 'native-outline',
  inputSha256: 'a'.repeat(64),
  roots: [
    {
      id: 'n0', title: 'Introduction', depth: 0, startPage: 0, endPage: 1, source: 'native-outline', children: [],
    },
    {
      id: 'n1', title: 'Methods', depth: 0, startPage: 2, endPage: 4, source: 'native-outline', children: [
        { id: 'n1.0', title: 'Model', depth: 1, startPage: 3, endPage: 4, source: 'native-outline', children: [] },
      ],
    },
    {
      id: 'n2', title: 'Results', depth: 0, startPage: 5, endPage: 5, source: 'native-outline', children: [],
    },
  ],
}

describe('TOC routing prompt and strict response parser', () => {
  it('exposes only the question and title-only tree with display ranges', () => {
    const prompt = buildTocRoutingPrompt('Which model is used?', tree)
    expect(prompt).toContain('Which model is used?')
    expect(prompt).toContain('n1  Methods  [pages 3-5]')
    expect(prompt).toContain('  n1.0  Model  [pages 4-5]')
    expect(prompt).not.toContain('paper')
    expect(prompt).not.toContain('summary')
    expect(prompt).not.toContain('page text')
  })

  it('accepts exactly one strict JSON object', () => {
    expect(parseTocRoutingResponse('{"reasoning":"model section","node_ids":["n1.0"]}'))
      .toEqual({ reasoning: 'model section', nodeIds: ['n1.0'] })
    const invalid = [
      '```json\n{"reasoning":"x","node_ids":["n1"]}\n```',
      'Answer: {"reasoning":"x","node_ids":["n1"]}',
      '{"reasoning":"x","node_ids":["unknown"]}',
      '{"reasoning":"x","node_ids":[1]}',
      '{"reasoning":"x","node_ids":["n0","n1","n2","n1.0"]}',
      '{"reasoning":"x","node_ids":[]}',
      '{"reasoning":"x","node_ids":["n1"],"extra":true}',
    ]
    for (const raw of invalid) expect(() => parseTocRoutingResponse(raw, tree)).toThrow()
  })
})

describe('TOC routing retries and node resolution', () => {
  it('uses one call for valid output and resolves descendants without reordering unrelated nodes', async () => {
    const complete = vi.fn(async () => '{"reasoning":"specific first","node_ids":["n2","n1","n1.0"]}')
    const result = await routeTocQuestion('q', tree, complete)
    expect(complete).toHaveBeenCalledTimes(1)
    expect(result.rawAttempts).toHaveLength(1)
    expect(result.requestedNodeIds).toEqual(['n2', 'n1', 'n1.0'])
    expect(result.selectedNodeIds).toEqual(['n2', 'n1.0'])
    expect(result.selectedRanges).toEqual([
      { nodeId: 'n2', startPage: 5, endPage: 5 },
      { nodeId: 'n1.0', startPage: 3, endPage: 4 },
    ])
    expect(resolveTocNodeIds(['n2', 'n2', 'n0'], tree)).toEqual(['n2', 'n0'])
  })

  it('makes exactly two logical calls after invalid JSON and records both attempts', async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce('invalid')
      .mockResolvedValueOnce('{"reasoning":"intro","node_ids":["n0"]}')
    const result = await routeTocQuestion('q', tree, complete)
    expect(complete).toHaveBeenCalledTimes(2)
    expect(result.rawAttempts).toEqual(['invalid', '{"reasoning":"intro","node_ids":["n0"]}'])
  })

  it('rejects after two invalid logical calls and never substitutes a node', async () => {
    const complete = vi.fn(async () => 'invalid')
    await expect(routeTocQuestion('q', tree, complete)).rejects.toThrow(/two invalid/i)
    expect(complete).toHaveBeenCalledTimes(2)
    expect(resolveTocNodeIds(['unknown'], tree)).toEqual([])
  })
})

describe('TOC page-range materialization', () => {
  it('deduplicates overlapping pages and preserves range relevance order', () => {
    const pages = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5']
    const result = materializePageRanges(pages, [
      { nodeId: 'parent', startPage: 2, endPage: 4 },
      { nodeId: 'child', startPage: 3, endPage: 4 },
      { nodeId: 'other', startPage: 0, endPage: 1 },
    ], text => text.length, 100)
    expect(result.text).toBe('P2\n\nP3\n\nP4\n\n---\n\nP0\n\nP1')
    expect(result.trace.filter(item => item.source).map(item => item.source!.page)).toEqual([2, 3, 4, 0, 1])
    expect(result.trace.some(item => item.source === null)).toBe(true)
    for (const item of result.trace) if (item.source) {
      expect(result.text.slice(item.contextStart, item.contextEnd))
        .toBe(pages[item.source.page].slice(item.source.start, item.source.end))
    }
  })

  it('clips from the selected node beginning at a grapheme-safe exact source offset', () => {
    const pages = [`${'a'.repeat(4094)}👨‍👩‍👧‍👦tail`]
    const result = materializePageRanges(pages, [{ nodeId: 'n0', startPage: 0, endPage: 0 }], text => text.length, 4096)
    expect(result.tokenCount).toBeLessThanOrEqual(4096)
    expect(result.text).toBe('a'.repeat(4094))
    const source = result.trace.at(-1)!.source!
    expect(source).toEqual({ page: 0, start: 0, end: 4094 })
  })
})
