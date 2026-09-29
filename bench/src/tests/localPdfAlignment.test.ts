import { it, expect } from 'vitest'
import { alignCanonical } from '../localPdf/alignment'
const source = (paragraphs: string[]) => ({ full_text: [{ section_name: 's', paragraphs }], figures_and_tables: [] })
it('aligns complete units across pages, ligatures and line hyphens', () => {
  const a = alignCanonical(['The ﬁrst co-\n', 'operation.'], source(['The first cooperation.']))
  expect(a.units[0].status).toBe('matched')
  expect(new Set(a.units[0].ranges.map(r => r.page))).toEqual(new Set([0, 1]))
})
it('rejects ambiguity, canonical collisions and empty normalized units', () => {
  expect(alignCanonical(['Repeat. Repeat.'], source(['Repeat.'])).units[0].status).toBe('ambiguous')
  expect(alignCanonical(['THE'], source(['the', 'THE'])).units.every(u => u.status === 'ambiguous')).toBe(true)
  expect(alignCanonical([''], source(['BIBREF1'])).units[0].status).toBe('unmapped')
})
it('keeps original caption strings and ignores annotations', () => {
  const a = alignCanonical(['Figure 1: Test'], { ...source([]), figures_and_tables: [{ file: 'f', caption: 'Figure 1: Test' }] })
  expect(a.units[0].text).toBe('FLOAT SELECTED: Figure 1: Test')
})
it('normalizes long PDF corpora without spreading origins onto the call stack', () => {
  const text = 'word '.repeat(35000)
  expect(alignCanonical([text], source(['absent'])).units[0].status).toBe('unmapped')
})
