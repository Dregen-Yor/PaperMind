import { describe, expect, it } from 'vitest'
import { buildEvaluationContract } from '../evaluationContract'
import { normalizePeerQa } from '../datasets/peerqa'
import { assertSentenceDenominator } from '../metrics/sentenceRetrieval'

const dataset = () => normalizePeerQa([{ paper_id: 'p', question_id: 'q', question: 'Result?', answerable: true,
  answer_evidence_mapped: [{ idx: [0] }], answer_free_form: 'Result.' }], [
  { paper_id: 'p', idx: 0, pidx: 0, sidx: 0, type: 'sentence', content: 'Result.' },
]).samples

describe('PeerQA sentence evaluation identity', () => {
  it('freezes sentence eligibility and binds IDs and gold mappings in the fingerprint', () => {
    const samples = dataset()
    const original = buildEvaluationContract(samples)
    expect(original.sentenceRetrievalDefinition).toBe('final-context-sentence-v1')
    expect(original.eligibleSentenceQuestionCount).toBe(1)
    samples[0].sentences![0].id = 'changed'
    expect(buildEvaluationContract(samples).datasetFingerprint).not.toBe(original.datasetFingerprint)
    samples[0].questions[0].sentenceEvidenceMapping = 'unmapped'
    expect(buildEvaluationContract(samples).eligibleSentenceQuestionCount).toBe(0)
  })

  it('rejects any missing sentence metric observation even if the others are complete', () => {
    const contract = buildEvaluationContract(dataset())
    expect(() => assertSentenceDenominator({ sentenceEvidenceRecall: 1, annotatedSentencePrecision: 1 }, contract)).toThrow(/denominator/i)
    expect(() => assertSentenceDenominator({ sentenceEvidenceRecall: 1, annotatedSentencePrecision: 1, allGoldSentenceCoverage: 1 }, contract)).not.toThrow()
  })
})
