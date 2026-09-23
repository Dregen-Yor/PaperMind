import { describe, expect, it } from 'vitest'
import { buildPassages, createEstimatingTokenCounter, hasPassagePartition } from '../utils/passages'

const counter = createEstimatingTokenCounter()
const LONG = `这在论文里是一段很长的正文。${'filler words here '.repeat(40)}`

function joined(passages: { text: string; pieces: { page: number; text: string }[] }[]): string {
  return passages.map(p => p.pieces.map(piece => piece.text).join('')).join('|')
}

describe('buildPassages', () => {
  it('pieces 拼接逐字等于 text', () => {
    const passages = buildPassages(['Intro\nFirst paragraph.\n\nSecond paragraph.', 'Third paragraph.'], counter)
    for (const passage of passages) {
      expect(passage.pieces.map(piece => piece.text).join('')).toBe(passage.text)
      expect(hasPassagePartition(passage)).toBe(true)
    }
  })

  it('标题行并入其后一段的段首，该段落的小节为标题', () => {
    const passages = buildPassages(['Introduction\nWe study X.'], counter, { minTokens: 1 })
    expect(passages).toHaveLength(1)
    expect(passages[0].text.startsWith('Introduction')).toBe(true)
    expect(passages[0].subsection).toBe('Introduction')
  })

  it('不足 minTokens 的段落在小节内向后合并', () => {
    const pages = ['Abstract\nShort one.\n\nShort two.\n\nShort three.']
    const passages = buildPassages(pages, counter, { minTokens: 20 })
    expect(passages).toHaveLength(1)
    expect(passages[0].text).toContain('Short one.')
    expect(passages[0].text).toContain('Short three.')
  })

  it('小节末尾的小段保留，不跨标题合并', () => {
    const pages = ['Introduction\nTiny intro.', 'Related Work\nTiny related work.']
    const passages = buildPassages(pages, counter, { minTokens: 50 })
    expect(passages).toHaveLength(2)
    expect(passages[0].subsection).toBe('Introduction')
    expect(passages[1].subsection).toBe('Related Work')
    expect(passages[0].text).not.toContain('Tiny related work')
  })

  it('超过 maxTokens 的段落在句子边界切开', () => {
    const pages = [`Methods\n${LONG}`]
    const passages = buildPassages(pages, counter, { minTokens: 10, maxTokens: 60 })
    expect(passages.length).toBeGreaterThan(1)
    for (const passage of passages) expect(passage.tokenCount).toBeLessThanOrEqual(120)
  })

  it('跨页自然段按页分片，pieces 页号递增且连续', () => {
    const pages = ['Abstract\nA sentence that continues', 'onto the next page.']
    const passages = buildPassages(pages, counter, { minTokens: 1 })
    expect(passages).toHaveLength(1)
    expect(passages[0].pieces.map(piece => piece.page)).toEqual([0, 1])
    expect(passages[0].pieces[0].text.endsWith('continues')).toBe(true)
  })

  it('searchText 去掉页眉页码，text 保持原文', () => {
    const pages = [
      'PaperMind Journal Vol 3\nReal content here.\n12',
      'PaperMind Journal Vol 3\nMore content.\n13',
      'PaperMind Journal Vol 3\nEven more content.\n14',
    ]
    const passages = buildPassages(pages, counter, { minTokens: 1 })
    const all = passages.map(p => p.searchText).join('\n')
    expect(all).not.toContain('PaperMind Journal Vol 3')
    expect(passages.map(p => p.text).join('')).toContain('PaperMind Journal Vol 3')
  })

  it('prevId / nextId 串成有序链', () => {
    const pages = ['A\npara one.\n\npara two.\n\npara three.']
    const passages = buildPassages(pages, counter, { minTokens: 1 })
    expect(passages[0].prevId).toBeNull()
    expect(passages[passages.length - 1].nextId).toBeNull()
    for (let i = 0; i + 1 < passages.length; i++) expect(passages[i].nextId).toBe(passages[i + 1].id)
  })

  it('空输入返回空数组', () => {
    expect(buildPassages([], counter)).toEqual([])
    expect(joined(buildPassages([], counter))).toBe('')
  })
})
