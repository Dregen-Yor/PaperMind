import type { AlignmentArtifact, CanonicalUnit, RawQasperPaper, SourceRange } from './types'
import { mergeRanges, normalizeWithOrigins } from './normalize'
function includeRemovedLineHyphens(ranges: SourceRange[], pages: string[]): SourceRange[] {
  const sorted = mergeRanges(ranges)
  const out: SourceRange[] = []
  for (const range of sorted) {
    const previous = out.at(-1)
    if (previous?.page === range.page) {
      const gap = pages[range.page].slice(previous.end, range.start)
      // Normalization removes the hyphen and line break. Keep only the source hyphen
      // as an explained range: PDF context traces attribute the hyphen but intentionally
      // leave synthetic line breaks unmapped.
      if (/^-[ \t]*\r?\n[ \t]*$/.test(gap)) {
        out.push({ page: range.page, start: previous.end, end: previous.end + 1 })
      }
    }
    out.push({ ...range })
  }
  return out
}
export function alignCanonical(pages: string[], source: Pick<RawQasperPaper, 'full_text' | 'figures_and_tables'>): AlignmentArtifact {
  const pdf = normalizeWithOrigins(pages)
  const entries = [
    ...source.full_text.flatMap((s, si) => s.paragraphs.map((text, pi) => ({ id: `paragraph:${si}:${pi}`, text, kind: 'paragraph' as const, search: text }))),
    ...source.figures_and_tables.map((f, i) => ({ id: `caption:${i}`, text: `FLOAT SELECTED: ${f.caption}`, kind: 'caption' as const, search: f.caption })),
  ].map(e => ({ ...e, normalized: normalizeWithOrigins([e.search]).text }))
  const names = new Map<string, Set<string>>()
  for (const e of entries) names.set(e.normalized, (names.get(e.normalized) ?? new Set()).add(e.text))
  const units: CanonicalUnit[] = entries.map(e => {
    const unit: CanonicalUnit = { id: e.id, text: e.text, kind: e.kind, status: 'unmapped', ranges: [] }
    if (!/[\p{L}\p{N}]/u.test(e.normalized)) return unit
    const first = pdf.text.indexOf(e.normalized)
    if (names.get(e.normalized)!.size > 1 || first >= 0 && pdf.text.indexOf(e.normalized, first + 1) >= 0) return { ...unit, status: 'ambiguous' }
    if (first < 0) return unit
    return { ...unit, status: 'matched', ranges: includeRemovedLineHyphens(mergeRanges(pdf.origins.slice(first, first + e.normalized.length).flat()), pages) }
  })
  return { version: 'canonical-pdf-v2', units }
}
