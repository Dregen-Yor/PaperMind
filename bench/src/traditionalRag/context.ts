import type { BenchChunk, ScoredChunk } from './types'
export function sortScoredChunks(scores: ScoredChunk[]): ScoredChunk[] { return [...scores].map(s => ({ ...s, score: Number.isFinite(s.score) ? s.score : 0 })).sort((a, b) => b.score - a.score || a.id - b.id) }
/**
 * 按名次取候选并产出上下文组。保留原有排序 / 检索窗口 / top-K 行为，
 * 仅移除旧的「整段候选超预算即停止」——最终 token 预算由公共 materializer 统一施加
 * （单个候选允许在预算边界被截断，部分进入的页面仍计入页序）。
 */
export function selectContext(chunks: BenchChunk[], scores: ScoredChunk[], options: { retrievalTopK: number; topK: number }) {
  const byId = new Map(chunks.map(c => [c.id, c])); const ranked = sortScoredChunks(scores); const selected: BenchChunk[] = []; let tokens = 0
  for (const score of ranked.slice(0, options.retrievalTopK)) { const chunk = byId.get(score.id); if (!chunk) continue; if (selected.length >= options.topK) break; selected.push(chunk); tokens += chunk.tokenCount }
  return { ranked, selected, tokenCount: tokens, context: selected.map(c => c.text).join('\n\n---\n\n'), contextGroups: selected.map(c => ({ pieces: c.pieces })), sources: selected.map(c => `第 ${c.startPage + 1}-${c.endPage + 1} 页`) }
}
