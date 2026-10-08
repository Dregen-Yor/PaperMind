export interface SourceRange { page: number; start: number; end: number }
export interface ContextTrace { passageId: string; contextStart: number; contextEnd: number; source: SourceRange | null }
