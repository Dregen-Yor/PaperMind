export type ChatRunStatus = 'preparing' | 'streaming' | 'completed' | 'failed' | 'cancelled' | 'interrupted'

export interface ChatMessageWrite {
  id: string
  conversationId: string
  role: 'user' | 'assistant'
  content: string
  sources: unknown[]
  timestamp: number
  error?: string
  truncated?: boolean
  context?: string
  runId?: string
  runStatus?: ChatRunStatus
}

export type ChatMessagePatch = Partial<Pick<ChatMessageWrite,
  'content' | 'sources' | 'error' | 'truncated' | 'context' | 'runId' | 'runStatus'>>
