/**
 * 对照臂 A 的打分器。不需要 Python、不需要 MLX、不需要网络——这正是
 * `evidenceJudge.ts` 刻意不依赖运行时的直接回报：A 臂能在任何机器上跑。
 */
import { describe, it, expect } from 'vitest'
import { createBm25Judge } from '../toc/bm25Judge'
import { assertJudgeOutput } from '../../../src/utils/evidenceJudge'
import { traverseWithJudge, type TocNode } from '../../../src/utils/tocTree'

const node = (id: string, title: string, path: string[] = []) => ({ id, title, path })

describe('createBm25Judge 契约', () => {
  it('返回与候选等长且落在 [0,1] 的分数', async () => {
    const judge = createBm25Judge()
    const scores = await judge.judge({
      query: 'masked language modeling',
      nodes: [node('a', 'Introduction'), node('b', 'Masked LM'), node('c', 'Related Work')],
    })
    expect(scores).toHaveLength(3)
    // 遍历会在阈值计算前调用它；不给过就等于整篇回落。
    expect(() => assertJudgeOutput(scores, 3)).not.toThrow()
  })

  it('词面命中的节点得分最高', async () => {
    const judge = createBm25Judge()
    const scores = await judge.judge({
      query: 'masked language modeling',
      nodes: [node('a', 'Introduction'), node('b', 'Masked LM'), node('c', 'Related Work')],
    })
    expect(scores.indexOf(Math.max(...scores))).toBe(1)
    expect(scores[1]).toBe(1) // 归一化后最高分恒为 1
  })

  it('父路径参与打分：子节点能借父标题命中', async () => {
    const judge = createBm25Judge()
    // 子节点自身标题毫不相关，只有父路径含查询词。
    const scores = await judge.judge({
      query: 'evaluation',
      nodes: [
        node('a', 'Something Unrelated'),
        node('b', 'Details', ['Evaluation']),
      ],
    })
    expect(scores[1]).toBeGreaterThan(scores[0])
  })

  it('空候选返回空数组，不构造打分器', async () => {
    expect(await createBm25Judge().judge({ query: 'q', nodes: [] })).toEqual([])
  })

  it('查询词一个都没命中时整层为 0，而不是 NaN', async () => {
    // NaN 会被 assertJudgeOutput 拦下、让整篇按「判定器输出非法」回落——
    // 把一个正常退化误报成判定失败。这里是那道防线的前置。
    const scores = await createBm25Judge().judge({
      query: 'zzzz qqqq',
      nodes: [node('a', 'Introduction'), node('b', 'Methods')],
    })
    expect(scores).toEqual([0, 0])
    expect(() => assertJudgeOutput(scores, 2)).not.toThrow()
  })
})

describe('createBm25Judge 接进 traverseWithJudge', () => {
  const tree: TocNode[] = [
    { id: 'n0', title: 'Introduction', path: [], depth: 0, pages: [0], children: [] },
    { id: 'n1', title: 'Masked Language Modeling', path: [], depth: 0, pages: [1], children: [] },
    { id: 'n2', title: 'Related Work', path: [], depth: 0, pages: [2], children: [] },
  ]

  it('同一棵树、同一套遍历，仅换打分器即可选出词面命中的节点', async () => {
    // 这条钉死 A 臂的**单变量**前提：`traverseWithJudge` 一行不改，换 judge 即可。
    // 若哪天遍历里混进了只对某个 judge 成立的假设，这里会先红。
    const selection = await traverseWithJudge(tree, 'masked language modeling', createBm25Judge(), {
      alpha: 0.9,
      topN: 2,
    })
    expect(selection.selected.map(n => n.title)).toEqual(['Masked Language Modeling'])
  })

  it('分数恒为 0 时阈值退化为 0，按原序取前 topN，不抛错', async () => {
    // θ = α·0 = 0，`score >= 0` 全存活，于是 top-N 按稳定序截断。
    // 这是条退化路径，必须有个确定的形态而不是崩溃或空选。
    const selection = await traverseWithJudge(tree, 'zzzz qqqq', createBm25Judge(), {
      alpha: 0.9,
      topN: 2,
    })
    expect(selection.selected.map(n => n.title)).toEqual(['Introduction', 'Masked Language Modeling'])
    expect(selection.emptySelectionFallback).toBe(false)
  })
})
