import { describe, expect, it } from 'vitest'
import { normalizeSourceList, isJumpable } from '../utils/sourceRef'

describe('来源归一（#1）', () => {
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
