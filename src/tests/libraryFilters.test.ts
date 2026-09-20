import { describe, expect, it } from 'vitest'
import type { Paper } from '../stores/paper'
import { filterLibraryPapers, formatAuthors } from '../utils/libraryFilters'

const papers: Paper[] = [
  { id: 'attention', title: 'Attention Is All You Need', authors: ['Ashish Vaswani'], abstract: '', year: 2017, tags: ['Transformer'], status: 'reading', fileName: 'attention.pdf', fileHash: 'h-attention', addedAt: 10, knowledgeBaseId: 'default' },
  { id: 'bert', title: 'BERT: Pre-training of Deep Bidirectional Transformers', authors: ['Jacob Devlin'], abstract: '', year: 2018, tags: ['NLP'], status: 'unread', fileName: 'bert.pdf', fileHash: 'h-bert', addedAt: 30, knowledgeBaseId: 'default' },
  { id: 'retrieval', title: 'Retrieval-Augmented Generation', authors: ['Patrick Lewis'], abstract: '', year: 2020, tags: ['检索增强'], status: 'done', fileName: 'rag-original.pdf', fileHash: 'h-retrieval', addedAt: 20, knowledgeBaseId: 'default' },
]

describe('library search and reading filters', () => {
  it('combines a case-insensitive search with reading status', () => {
    expect(filterLibraryPapers(papers, { query: '  TRANSFORMER  ', status: 'reading' }).map(p => p.id)).toEqual(['attention'])
    expect(filterLibraryPapers(papers, { query: 'TRANSFORMER', status: 'unread' }).map(p => p.id)).toEqual(['bert'])
  })

  it.each([
    ['vaswani', 'attention'],
    ['检索增强', 'retrieval'],
    ['rag-original.pdf', 'retrieval'],
  ])('finds papers by author, tag or filename: %s', (query, id) => {
    expect(filterLibraryPapers(papers, { query }).map(p => p.id)).toEqual([id])
  })

  it('shows newest additions first, and supports title order without changing store data', () => {
    expect(filterLibraryPapers(papers).map(p => p.id)).toEqual(['bert', 'retrieval', 'attention'])
    expect(filterLibraryPapers(papers, { sort: 'title' }).map(p => p.id)).toEqual(['attention', 'bert', 'retrieval'])
    expect(papers.map(p => p.id)).toEqual(['attention', 'bert', 'retrieval'])
  })

  it('returns no matches for an absent query and restores all papers when cleared', () => {
    expect(filterLibraryPapers(papers, { query: 'no such paper' })).toEqual([])
    expect(filterLibraryPapers(papers, { query: ' ', status: 'all' })).toHaveLength(3)
    expect(filterLibraryPapers([], { status: 'reading' })).toEqual([])
  })
})

describe('作者展示（#9）', () => {
  it('4 位以内原样展示', () => {
    expect(formatAuthors(['A', 'B'])).toBe('A, B')
  })
  it('超过 4 位截断为「等 N 位作者」', () => {
    expect(formatAuthors(['A', 'B', 'C', 'D', 'E', 'F'])).toBe('A, B, C, D 等 2 位作者')
  })
  it('空/缺省回退占位文案', () => {
    expect(formatAuthors([])).toBe('作者信息待补充')
    expect(formatAuthors(undefined)).toBe('作者信息待补充')
  })
})
