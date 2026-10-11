import { describe, expect, it } from 'vitest'
import { normalizePeerQa, validatePeerQaSamples } from '../datasets/peerqa'

const paperId = 'openreview/ICLR-2022-conf/example'
const papers = [
  { paper_id: paperId, idx: 0, pidx: 0, sidx: 0, type: 'title', content: 'Example Paper' },
  { paper_id: paperId, idx: 1, pidx: 1, sidx: 0, type: 'sentence', content: 'First evidence.', last_heading: 'Methods' },
  { paper_id: paperId, idx: 2, pidx: 1, sidx: 1, type: 'sentence', content: 'Second evidence.', last_heading: 'Methods' },
]
const qa = [
  { paper_id: paperId, question_id: 'q1', question: 'What is reported?', answerable: true,
    answer_free_form: 'First evidence.', answer_evidence_mapped: [{ sentence: 'First evidence.', idx: [1] }] },
  { paper_id: paperId, question_id: 'q2', question: 'Where is unpublished data?', answerable: false,
    answer_free_form: '', answer_evidence_mapped: null },
  { paper_id: paperId, question_id: 'q3', question: 'Why?', answerable: true,
    answer_free_form: 'Because it works.', answer_evidence_mapped: null },
]

describe('PeerQA native dataset normalization', () => {
  it('accepts empty extracted units without fabricating a source sentence', () => {
    const emptyFormula = { ...papers[2], idx: 3, sidx: 2, type: 'formula', content: '' }
    expect(normalizePeerQa(qa, [...papers, emptyFormula]).samples[0].sentences).toHaveLength(2)
  })

  it('counts official unlabeled questions separately from known answerability labels', () => {
    const result = normalizePeerQa([...qa, { ...qa[0], question_id: 'unlabeled', answerable: null }], papers)
    expect(result.samples[0].questions).toHaveLength(3)
    expect(result.preparation.unlabeledQuestions).toBe(1)
  })

  it('retains text but excludes ambiguous official sentence identities from scoring', () => {
    const collision = { ...papers[2], idx: 3, type: 'figure', content: 'Figure 1.' }
    const question = { ...qa[0], answer_evidence_mapped: [{ idx: [2] }] }
    const sample = normalizePeerQa([question], [...papers, collision]).samples[0]
    expect(sample.pages.join('')).toContain('Figure 1.')
    expect(sample.questions[0].sentenceEvidenceMapping).toBe('ambiguous')
    expect(sample.sentences).toHaveLength(1)
  })
  it('preserves official sentence identities, headings, exact spans and separate label eligibility', () => {
    const { samples, preparation } = normalizePeerQa(qa, papers)
    expect(samples).toHaveLength(1)
    const sample = samples[0]
    expect(sample.source).toBe('peerqa')
    expect(sample.pages.join('')).toContain('Methods')
    expect(sample.sentences).toHaveLength(2)
    expect(sample.sentences![0].id).toBe(`${paperId}/1/0`)
    expect(sample.questions[0].evidenceSentenceIds).toEqual([`${paperId}/1/0`])
    expect(sample.questions[0].sentenceEvidenceMapping).toBe('mapped')
    expect(sample.questions[1].unanswerable).toBe(true)
    expect(sample.questions[2].sentenceEvidenceMapping).toBe('unmapped')
    expect(preparation.missingPaperQuestions).toBe(0)
    expect(() => validatePeerQaSamples(samples)).not.toThrow()
  })

  it('accepts Hugging Face dict-of-lists evidence and maps all sentence indices', () => {
    const question = { ...qa[0], answer_evidence_mapped: { sentence: ['First evidence. Second evidence.'], idx: [[1, 2]] } }
    const { samples } = normalizePeerQa([question], papers)
    expect(samples[0].questions[0].evidenceSentenceIds).toHaveLength(2)
  })

  it('retains unmapped evidence rather than silently reducing the gold set', () => {
    const question = { ...qa[0], answer_evidence_mapped: [{ sentence: 'Missing evidence.', idx: [1, null] }] }
    const { samples } = normalizePeerQa([question], papers)
    expect(samples[0].questions[0].sentenceEvidenceMapping).toBe('unmapped')
  })

  it('reports questions without source papers and rejects duplicate question and row IDs', () => {
    expect(normalizePeerQa([{ ...qa[0], paper_id: 'missing' }], papers).preparation.missingPaperQuestions).toBe(1)
    expect(() => normalizePeerQa([qa[0], qa[0]], papers)).toThrow(/duplicate/i)
    expect(() => normalizePeerQa(qa, [...papers, papers[0]])).toThrow(/duplicate/i)
  })

  it('rejects forged normalized spans and evidence IDs on reload', () => {
    const { samples } = normalizePeerQa(qa, papers)
    samples[0].sentences![0].end++
    expect(() => validatePeerQaSamples(samples)).toThrow(/span/i)
    const valid = normalizePeerQa(qa, papers).samples
    valid[0].questions[0].evidenceSentenceIds = ['wrong']
    expect(() => validatePeerQaSamples(valid)).toThrow(/evidence/i)
  })

  it('rejects out-of-bounds and overlapping sentence spans', () => {
    const outOfBounds = normalizePeerQa(qa, papers).samples
    outOfBounds[0].sentences!.at(-1)!.end += 100
    expect(() => validatePeerQaSamples(outOfBounds)).toThrow(/span/i)
    const overlap = normalizePeerQa(qa, papers).samples
    overlap[0].sentences!.push({ ...overlap[0].sentences![0], id: `${paperId}/99/0` })
    expect(() => validatePeerQaSamples(overlap)).toThrow(/overlap/i)
  })
})
