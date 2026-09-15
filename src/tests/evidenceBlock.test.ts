import { describe, it, expect } from 'vitest'
import {
  buildEvidenceBlocks,
  detectRunningLines,
  classifySourceType,
  type EvidenceBlock,
  type EvidenceBlockOptions,
} from '../utils/evidenceBlock'

/** 段落文本，长度可控，便于精确推导分块边界。 */
const para = (tag: string, chars: number) => `${tag} ${'x'.repeat(chars)}`

const OPTS: EvidenceBlockOptions = { targetChars: 1000, maxChars: 1200, minChars: 600 }

const ids = (blocks: EvidenceBlock[]) => blocks.map(b => b.id)

describe('buildEvidenceBlocks — 结构契约', () => {
  it('空输入返回空数组', () => {
    expect(buildEvidenceBlocks([])).toEqual([])
  })

  it('单页短文形成一个块，ID 与相邻关系自洽', () => {
    const blocks = buildEvidenceBlocks(['A short body paragraph.'], OPTS)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({
      id: 'B001',
      order: 0,
      startPage: 0,
      endPage: 0,
      previousId: null,
      nextId: null,
    })
  })

  it('ID 按 B001 递增，order / previousId / nextId 串成有序链表', () => {
    const pages = [para('p0', 1100), para('p1', 1100), para('p2', 1100)]
    const blocks = buildEvidenceBlocks(pages, OPTS)
    expect(blocks.length).toBeGreaterThan(1)
    expect(ids(blocks)).toEqual(blocks.map((_, i) => `B${String(i + 1).padStart(3, '0')}`))
    expect(blocks.map(b => b.order)).toEqual(blocks.map((_, i) => i))
    expect(blocks[0].previousId).toBeNull()
    expect(blocks.at(-1)!.nextId).toBeNull()
    for (let i = 1; i < blocks.length; i++) {
      expect(blocks[i].previousId).toBe(blocks[i - 1].id)
      expect(blocks[i - 1].nextId).toBe(blocks[i].id)
    }
  })

  it('页码为 0-based 闭区间，且覆盖原文所在页', () => {
    const blocks = buildEvidenceBlocks([para('p0', 500), para('p1', 500), para('p2', 500)], OPTS)
    for (const block of blocks) {
      expect(block.startPage).toBeGreaterThanOrEqual(0)
      expect(block.endPage).toBeLessThanOrEqual(2)
      expect(block.startPage).toBeLessThanOrEqual(block.endPage)
    }
    expect(blocks[0].startPage).toBe(0)
    expect(blocks.at(-1)!.endPage).toBe(2)
  })
})

describe('buildEvidenceBlocks — 原文正确性（§5.3）', () => {
  it('rawText 是原文片段的逐字拼接，不含任何清洗痕迹', () => {
    const pages = ['Running Title\n\nBody text here.\n']
    const blocks = buildEvidenceBlocks(pages, OPTS)
    expect(blocks[0].rawText).toContain('Running Title')
    expect(blocks[0].rawText).toContain('Body text here.')
  })

  it('页眉页脚只从 normalizedText 移除，rawText 保持不变', () => {
    const pages = [
      'Journal of Testing Vol 1\n\nFirst body paragraph.\n\n1',
      'Journal of Testing Vol 1\n\nSecond body paragraph.\n\n2',
      'Journal of Testing Vol 1\n\nThird body paragraph.\n\n3',
      'Journal of Testing Vol 1\n\nFourth body paragraph.\n\n4',
    ]
    const blocks = buildEvidenceBlocks(pages, OPTS)
    for (const block of blocks) {
      expect(block.rawText).toContain('Journal of Testing Vol 1')
      expect(block.normalizedText).not.toContain('Journal of Testing Vol 1')
    }
    expect(blocks[0].normalizedText).toContain('First body paragraph.')
  })

  it('断词连字符只在 normalizedText 复原', () => {
    const pages = ['A trans-\nformer model is proposed.']
    const blocks = buildEvidenceBlocks(pages, OPTS)
    expect(blocks[0].rawText).toContain('trans-\nformer')
    expect(blocks[0].normalizedText).toContain('transformer')
    expect(blocks[0].normalizedText).not.toContain('trans-\nformer')
  })

  it('normalizedText 折叠多余空白', () => {
    const blocks = buildEvidenceBlocks(['A    body\n\nwith   gaps.'], OPTS)
    expect(blocks[0].normalizedText).not.toMatch(/\s{2,}/)
  })

  it('normalizedText 非空且可检索', () => {
    const blocks = buildEvidenceBlocks([para('term', 800)], OPTS)
    expect(blocks[0].normalizedText).toContain('term')
  })
})

