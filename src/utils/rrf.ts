/**
 * 加权倒数名次融合（自 `bench/src/baselines/rrf.ts` 移入并加权重）。
 * 名次 1-based：`score = Σ w_i / (k + rank_i)`。
 */
export interface RankedItem {
  id: number
  score: number
  /**
   * 显式名次（1-based）。给了就不再按排序位置计名次——用于「多个条目共享同一名次」
   * 的场景（段落继承所属卡片名次、零分段落并列末位），见方案 §4.2。
   */
  rank?: number
}

export function reciprocalRankFusion(lists: RankedItem[][], k: number, weights?: number[]): RankedItem[] {
  if (!Number.isFinite(k) || k <= 0) throw new Error('RRF k 必须为正数')
  if (weights && (weights.length !== lists.length || weights.some(w => !Number.isFinite(w)))) {
    throw new Error('RRF 权重必须与排名路数一致且为有限数')
  }
  const scores = new Map<number, number>()
  lists.forEach((list, listIndex) => {
    const weight = weights?.[listIndex] ?? 1
    const ranked = [...list].sort((a, b) => b.score - a.score || a.id - b.id)
    ranked.forEach((item, rank) => {
      scores.set(item.id, (scores.get(item.id) ?? 0) + weight / (k + (item.rank ?? rank + 1)))
    })
  })
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || a.id - b.id)
}
