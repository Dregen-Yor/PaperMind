import { describe, expect, it } from 'vitest'
import { mergeSegments, planFragmentMerge } from '../utils/highlightMerge'

describe('划选合并（#7）', () => {
  it('相邻/重叠片段合并为一段（一次划选只留一条记录）', () => {
    expect(mergeSegments([
      { page: 1, start: 252, end: 298 },
      { page: 1, start: 298, end: 392 },
      { page: 1, start: 392, end: 449 },
    ])).toEqual([{ page: 1, start: 252, end: 449 }])
  })

  it('中间有缺口的片段保持两条（不同划选不误并）', () => {
    expect(mergeSegments([
      { page: 1, start: 10, end: 20 },
      { page: 1, start: 30, end: 40 },
    ])).toHaveLength(2)
  })

  it('乱序输入按起点排序后合并', () => {
    expect(mergeSegments([
      { page: 1, start: 100, end: 120 },
      { page: 1, start: 50, end: 101 },
    ])).toEqual([{ page: 1, start: 50, end: 120 }])
  })

  it('历史碎片计划：同论文/页/文本/秒的 3 条 → 1 更新 + 2 删除', () => {
    const base = { paperId: 'p1', pageNum: 1, text: 'ale reinforcement learning (RL) without', createdAt: 1000 }
    const plan = planFragmentMerge([
      { id: 'a', ...base, startOffset: 252, endOffset: 298 },
      { id: 'b', ...base, startOffset: 298, endOffset: 392 },
      { id: 'c', ...base, startOffset: 392, endOffset: 449 },
    ])
    expect(plan.updates).toEqual([{ id: 'a', endOffset: 449 }])
    expect(plan.removals).toEqual(['b', 'c'])
  })

  it('不同秒的相同文本不合并（跨会话重复划选保持独立）', () => {
    const plan = planFragmentMerge([
      { id: 'a', paperId: 'p1', pageNum: 1, text: 'x', startOffset: 0, endOffset: 10, createdAt: 1000 },
      { id: 'b', paperId: 'p1', pageNum: 1, text: 'x', startOffset: 0, endOffset: 10, createdAt: 2000 },
    ])
    expect(plan.updates).toEqual([])
    expect(plan.removals).toEqual([])
  })
})