describe('buildEvidenceBlocks — 分块边界（§5.1）', () => {
  it('块大小受 maxChars 约束', () => {
    const paragraphs = Array.from({ length: 12 }, (_, i) => para(`p${i}`, 600))
    const blocks = buildEvidenceBlocks([paragraphs.join('\n\n')], OPTS)
    for (const block of blocks) expect(block.rawText.length).toBeLessThanOrEqual(OPTS.maxChars!)
  })

  it('优先在自然段落边界切分，不把段落拦腰截断', () => {
    const paragraphs = Array.from({ length: 6 }, (_, i) => para(`p${i}`, 450))
    const source = paragraphs.join('\n\n')
    const blocks = buildEvidenceBlocks([source], OPTS)
    for (const block of blocks) {
      expect(source).toContain(block.rawText)
    }
    // 每个块都由完整段落拼成：段落标签不应缺失
    const covered = blocks.map(b => b.rawText).join('\n\n')
    for (const p of paragraphs) expect(covered).toContain(p)
  })

  it('单个段落超过 maxChars 时被硬切，而不是产生超限块', () => {
    const blocks = buildEvidenceBlocks([para('huge', 3000)], OPTS)
    expect(blocks.length).toBeGreaterThan(1)
    for (const block of blocks) expect(block.rawText.length).toBeLessThanOrEqual(OPTS.maxChars!)
  })

  it('硬切不丢字符：所有块按序拼接等于归一化后的原文', () => {
    const source = para('huge', 3000)
    const blocks = buildEvidenceBlocks([source], OPTS)
    const reassembled = blocks.map(b => b.rawText).join('')
    expect(reassembled.replace(/\s+/g, ' ')).toBe(source.replace(/\s+/g, ' '))
  })

  it('末块过小时并入前一块（在 maxChars 允许范围内）', () => {
    // 1100 + 50：末块只有 50 字符，应被并入前块而不是留下碎片
    const source = `${para('main', 1100)}\n\n${para('tail', 50)}`
    const blocks = buildEvidenceBlocks([source], OPTS)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].rawText).toContain('tail')
  })

  it('末块并入会超过 maxChars 时保持独立', () => {
    const source = `${para('main', 1100)}\n\n${para('tail', 300)}`
    const blocks = buildEvidenceBlocks([source], OPTS)
    expect(blocks).toHaveLength(2)
    expect(blocks.at(-1)!.rawText).toContain('tail')
  })

  it('短页可以跨页合并成一个块', () => {
    const blocks = buildEvidenceBlocks([para('p0', 300), para('p1', 300)], OPTS)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ startPage: 0, endPage: 1 })
  })

  it('空白页不产生空块', () => {
    const blocks = buildEvidenceBlocks(['', '   ', 'real content here'], OPTS)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].startPage).toBe(2)
  })
})

describe('detectRunningLines', () => {
  it('识别跨页重复的首行页眉', () => {
    const pages = [
      'Journal of Testing Vol 1\n\nFirst paragraph.',
      'Journal of Testing Vol 1\n\nSecond paragraph.',
      'Journal of Testing Vol 1\n\nThird paragraph.',
    ]
    expect(detectRunningLines(pages).has('journal of testing vol 1')).toBe(true)
  })

  it('识别纯数字的页脚页码', () => {
    const pages = ['A body.\n\n42', 'Another body.\n\n43', 'More body.\n\n44']
    const running = detectRunningLines(pages)
    expect([...running].some(line => line === '42' || line === '<page-number>')).toBe(true)
  })

  it('不把只在单页出现的正文首行误判为页眉', () => {
    const pages = ['Unique opening A.\n\nrest', 'Unique opening B.\n\nrest', 'Unique opening C.\n\nrest']
    expect(detectRunningLines(pages).has('unique opening a.')).toBe(false)
  })

  it('页数过少时不启用页眉检测', () => {
    expect(detectRunningLines(['Header\n\nbody']).size).toBe(0)
  })
})

describe('classifySourceType', () => {
  it('识别图注', () => {
    expect(classifySourceType('Figure 3: The proposed architecture.')).toBe('figure-caption')
    expect(classifySourceType('Fig. 2. Ablation results.')).toBe('figure-caption')
    expect(classifySourceType('图 3：整体架构')).toBe('figure-caption')
  })

  it('识别表注', () => {
    expect(classifySourceType('Table 1: Main results on QASPER.')).toBe('table-caption')
    expect(classifySourceType('表 2 消融实验结果')).toBe('table-caption')
  })

  it('识别公式密集文本', () => {
    expect(classifySourceType('\\begin{equation} x = \\sum_i w_i z_i \\end{equation}')).toBe('formula')
  })

  it('识别脚注', () => {
    expect(classifySourceType('1 Corresponding author. Email: a@b.c')).toBe('footnote')
  })

  it('默认归为正文', () => {
    expect(classifySourceType('We propose a transformer variant that scales.')).toBe('body')
  })
})
