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

  it('历史碎片计划：同论文/页/文本的 3 条跨毫秒碎片 → 1 更新 + 2 删除', () => {
    const base = { paperId: 'p1', pageNum: 1, text: 'ale reinforcement learning (RL) without' }
    const plan = planFragmentMerge([
      { id: 'a', ...base, startOffset: 252, endOffset: 298, createdAt: 1788435487939 },
      { id: 'b', ...base, startOffset: 298, endOffset: 392, createdAt: 1788435487940 },
      { id: 'c', ...base, startOffset: 392, endOffset: 449, createdAt: 1788435487940 },
    ])
    expect(plan.updates).toEqual([{ id: 'a', endOffset: 449 }])
    expect(plan.removals).toEqual(['b', 'c'])
  })

  it('相隔 3000ms 的相同文本不合并（单行簇各自不动）', () => {
    const plan = planFragmentMerge([
      { id: 'a', paperId: 'p1', pageNum: 1, text: 'x', startOffset: 0, endOffset: 10, createdAt: 1000 },
      { id: 'b', paperId: 'p1', pageNum: 1, text: 'x', startOffset: 0, endOffset: 10, createdAt: 4000 },
    ])
    expect(plan.updates).toEqual([])
    expect(plan.removals).toEqual([])
  })

  it('链式时间窗：相邻各 1900ms（总跨度 3800ms）仍并为一簇', () => {
    const base = { paperId: 'p1', pageNum: 1, text: 'x' }
    const plan = planFragmentMerge([
      { id: 'a', ...base, startOffset: 0, endOffset: 10, createdAt: 1000 },
      { id: 'b', ...base, startOffset: 10, endOffset: 20, createdAt: 2900 },
      { id: 'c', ...base, startOffset: 20, endOffset: 30, createdAt: 4800 },
    ])
    expect(plan.updates).toEqual([{ id: 'a', endOffset: 30 }])
    expect(plan.removals).toEqual(['b', 'c'])
  })
})
