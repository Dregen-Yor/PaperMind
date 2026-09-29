import { it, expect } from 'vitest'
import { deriveEvidence } from '../localPdf/evidence'
import { alignCanonical } from '../localPdf/alignment'
import { scoreOfficial } from '../localPdf/scoring'
import { goldFixture, recordFixture } from './localPdfFixtures'
it('requires complete coverage; preserves extra retrieved content as false positive', async () => {
  const pages = ['paragraph extra']
  const a = alignCanonical(pages, goldFixture().p)
  const ctx = { text: pages[0], trace: [{ passageId: 'P1', contextStart: 0, contextEnd: 15, source: { page: 0, start: 0, end: 15 } }] }
  const e = deriveEvidence('p', pages, ctx, a)
  expect(e.predicted).toContain('paragraph')
  expect(e.unmatched).toHaveLength(1)
  expect((await scoreOfficial(goldFixture(), [recordFixture('A', 'q', { evidence: e.predicted })], ['q'], 'A')).evidenceF1).toBeCloseTo(2 / 3)
  expect(deriveEvidence('p', pages, { text: 'para', trace: [{ passageId: 'P1', contextStart: 0, contextEnd: 4, source: { page: 0, start: 0, end: 4 } }] }, a).predicted).not.toContain('paragraph')
})
it('joins coverage from multiple chunks and deduplicates evidence', () => {
  const pages = ['paragraph']; const a = alignCanonical(pages, goldFixture().p)
  const e = deriveEvidence('p', pages, { text: 'paragraph', trace: [
    { passageId: 'P1', contextStart: 0, contextEnd: 4, source: { page: 0, start: 0, end: 4 } },
    { passageId: 'P2', contextStart: 4, contextEnd: 9, source: { page: 0, start: 4, end: 9 } },
  ] }, a)
  expect(e.predicted).toEqual(['paragraph'])
})
