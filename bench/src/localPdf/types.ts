import type { ContextTrace, SourceRange } from '../../../src/utils/sourceTrace'
export type { ContextTrace, SourceRange }
export type Method = 'A' | 'B' | 'C' | 'R'
export type Split = 'train' | 'dev'
export type RunStatus = 'running' | 'completed' | 'incomplete' | 'failed'
export interface FileIdentity { path: string; sha256: string }
export interface FrozenQuestion { id: string; paperId: string; question: string }
export interface FrozenPaper {
  id: string; pdf: FileIdentity; questionIds: string[]; prepared: FileIdentity
  parseStatus: 'completed' | 'failed'; parseError?: string
}
export interface Manifest {
  schema: 'local-pdf-qasper-v1'; split: Split; subset: boolean
  dataset: FileIdentity; gold: FileIdentity; papers: FrozenPaper[]; questions: FrozenQuestion[]
  excluded: { paperId: string; questionIds: string[]; reason: string }[]
  parserVersion: string; alignmentVersion: string; fingerprint: string
}
export interface SixMetrics {
  answerF1: number; evidenceF1: number | null
  retrievalLatencyP50Ms: number | null; retrievalLatencyP95Ms: number | null
  ttftP50Ms: number | null; ttftP95Ms: number | null
}
export interface QueryRecord {
  method: Method; questionId: string; paperId: string
  retrievalStatus: 'completed' | 'failed' | 'not-applicable'
  generationStatus: 'completed' | 'failed' | 'skipped'
  answer: string; partialAnswer?: string; fallbackReason?: string; evidence: string[] | null
  context: string; trace: ContextTrace[]
  t0: number | null; tContextReady: number | null; tFirstAnswerToken: number | null
  error?: { stage: 'parse' | 'index' | 'retrieve' | 'generate'; message: string }
}
export interface RunIdentity {
  manifestFingerprint: string; gitSha: string; evaluatorSha256: string
  configSha256: string; generationSha256: string; endpointSha256: string
  environmentSha256: string; modelFiles: FileIdentity[]
}
export interface RunHeader {
  goldSha256?: string
  dataset?: { split: Split; subset: boolean; papers: number }
  schema: 'local-pdf-qasper-v1'; runId: string; identity: RunIdentity
  methods: Method[]; expectedQuestionIds: string[]; status: RunStatus
}
export interface MethodResult {
  method: Method; metrics: SixMetrics; qualityQuestionIds: string[]
  speedQuestionIds: string[]; paired: boolean
}
export interface RunSummary { header: RunHeader; results: MethodResult[] }
export interface RawAnswer {
  unanswerable: boolean; extractive_spans: string[]; free_form_answer: string
  yes_no: boolean | null; evidence: string[]; annotation_id?: string
}
export interface RawQasperPaper {
  title: string
  full_text: { section_name: string; paragraphs: string[] }[]
  figures_and_tables: { file: string; caption: string }[]
  qas: { question_id: string; question: string; answers: { answer: RawAnswer }[] }[]
}
export type RawQasperDataset = Record<string, RawQasperPaper>
export interface QualityScores {
  answerF1: number; evidenceF1: number | null
  perQuestion: { id: string; answerF1: number; evidenceF1: number | null }[]
}
export interface CanonicalUnit {
  id: string; text: string; kind: 'paragraph' | 'caption'
  status: 'matched' | 'unmapped' | 'ambiguous'; ranges: SourceRange[]
}
export interface AlignmentArtifact { version: 'canonical-pdf-v2'; units: CanonicalUnit[] }
