import { it, expect } from 'vitest'
import { scoreOfficial } from '../localPdf/scoring'
import { goldFixture, recordFixture } from './localPdfFixtures'
it('uses official duplicate, empty and missing evidence semantics', async () => {
  const g = goldFixture()
  expect((await scoreOfficial(g, [recordFixture('A', 'q', { evidence: ['paragraph', 'paragraph'] })], ['q'], 'A')).evidenceF1).toBeCloseTo(2 / 3)
  expect(await scoreOfficial(g, [], ['q'], 'A')).toMatchObject({ answerF1: 0, evidenceF1: 0 })
  g.p.qas[0].answers[0].answer.unanswerable = true
  expect(await scoreOfficial(g, [recordFixture('A', 'q', { answer: 'Unanswerable', evidence: [] })], ['q'], 'A')).toMatchObject({ answerF1: 1, evidenceF1: 1 })
})
it('takes separate best annotators and preserves official normalization', async () => {
  const g = goldFixture()
  const a = g.p.qas[0].answers[0].answer
  a.free_form_answer = 'stateofart'; a.yes_no = null
  g.p.qas[0].answers.push({ answer: { ...a, free_form_answer: 'wrong', evidence: ['other'] } })
  expect(await scoreOfficial(g, [recordFixture('A', 'q', { answer: 'State-of-art', evidence: ['other'] })], ['q'], 'A')).toMatchObject({ answerF1: 1, evidenceF1: 1 })
  a.free_form_answer = 'a'
  expect((await scoreOfficial(g, [recordFixture('A', 'q', { answer: 'the' })], ['q'], 'A')).answerF1).toBe(0)
})
it('R has no evidence score; failed generation preserves retrieval score', async () => {
  expect((await scoreOfficial(goldFixture(), [recordFixture('R')], ['q'], 'R')).evidenceF1).toBeNull()
  expect(await scoreOfficial(goldFixture(), [recordFixture('A', 'q', { generationStatus: 'failed', answer: '' })], ['q'], 'A')).toMatchObject({ answerF1: 0, evidenceF1: 1 })
})
