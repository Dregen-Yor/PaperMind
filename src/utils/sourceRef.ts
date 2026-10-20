/** 结构化来源：芯片文案 + 跳转所需的论文与页区间（#1）。 */
export interface SourceRef {
  label: string
  paperId?: string
  startPage?: number
  endPage?: number
  region?: EvidenceRegion
  quote?: string
}

export interface EvidenceRegion { x: number; y: number; width: number; height: number }
const MAX_EVIDENCE_QUOTE = 2048

export function validEvidenceRegion(value: unknown): value is EvidenceRegion {
  if (!value || typeof value !== 'object') return false
  const { x, y, width, height } = value as EvidenceRegion
  return [x, y, width, height].every(Number.isFinite) && x >= 0 && y >= 0 && width > 0 && height > 0
    && x + width <= 1.00001 && y + height <= 1.00001
}

export function evidenceHref(paperId: string, page: number, region?: EvidenceRegion, quote = '', endPage = page): string {
  const base = `paper-source:${encodeURIComponent(paperId)}:${page}${Number.isSafeInteger(endPage) && endPage > page ? `-${endPage}` : ''}`
  if (!validEvidenceRegion(region) && !quote) return base
  const box = validEvidenceRegion(region) ? [region.x, region.y, region.width, region.height].map(n => Number(n.toFixed(4))).join(',') : '-'
  // Markdown destinations treat parentheses as syntax, but encodeURIComponent leaves them bare.
  const encodedQuote = encodeURIComponent(quote.slice(0, MAX_EVIDENCE_QUOTE))
    .replace(/[()]/g, character => character === '(' ? '%28' : '%29')
  return `${base}:${box}:${encodedQuote}`
}

export function parseEvidenceHref(href: string): Pick<SourceRef, 'paperId' | 'startPage' | 'endPage' | 'region' | 'quote'> | null {
  const match = /^paper-source:([^:]+):(\d+(?:-\d+)?)(?::([\d.,-]+):([^:]*))?$/.exec(href)
  if (!match) return null
  try {
    const paperId = decodeURIComponent(match[1])
    const [page, endPage = page] = match[2].split('-').map(Number)
    if (!paperId || !Number.isSafeInteger(page) || page < 0 || !Number.isSafeInteger(endPage) || endPage < page) return null
    const values = match[3]?.split(',').map(Number)
    const region = values?.length === 4 ? { x: values[0], y: values[1], width: values[2], height: values[3] } : undefined
    if (match[3] && match[3] !== '-' && !validEvidenceRegion(region)) return null
    const quote = match[4] ? decodeURIComponent(match[4]) : ''
    if (quote.length > MAX_EVIDENCE_QUOTE || /[\u0000-\u001f]/.test(quote)) return null
    return { paperId, startPage: page, endPage, ...(region ? { region } : {}), ...(quote ? { quote } : {}) }
  } catch { return null }
}

export function sourceRouteQuery(ref: SourceRef): Record<string, string> {
  const query: Record<string, string> = { page: String((ref.startPage ?? 0) + 1) }
  if (Number.isSafeInteger(ref.endPage) && ref.endPage! > (ref.startPage ?? 0)) query.endPage = String(ref.endPage! + 1)
  if (validEvidenceRegion(ref.region)) query.region = [ref.region.x, ref.region.y, ref.region.width, ref.region.height].join(',')
  if (ref.quote) query.quote = ref.quote
  return query
}

export function sourceFromRouteQuery(paperId: string, query: Record<string, unknown>): SourceRef | null {
  const page = typeof query.page === 'string' ? Number(query.page) : NaN
  if (!Number.isSafeInteger(page) || page < 1) return null
  const ref: SourceRef = { label: `p${page}`, paperId, startPage: page - 1, endPage: page - 1 }
  const endPage = typeof query.endPage === 'string' ? Number(query.endPage) : page
  if (Number.isSafeInteger(endPage) && endPage >= page) ref.endPage = endPage - 1
  if (typeof query.region === 'string') {
    const values = query.region.split(',').map(Number)
    const region = values.length === 4 ? { x: values[0], y: values[1], width: values[2], height: values[3] } : undefined
    if (validEvidenceRegion(region)) ref.region = region
  }
  if (typeof query.quote === 'string' && query.quote.length <= MAX_EVIDENCE_QUOTE && !/[\u0000-\u001f]/.test(query.quote)) ref.quote = query.quote
  return ref
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
      const { label, paperId, startPage, endPage, region, quote } = item as any
      refs.push({
        label,
        ...(typeof paperId === 'string' ? { paperId } : {}),
        ...(typeof startPage === 'number' ? { startPage } : {}),
        ...(typeof endPage === 'number' ? { endPage } : {}),
        ...(validEvidenceRegion(region) ? { region } : {}),
        ...(typeof quote === 'string' && quote.length <= MAX_EVIDENCE_QUOTE && !/[\u0000-\u001f]/.test(quote) ? { quote } : {}),
      })
    }
  }
  return refs
}

/** 芯片是否可跳页。 */
export function isJumpable(ref: SourceRef): boolean {
  return typeof ref.paperId === 'string' && typeof ref.startPage === 'number'
}
