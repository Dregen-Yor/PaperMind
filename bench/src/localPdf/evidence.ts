import type { AlignmentArtifact, ContextTrace, SourceRange } from './types'
import { mergeRanges } from './normalize'
import { hashCanonical, requireThat } from './contract'
function subtract(range: SourceRange, covered: SourceRange[]): SourceRange[] {
  let parts = [{ ...range }]
  for (const c of covered) {
    parts = parts.flatMap(p => {
      if (p.page !== c.page || p.end <= c.start || p.start >= c.end) return [p]
      return [ ...(p.start < c.start ? [{ ...p, end: c.start }] : []), ...(p.end > c.end ? [{ ...p, start: c.end }] : []) ]
    })
  }
  return parts
}
export function deriveEvidence(paperId: string, pages: string[], context: { text: string; trace: ContextTrace[] }, alignment: AlignmentArtifact): { predicted: string[]; unmatched: { id: string; passageId: string; ranges: SourceRange[]; text: string }[] } {
  let cursor = 0
  for (const t of context.trace) {
    requireThat(t.contextStart === cursor && t.contextEnd > cursor, 'incomplete context trace')
    const fragment = context.text.slice(t.contextStart, t.contextEnd)
    if (t.source) requireThat(fragment === pages[t.source.page]?.slice(t.source.start, t.source.end), 'invalid trace source')
    else requireThat(/^[\s-]*$/.test(fragment), 'unattributed non-harness text')
    cursor = t.contextEnd
  }
  requireThat(cursor === context.text.length, 'untraced context text')
  const coverage = mergeRanges(context.trace.flatMap(t => t.source ? [t.source] : []))
  const selected = alignment.units.filter(u => u.status === 'matched' && u.ranges.length > 0 && u.ranges.every(r => subtract(r, coverage).length === 0))
  const firstPosition = (ranges: SourceRange[]) => context.trace.findIndex(t => t.source && ranges.some(r => r.page === t.source!.page && r.start < t.source!.end && r.end > t.source!.start))
  selected.sort((a, b) => firstPosition(a.ranges) - firstPosition(b.ranges))
  const predicted = [...new Set(selected.map(u => u.text))]
  const explained = mergeRanges(selected.flatMap(u => u.ranges))
  const byPassage = new Map<string, SourceRange[]>()
  for (const t of context.trace) if (t.source) byPassage.set(t.passageId, [...(byPassage.get(t.passageId) ?? []), ...subtract(t.source, explained)])
  const unmatched: { id: string; passageId: string; ranges: SourceRange[]; text: string }[] = []
  for (const [passageId, ranges] of byPassage) {
    for (const range of mergeRanges(ranges)) {
      const text = pages[range.page].slice(range.start, range.end)
      if (!text.trim()) continue
      const id = `UNALIGNED:${paperId}:${hashCanonical({ passageId, range })}`
      requireThat(!alignment.units.some(u => u.text === id), 'unmatched evidence ID collision')
      unmatched.push({ id, passageId, ranges: [range], text }); predicted.push(id)
    }
  }
  return { predicted, unmatched }
}
