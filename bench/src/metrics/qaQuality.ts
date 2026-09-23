import type { PerSampleRecord, QaQuestion } from '../types'
import { qasperAnswerF1 } from './qasperQuality'

export const QA_QUALITY_DEFINITION = 'qasper-all-questions-v1' as const

export interface QaQualityMetrics {
  answerF1AllQuestions: number
  answerF1AllQuestionsSampleCount: number
  qaCompletionRate: number
}

function assertUniqueNonemptyIds(ids: readonly string[], label: string): void {
  if (ids.length === 0) throw new Error(`${label} must be non-empty`)
  const seen = new Set<string>()
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0) throw new Error(`${label} contains an invalid id`)
    if (seen.has(id)) throw new Error(`${label} contains duplicate id ${id}`)
    seen.add(id)
  }
}

export function aggregateQaQuality(
  records: PerSampleRecord[],
  expectedIds: string[],
): QaQualityMetrics {
  assertUniqueNonemptyIds(expectedIds, 'expected question ids')
  const expected = new Set(expectedIds)
  const byId = new Map<string, PerSampleRecord>()
  for (const record of records) {
    if (!expected.has(record.id)) throw new Error(`unexpected QA quality record ${record.id}`)
    if (byId.has(record.id)) throw new Error(`duplicate QA quality record ${record.id}`)
    byId.set(record.id, record)
  }
  for (const id of expectedIds) {
    if (!byId.has(id)) throw new Error(`missing QA quality record ${id}`)
  }

  let scoreSum = 0
  let completed = 0
  for (const id of expectedIds) {
    const record = byId.get(id)!
    if (record.generationStatus !== 'completed'
      && record.generationStatus !== 'failed'
      && record.generationStatus !== 'skipped') {
      throw new Error(`QA quality record ${id} has invalid generation status`)
    }
    const score = record.metrics.answerF1AllQuestions
    if (!Number.isFinite(score) || score < 0 || score > 1) {
      throw new Error(`QA quality record ${id} has invalid answer F1`)
    }
    if (record.generationStatus !== 'completed' && score !== 0) {
      throw new Error(`failed or skipped QA quality record ${id} must score zero`)
    }
    scoreSum += score
    if (record.generationStatus === 'completed') completed++
  }

  return {
    answerF1AllQuestions: scoreSum / expectedIds.length,
    answerF1AllQuestionsSampleCount: expectedIds.length,
    qaCompletionRate: completed / expectedIds.length,
  }
}

export function finalizeQaQuality(
  records: PerSampleRecord[],
  questions: QaQuestion[],
): {
  metrics: QaQualityMetrics
  meta: {
    qaQualityDefinition: typeof QA_QUALITY_DEFINITION
    qaExpectedQuestionIds: string[]
  }
} {
  const ids = questions.map(question => question.id)
  assertUniqueNonemptyIds(ids, 'quality questions')
  const expected = new Set(ids)
  const qualityRecords = records.filter(record => record.source === 'qasper')
  const byId = new Map<string, PerSampleRecord>()
  for (const record of qualityRecords) {
    if (!expected.has(record.id)) throw new Error(`unexpected QASPER quality record ${record.id}`)
    if (byId.has(record.id)) throw new Error(`duplicate QASPER quality record ${record.id}`)
    byId.set(record.id, record)
  }

  for (const question of questions) {
    if (question.qualityDefinition !== QA_QUALITY_DEFINITION) {
      throw new Error(`question ${question.id} has invalid QA quality definition`)
    }
    const references = question.qualityAnswers
    if (!Array.isArray(references) || references.length === 0
      || references.some(reference => typeof reference !== 'string' || reference.trim().length === 0)) {
      throw new Error(`question ${question.id} has invalid QA quality reference answers`)
    }
    const record = byId.get(question.id)
    if (!record) throw new Error(`missing QASPER quality record ${question.id}`)
    record.referenceAnswers = [...references]
    if (record.generationStatus === 'completed') {
      if (typeof record.answer !== 'string') {
        throw new Error(`completed QA quality record ${question.id} requires an answer string`)
      }
      record.metrics.answerF1AllQuestions = qasperAnswerF1(record.answer, references)
    } else if (record.generationStatus === 'failed' || record.generationStatus === 'skipped') {
      record.metrics.answerF1AllQuestions = 0
    } else {
      throw new Error(`QA quality record ${question.id} has invalid generation status`)
    }
  }

  return {
    metrics: aggregateQaQuality(qualityRecords, ids),
    meta: {
      qaQualityDefinition: QA_QUALITY_DEFINITION,
      qaExpectedQuestionIds: [...ids],
    },
  }
}
