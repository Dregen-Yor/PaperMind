/** PDF 划选片段（页内字符区间，0-based 页号）（#7）。 */
export interface HighlightSegment {
  page: number
  start: number
  end: number
}

/** 合并重叠/相邻片段：一次划选在页内只留一条记录（#7）。 */
export function mergeSegments(segments: HighlightSegment[]): HighlightSegment[] {
  if (segments.length === 0) return []
  const sorted = [...segments].sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: HighlightSegment[] = [{ ...sorted[0] }]
  for (const segment of sorted.slice(1)) {
    const last = merged[merged.length - 1]
    if (segment.start <= last.end) last.end = Math.max(last.end, segment.end)
    else merged.push({ ...segment })
  }
  return merged
}

export interface FragmentRow {
  id: string
  paperId: string
  pageNum: number
  text: string
  startOffset: number
  endOffset: number
  createdAt: number
}

export interface FragmentMergePlan {
  updates: Array<{ id: string; endOffset: number }>
  removals: string[]
}

/** 历史碎片合并计划（#7）：同论文/同页/同文本/同一秒的连续片段是一次划选被拆段的产物。 */
export function planFragmentMerge(rows: FragmentRow[]): FragmentMergePlan {
  const groups = new Map<string, FragmentRow[]>()
  for (const row of rows) {
    const key = `${row.paperId}|${row.pageNum}|${row.text}|${row.createdAt}`
    const list = groups.get(key)
    if (list) list.push(row)
    else groups.set(key, [row])
  }
  const updates: FragmentMergePlan['updates'] = []
  const removals: string[] = []
  for (const list of groups.values()) {
    if (list.length <= 1) continue
    const sorted = [...list].sort((a, b) => a.startOffset - b.startOffset || a.endOffset - b.endOffset)
    const keep = sorted[0]
    const maxEnd = Math.max(...sorted.map(r => r.endOffset))
    if (maxEnd !== keep.endOffset) updates.push({ id: keep.id, endOffset: maxEnd })
    for (const extra of sorted.slice(1)) removals.push(extra.id)
  }
  return { updates, removals }
}
