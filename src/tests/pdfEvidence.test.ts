import { describe, expect, it } from 'vitest'
import { findEvidenceRanges } from '../utils/pdfEvidence'

describe('PDF evidence text matching', () => {
  it('locates a sentence across line breaks and punctuation differences', () => {
    expect(findEvidenceRanges('The model improves reasoning\naccuracy by 12.5 points', 'The model improves reasoning accuracy by 12.5 points.'))
      .toEqual([{ start: 0, end: 52 }])
  })
  it('returns all repeated values so a table can avoid an ambiguous cell highlight', () => {
    expect(findEvidenceRanges('74.7   81.2   74.7', '74.7')).toEqual([{ start: 0, end: 4 }, { start: 14, end: 18 }])
  })
  it('does not turn an unmatched quotation into an arbitrary text highlight', () => {
    expect(findEvidenceRanges('Measured score: 74.7', 'Invented score: 99.9')).toEqual([])
  })
  it('does not match a number inside a different table value', () => {
    expect(findEvidenceRanges('174.7  74.7  74.71', '74.7')).toEqual([{ start: 7, end: 11 }])
  })
  it('recognizes a PDF text-run boundary as a word boundary', () => {
    expect(findEvidenceRanges('First line of textSecond line', 'First line of text', [18])).toEqual([{ start: 0, end: 18 }])
  })
})
