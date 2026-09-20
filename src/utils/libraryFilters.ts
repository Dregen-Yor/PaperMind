import type { Paper } from '../stores/paper'

export interface LibraryFilters {
  query?: string
  status?: Paper['status'] | 'all'
  sort?: 'recent' | 'title'
}

export function filterLibraryPapers(papers: Paper[], filters: LibraryFilters = {}): Paper[] {
  const query = filters.query?.trim().toLowerCase() ?? ''

  return papers
    .filter(paper => {
      if (filters.status && filters.status !== 'all' && paper.status !== filters.status) return false
      const searchable = [paper.title, paper.fileName, ...(paper.authors ?? []), ...(paper.tags ?? [])]
      return !query || searchable.some(value => value?.toLowerCase().includes(query))
    })
    .sort((a, b) => filters.sort === 'title'
      ? (a.title || a.fileName).localeCompare(b.title || b.fileName, 'zh-CN', { sensitivity: 'base', numeric: true })
      : b.addedAt - a.addedAt)
}

/** 卡片作者行：超长作者列表截断为「前 N 位 等 M 位作者」（#9）。 */
export function formatAuthors(authors: string[] | undefined, max = 4): string {
  const list = (authors ?? []).filter(Boolean)
  if (list.length === 0) return '作者信息待补充'
  if (list.length <= max) return list.join(', ')
  return `${list.slice(0, max).join(', ')} 等 ${list.length - max} 位作者`
}
