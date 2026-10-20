import { describe, expect, it } from 'vitest'
import { normalizeSourceList, isJumpable, sourceRouteQuery, sourceFromRouteQuery } from '../utils/sourceRef'

describe('来源归一（#1）', () => {
  it('跨论文跳转保留句子与区域定位，并拒绝无效坐标', () => {
    const ref = { label: 'p2', paperId: 'paper:1', startPage: 1, endPage: 1,
      region: { x: 0.1, y: 0.2, width: 0.4, height: 0.08 }, quote: 'A measured score of 74.7' }
    const query = sourceRouteQuery(ref)
    expect(query).toEqual({ page: '2', region: '0.1,0.2,0.4,0.08', quote: 'A measured score of 74.7' })
    expect(sourceFromRouteQuery('paper:1', query)).toEqual(ref)
    expect(sourceFromRouteQuery('paper:1', { page: '2', region: '0.1,0.2,2,0.08' }))
      .toEqual({ label: 'p2', paperId: 'paper:1', startPage: 1, endPage: 1 })
  })
  it('旧字符串数组 → 不可跳转的纯标签', () => {
    const refs = normalizeSourceList(['Pages 1–2: 老数据', 'Pages 3–3: x'])
    expect(refs).toEqual([{ label: 'Pages 1–2: 老数据' }, { label: 'Pages 3–3: x' }])
    expect(refs.every(r => !isJumpable(r))).toBe(true)
  })
  it('结构化对象保留 paperId 与页区间', () => {
    const refs = normalizeSourceList([{ label: 'Pages 11–15: R1', paperId: 'p1', startPage: 10, endPage: 14 }])
    expect(refs[0]).toEqual({ label: 'Pages 11–15: R1', paperId: 'p1', startPage: 10, endPage: 14 })
    expect(isJumpable(refs[0])).toBe(true)
  })
  it('脏输入被丢弃或降级，不崩溃', () => {
    expect(normalizeSourceList(null)).toEqual([])
    expect(normalizeSourceList([42, '', { paperId: 'x' }, { label: 'ok', startPage: 'nope' }]))
      .toEqual([{ label: 'ok' }])
  })
})

it('round trips page ranges through href and route queries without changing single-page URLs', async () => {
  const { evidenceHref, parseEvidenceHref } = await import('../utils/sourceRef')
  expect(evidenceHref('p', 1)).toBe('paper-source:p:1')
  const region = { x: .1, y: .2, width: .3, height: .4 }
  expect(parseEvidenceHref(evidenceHref('p', 1, region, 'quote'))).toMatchObject({ startPage: 1, endPage: 1, region, quote: 'quote' })
  expect(parseEvidenceHref(evidenceHref('p', 1, undefined, '', 3))).toMatchObject({ startPage: 1, endPage: 3 })
  expect(parseEvidenceHref('paper-source:p:3-1')).toBeNull()
  const query = sourceRouteQuery({ label: 'range', paperId: 'p', startPage: 1, endPage: 3 })
  expect(query).toEqual({ page: '2', endPage: '4' })
  expect(sourceFromRouteQuery('p', query)).toMatchObject({ startPage: 1, endPage: 3 })
})
