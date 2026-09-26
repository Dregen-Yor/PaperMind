/**
 * `createMlxJudge` 的切分批边界。侧车被整块换成假实现（`vi.mock` 掉 `./protocol`）——
 * 这是把这层适配器从 Python / MLX 里摘出来的直接回报：批大小、批序、返回的逐位对应
 * 都能在普通机器上验到，不必真的拉起侧车。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMlxJudge } from '../jev/mlxJudge'

/** 假侧车记录每一次 judge 的入参；分数由标题派生，好让「按位对应」可证伪。 */
const h = vi.hoisted(() => ({
  calls: [] as Array<{ query: string; nodes: Array<{ id: string; title: string; path: string[] }> }>,
  closed: 0,
}))

vi.mock('../jev/protocol', () => ({
  SidecarJudge: class {
    async judge(input: { query: string; nodes: Array<{ id: string; title: string; path: string[] }> }) {
      h.calls.push({ query: input.query, nodes: input.nodes })
      // 用标题当分数：批与批之间若不按原序拼回，返回值的顺序会立刻露馅。
      return input.nodes.map((n) => Number(n.title))
    }
    async close() { h.closed += 1 }
  },
}))

/** 造 n 个节点，标题即下标字符串，故期望分数恒为 [0, 1, …, n-1]。 */
const nodes = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `n${i}`, title: String(i), path: [] as string[] }))

beforeEach(() => { h.calls = []; h.closed = 0 })

describe('createMlxJudge 切分', () => {
  it('空候选返回空数组，且一次都不调用侧车', async () => {
    const judge = createMlxJudge()
    expect(await judge.judge({ query: 'q', nodes: [] })).toEqual([])
    expect(h.calls.length).toBe(0)
  })

  it('恰好整除时不产生空尾批', async () => {
    const judge = createMlxJudge({ batchSize: 2 })
    const scores = await judge.judge({ query: 'q', nodes: nodes(4) })
    expect(h.calls.map((c) => c.nodes.length)).toEqual([2, 2])
    expect(scores).toEqual([0, 1, 2, 3])
  })

  it('末批不满时按原序拼回，分数不串位', async () => {
    const judge = createMlxJudge({ batchSize: 2 })
    const scores = await judge.judge({ query: 'q', nodes: nodes(5) })
    expect(h.calls.map((c) => c.nodes.length)).toEqual([2, 2, 1])
    // 逐位对应是硬要求：乱序拼接会把每个分数悄悄记到错的节点上。
    expect(scores).toEqual([0, 1, 2, 3, 4])
    expect(h.calls.flatMap((c) => c.nodes.map((n) => n.title))).toEqual(['0', '1', '2', '3', '4'])
  })

  it('省略 batchSize 时默认 16', async () => {
    const judge = createMlxJudge()
    await judge.judge({ query: 'q', nodes: nodes(17) })
    expect(h.calls.map((c) => c.nodes.length)).toEqual([16, 1])
  })

  it('非正整数的 batchSize 在构造时就抛 RangeError，而不是静默卡死', () => {
    // 0 / 负数会让步进不前进，1.5 会切出小数下标——都是构造期就该拒的调用方错误。
    for (const bad of [0, -1, 1.5]) {
      expect(() => createMlxJudge({ batchSize: bad })).toThrow(RangeError)
      expect(() => createMlxJudge({ batchSize: bad })).toThrow(new RegExp(`收到 ${bad}`))
    }
  })
})
