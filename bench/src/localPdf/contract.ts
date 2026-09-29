import { createHash } from 'node:crypto'
import type { Manifest, QueryRecord, RunHeader, RunSummary } from './types'
export const SCHEMA = 'local-pdf-qasper-v1' as const
export const METHODS = ['A', 'B', 'C', 'R'] as const
export const METRIC_KEYS = ['answerF1', 'evidenceF1', 'retrievalLatencyP50Ms', 'retrievalLatencyP95Ms', 'ttftP50Ms', 'ttftP95Ms'] as const
export function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
export function uniqueIds(ids: string[]): void {
  requireThat(Array.isArray(ids) && ids.every(id => typeof id === 'string' && id.length > 0), 'invalid IDs')
  requireThat(new Set(ids).size === ids.length, 'duplicate IDs')
}
export function hashCanonical(value: unknown): string {
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sort(x)])) : v
  return createHash('sha256').update(JSON.stringify(sort(value))).digest('hex')
}
export function validateManifest(value: unknown): Manifest {
  const m = value as Manifest
  requireThat(m?.schema === SCHEMA && ['train', 'dev'].includes(m.split), 'invalid manifest schema')
  requireThat(typeof m.subset === 'boolean' && Array.isArray(m.papers) && Array.isArray(m.questions), 'invalid manifest')
  uniqueIds(m.papers.map(p => p.id)); uniqueIds(m.questions.map(q => q.id))
  requireThat(m.questions.length > 0, 'empty question set')
  for (const p of m.papers) {
    uniqueIds(p.questionIds)
    requireThat(['completed', 'failed'].includes(p.parseStatus), 'invalid parse status')
    requireThat(JSON.stringify(p.questionIds) === JSON.stringify(m.questions.filter(q => q.paperId === p.id).map(q => q.id)), 'question membership mismatch')
  }
  for (const q of m.questions) requireThat(typeof q.question === 'string' && m.papers.some(p => p.id === q.paperId), 'unknown paper')
  for (const f of [m.dataset, m.gold, ...m.papers.flatMap(p => [p.pdf, p.prepared])]) requireThat(typeof f?.path === 'string' && /^[a-f0-9]{64}$/.test(f.sha256), 'invalid file identity')
  return m
}
export function validateHeader(h: RunHeader): void {
  requireThat(h?.schema === SCHEMA && typeof h.runId === 'string', 'invalid run schema')
  uniqueIds(h.methods); uniqueIds(h.expectedQuestionIds)
  requireThat(h.methods.length > 0 && h.methods.every(m => METHODS.includes(m)), 'invalid methods')
  requireThat(['running', 'completed', 'incomplete', 'failed'].includes(h.status), 'invalid run status')
  requireThat(h.identity && Object.entries(h.identity).filter(([k]) => k !== 'modelFiles').every(([, v]) => typeof v === 'string' && v.length > 0), 'invalid identity')
}
export function validateQueryRecord(value: unknown): QueryRecord {
  const r = value as QueryRecord
  requireThat(r && METHODS.includes(r.method) && typeof r.questionId === 'string' && typeof r.paperId === 'string', 'invalid record identity')
  requireThat(['completed', 'failed', 'not-applicable'].includes(r.retrievalStatus) && ['completed', 'failed', 'skipped'].includes(r.generationStatus), 'invalid record status')
  requireThat(typeof r.answer === 'string' && typeof r.context === 'string' && Array.isArray(r.trace), 'invalid record content')
  requireThat(r.evidence === null || Array.isArray(r.evidence) && r.evidence.every(e => typeof e === 'string'), 'invalid evidence')
  for (const t of [r.t0, r.tContextReady, r.tFirstAnswerToken]) requireThat(t === null || Number.isFinite(t) && t >= 0, 'invalid time')
  if (r.method === 'R') requireThat(r.evidence === null && r.tContextReady === null && r.retrievalStatus === 'not-applicable', 'R retrieval must be null')
  if (r.generationStatus !== 'completed') requireThat(r.answer === '', 'failed answer must be empty')
  return r
}
export function validateRunSummary(value: unknown): RunSummary {
  const s = value as RunSummary
  validateHeader(s?.header)
  requireThat(Array.isArray(s.results), 'missing results')
  uniqueIds(s.results.map(r => r.method))
  requireThat(s.results.length === s.header.methods.length, 'missing method result')
  for (const r of s.results) {
    requireThat(s.header.methods.includes(r.method), 'unknown method')
    requireThat(Object.keys(r.metrics).sort().join() === [...METRIC_KEYS].sort().join(), 'metrics must have exactly six keys')
    for (const key of METRIC_KEYS) {
      const n = r.metrics[key]
      requireThat((n === null && key !== 'answerF1') || typeof n === 'number' && Number.isFinite(n) && n >= 0 && (!key.endsWith('F1') || n <= 1), 'invalid metric')
    }
    if (r.method === 'R') requireThat(r.metrics.evidenceF1 === null && r.metrics.retrievalLatencyP50Ms === null && r.metrics.retrievalLatencyP95Ms === null, 'R metrics must be null')
    requireThat(JSON.stringify(r.qualityQuestionIds) === JSON.stringify(s.header.expectedQuestionIds), 'quality denominator mismatch')
    uniqueIds(r.speedQuestionIds)
    requireThat(r.speedQuestionIds.every(id => s.header.expectedQuestionIds.includes(id)), 'unknown speed question')
  }
  return s
}
