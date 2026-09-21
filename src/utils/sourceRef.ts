/** 结构化来源：芯片文案 + 跳转所需的论文与页区间（#1）。 */
export interface SourceRef {
  label: string
  paperId?: string
  startPage?: number
  endPage?: number
}

/** 把持久化的 sources 归一为 SourceRef[]：兼容旧的字符串数组与脏数据（#1）。 */
export function normalizeSourceList(raw: unknown): SourceRef[] {
  if (!Array.isArray(raw)) return []
  const refs: SourceRef[] = []
  for (const item of raw) {
    if (typeof item === 'string') {
      if (item) refs.push({ label: item })
      continue
    }
    if (item && typeof item === 'object' && typeof (item as any).label === 'string' && (item as any).label) {
      const { label, paperId, startPage, endPage } = item as any
      refs.push({
        label,
        ...(typeof paperId === 'string' ? { paperId } : {}),
        ...(typeof startPage === 'number' ? { startPage } : {}),
        ...(typeof endPage === 'number' ? { endPage } : {}),
      })
    }
  }
  return refs
}

/** 芯片是否可跳页。 */
export function isJumpable(ref: SourceRef): boolean {
  return typeof ref.paperId === 'string' && typeof ref.startPage === 'number'
}
