import { describe, it, expect } from 'vitest'
import type { IndexNode } from '../../../src/utils/pageIndex'
import { expandPages, computeContextPageMetrics, computeRetrievalMetrics } from '../metrics/retrieval'

function node(id: string, start: number, end: number): IndexNode {
  return { title: `S${id}`, nodeId: id, startPage: start, endPage: end, summary: '', nodes: [] }
}

describe('expandPages', () => {
  it('把页码区间展开为去重升序页号', () => {
    expect(expandPages([node('a', 0, 2), node('b', 2, 3)])).toEqual([0, 1, 2, 3])
  })

  it('空输入返回空数组', () => {
    expect(expandPages([])).toEqual([])
  })
})

describe('computeContextPageMetrics', () => {
  it('uses the first gold page position in deduplicated prompt order', () => {
    expect(computeContextPageMetrics([4, 1, 7, 1], [7, 8])).toEqual({
      contextPageMrr: 1 / 3,
      evidenceRecall: 0.5,
      evidenceHit: 1,
      contextPrecision: 1 / 3,
    })
  })

  it('writes four zeros for an eligible miss', () => {
    expect(computeContextPageMetrics([], [2])).toEqual({
      contextPageMrr: 0,
      evidenceRecall: 0,
      evidenceHit: 0,
      contextPrecision: 0,
    })
  })

  it('多个 gold 页全部覆盖时 recall=1、precision=1', () => {
    expect(computeContextPageMetrics([0, 1, 2], [0, 1, 2])).toEqual({
      contextPageMrr: 1,
      evidenceRecall: 1,
      evidenceHit: 1,
      contextPrecision: 1,
    })
  })

  it('重复页不改变名次（页序先做首次出现去重）', () => {
    // 去重后 [5, 9]；gold 9 在第 2 位
    expect(computeContextPageMetrics([5, 5, 9, 5], [9]).contextPageMrr).toBe(0.5)
    expect(computeContextPageMetrics([5, 5, 9, 5], [9]).contextPrecision).toBe(0.5)
  })

  it('空上下文记 0，不产生除零', () => {
    const m = computeContextPageMetrics([], [3])
    expect(m.contextPrecision).toBe(0)
    expect(Number.isNaN(m.contextPrecision)).toBe(false)
  })
})

describe('指标层只认最终页序，而非被选中候选的页区间包络（回归）', () => {
  it('pageOrder 排除 span 包络点名但未产出文本的空白页', () => {
    // selected 的区间包络 cover 页 0-1；页 0 仅含空白，materializer 不为它产出文本，
    // 故最终页序是 [1]。包络会多算一页，把 MRR 从 1 稀释成 0.5。
    const envelope = expandPages([{ startPage: 0, endPage: 1 }])
    expect(envelope).toEqual([0, 1])
    expect(computeContextPageMetrics(envelope, [1]).contextPageMrr).toBe(0.5)
    // 真实页序 [1] 排除包络里的页 0：指标层消费的参数与包络解耦
    expect(computeContextPageMetrics([1], [1]).contextPageMrr).toBe(1)
    expect(computeContextPageMetrics([1], [1]).contextPrecision).toBe(1)
  })
})

describe('computeRetrievalMetrics', () => {
  it('只从 pageOrder 计算四个检索指标并附加 token 估算', () => {
    const m = computeRetrievalMetrics({
      pageOrder: [4, 1, 7, 1],
      evidencePages: [7, 8],
      context: 'x'.repeat(400),
    })
    expect(m).toEqual({
      contextPageMrr: 1 / 3,
      evidenceRecall: 0.5,
      evidenceHit: 1,
      contextPrecision: 1 / 3,
      contextTokens: 100,
    })
  })

  it('空上下文同样写出四个 0，不退化为缺失指标', () => {
    expect(computeRetrievalMetrics({ pageOrder: [], evidencePages: [2], context: '' })).toEqual({
      contextPageMrr: 0,
      evidenceRecall: 0,
      evidenceHit: 0,
      contextPrecision: 0,
      contextTokens: 0,
    })
  })
})
