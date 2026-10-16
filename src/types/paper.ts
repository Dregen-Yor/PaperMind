export interface Paper {
  id: string
  title: string
  authors: string[]
  abstract: string
  year: number
  tags: string[]
  status: 'unread' | 'reading' | 'done'
  fileName: string
  fileHash: string
  addedAt: number
  knowledgeBaseId: string
}

export interface KnowledgeBase {
  id: string
  name: string
  description: string
  color: string
  createdAt: number
}

export interface Highlight {
  id: string
  paperId: string
  text: string
  pageNum: number
  color: string
  note: string
  startOffset: number
  endOffset: number
  createdAt: number
}
