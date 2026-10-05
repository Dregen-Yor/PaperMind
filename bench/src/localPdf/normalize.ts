import type { SourceRange } from './types'
export interface NormalizedText { text: string; origins: SourceRange[][] }
/** Transform a view, never the PDF corpus. Origins survive normalization expansions. */
export function normalizeWithOrigins(pages: string[]): NormalizedText {
  let text = ''; let origins: SourceRange[][] = []
  const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })
  pages.forEach((pageText, page) => {
    if (page > 0) { text += ' '; origins.push([]) }
    for (const { segment, index } of segmenter.segment(pageText)) {
      const n = segment.normalize('NFKC')
      text += n
      for (let i = 0; i < n.length; i++) origins.push([{ page, start: index, end: index + segment.length }])
    }
  })
  const replace = (pattern: RegExp, replacement: string) => {
    let out = ''; const mapped: SourceRange[][] = []; let cursor = 0
    for (const match of text.matchAll(pattern)) {
      const start = match.index!
      out += text.slice(cursor, start) + replacement
      for (let i = cursor; i < start; i++) mapped.push(origins[i])
      for (let i = 0; i < replacement.length; i++) mapped.push([])
      cursor = start + match[0].length
    }
    out += text.slice(cursor)
    for (let i = cursor; i < origins.length; i++) mapped.push(origins[i])
    text = out; origins = mapped
  }
  replace(/(?<=[A-Za-z])-\s*\n\s*(?=[A-Za-z])/g, '')
  replace(/\b(?:BIB|TAB|FIG|SEC|EQ)REF\d+\b/g, ' ')
  let lowered = ''; const lowerOrigins: SourceRange[][] = []
  for (let i = 0; i < text.length;) {
    const char = String.fromCodePoint(text.codePointAt(i)!)
    const lower = char.toLowerCase(); lowered += lower
    for (let j = 0; j < lower.length; j++) lowerOrigins.push(origins.slice(i, i + char.length).flat())
    i += char.length
  }
  text = lowered; origins = lowerOrigins
  replace(/\s+/g, ' ')
  const start = text.length - text.trimStart().length
  const end = text.trimEnd().length
  return { text: text.slice(start, end), origins: origins.slice(start, end) }
}
export function mergeRanges(ranges: SourceRange[]): SourceRange[] {
  const out: SourceRange[] = []
  for (const r of [...ranges].sort((a, b) => a.page - b.page || a.start - b.start || a.end - b.end)) {
    const last = out.at(-1)
    if (last && last.page === r.page && r.start <= last.end) last.end = Math.max(last.end, r.end)
    else out.push({ ...r })
  }
  return out
}
