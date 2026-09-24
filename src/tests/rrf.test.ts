import { describe, expect, it } from 'vitest'
import { reciprocalRankFusion } from '../utils/rrf'

const list = (...scores: number[]) => scores.map((score, id) => ({ id, score }))

describe('reciprocalRankFusion', () => {
  it('同一名次在多路出现者得分更高', () => {
    const fused = reciprocalRankFusion([list(3, 2, 1), list(3, 1, 2)], 60)
    expect(fused.map(item => item.id)).toEqual([0, 1, 2])
  })

  it('并列按 id 升序，保证确定性', () => {
    const fused = reciprocalRankFusion([list(1, 1), list(1, 1)], 60)
    expect(fused.map(item => item.id)).toEqual([0, 1])
  })

  it('权重 0 等价于该路不参与', () => {
    const two = reciprocalRankFusion([list(5, 1), list(1, 5)], 60)
    const three = reciprocalRankFusion([list(5, 1), list(1, 5), list(9, 9)], 60, [1, 1, 0])
    expect(three).toEqual(two)
  })

  it('权重改变卡片路的名次贡献', () => {
    // 卡片路是 BM25 路的镜像，权重同为 1 时两个 id 得分逐位相同（各为 1/61 + 1/62），
    // 并列只能由 id 升序破平，卡片路便不可能改变第一名；权重 2 才让卡片路真正加权，
    // 把 id 1 顶到第一（1/62 + 2/61 > 1/61 + 2/62）。
    const noPrior = reciprocalRankFusion([list(2, 1)], 60, [1])
    const withPrior = reciprocalRankFusion([list(2, 1), list(1, 2)], 60, [1, 2])
    expect(noPrior[0].id).toBe(0)
    expect(withPrior[0].id).toBe(1)
  })

  it('非法 k 与权重直接抛错', () => {
    expect(() => reciprocalRankFusion([list(1)], 0)).toThrow()
    expect(() => reciprocalRankFusion([list(1), list(1)], 60, [1])).toThrow()
  })
})
