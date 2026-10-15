/** Locate a verified source quotation despite PDF text-layer whitespace and punctuation changes. */
export function findEvidenceRanges(text: string, quote: string, runBoundaries: number[] = []): Array<{ start: number; end: number }> {
  const letters: string[] = []
  const offsets: number[] = []
  for (let index = 0; index < text.length; index++) {
    if (!/[\p{L}\p{N}]/u.test(text[index])) continue
    letters.push(text[index].toLocaleLowerCase())
    offsets.push(index)
  }
  const target = Array.from(quote.toLocaleLowerCase()).filter(char => /[\p{L}\p{N}]/u.test(char)).join('')
  if (target.length < 2) return []
  const normalized = letters.join('')
  const result: Array<{ start: number; end: number }> = []
  let found = normalized.indexOf(target)
  while (found !== -1) {
    const start = offsets[found]
    const end = offsets[found + target.length - 1] + 1
    if (!(start > 0 && !runBoundaries.includes(start) && /[\p{L}\p{N}]/u.test(text[start - 1]))
      && !(end < text.length && !runBoundaries.includes(end) && /[\p{L}\p{N}]/u.test(text[end]))) result.push({ start, end })
    found = normalized.indexOf(target, found + 1)
  }
  return result
}
