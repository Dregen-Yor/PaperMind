import type { Method, QualityScores, QueryRecord, RunHeader, RunSummary } from './types'
import { requireThat, validateHeader, validateQueryRecord, validateRunSummary } from './contract'
export function nearestRank(values: number[], percentile: 50 | 95): number | null {
  requireThat(values.every(n => Number.isFinite(n) && n >= 0), 'invalid timing value')
  if (!values.length) return null
  return [...values].sort((a, b) => a - b)[Math.ceil(percentile / 100 * values.length) - 1]
}
function complete(r: QueryRecord | undefined): r is QueryRecord & { t0: number; tFirstAnswerToken: number } {
  return !!r && r.generationStatus === 'completed' && !!r.answer.trim() && r.t0 !== null && r.tFirstAnswerToken !== null && r.tFirstAnswerToken >= r.t0
    && (r.method === 'R' || r.retrievalStatus === 'completed' && r.tContextReady !== null && r.tContextReady >= r.t0 && r.tContextReady <= r.tFirstAnswerToken)
}
export function aggregateRun(header: RunHeader, records: QueryRecord[], scores: Map<Method, QualityScores>): RunSummary {
  validateHeader(header)
  const byKey = new Map<string, QueryRecord>()
  for (const r of records) {
    validateQueryRecord(r)
    requireThat(header.methods.includes(r.method) && header.expectedQuestionIds.includes(r.questionId), 'unexpected record')
    const key = `${r.method}:${r.questionId}`
    requireThat(!byKey.has(key), 'duplicate record'); byKey.set(key, r)
  }
  const cohort = header.expectedQuestionIds.filter(id => header.methods.every(m => complete(byKey.get(`${m}:${id}`))))
  const results = header.methods.map(method => {
    const quality = scores.get(method)
    requireThat(quality && JSON.stringify(quality.perQuestion.map(q => q.id)) === JSON.stringify(header.expectedQuestionIds), 'quality denominator mismatch')
    const selected = cohort.map(id => byKey.get(`${method}:${id}`)!)
    const retrieval = method === 'R' ? [] : selected.map(r => r.tContextReady! - r.t0!)
    const ttft = selected.map(r => r.tFirstAnswerToken! - r.t0!)
    return { method, metrics: {
      answerF1: quality.answerF1, evidenceF1: method === 'R' ? null : quality.evidenceF1,
      retrievalLatencyP50Ms: nearestRank(retrieval, 50), retrievalLatencyP95Ms: nearestRank(retrieval, 95),
      ttftP50Ms: nearestRank(ttft, 50), ttftP95Ms: nearestRank(ttft, 95),
    }, qualityQuestionIds: [...header.expectedQuestionIds], speedQuestionIds: cohort, paired: header.methods.length > 1 }
  })
  return validateRunSummary({ header, results })
}
