import type { SourceRef } from './sourceRef'

/** One saved Docling report per paper, independent of chat conversations. */
export interface PaperAbstractReport {
  paperId: string
  content: string
  sources: SourceRef[]
  truncated: boolean
  updatedAt: number
}
