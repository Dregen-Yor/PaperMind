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

/** 碎片时间窗（毫秒）（#7）：一次划选的碎片在同步循环内产生，相邻两条间隔远小于此。 */
const FRAGMENT_WINDOW_MS = 2000

/** 合并一个碎片簇：保留 startOffset 最小者，endOffset 取簇内最大值，其余删除。 */
function mergeCluster(
  cluster: FragmentRow[],
  updates: FragmentMergePlan['updates'],
  removals: string[],
): void {
  if (cluster.length <= 1) return
  const sorted = [...cluster].sort((a, b) => a.startOffset - b.startOffset || a.endOffset - b.endOffset)
  const keep = sorted[0]
  const maxEnd = Math.max(...cluster.map(row => row.endOffset))
  if (maxEnd !== keep.endOffset) updates.push({ id: keep.id, endOffset: maxEnd })
  for (const extra of sorted.slice(1)) removals.push(extra.id)
}

/**
 * 历史碎片合并计划（#7）：同论文/同页/同文本的行是一次划选被拆段的候选；
 * 组内按 createdAt 升序做链式 ≤2s 时间窗聚类（真实库碎片实测跨 1ms），每簇并作一条。
 */
export function planFragmentMerge(rows: FragmentRow[]): FragmentMergePlan {
  const groups = new Map<string, FragmentRow[]>()
  for (const row of rows) {
    const key = `${row.paperId}|${row.pageNum}|${row.text}`
    const list = groups.get(key)
    if (list) list.push(row)
    else groups.set(key, [row])
  }
  const updates: FragmentMergePlan['updates'] = []
  const removals: string[] = []
  for (const list of groups.values()) {
    if (list.length <= 1) continue
    const sorted = [...list].sort((a, b) => a.createdAt - b.createdAt || a.startOffset - b.startOffset)
    let cluster: FragmentRow[] = [sorted[0]]
    for (const row of sorted.slice(1)) {
      if (row.createdAt - cluster[cluster.length - 1].createdAt <= FRAGMENT_WINDOW_MS) cluster.push(row)
      else {
        mergeCluster(cluster, updates, removals)
        cluster = [row]
      }
    }
    mergeCluster(cluster, updates, removals)
  }
  return { updates, removals }
}
