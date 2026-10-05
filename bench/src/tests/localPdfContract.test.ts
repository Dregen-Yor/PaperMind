import { describe, it, expect } from 'vitest'
import { hashCanonical, validateHeader, validateManifest, validateQueryRecord, validateRunSummary } from '../localPdf/contract'
import { headerFixture, manifestFixture, recordFixture, summaryFixture } from './localPdfFixtures'
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
  it('requires both TOC identities when D is present and preserves old headers', () => {
    expect(() => validateHeader(headerFixture(['A', 'B', 'C', 'R']))).not.toThrow()
    const d = headerFixture(['D'])
    expect(() => validateHeader(d)).toThrow(/TOC identity/)
    d.identity.tocTreeSha256 = 'tree'
    d.identity.tocRoutingSha256 = 'routing'
    expect(() => validateHeader(d)).not.toThrow()
  })
  it('requires routing diagnostics only for completed D retrievals', () => {
    const d = recordFixture('D', 'q', { routing: undefined })
    expect(() => validateQueryRecord(d)).toThrow(/routing/)
    d.routing = {
      rawAttempts: ['{}'], reasoning: 'methods', requestedNodeIds: ['n1'], selectedNodeIds: ['n1'],
      selectedRanges: [{ nodeId: 'n1', startPage: 1, endPage: 1 }],
    }
    expect(() => validateQueryRecord(d)).not.toThrow()
    expect(() => validateQueryRecord({ ...recordFixture('A'), routing: d.routing })).toThrow(/routing/)
  })
})
