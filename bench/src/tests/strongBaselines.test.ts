import { describe, expect, it } from 'vitest'
import { buildTokenStream, chunkTokenStream, sliceText, spanPages, tokenRangeToPieces } from '../baselines/tokenStream'
import { detectSections, isHeadingLine } from '../baselines/sections'
import { expandWithinSection } from '../baselines/contiguous'

// 模拟 BGE/XLM-R Metaspace 语义：token 自带词前空白（▁），还原时转空格
const tokenizer = { tokenize: (text: string) => text.split(/\s+/).filter(Boolean).map(w => `▁${w}`) }

describe('tokenStream', () => {
  it('keeps page numbers on tokens and inserts page breaks only at page changes', () => {
    const { tokens } = buildTokenStream(['alpha beta', 'gamma'], tokenizer)
    expect(tokens.map(t => t.page)).toEqual([0, 0, 1])
    // 跨页换行后首个 token 携带 ▁（词前空白），与生产 chunker 行为一致
    expect(sliceText(tokens, 0, 3)).toBe('alpha beta\n gamma')
    expect(sliceText(tokens, 0, 2)).toBe('alpha beta')
  })

  it('spanPages covers all pages touched by the range', () => {
    const { tokens } = buildTokenStream(['a b', 'c d', 'e'], tokenizer)
    // token 1..3 覆盖页 0 与页 1
    expect(spanPages(tokens, 1, 4)).toEqual({ startPage: 0, endPage: 1 })
  })

  it('chunkTokenStream mirrors chunkPages stepping and records token offsets', () => {
    const { tokens } = buildTokenStream(['a b c d e'], tokenizer)
    const passages = chunkTokenStream(tokens, { chunkSize: 3, overlap: 1 })
    expect(passages.map(p => [p.startToken, p.endToken])).toEqual([[0, 3], [2, 5]])
    expect(passages[0].text).toBe('a b c')
    expect(passages[1].tokenCount).toBe(3)
  })

  it('records exact page pieces whose text concatenates back to every passage', () => {
    const { tokens } = buildTokenStream(['alpha beta', 'gamma delta epsilon'], tokenizer)
    const passages = chunkTokenStream(tokens, { chunkSize: 4, overlap: 1 })
    for (const passage of passages) {
      expect(passage.pieces.map(piece => piece.text).join('')).toBe(passage.text)
    }
    // 首个跨页 passage 的页间换行归属于新页分片
    const crossPage = passages.find(p => p.pieces.length > 1)!
    expect(crossPage.pieces.map(piece => piece.page)).toEqual([0, 1])
    expect(crossPage.pieces[1].text.startsWith('\n')).toBe(true)
  })
})

describe('tokenRangeToPieces', () => {
  it('partitions a cross-page range exactly and attaches the page break to the new page', () => {
    const { tokens } = buildTokenStream(['alpha beta', 'gamma delta'], tokenizer)
    const pieces = tokenRangeToPieces(tokens, 0, tokens.length)
    expect(pieces.map(piece => piece.page)).toEqual([0, 1])
    expect(pieces.map(piece => piece.text).join('')).toBe('alpha beta\n gamma delta')
    expect(pieces[0].text).toBe('alpha beta')
    expect(pieces[1].text).toBe('\n gamma delta')
  })

  it('trims only the outer edges of a mid-page range, keeping page attribution', () => {
    const { tokens } = buildTokenStream(['a b c d', 'e f'], tokenizer)
    const pieces = tokenRangeToPieces(tokens, 1, 5)
    expect(pieces.map(piece => piece.page)).toEqual([0, 1])
    expect(pieces.map(piece => piece.text).join('')).toBe('b c d\n e')
  })

  it('pins the leading-whitespace-page divergence from sliceText', () => {
    // 首 token 是独占一页的纯空白：该页被丢弃，于是页间换行成为新页首分片的前导 '\n'
    const leading = [{ text: '▁', page: 0 }, { text: '▁foo', page: 1 }]
    const pieces = tokenRangeToPieces(leading, 0, 2)
    expect(pieces).toEqual([{ page: 1, text: '\n foo' }])
    expect(pieces[0].page).toBe(1)
    expect(pieces.map(piece => piece.text).join('')).toBe('\n foo')
    // 对照：sliceText 的整段 trim 会吃掉这个前导换行 → 二者在此不再等价
    expect(sliceText(leading, 0, 2)).toBe('foo')

    // 尾随的纯空白页则被干净丢弃，与 sliceText 的整段 trim 一致
    const trailing = [{ text: '▁foo', page: 0 }, { text: '▁', page: 1 }]
    expect(tokenRangeToPieces(trailing, 0, 2)).toEqual([{ page: 0, text: 'foo' }])
    expect(sliceText(trailing, 0, 2)).toBe('foo')
  })

  it.each([
    { label: 'an empty range', tokens: [{ text: '▁a', page: 0 }], start: 1, end: 1 },
    { label: 'an all-whitespace range', tokens: [{ text: '▁', page: 0 }, { text: ' ', page: 1 }], start: 0, end: 2 },
  ])('returns no pieces for $label (defensive contract)', ({ tokens, start, end }) => {
    expect(tokenRangeToPieces(tokens, start, end)).toEqual([])
  })
})

describe('isHeadingLine', () => {
  it('accepts markdown, short numbered, known English and Chinese headings', () => {
    expect(isHeadingLine('## Method')).toBe('Method')
    expect(isHeadingLine('3 Approach')).toBe('Approach')
    expect(isHeadingLine('4.1 Dataset Construction')).toBe('Dataset Construction')
    expect(isHeadingLine('Abstract')).toBe('Abstract')
    expect(isHeadingLine('第三章 实验设置')).toBe('第三章 实验设置')
    expect(isHeadingLine('三、方法设计')).toBe('三、方法设计')
  })

  it('rejects heading-like false positives (long numbered sentences)', () => {
    expect(isHeadingLine('2. We then run the full evaluation on the benchmark and report all metrics in the table below for completeness')).toBeNull()
    expect(isHeadingLine('')).toBeNull()
  })
})

