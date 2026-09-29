import type { Manifest, Method, QueryRecord, RunSummary, RawQasperDataset, RunHeader } from '../localPdf/types'
const file = { path: 'fixture', sha256: 'a'.repeat(64) }
export function manifestFixture(): Manifest {
  return { schema: 'local-pdf-qasper-v1', split: 'dev', subset: true, dataset: file, gold: file,
    papers: [{ id: 'p', pdf: file, prepared: file, questionIds: ['q'], parseStatus: 'completed' }],
    questions: [{ id: 'q', paperId: 'p', question: 'What?' }], excluded: [], parserVersion: 'test', alignmentVersion: 'canonical-pdf-v1', fingerprint: 'f' }
}
export function headerFixture(methods: Method[] = ['A']): RunHeader {
  return { schema: 'local-pdf-qasper-v1', runId: 'test', methods, expectedQuestionIds: ['q'], status: 'completed', identity: {
    manifestFingerprint: 'f', gitSha: 'test', evaluatorSha256: 'test', configSha256: 'test', generationSha256: 'test', endpointSha256: 'test', environmentSha256: 'test', modelFiles: [],
  } }
}
export function recordFixture(method: Method = 'A', questionId = 'q', overrides: Partial<QueryRecord> = {}): QueryRecord {
  return { method, questionId, paperId: 'p', retrievalStatus: method === 'R' ? 'not-applicable' : 'completed', generationStatus: 'completed', answer: 'yes', evidence: method === 'R' ? null : ['paragraph'], context: '', trace: [], t0: 0, tContextReady: method === 'R' ? null : 10, tFirstAnswerToken: 20, ...overrides }
}
export function summaryFixture(): RunSummary {
  return { header: headerFixture(), results: [{ method: 'A', metrics: { answerF1: 1, evidenceF1: 1, retrievalLatencyP50Ms: 10, retrievalLatencyP95Ms: 10, ttftP50Ms: 20, ttftP95Ms: 20 }, qualityQuestionIds: ['q'], speedQuestionIds: ['q'], paired: false }] }
}
export function goldFixture(): RawQasperDataset {
  return { p: { title: 'Artificial paper', full_text: [{ section_name: 'Intro', paragraphs: ['paragraph'] }], figures_and_tables: [], qas: [{ question_id: 'q', question: 'What?', answers: [{ answer: { unanswerable: false, yes_no: true, extractive_spans: [], free_form_answer: '', evidence: ['paragraph'] } }] }] } }
}
