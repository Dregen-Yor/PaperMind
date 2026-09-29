import { it, expect } from 'vitest'
import { buildPassages } from '../../../src/utils/passages'
import { materializeTracedContext } from '../localPdf/context'
it('tracks second occurrence instead of first text match', () => {
  const pages = ['Repeat.\n\nRepeat.']
  const passages = buildPassages(pages, s => s.length, { minTokens: 1, maxTokens: 20 })
  const c = materializeTracedContext(passages, [passages[1].id], pages, s => s.length, 20)
  expect(c.trace.find(t => t.source)?.source?.start).toBe(9)
  expect(c.text).toBe('Repeat.')
})
it('clips exact source and excludes discarded candidate text', () => {
  const pages = ['Alpha beta gamma.']
  const passages = buildPassages(pages, s => s.length, { minTokens: 1, maxTokens: 30 })
  const c = materializeTracedContext(passages, [passages[0].id], pages, s => s.length, 5)
  expect(c.text).toBe('Alpha')
  expect(c.trace.filter(t => t.source).map(t => pages[t.source!.page].slice(t.source!.start, t.source!.end)).join('')).toBe('Alpha')
})
it('preserves sentence split provenance and Unicode boundaries', () => {
  const pages = ['One sentence.   Another sentence. 🧪 test.']
  const p = buildPassages(pages, s => s.length, { minTokens: 1, maxTokens: 18 })
  const c = materializeTracedContext(p, p.map(x => x.id), pages, s => s.length, 100)
  for (const t of c.trace) if (t.source) expect(c.text.slice(t.contextStart, t.contextEnd)).toBe(pages[t.source.page].slice(t.source.start, t.source.end))
})
