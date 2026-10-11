import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { finalizePeerQaQuality, importPeerQaScores } from '../metrics/peerqaQuality'
import type { BenchResult, PerSampleRecord, QaQuestion } from '../types'

const questions: QaQuestion[] = [
  { id: 'a', question: 'A?', answers: ['alpha result'], evidencePages: [], unanswerable: false },
  { id: 'b', question: 'B?', answers: ['beta result'], evidencePages: [], unanswerable: false },
  { id: 'u', question: 'U?', answers: [], evidencePages: [], unanswerable: true },
]
const records = (): PerSampleRecord[] => [
  { id: 'a', paperId: 'p', source: 'peerqa', metrics: {}, answer: 'alpha result', generationStatus: 'completed' },
  { id: 'b', paperId: 'p', source: 'peerqa', metrics: {}, generationStatus: 'failed' },
  { id: 'u', paperId: 'p', source: 'peerqa', metrics: {}, answer: 'No Answer', generationStatus: 'completed' },
]
const hash = (text: string) => createHash('sha256').update(text).digest('hex')

describe('PeerQA fixed quality cohorts', () => {
  it('scores failed references zero and classifies successful No Answer refusals', () => {
    const rows = records()
    const result = finalizePeerQaQuality(rows, questions)
    expect(result.metrics.peerqaRougeL).toBe(0.5)
    expect(result.metrics.peerqaRougeLSampleCount).toBe(2)
    expect(result.metrics.peerqaAnswerabilityMacroF1).toBeCloseTo((2 / 3 + 1) / 2)
    expect(result.metrics.peerqaCompletionRate).toBeCloseTo(2 / 3)
    expect(result.meta.peerqaReferenceQuestionIds).toEqual(['a', 'b'])
    expect(rows[1].metrics.peerqaRougeL).toBe(0)
  })

  it('counts a failed unanswerable prediction as FN rather than a correct refusal', () => {
    const rows = records()
    rows[1].answer = 'beta result'
    rows[1].generationStatus = 'completed'
    rows[2].generationStatus = 'skipped'
    expect(finalizePeerQaQuality(rows, questions).metrics.peerqaAnswerabilityMacroF1).toBe(0.5)
  })

  it('rejects missing and duplicate observations', () => {
    expect(() => finalizePeerQaQuality(records().slice(1), questions)).toThrow(/missing/)
    expect(() => finalizePeerQaQuality([...records(), records()[0]], questions)).toThrow(/duplicate/)
  })

  it('imports model scores only for the exact source and answers, with a fixed denominator', () => {
    const rows = records()
    const quality = finalizePeerQaQuality(rows, questions)
    const source = { task: 'qa', config: { name: 'native' }, meta: { ...quality.meta }, metrics: quality.metrics, perSample: rows, errors: [] } as unknown as BenchResult
    const artifact = {
      schemaVersion: 1,
      sourceResultSha256: hash('source'),
      alignScoreModel: 'AlignScore-large',
      prometheusModel: 'prometheus-13b-v1.0',
      scores: [{ questionId: 'a', answerSha256: hash('alpha result'), alignScore: 0.8, prometheus: 4 }],
    }
    const scored = importPeerQaScores(source, artifact, hash('source'))
    expect(scored.metrics.peerqaAlignScore).toBe(0.4)
    expect(scored.metrics.peerqaPrometheus).toBe(0.375)
    expect(scored.metrics.peerqaAlignScoreCoverageCount).toBe(1)
    expect(scored.perSample[0].metrics.peerqaPrometheusRaw).toBe(4)
    expect(source.metrics.peerqaAlignScore).toBeUndefined()
    expect(() => importPeerQaScores(source, artifact, hash('other'))).toThrow(/source/)
    expect(() => importPeerQaScores(source, { ...artifact, scores: [{ ...artifact.scores[0], answerSha256: hash('wrong') }] }, hash('source'))).toThrow(/answer/)
    expect(() => importPeerQaScores(source, { ...artifact, scores: [{ ...artifact.scores[0], prometheus: 6 }] }, hash('source'))).toThrow(/range/)
    expect(() => importPeerQaScores(source, { ...artifact, alignScoreModel: '' }, hash('source'))).toThrow(/model/)
  })
})
