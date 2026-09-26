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
    const { pages, sectionPages } = sectionsToPages(['Empty', 'Real'], [[], ['body']])
    expect(sectionPages[0]).toEqual([])
    expect(sectionPages[1].length).toBeGreaterThan(0)
    expect(pages.join('\u0000')).toContain('Empty')
  })

  it('不改变既有输出：pages 与 paragraphToPage 对固定输入产出确定值', () => {
    // 必须拿**字面量**钉。比两次调用（`expect(f(x)).toBe(f(x))`）是拿函数与自己比，
    // 名字再像「逐字不变」也不可能失败。下面的期望值是本次改动前实现的实际输出：
    // 封页条件、标题与首段的耦合、段落切片任意一处被改都会让它变红。
    const { pages, paragraphToPage } = sectionsToPages(['A', 'B', 'C'], [['a1', 'a2'], ['b1'], ['c1', 'c2', 'c3']])
    expect(paragraphToPage).toEqual([0, 0, 0, 0, 0, 0])
    expect(pages).toEqual(['A\n\na1\n\na2\n\nB\n\nb1\n\nC\n\nc1\n\nc2\n\nc3'])
  })

  it('跨封页边界时节号随之 +1（节区间与打包同源的关键场景）', () => {
    // 单页输入钉不住封页条件：`PSEUDO_PAGE_CHARS` 或 `bufferLen + text.length > …`
    // 被改动时单页 golden 照过。这里先顶满第一页，再验证第二节确实落到**第二页**。
    const names = ['Filler', 'Method']
    const sections = [['a'.repeat(PSEUDO_PAGE_CHARS - 100)], ['b'.repeat(200)]]
    const { pages, paragraphToPage, sectionPages } = sectionsToPages(names, sections)
    expect(pages).toHaveLength(2)
    expect(paragraphToPage).toEqual([0, 1])
    expect(sectionPages).toEqual([[0], [1]])
    expect(pages[1]).toBe(`Method\n\n${'b'.repeat(200)}`)
  })
})
