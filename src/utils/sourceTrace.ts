/** UTF-16, zero-based, half-open coordinates in original PDF page text. */
export interface SourceRange { page: number; start: number; end: number }
export interface SourceRun { textStart: number; textEnd: number; source: SourceRange | null }
export interface ContextTrace { passageId: string; contextStart: number; contextEnd: number; source: SourceRange | null }
