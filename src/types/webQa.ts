import type { PreviewSnapshot } from './webPreview'

export type WebPreviewBlock = {
  kind: 'heading' | 'paragraph' | 'list' | 'quote' | 'code'
  text: string
  level?: number
}

export type WebReadPreview = { blocks: WebPreviewBlock[]; truncated: boolean }

export interface WebPageSummary {
  id: string
  canonicalUrl: string
  title: string
  createdAt: number
  lastOpenedAt: number
  latestSnapshotId: string
  snapshotCount: number
  sessionCount: number
  totalBytes: number
}

export interface WebSnapshotPreview {
  id: string
  pageId: string
  finalUrl: string
  title: string
  capturedAt: number
  byteLength: number
  contentHash: string
  preview: WebReadPreview
}

export interface WebQaPageSessionSummary extends WebQaSessionSummary {
  pageId: string
  firstQuestion: string
}

export interface WebQaSavedSession extends WebQaPageSessionSummary {
  messages: WebQaMessage[]
}

export interface WebQaNewSessionInput {
  sessionId: string
  questionId: string
  assistantId: string
  snapshotId: string
  question: string
  createdAt: number
  modelId: string
}

export type WebQaAppendInput = Omit<WebQaNewSessionInput, 'snapshotId'>

export type WebQaMessageStatus = 'completed' | 'streaming' | 'failed' | 'cancelled' | 'interrupted'

export interface WebQaMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant'
  content: string
  status: WebQaMessageStatus
  error: string
  modelId: string
  createdAt: number
}

export interface WebQaSessionSummary {
  id: string
  snapshotId: string
  finalUrl: string
  title: string
  capturedAt: number
  byteLength: number
  createdAt: number
  updatedAt: number
}

export interface WebQaSessionDetail extends WebQaSessionSummary {
  snapshot: PreviewSnapshot
  messages: WebQaMessage[]
}

export interface WebQaCreateInput {
  sessionId: string
  messageId: string
  snapshot: PreviewSnapshot
  question: string
  createdAt: number
}

export type WebQaMessagePatch = Partial<Pick<WebQaMessage, 'content' | 'status' | 'error' | 'modelId'>>

export interface WebQaBackup {
  snapshots: Array<{ id: string } & PreviewSnapshot>
  sessions: Array<{ id: string; snapshotId: string; createdAt: number; updatedAt: number }>
  messages: WebQaMessage[]
}
