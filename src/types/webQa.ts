import type { PreviewSnapshot } from './webPreview'

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
