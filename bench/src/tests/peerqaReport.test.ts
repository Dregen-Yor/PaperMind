import { describe, expect, it } from 'vitest'
import { parseArgs } from '../args'
import { renderReport, renderComparison } from '../report'
import type { BenchResult } from '../types'
import { SENTENCE_METRICS } from '../metrics/sentenceRetrieval'

function result(): BenchResult {
  return {
    task: 'qa', config: { name: 'native' },
    meta: {
      model: 'm', timestamp: 'now', gitSha: 'sha', completed: 1, total: 1,
      datasetFingerprint: 'same', contextBudgetTokens: 4096, contextTokenizer: 'bge', contextTokenizerRevision: 'main',
      sentenceRetrievalDefinition: 'final-context-sentence-v1', sentenceEvidenceMappingVersion: 'peerqa-official-spans-v1',
      eligibleSentenceQuestionIdsHash: 'ids', eligibleSentenceQuestionCount: 1, sentenceEvidenceQuestionCount: 1, mappedSentenceEvidenceQuestionCount: 1, comparisonEligible: true,
      peerqaQualityDefinition: 'peerqa-native-rouge-refusal-v1', peerqaExpectedQuestionIds: ['q'], peerqaReferenceQuestionIds: ['q'],
    },
    metrics: { sentenceEvidenceRecall: 1, annotatedSentencePrecision: 1, allGoldSentenceCoverage: 1,
      ...Object.fromEntries(SENTENCE_METRICS.map(key => [`${key}SampleCount`, 1])),
      peerqaRougeL: 1, peerqaRougeLSampleCount: 1, peerqaAnswerabilityMacroF1: 0.5, peerqaAnswerabilitySampleCount: 1, peerqaCompletionRate: 1 },
    perSample: [{ id: 'q', paperId: 'p', source: 'peerqa', metrics: {}, answer: 'alpha answer', generationStatus: 'completed' }], errors: [],
  }
}

describe('PeerQA separate reporting and CLI', () => {
  it('accepts an explicit QA dataset path and preserves default all', () => {
    expect(parseArgs(['--task', 'qa', '--dataset', 'peerqa', '--dataset-path', 'local.jsonl', '--speed']).dataset).toBe('peerqa')
    expect(parseArgs([]).dataset).toBe('all')
    expect(() => parseArgs(['--dataset', 'peerqa'])).toThrow(/qa/)
    expect(() => parseArgs(['--task', 'summary', '--dataset', 'peerqa'])).toThrow(/qa/)
    expect(() => parseArgs(['--task', 'qa', '--dataset-path', 'local.jsonl'])).toThrow(/peerqa/)
  })

  it('shows separate sentence and answer sections with explicit unavailable model scores', () => {
    const report = renderReport([result()])
    expect(report).toContain('句子检索')
    expect(report).toContain('回答质量')
    expect(report).toContain('Annotated Precision')
    expect(report).toContain('AlignScore')
    expect(report).toContain('bench:peerqa:score')
    expect(report).toContain('参考答案 1')
    expect(report).not.toContain('综合分')
  })

  it('suppresses sentence deltas for different cohorts, versions, or observation counts', () => {
    const a = result()
    const b = result()
    b.config.name = 'changed'
    b.metrics.sentenceEvidenceRecall = 0.5
    expect(renderComparison(a, b)).toContain('-0.5000')
    b.meta.sentenceEvidenceMappingVersion = 'different'
    const report = renderComparison(a, b)
    expect(report).toContain('sentenceEvidenceMappingVersion')
    expect(report).not.toContain('-0.5000')
    b.meta.sentenceEvidenceMappingVersion = a.meta.sentenceEvidenceMappingVersion
    b.metrics.sentenceEvidenceRecallSampleCount = 0
    expect(renderComparison(a, b)).toContain('sentenceEvidenceRecallSampleCount')
  })

  it('rejects an incomplete answer quality denominator before calculating quality deltas', () => {
    const a = result()
    const b = result()
    b.metrics.peerqaRougeL = 0.25
    expect(renderComparison(a, b)).toContain('-0.7500')
    b.metrics.peerqaRougeLSampleCount = 0
    expect(renderComparison(a, b)).not.toContain('-0.7500')
    expect(renderComparison(a, b)).toContain('peerqaRougeLSampleCount')
  })
})
