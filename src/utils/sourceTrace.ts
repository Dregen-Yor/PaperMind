/** UTF-16, zero-based, half-open coordinates in original PDF page text. */
export interface SourceRange { page: number; start: number; end: number }
export interface SourceRun { textStart: number; textEnd: number; source: SourceRange | null }
export interface ContextTrace { passageId: string; contextStart: number; contextEnd: number; source: SourceRange | null }

export function sliceSourceRuns(runs: SourceRun[], start: number, end: number): SourceRun[] {
  return runs.flatMap(r => {
    const lo = Math.max(start, r.textStart); const hi = Math.min(end, r.textEnd)
    if (lo >= hi) return []
    return [{ textStart: lo - start, textEnd: hi - start, source: r.source ? { page: r.source.page, start: r.source.start + lo - r.textStart, end: r.source.start + hi - r.textStart } : null }]
  })
}
/** Sequential whitespace-only transform; never searches the page for repeated text. */
export function mapTransformedRuns(original: string, runs: SourceRun[], output: string, cursor: number): { runs: SourceRun[]; cursor: number } {
  const mapped: SourceRun[] = []
  for (let i = 0; i < output.length; i++) {
    const char = output[i]
    if (/\s/.test(char)) {
      if (/\s/.test(original[cursor] ?? '')) cursor++
      mapped.push({ textStart: i, textEnd: i + 1, source: null })
    } else {
      while (/\s/.test(original[cursor] ?? '')) cursor++
      if (original[cursor] !== char) throw new Error('Source transform changed non-whitespace text')
      const r = runs.find(r => r.textStart <= cursor && cursor < r.textEnd)
      if (!r?.source) throw new Error('Missing source for original text')
      const source = { page: r.source.page, start: r.source.start + cursor - r.textStart, end: r.source.start + cursor - r.textStart + 1 }
      const last = mapped.at(-1)
      if (last?.source && last.source.page === source.page && last.source.end === source.start && last.textEnd === i) { last.textEnd++; last.source.end++ }
      else mapped.push({ textStart: i, textEnd: i + 1, source })
      cursor++
    }
  }
  return { runs: mapped, cursor }
}
