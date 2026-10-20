/** Display-only preview; the main process remains the authoritative backup validator. */
export interface BackupPreview {
  data: Record<string, unknown>
  papers: number
  missingPdfs: number
  knowledgeBases: number
  conversations: number
  highlights: number
  webPages: number
}
export function previewBackup(value: unknown): BackupPreview {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请选择 PaperMind JSON 备份')
  const data = value as Record<string, unknown>
  if (data.version !== 1) throw new Error('不支持此备份版本')
  const rows = (key: string): unknown[] => {
    if (data[key] === undefined) return []
    if (!Array.isArray(data[key])) throw new Error(`备份中的 ${key} 必须是列表`)
    return data[key] as unknown[]
  }
  const papers = rows('papers')
  const web = data.webQa
  if (web !== undefined && (!web || typeof web !== 'object' || Array.isArray(web))) throw new Error('备份中的网页数据无效')
  const webPages = (web as { pages?: unknown } | undefined)?.pages
  if (webPages !== undefined && !Array.isArray(webPages)) throw new Error('备份中的网页列表无效')
  return {
    data, papers: papers.length,
    missingPdfs: papers.filter(paper => !paper || typeof paper !== 'object' || typeof (paper as { fileData?: unknown }).fileData !== 'string').length,
    knowledgeBases: rows('knowledgeBases').length, conversations: rows('conversations').length,
    highlights: rows('highlights').length, webPages: Array.isArray(webPages) ? webPages.length : 0,
  }
}
