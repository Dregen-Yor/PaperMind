import type { PerSampleRecord, QaQuestion, SampleSource } from '../types'
import { qasperAnswerF1 } from './qasperQuality'

export const QA_QUALITY_DEFINITION = 'qasper-all-questions-v1' as const
export const PDF_QA_QUALITY_DEFINITION = 'pdf-qa-all-questions-v1' as const

export type QaQualityDefinition = typeof QA_QUALITY_DEFINITION | typeof PDF_QA_QUALITY_DEFINITION

/**
 * 定义 → 期望来源。两个定义各自只接受自己来源的记录：QASPER 全题质量沿用
 * `qasper` 记录（旧行为不变），PDF 大纲研究集质量只接受 `pdf-study` 记录。
 */
const DEFINITION_SOURCE: Record<QaQualityDefinition, SampleSource> = {
  [QA_QUALITY_DEFINITION]: 'qasper',
  [PDF_QA_QUALITY_DEFINITION]: 'pdf-study',
}

/** 定义 → 期望来源的唯一判定点；qComparison 复用，避免两处各自硬编码来源映射。 */
export function sourceForQaQualityDefinition(definition: QaQualityDefinition): SampleSource {
  return DEFINITION_SOURCE[definition]
}

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
  manifestFingerprint?: string,
): {
  metrics: QaQualityMetrics
  meta: {
    qaQualityDefinition: QaQualityDefinition
    qaExpectedQuestionIds: string[]
    qaQualitySource?: SampleSource
    qaQualityManifestFingerprint?: string
  }
} {
  const ids = questions.map(question => question.id)
  assertUniqueNonemptyIds(ids, 'quality questions')

  // 定义由题目自身携带，而不是猜：整批必须一致，且必须是已知定义之一。
  const definition = questions[0].qualityDefinition
  if (definition !== QA_QUALITY_DEFINITION && definition !== PDF_QA_QUALITY_DEFINITION) {
    throw new Error(`question ${questions[0].id} has invalid QA quality definition`)
  }
  for (const question of questions) {
    if (question.qualityDefinition !== definition) {
      throw new Error(`question ${question.id} has invalid QA quality definition`)
    }
  }
  const expectedSource = DEFINITION_SOURCE[definition]
  const isPdf = definition === PDF_QA_QUALITY_DEFINITION
  // manifest 指纹只在 pdf-study 有意义；提供了就校验，避免空串落进结果元数据。
  if (isPdf && manifestFingerprint !== undefined
    && (typeof manifestFingerprint !== 'string' || manifestFingerprint.trim().length === 0)) {
    throw new Error('pdf-study QA quality manifest fingerprint must be a non-empty string')
  }

  const expected = new Set(ids)
  // 记录按定义对应的来源过滤：另一来源的记录不参与本定义的聚合——这保留了 QASPER
  // 「只看 qasper」的原有行为（同 id 的 smoke 记录被忽略而非报错）。
  const qualityRecords = records.filter(record => record.source === expectedSource)
  const byId = new Map<string, PerSampleRecord>()
  for (const record of qualityRecords) {
    if (!expected.has(record.id)) throw new Error(`unexpected ${definition} quality record ${record.id}`)
    if (byId.has(record.id)) throw new Error(`duplicate ${definition} quality record ${record.id}`)
    byId.set(record.id, record)
  }

  for (const question of questions) {
    const references = question.qualityAnswers
    if (!Array.isArray(references) || references.length === 0
      || references.some(reference => typeof reference !== 'string' || reference.trim().length === 0)) {
      throw new Error(`question ${question.id} has invalid QA quality reference answers`)
    }
    const record = byId.get(question.id)
    if (!record) {
      // 该题没有任何本来源记录，却存在一条同 id 的**异来源**记录：这是来源错配，必须点名
      // 报「来源不符」而非「缺记录」——否则错配会被误读成漏跑。
      const mismatched = records.find(candidate => candidate.id === question.id && candidate.source !== expectedSource)
      if (mismatched) {
        throw new Error(
          `QA quality record ${question.id} has source ${mismatched.source}, expected ${expectedSource}`,
        )
      }
      throw new Error(`missing ${definition} quality record ${question.id}`)
    }
    record.referenceAnswers = [...references]
    if (record.generationStatus === 'completed') {
      if (typeof record.answer !== 'string') {
        throw new Error(`completed QA quality record ${question.id} requires an answer string`)
      }
      // 同一份 token-multiset F1 同时服务两个定义；分别校验来源，共用实现。
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
      qaQualityDefinition: definition,
      qaExpectedQuestionIds: [...ids],
      // 只有 pdf-study 写来源与 manifest 指纹；QASPER 不加任何新键，保证旧结果逐字不变。
      ...(isPdf
        ? {
            qaQualitySource: expectedSource,
            ...(manifestFingerprint !== undefined ? { qaQualityManifestFingerprint: manifestFingerprint } : {}),
          }
        : {}),
    },
  }
}
