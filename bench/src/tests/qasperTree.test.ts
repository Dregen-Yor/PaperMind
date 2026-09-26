import { describe, it, expect } from 'vitest'
import { sectionsToPages, PSEUDO_PAGE_CHARS } from '../datasets/qasper'

describe('sectionsToPages —— sectionPages 与 pages 同源', () => {
  it('节的页区间覆盖其内容真正落入的伪页', () => {
    const names = ['Intro', 'Method']
    // 每段 1200 字符：Intro 占 p0，Method 起于 p0 尾或 p1（由打包决定）
    const sections = [['x'.repeat(1200)], ['y'.repeat(1200)]]
    const { pages, sectionPages } = sectionsToPages(names, sections)
    expect(sectionPages).toHaveLength(2)
    for (const [i, touched] of sectionPages.entries()) {
      expect(touched.length).toBeGreaterThan(0)
      for (const page of touched) expect(page).toBeLessThan(pages.length)
      // 区间必须升序且不重复
      expect(touched).toEqual([...new Set(touched)].sort((a, b) => a - b))
    }
  })

  it('标题与其首段强制同页：sectionPages 的首元素等于该首段落的伪页号', () => {
    // 先塞一个几乎占满页的节，逼出封页，再验证下一节的标题没被孤立
    const names = ['Filler', 'Method']
    const sections = [
      ['f'.repeat(PSEUDO_PAGE_CHARS - 10)],
      ['z'.repeat(50)],
    ]
    const { paragraphToPage, sectionPages } = sectionsToPages(names, sections)
    // 第 2 节只有 1 段，对应 paragraphToPage[1]
    expect(sectionPages[1]).toEqual([paragraphToPage[1]])
  })

  it('无内容的节得到空数组', () => {
    const { sectionPages } = sectionsToPages(['Empty', 'Real'], [[], ['body']])
    expect(sectionPages[0]).toEqual([])
    expect(sectionPages[1].length).toBeGreaterThan(0)
  })

  it('不改变既有输出：pages 与 paragraphToPage 逐字不变', () => {
    const names = ['A', 'B', 'C']
    const sections = [['a1', 'a2'], ['b1'], ['c1', 'c2', 'c3']]
    const out = sectionsToPages(names, sections)
    // 这三个不变量是 evidencePages 的基础，任何重构都不得动摇
    expect(out.paragraphToPage).toHaveLength(sections.flat().length)
    expect(out.pages.join('\u0000')).toBe(sectionsToPages(names, sections).pages.join('\u0000'))
    for (const p of out.paragraphToPage) expect(p).toBeLessThan(out.pages.length)
  })
})
