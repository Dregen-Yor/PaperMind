import { describe, it, expect } from 'vitest'
import { tocNodePageSpan, tocSelectionToContextGroups, type TocNode } from '../utils/tocTree'

/** 造一个节点；只给本任务用到的字段，children 默认空 */
const node = (over: Partial<TocNode> & { id: string; title: string }): TocNode => ({
  path: [], depth: 0, pages: [], children: [], ...over,
})

const PAGES = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']

describe('tocNodePageSpan', () => {
  it('首片无前缀、后续每片带 \\n\\n，与 pages.slice().join() 同口径', () => {
    const n = node({ id: 'a', title: 'A', pages: [1, 2, 3] })
    const span = tocNodePageSpan(n, PAGES)
    expect(span).toEqual([
      { page: 1, text: 'p1' },
      { page: 2, text: '\n\np2' },
      { page: 3, text: '\n\np3' },
    ])
    expect(span.map(p => p.text).join('')).toBe(PAGES.slice(1, 4).join('\n\n'))
  })

  it('pages 升序输出，乱序输入被归一', () => {
    const n = node({ id: 'a', title: 'A', pages: [3, 1, 2] })
    expect(tocNodePageSpan(n, PAGES).map(p => p.page)).toEqual([1, 2, 3])
  })

  it('pages 为空产出空片段数组', () => {
    expect(tocNodePageSpan(node({ id: 'a', title: 'A' }), PAGES)).toEqual([])
  })

  it('页号越界直接抛错，不静默产出 undefined 文本', () => {
    const n = node({ id: 'a', title: 'A', pages: [99] })
    expect(() => tocNodePageSpan(n, PAGES)).toThrow('toc-page-out-of-range')
  })
})

describe('tocSelectionToContextGroups', () => {
  it('每个选中节点一组，组内按页顺序', () => {
    const groups = tocSelectionToContextGroups([
      node({ id: 'a', title: 'A', pages: [0, 1] }),
      node({ id: 'b', title: 'B', pages: [4, 5] }),
    ], PAGES)
    expect(groups).toHaveLength(2)
    expect(groups[0].pieces.map(p => p.page)).toEqual([0, 1])
    expect(groups[1].pieces.map(p => p.page)).toEqual([4, 5])
  })

  it('pages 为空的节点被跳过，不产生空组', () => {
    const groups = tocSelectionToContextGroups([
      node({ id: 'a', title: 'A' }),
      node({ id: 'b', title: 'B', pages: [2] }),
    ], PAGES)
    expect(groups).toHaveLength(1)
    expect(groups[0].pieces.map(p => p.page)).toEqual([2])
  })

  it('兄弟节点共用伪页时两组都产出该页——重叠由物化器按首次出现去重', () => {
    const groups = tocSelectionToContextGroups([
      node({ id: 'a', title: 'A', pages: [3] }),
      node({ id: 'b', title: 'B', pages: [3] }),
    ], PAGES)
    expect(groups).toHaveLength(2)
    expect(groups.every(g => g.pieces[0].page === 3)).toBe(true)
  })
})
