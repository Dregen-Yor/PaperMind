import type { SourceRef } from './sourceRef'

/** One saved Docling report per paper, independent of chat conversations. */
export interface PaperAbstractReport {
  paperId: string
  content: string
  sources: SourceRef[]
  truncated: boolean
  updatedAt: number
}

/** Application-owned state; survives summary panel and route changes. */
export interface PaperAbstractState {
  generating: boolean
  report: PaperAbstractReport | null
  error: string
}
