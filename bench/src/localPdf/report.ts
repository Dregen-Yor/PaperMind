import type { MethodResult, RunSummary } from './types'
import { hashCanonical, validateRunSummary } from './contract'
const label = { A: 'A · BM25', B: 'B · BM25 + dense', C: 'C · BM25 + dense + outline', D: 'D · PageIndex-style TOC tree', R: 'R · Full context',
  'E-bm25-k3': 'E-bm25-k3 · Heading hierarchy + BM25', 'E-dense-k3': 'E-dense-k3 · Heading-path cosine',
  'E-hybrid-k1': 'E-hybrid-k1 · Heading hierarchy + BM25/cosine RRF', 'E-hybrid-k3': 'E-hybrid-k3 · Heading hierarchy + BM25/cosine RRF', 'E-hybrid-k5': 'E-hybrid-k5 · Heading hierarchy + BM25/cosine RRF',
}
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
    ...(h.methods.includes('D') ? ['D routes over title/page metadata without summaries; selected PDF page text is used only after routing.', ''] : []),
    ...(h.methods.some(m => m.startsWith('E-')) ? ['E embeds full heading paths during cold start; query-time BM25/cosine/RRF selects original PDF page ranges without generative routing. The BM25 variant is a lexical ablation.', ''] : []),
    ...table(summary.results.filter(r => r.method !== 'R')), '',
    ...(summary.results.some(r => r.method === 'R') ? ['Full-context reference (no evidence selection):', '', ...table(summary.results.filter(r => r.method === 'R'))] : []), '',
  ].join('\n')
}
