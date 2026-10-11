import { createHash } from 'node:crypto'
import type { BenchResult, PerSampleRecord, QaQuestion } from '../types'
import { isRefusal, REFUSAL_PATTERN_VERSION } from './answerF1'
import { rougeL } from './rouge'

// Native normalization follows PaperMind's ROUGE implementation, not rouge_score's tokenizer.
export const PEERQA_QUALITY_DEFINITION = `peerqa-native-rouge-refusal-${REFUSAL_PATTERN_VERSION}` as const
export const answerSha256 = (answer: string): string => createHash('sha256').update(answer).digest('hex')

export function finalizePeerQaQuality(records: PerSampleRecord[], questions: QaQuestion[]): {
  metrics: Record<string, number>
  meta: Partial<BenchResult['meta']>
} {
  if (!questions.length) throw new Error('PeerQA questions must be non-empty')
  const expected = new Set(questions.map(q => q.id))
  if (expected.size !== questions.length) throw new Error('duplicate PeerQA question id')
  const byId = new Map<string, PerSampleRecord>()
  for (const row of records.filter(row => row.source === 'peerqa')) {
    if (!expected.has(row.id)) throw new Error(`unexpected PeerQA record ${row.id}`)
    if (byId.has(row.id)) throw new Error(`duplicate PeerQA record ${row.id}`)
    byId.set(row.id, row)
  }
  const references = questions.filter(q => !q.unanswerable && q.answers.some(answer => answer.trim()))
  const referenceIds = new Set(references.map(q => q.id))
  const classes = [{ tp: 0, fp: 0, fn: 0 }, { tp: 0, fp: 0, fn: 0 }]
  let completed = 0
  let rougeSum = 0
  for (const question of questions) {
    const row = byId.get(question.id)
    if (!row) throw new Error(`missing PeerQA record ${question.id}`)
    if (!['completed', 'failed', 'skipped'].includes(row.generationStatus ?? '')) {
      throw new Error(`invalid PeerQA generation status ${question.id}`)
    }
    const success = row.generationStatus === 'completed'
    if (success && !row.answer?.trim()) throw new Error(`completed PeerQA answer is empty: ${question.id}`)
    if (success) {
      completed++
      row.metrics.peerqaAnswerWordCount = row.answer!.trim().split(/\s+/u).length
    }
    row.referenceAnswers = [...question.answers]
    if (referenceIds.has(question.id)) {
      const score = success ? Math.max(...question.answers.filter(a => a.trim()).map(a => rougeL(row.answer!, a))) : 0
      row.metrics.peerqaRougeL = score
      rougeSum += score
    }
    const truth = question.unanswerable ? 0 : 1
    if (!success) {
      classes[truth].fn++
      continue
    }
    const refusal = /^\s*no answer[.!]?\s*$/i.test(row.answer!) || isRefusal(row.answer!)
    const prediction = refusal ? 0 : 1
    if (prediction === truth) classes[truth].tp++
    else {
      classes[truth].fn++
      classes[prediction].fp++
    }
  }
  const f1 = classes.map(({ tp, fp, fn }) => 2 * tp + fp + fn ? 2 * tp / (2 * tp + fp + fn) : 0)
  return {
    metrics: {
      ...(references.length ? { peerqaRougeL: rougeSum / references.length } : {}),
      peerqaRougeLSampleCount: references.length,
      peerqaAnswerabilityMacroF1: (f1[0] + f1[1]) / 2,
      peerqaAnswerabilitySampleCount: questions.length,
      peerqaAnswerableQuestionCount: questions.filter(q => !q.unanswerable).length,
      peerqaUnanswerableQuestionCount: questions.filter(q => q.unanswerable).length,
      peerqaNoEvidenceQuestionCount: questions.filter(q => !q.unanswerable && !q.hasSentenceEvidence).length,
      peerqaAmbiguousEvidenceQuestionCount: questions.filter(q => !q.unanswerable && q.hasSentenceEvidence && q.sentenceEvidenceMapping === 'ambiguous').length,
      peerqaUnmappedEvidenceQuestionCount: questions.filter(q => !q.unanswerable && q.hasSentenceEvidence && q.sentenceEvidenceMapping === 'unmapped').length,
      peerqaCompletionRate: completed / questions.length,
    },
    meta: {
      peerqaQualityDefinition: PEERQA_QUALITY_DEFINITION,
      peerqaExpectedQuestionIds: questions.map(q => q.id),
      peerqaReferenceQuestionIds: references.map(q => q.id),
    },
  }
}

export interface PeerQaScoreArtifact {
  schemaVersion: 1
  sourceResultSha256: string
  alignScoreModel?: string
  prometheusModel?: string
  scores: Array<{ questionId: string; answerSha256: string; alignScore?: number; prometheus?: number }>
}

