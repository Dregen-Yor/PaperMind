/** Shared boundary between Docling, Electron persistence and the renderer. Pages are 0-based. */
export interface DoclingSettings {
  baseUrl: string
  apiKey: string
  timeoutSeconds: number
  ocr: boolean
  formula: boolean
}
export interface SourceRegion { page: number; x: number; y: number; width: number; height: number }
export interface DocumentImage { page?: number; data?: string; assetId?: string }
export interface DocumentItem {
  id: string
  kind: 'text' | 'heading' | 'picture' | 'table' | 'formula'
  text: string
  caption: string
  pages: number[]
  regions: SourceRegion[]
  images: DocumentImage[]
}
export interface ParsedDocument { version: 1; items: DocumentItem[]; warnings: string[] }
export interface DoclingRecord { document: ParsedDocument; sourceHash: string; configHash: string; cached: boolean }
export const DOCLING_SETTINGS_KEY = 'docling_config'
export const DEFAULT_DOCLING_SETTINGS: DoclingSettings = {
  baseUrl: '', apiKey: '', timeoutSeconds: 600, ocr: true, formula: true,
}
export const IMAGE_DATA_PATTERN = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024
export const ASSET_ID_PATTERN = /^[a-f0-9]{64}$/

type JsonObject = Record<string, any>
const object = (value: unknown): JsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
const list = (value: unknown): any[] => Array.isArray(value) ? value : []
const string = (value: unknown): string => typeof value === 'string' ? value : ''

export function normalizeDoclingSettings(value: unknown): DoclingSettings {
  const raw = object(value)
  let baseUrl = string(raw.baseUrl).trim().replace(/\/+$/, '')
  if (baseUrl) {
    let url: URL
    try { url = new URL(baseUrl) } catch { throw new Error('Docling 服务地址必须是有效的 HTTP/HTTPS 地址') }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Docling 服务地址必须使用 HTTP/HTTPS')
    if (url.username || url.password) throw new Error('服务地址不能包含凭据，请使用 API Key 字段')
    if (url.search || url.hash) throw new Error('请填写 Docling 服务根地址，不包含查询参数或片段')
    baseUrl = url.href.replace(/\/+$/, '')
  }
  const timeoutSeconds = raw.timeoutSeconds ?? DEFAULT_DOCLING_SETTINGS.timeoutSeconds
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 1800) throw new Error('Docling 超时必须为 30–1800 秒')
  return { baseUrl, apiKey: string(raw.apiKey).trim(), timeoutSeconds, ocr: raw.ocr !== false, formula: raw.formula !== false }
}

export function isParsedDocument(value: unknown): value is ParsedDocument {
  const doc = object(value)
  return doc.version === 1 && Array.isArray(doc.items) && Array.isArray(doc.warnings)
    && doc.warnings.every((w: unknown) => typeof w === 'string') && doc.items.every((item: unknown) => {
      const i = object(item)
      return typeof i.id === 'string' && /^item-\d+$/.test(i.id) && ['text', 'heading', 'picture', 'table', 'formula'].includes(i.kind)
        && typeof i.text === 'string' && typeof i.caption === 'string'
        && Array.isArray(i.pages) && i.pages.every((p: unknown) => Number.isInteger(p) && Number(p) >= 0)
        && Array.isArray(i.regions) && i.regions.every((r: SourceRegion) => r && Number.isInteger(r.page) && r.page >= 0
          && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0 && r.x + r.width <= 1.00001 && r.y + r.height <= 1.00001)
        && Array.isArray(i.images) && i.images.every((im: DocumentImage) => im && (im.page === undefined || Number.isInteger(im.page) && im.page >= 0)
          && (im.data === undefined || typeof im.data === 'string' && IMAGE_DATA_PATTERN.test(im.data) && im.data.length <= MAX_IMAGE_BYTES * 1.4)
          && (im.assetId === undefined || typeof im.assetId === 'string' && ASSET_ID_PATTERN.test(im.assetId)))
    })
}