describe('detectSections', () => {
  const pages = [
    'This is the preamble talking about the paper.\nIntroduction\nWe study retrieval for papers.\n## Method\nThe method uses sections.\nAnd more detail here.\n2. We then run the full evaluation on the benchmark and report all metrics in the table below for completeness\n## Results\nFinal results are strong.',
    'Appendix material here.',
  ]

  it('produces a preamble section and heading sections, tiling the token stream', () => {
    const sections = detectSections(pages, tokenizer)
    // 页 1 的 'Appendix material here.' 不是标题行，归属最后一个章节
    expect(sections.map(s => s.title)).toEqual(['', 'Introduction', 'Method', 'Results'])
    for (let i = 1; i < sections.length; i++) expect(sections[i].startToken).toBe(sections[i - 1].endToken)
    expect(sections[0].startToken).toBe(0)
    expect(sections.at(-1)!.endToken).toBe(buildTokenStream(pages, tokenizer).tokens.length)
  })

  it('keeps the false-positive sentence inside the preceding section', () => {
    const sections = detectSections(pages, tokenizer)
    const method = sections.find(s => s.title === 'Method')!
    const tokens = buildTokenStream(pages, tokenizer).tokens
    expect(sliceText(tokens, method.startToken, method.endToken)).toContain('for completeness')
  })

  it('maps page spans from the underlying tokens', () => {
    const sections = detectSections(pages, tokenizer)
    const results = sections.find(s => s.title === 'Results')!
    // Results 的正文在页 0，页 1 的尾部内容也归属它
    expect(results.startPage).toBe(0)
    expect(results.endPage).toBe(1)
    expect(sections[0].startPage).toBe(0)
  })

  it('returns a single preamble section for text without any heading', () => {
    const sections = detectSections(['plain text only'], tokenizer)
    expect(sections).toHaveLength(1)
    expect(sections[0].title).toBe('')
    expect(sections[0].startPage).toBe(0)
  })
})

describe('expandWithinSection', () => {
  const pages = ['h a b c d e f g h i j', 'k l m n o p', 'q r s t u v']
  const { tokens } = buildTokenStream(pages, tokenizer)
  // 手工构造章节：A=页0 的 h..j，B=页1，C=页2
  const sA = { title: 'A', startToken: 1, endToken: 11, startPage: 0, endPage: 0 }
  const sB = { title: 'B', startToken: 11, endToken: 17, startPage: 1, endPage: 1 }
  const sC = { title: 'C', startToken: 17, endToken: tokens.length, startPage: 2, endPage: 2 }

  it('grows a centered region within the token budget and never beyond the section', () => {
    const region = expandWithinSection(tokens, [sA, sB, sC], { startToken: 5, endToken: 7 }, 6)
    expect(region).not.toBeNull()
    expect(region!.tokenCount).toBe(6)
    expect(region!.startToken).toBeGreaterThanOrEqual(sA.startToken)
    expect(region!.endToken).toBeLessThanOrEqual(sA.endToken)
    expect(region!.text).toBe('c d e f g h')
    expect(region!.pieces.map(piece => piece.text).join('')).toBe(region!.text)
  })

  it('exposes exact page pieces that concatenate back to a cross-page region text', () => {
    const twoPage = buildTokenStream(['p0 a b c', 'p1 d e f'], tokenizer)
    const whole = { title: 'All', startToken: 0, endToken: twoPage.tokens.length, startPage: 0, endPage: 1 }
    const region = expandWithinSection(twoPage.tokens, [whole], { startToken: 2, endToken: 4 }, 4096)!
    expect(region.pieces.map(piece => piece.page)).toEqual([0, 1])
    expect(region.pieces.map(piece => piece.text).join('')).toBe(region.text)
    // 页间换行归属于新页分片，与 tokenStream 的还原规则一致
    expect(region.pieces[1].text.startsWith('\n')).toBe(true)
  })

  it('reads the whole section when it fits the budget', () => {
    const region = expandWithinSection(tokens, [sA, sB, sC], { startToken: 12, endToken: 13 }, 4096)
    expect(region!.startToken).toBe(sB.startToken)
    expect(region!.endToken).toBe(sB.endToken)
    expect(region!.sectionTitle).toBe('B')
  })

  it('stops at the section boundary even when the budget allows more', () => {
    const region = expandWithinSection(tokens, [sA, sB, sC], { startToken: 8, endToken: 10 }, 100)
    expect(region!.endToken).toBe(sA.endToken)
    expect(region!.startToken).toBe(sA.startToken)
  })

  it('maps the region to all covered pages', () => {
    const region = expandWithinSection(tokens, [sA, sB, sC], { startToken: 12, endToken: 14 }, 4096)
    expect(region!.startPage).toBe(1)
    expect(region!.endPage).toBe(1)
  })

  it('clips an anchor that spills into the next section and returns null outside sections', () => {
    // 锚点从 A 末尾跨到 B：起点在 A → 区域不越过 A 的边界
    const clipped = expandWithinSection(tokens, [sA, sB, sC], { startToken: 9, endToken: 13 }, 4096)
    expect(clipped!.endToken).toBeLessThanOrEqual(sA.endToken)
    expect(expandWithinSection(tokens, [], { startToken: 0, endToken: 2 }, 10)).toBeNull()
  })
})
