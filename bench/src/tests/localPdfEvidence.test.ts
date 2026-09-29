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
it('groups residual words across normalized whitespace but not explained text', () => {
  const pages = ['alpha beta paragraph gamma delta']
  const words = [...pages[0].matchAll(/\S+|\s+/g)]
  const trace = words.map(m => ({ passageId: 'P', contextStart: m.index!, contextEnd: m.index! + m[0].length, source: m[0].trim() ? { page: 0, start: m.index!, end: m.index! + m[0].length } : null }))
  const e = deriveEvidence('p', pages, { text: pages[0], trace }, alignCanonical(pages, goldFixture().p))
  expect(e.predicted).toContain('paragraph')
  expect(e.unmatched).toHaveLength(2)
  expect(e.unmatched.map(u => u.text)).toEqual(['alpha beta', 'gamma delta'])
})
it('does not emit removed line-end hyphens as false-positive evidence', async () => {
  const pages = ['co-\noperation']
  const alignment = alignCanonical(pages, { full_text: [{ section_name: '', paragraphs: ['cooperation'] }], figures_and_tables: [] })
  const e = deriveEvidence('p', pages, { text: pages[0], trace: [
    { passageId: 'P', contextStart: 0, contextEnd: 3, source: { page: 0, start: 0, end: 3 } },
    { passageId: 'P', contextStart: 3, contextEnd: 4, source: null },
    { passageId: 'P', contextStart: 4, contextEnd: pages[0].length, source: { page: 0, start: 4, end: pages[0].length } },
  ] }, alignment)
  expect(e.predicted).toEqual(['cooperation'])
  const gold = goldFixture(); gold.p.full_text[0].paragraphs = ['cooperation']
  gold.p.qas[0].answers[0].answer.evidence = ['cooperation']
  expect((await scoreOfficial(gold, [recordFixture('A', 'q', { evidence: e.predicted })], ['q'], 'A')).evidenceF1).toBe(1)
})
