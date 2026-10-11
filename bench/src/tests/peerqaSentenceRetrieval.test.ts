import { describe, expect, it } from 'vitest'
import { materializeContext } from '../../../src/utils/contextTrace'
import { normalizePeerQa } from '../datasets/peerqa'
import { computeSentenceMetrics, traceSentenceCoverage } from '../metrics/sentenceRetrieval'

function sample(first = 'Alpha result.', second = 'Beta result.') {
  return normalizePeerQa([{ paper_id: 'p', question_id: 'q', question: 'Results?', answerable: true,
    answer_evidence_mapped: [{ idx: [0, 1] }], answer_free_form: 'Results.' }], [
    { paper_id: 'p', idx: 0, pidx: 0, sidx: 0, type: 'sentence', content: first },
    { paper_id: 'p', idx: 1, pidx: 0, sidx: 1, type: 'sentence', content: second },
  ]).samples[0]
}

describe('final-context sentence evidence coverage', () => {
  it('counts gold overlap and deduplicates sentence identities', () => {
    expect(computeSentenceMetrics(['a', 'b'], ['a', 'a', 'c'])).toEqual({
      sentenceEvidenceRecall: 0.5, annotatedSentencePrecision: 0.5, allGoldSentenceCoverage: 0,
    })
    expect(computeSentenceMetrics(['a'], [])).toEqual({
      sentenceEvidenceRecall: 0, annotatedSentencePrecision: 0, allGoldSentenceCoverage: 0,
    })
  })

  it('uses only emitted fragments after budget truncation, not the candidate page', () => {
    const input = sample()
    const output = materializeContext([{ pieces: [{ page: 0, text: input.pages[0] }] }], { tokenize: text => [...text] }, 17, true)
    expect(output.pieces).toEqual([{ page: 0, text: 'Alpha result. Bet' }])
    expect(traceSentenceCoverage(input, output.pieces)).toEqual(['p/0/0'])
  })

  it('unions adjacent and overlapping source intervals, but does not bridge missing text', () => {
    const input = sample('Alpha result.', 'Beta conclusion!')
    expect(traceSentenceCoverage(input, [{ page: 0, text: 'Alpha ' }, { page: 0, text: 'result.' }])).toEqual(['p/0/0'])
    expect(traceSentenceCoverage(input, [{ page: 0, text: 'Alpha result.' }, { page: 0, text: 'Alpha result.' }])).toEqual(['p/0/0'])
    expect(traceSentenceCoverage(input, [{ page: 0, text: 'Alpha' }, { page: 0, text: '.' }])).toEqual([])
  })

  it('rejects missing, ambiguous and fabricated nonempty source provenance', () => {
    const input = sample('Echo.', 'Echo.')
    expect(() => traceSentenceCoverage(input, undefined)).toThrow(/provenance/i)
    expect(() => traceSentenceCoverage(input, [{ page: 0, text: 'Echo.' }])).toThrow(/ambiguous/i)
    expect(() => traceSentenceCoverage(input, [{ page: 0, text: 'Not in paper.' }])).toThrow(/source/i)
    expect(traceSentenceCoverage(input, [{ page: 0, text: input.pages[0] }])).toEqual(['p/0/0', 'p/0/1'])
  })
})
