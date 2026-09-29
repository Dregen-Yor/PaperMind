import { describe, it, expect } from 'vitest'
import { hashCanonical, validateManifest, validateRunSummary } from '../localPdf/contract'
import { manifestFixture, summaryFixture } from './localPdfFixtures'
describe('local PDF contract', () => {
  it('rejects duplicate question IDs', () => {
    const m = manifestFixture()
    m.questions.push(m.questions[0])
    expect(() => validateManifest(m)).toThrow(/duplicate/)
  })
  it('accepts exactly six finite metrics and R nulls', () => {
    const s = summaryFixture()
    expect(Object.keys(validateRunSummary(s).results[0].metrics)).toHaveLength(6)
    for (const invalid of [NaN, -1, 2]) {
      s.results[0].metrics.answerF1 = invalid
      expect(() => validateRunSummary(s)).toThrow()
    }
  })
  it('rejects legacy schema and metrics', () => {
    expect(() => validateRunSummary({ meta: {}, metrics: {} })).toThrow()
    const s = summaryFixture()
    Object.assign(s.results[0].metrics, { answerF1AllQuestions: 1 })
    expect(() => validateRunSummary(s)).toThrow()
  })
  it('hashes objects canonically but preserves array order', () => {
    expect(hashCanonical({ b: 2, a: 1 })).toBe(hashCanonical({ a: 1, b: 2 }))
    expect(hashCanonical([1, 2])).not.toBe(hashCanonical([2, 1]))
  })
})
