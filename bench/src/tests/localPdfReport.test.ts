import { it, expect } from 'vitest'
import { aggregateRun, nearestRank } from '../localPdf/timing'
import { renderReport } from '../localPdf/report'
import { headerFixture, recordFixture } from './localPdfFixtures'
import type { Method, QualityScores } from '../localPdf/types'
it('uses nearest rank and no fake zero for empty cohort', () => {
  expect(nearestRank([10, 20, 30, 40], 50)).toBe(20)
  expect(nearestRank([10, 20, 30, 40], 95)).toBe(40)
  expect(nearestRank([], 95)).toBeNull()
})
it('uses common successful IDs but full quality denominator including failures', () => {
  const methods: Method[] = ['A', 'B', 'C', 'R']; const h = headerFixture(methods)
  h.dataset = { split: 'train', subset: true, papers: 1 }
  const records = methods.map(m => recordFixture(m))
  const scores = new Map<Method, QualityScores>(methods.map(m => [m, { answerF1: 0.5, evidenceF1: m === 'R' ? null : 1, perQuestion: [{ id: 'q', answerF1: 0.5, evidenceF1: m === 'R' ? null : 1 }] }]))
  const good = aggregateRun(h, records, scores)
  expect(good.results.every(r => r.speedQuestionIds.join() === 'q')).toBe(true)
  records[3].generationStatus = 'failed'; records[3].answer = ''
  const result = aggregateRun(h, records, scores)
  expect(result.results[0].metrics).toMatchObject({ answerF1: 0.5, ttftP50Ms: null })
  expect(Object.keys(result.results[0].metrics)).toHaveLength(6)
  expect(renderReport(result)).toContain('—')
  expect(renderReport(result)).toContain('train / development subset; PDFs: 1')
  expect(() => aggregateRun(h, [...records, records[0]], scores)).toThrow(/duplicate/)
})