export function normalizeDoclingDocument(input: unknown): ParsedDocument {
  const doc = object(input)
  const items: DocumentItem[] = []
  const warnings: string[] = []
  const visited = new Set<string>()
  const resolve = (ref: unknown): JsonObject => {
    const path = string(object(ref).$ref)
    if (!/^#\/(texts|pictures|tables|groups)\/\d+$/.test(path)) return {}
    const [, collection, index] = path.split('/')
    return object(list(doc[collection!])[Number(index)])
  }
  const regions = (raw: JsonObject): SourceRegion[] => list(raw.prov).flatMap(p => {
    const page = p?.page_no
    const box = object(p?.bbox)
    const size = object(object(object(doc.pages)[String(page)]).size)
    if (!Number.isInteger(page) || page < 1 || ![box.l, box.r, box.t, box.b, size.width, size.height].every(Number.isFinite) || size.width <= 0 || size.height <= 0) return []
    if (!['TOPLEFT', 'BOTTOMLEFT'].includes(box.coord_origin ?? 'BOTTOMLEFT')) return []
    const top = box.coord_origin === 'TOPLEFT' ? Math.min(box.t, box.b) : size.height - Math.max(box.t, box.b)
    const x = Math.max(0, Math.min(box.l, box.r) / size.width)
    const y = Math.max(0, top / size.height)
    const right = Math.min(1, Math.max(box.l, box.r) / size.width)
    const bottom = Math.min(1, (top + Math.abs(box.t - box.b)) / size.height)
    return right > x && bottom > y ? [{ page: page - 1, x, y, width: right - x, height: bottom - y }] : []
  })
  const visit = (raw: JsonObject, path: string) => {
    const key = string(raw.self_ref) || path
    if (visited.has(key)) return
    visited.add(key)
    if (path.startsWith('#/groups/')) {
      for (const ref of list(raw.children)) visit(resolve(ref), string(ref?.$ref))
      return
    }
    if (raw.content_layer === 'furniture' || ['caption', 'page_header', 'page_footer'].includes(raw.label)) return
    const kind: DocumentItem['kind'] = path.startsWith('#/pictures/') ? 'picture'
      : path.startsWith('#/tables/') ? 'table' : raw.label === 'formula' ? 'formula'
      : ['section_header', 'title'].includes(raw.label) ? 'heading' : 'text'
    let text = string(raw.text)
    if (kind === 'table') {
      const cells = list(object(raw.data).table_cells).map(c => object(c)).sort((a, b) => (a.start_row_offset_idx ?? 0) - (b.start_row_offset_idx ?? 0) || (a.start_col_offset_idx ?? 0) - (b.start_col_offset_idx ?? 0))
      text = cells.map(c => `[row ${c.start_row_offset_idx ?? '?'}, col ${c.start_col_offset_idx ?? '?'}] ${string(c.text)}`).join('\n') || text
    }
    const caption = list(raw.captions).map(ref => string(resolve(ref).text)).filter(Boolean).join('\n') || string(raw.caption)
    const pages = [...new Set<number>(list(raw.prov).map(p => p?.page_no).filter(p => Number.isInteger(p) && p >= 1).map(p => p - 1))].sort((a, b) => a - b)
    const uri = string(object(raw.image).uri)
    const images: DocumentImage[] = IMAGE_DATA_PATTERN.test(uri) && uri.length <= MAX_IMAGE_BYTES * 1.4 ? [{ data: uri, ...(pages[0] !== undefined ? { page: pages[0] } : {}) }] : []
    if (!text && !caption && kind === 'text') return
    items.push({ id: `item-${items.length}`, kind, text, caption, pages, regions: regions(raw), images })
  }
  for (const ref of list(object(doc.body).children)) visit(resolve(ref), string(ref?.$ref))
  // Old or partial exports can omit body. Include unreferenced evidence without duplicating references.
  for (const collection of ['texts', 'pictures', 'tables']) list(doc[collection]).forEach((raw, index) => visit(object(raw), `#/${collection}/${index}`))
  if (!items.some(i => i.text || i.caption)) throw new Error('Docling 未返回可用于解读的文档内容')
  return { version: 1, items, warnings }
}
