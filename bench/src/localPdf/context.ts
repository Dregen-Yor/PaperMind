import type { Passage } from '../../../src/utils/passages'
import { sliceSourceRuns, type ContextTrace } from '../../../src/utils/sourceTrace'
import { CONTEXT_GROUP_SEPARATOR } from '../../../src/utils/contextTrace'
import { requireThat, uniqueIds } from './contract'
export function materializeTracedContext(passages: Passage[], selectedIds: string[], pages: string[], countTokens: (text: string) => number, maxTokens: number): { text: string; trace: ContextTrace[]; tokenCount: number } {
  uniqueIds(selectedIds)
  requireThat(Number.isInteger(maxTokens) && maxTokens > 0, 'invalid context budget')
  let text = ''; const trace: ContextTrace[] = []; let previous = -2
  for (const id of selectedIds) {
    const p = passages.find(p => p.id === id)
    requireThat(p, 'unknown selected passage')
    const prefix = text && p.order !== previous + 1 ? CONTEXT_GROUP_SEPARATOR : ''
    if (countTokens(text + prefix) >= maxTokens) break
    const before = text.length; text += prefix
    if (prefix) trace.push({ passageId: id, contextStart: before, contextEnd: text.length, source: null })
    for (const piece of p.pieces) {
      requireThat(piece.sourceRuns, 'passage lacks source trace; rebuild index')
      let take = piece.text.length
      if (countTokens(text + piece.text) > maxTokens) {
        take = 0
        // Stop at the first over-budget grapheme; conservative, no BPE monotonicity assumption.
        for (const segment of new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(piece.text)) {
          const end = segment.index + segment.segment.length
          if (countTokens(text + piece.text.slice(0, end)) > maxTokens) break
          take = end
        }
      }
      const offset = text.length
      for (const r of sliceSourceRuns(piece.sourceRuns, 0, take)) {
        if (r.source) requireThat(piece.text.slice(r.textStart, r.textEnd) === pages[r.source.page].slice(r.source.start, r.source.end), 'source trace text mismatch')
        trace.push({ passageId: id, contextStart: offset + r.textStart, contextEnd: offset + r.textEnd, source: r.source })
      }
      text += piece.text.slice(0, take)
      if (take < piece.text.length) return finish(text, trace, countTokens)
    }
    previous = p.order
  }
  return finish(text, trace, countTokens)
}
function finish(raw: string, trace: ContextTrace[], countTokens: (text: string) => number) {
  const start = raw.length - raw.trimStart().length; const end = raw.trimEnd().length
  const text = raw.slice(start, end)
  const clipped = trace.flatMap(t => {
    const lo = Math.max(start, t.contextStart); const hi = Math.min(end, t.contextEnd)
    if (lo >= hi) return []
    return [{ ...t, contextStart: lo - start, contextEnd: hi - start, source: t.source ? { page: t.source.page, start: t.source.start + lo - t.contextStart, end: t.source.start + hi - t.contextStart } : null }]
  })
  return { text, trace: clipped, tokenCount: countTokens(text) }
}