/** Offline scores are tied to both the serialized source result and each successful answer. */
export function importPeerQaScores(source: BenchResult, input: unknown, sourceHash: string): BenchResult {
  if (source.meta.peerqaQualityDefinition !== PEERQA_QUALITY_DEFINITION) throw new Error('PeerQA quality definition mismatch')
  if (!input || typeof input !== 'object') throw new Error('invalid score artifact')
  const artifact = input as PeerQaScoreArtifact
  if (artifact.schemaVersion !== 1 || artifact.sourceResultSha256 !== sourceHash || !/^[a-f0-9]{64}$/.test(sourceHash)) {
    throw new Error('score artifact source hash/schema mismatch')
  }
  for (const model of [artifact.alignScoreModel, artifact.prometheusModel]) {
    if (model !== undefined && (typeof model !== 'string' || !model.trim())) throw new Error('model identity must be non-empty')
  }
  if (!artifact.alignScoreModel && !artifact.prometheusModel) throw new Error('at least one model identity is required')
  if (!Array.isArray(artifact.scores)) throw new Error('score rows must be an array')
  const result: BenchResult = structuredClone(source)
  const refs = source.meta.peerqaReferenceQuestionIds
  if (!refs || new Set(refs).size !== refs.length) throw new Error('invalid reference cohort')
  const byId = new Map(result.perSample.filter(row => row.source === 'peerqa').map(row => [row.id, row]))
  if (byId.size !== result.perSample.filter(row => row.source === 'peerqa').length) throw new Error('duplicate source record')
  for (const id of refs) if (!byId.has(id)) throw new Error(`missing reference record ${id}`)
  // Re-import replaces prior scoring rather than silently retaining stale model observations.
  for (const row of byId.values()) {
    delete row.metrics.peerqaAlignScore
    delete row.metrics.peerqaPrometheus
    delete row.metrics.peerqaPrometheusRaw
  }
  const seen = new Set<string>()
  let alignSum = 0
  let prometheusSum = 0
  let alignCount = 0
  let prometheusCount = 0
  for (const entry of artifact.scores) {
    if (!entry || typeof entry !== 'object') throw new Error('invalid score row')
    if (seen.has(entry.questionId)) throw new Error(`duplicate score ${entry.questionId}`)
    seen.add(entry.questionId)
    const row = byId.get(entry.questionId)
    if (!refs.includes(entry.questionId) || !row || row.generationStatus !== 'completed' || !row.answer?.trim()) {
      throw new Error(`score requires a completed reference answer: ${entry.questionId}`)
    }
    if (entry.answerSha256 !== answerSha256(row.answer)) throw new Error(`score answer hash mismatch: ${entry.questionId}`)
    if (entry.alignScore === undefined && entry.prometheus === undefined) throw new Error('empty model score row')
    if (entry.alignScore !== undefined) {
      if (!artifact.alignScoreModel) throw new Error('AlignScore model identity missing')
      if (!Number.isFinite(entry.alignScore) || entry.alignScore < 0 || entry.alignScore > 1) throw new Error('AlignScore range must be [0,1]')
      row.metrics.peerqaAlignScore = entry.alignScore
      alignSum += entry.alignScore
      alignCount++
    }
    if (entry.prometheus !== undefined) {
      if (!artifact.prometheusModel) throw new Error('Prometheus model identity missing')
      if (!Number.isInteger(entry.prometheus) || entry.prometheus < 1 || entry.prometheus > 5) throw new Error('Prometheus range must be integer [1,5]')
      row.metrics.peerqaPrometheusRaw = entry.prometheus
      row.metrics.peerqaPrometheus = (entry.prometheus - 1) / 4
      prometheusSum += row.metrics.peerqaPrometheus
      prometheusCount++
    }
  }
  for (const key of ['peerqaAlignScore', 'peerqaAlignScoreCoverageCount', 'peerqaPrometheus', 'peerqaPrometheusCoverageCount']) delete result.metrics[key]
  if (artifact.alignScoreModel) {
    if (refs.length) result.metrics.peerqaAlignScore = alignSum / refs.length
    result.metrics.peerqaAlignScoreCoverageCount = alignCount
  }
  if (artifact.prometheusModel) {
    if (refs.length) result.metrics.peerqaPrometheus = prometheusSum / refs.length
    result.metrics.peerqaPrometheusCoverageCount = prometheusCount
  }
  result.meta.peerqaModelScoring = {
    sourceResultSha256: sourceHash,
    ...(artifact.alignScoreModel ? { alignScoreModel: artifact.alignScoreModel } : {}),
    ...(artifact.prometheusModel ? { prometheusModel: artifact.prometheusModel } : {}),
  }
  return result
}
