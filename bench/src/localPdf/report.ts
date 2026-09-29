import type { MethodResult, RunSummary } from './types'
import { hashCanonical, validateRunSummary } from './contract'
const label = { A: 'A · BM25', B: 'B · BM25 + dense', C: 'C · BM25 + dense + outline', R: 'R · Full context' }
const fmt = (n: number | null, digits: number) => n === null ? '—' : n.toFixed(digits)
function table(rows: MethodResult[]): string[] {
  if (!rows.length) return []
  return ['| Method | AnswerF1 | EvidenceF1 | Retrieval latency P50 (ms) | P95 (ms) | TTFT P50 (ms) | P95 (ms) |', '|---|---:|---:|---:|---:|---:|---:|', ...rows.map(r => {
    const m = r.metrics
    return `| ${label[r.method]} | ${fmt(m.answerF1, 4)} | ${fmt(m.evidenceF1, 4)} | ${fmt(m.retrievalLatencyP50Ms, 2)} | ${fmt(m.retrievalLatencyP95Ms, 2)} | ${fmt(m.ttftP50Ms, 2)} | ${fmt(m.ttftP95Ms, 2)} |`
  })]
}
export function renderReport(summary: RunSummary): string {
  validateRunSummary(summary)
  const h = summary.header; const ids = summary.results[0]?.speedQuestionIds ?? []
  return [
    '# Local-PDF QASPER benchmark', '',
    ...(h.dataset ? [`Dataset: ${h.dataset.split} / ${h.dataset.subset ? 'development subset' : 'all available PDFs'}; PDFs: ${h.dataset.papers}.`] : []),
    `Run: ${h.runId} (${h.status}). Manifest: ${h.identity.manifestFingerprint}.`,
    `Quality denominator: ${h.expectedQuestionIds.length}. Speed cohort: ${ids.length}; ${h.methods.length > 1 ? 'paired' : 'unpaired'}; hash ${hashCanonical(ids)}.`,
    `Generation identity: ${h.identity.generationSha256}. Evaluator: ${h.identity.evaluatorSha256}.`,
    'Input is parsed PDF text with canonical alignment; these are not official leaderboard inputs. Errors and original predictions are in records.jsonl.', '',
    ...table(summary.results.filter(r => r.method !== 'R')), '',
    ...(summary.results.some(r => r.method === 'R') ? ['Full-context reference (no evidence selection):', '', ...table(summary.results.filter(r => r.method === 'R'))] : []), '',
  ].join('\n')
}
