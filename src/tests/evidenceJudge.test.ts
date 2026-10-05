import { describe, it, expect } from 'vitest'
import { assertJudgeOutput, type EvidenceJudge, type JudgeNode } from '../utils/evidenceJudge'

describe('assertJudgeOutput', () => {
  it('接受与候选等长、取值在 [0,1] 的有限数数组', () => {
    expect(assertJudgeOutput([0, 0.5, 1], 3)).toEqual([0, 0.5, 1])
  })

  it('长度不匹配即拒绝', () => {
    expect(() => assertJudgeOutput([0.1, 0.2], 3)).toThrow('length-mismatch')
  })

  it('非数组即拒绝', () => {
    expect(() => assertJudgeOutput({ 0: 0.1 }, 1)).toThrow('not-an-array')
  })

  it('NaN 与 Infinity 一律拒绝', () => {
    expect(() => assertJudgeOutput([Number.NaN], 1)).toThrow('invalid-score')
    expect(() => assertJudgeOutput([Number.POSITIVE_INFINITY], 1)).toThrow('invalid-score')
  })

  it('越界值拒绝', () => {
    expect(() => assertJudgeOutput([-0.01], 1)).toThrow('invalid-score')
    expect(() => assertJudgeOutput([1.01], 1)).toThrow('invalid-score')
  })

  it('非数字元素拒绝', () => {
    expect(() => assertJudgeOutput(['0.5'], 1)).toThrow('invalid-score')
  })

  it('零候选返回空数组', () => {
    expect(assertJudgeOutput([], 0)).toEqual([])
  })
})

describe('EvidenceJudge 契约', () => {
  it('是可注入的接口：假实现返回与候选等长的概率', async () => {
    const judge: EvidenceJudge = {
      async judge({ nodes }) { return nodes.map(() => 0.5) },
    }
    const nodes: JudgeNode[] = [
      { id: 'a', title: 'A', path: [] },
      { id: 'b', title: 'B', path: ['A'] },
    ]
    await expect(judge.judge({ query: 'q', nodes })).resolves.toEqual([0.5, 0.5])
  })
})
