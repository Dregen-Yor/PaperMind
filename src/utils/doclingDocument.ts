/** Shared boundary between Docling, Electron persistence and the renderer. Pages are 0-based. */
export interface SourceRegion { page: number; x: number; y: number; width: number; height: number }
export interface TextProvenance { page: number; start: number; end: number; region?: SourceRegion }
export interface DocumentCell { text: string; region: SourceRegion }
export interface DocumentImage { page?: number; data?: string; assetId?: string }
export interface DocumentTableCell {
  text: string
  row: number
  column: number
  rowSpan: number
  colSpan: number
  columnHeader: boolean
  rowHeader: boolean
}
export interface DocumentTable { numRows: number; numCols: number; cells: DocumentTableCell[] }
export interface DocumentItem {
  id: string
  kind: 'text' | 'heading' | 'picture' | 'table' | 'formula'
  text: string
  caption: string
  pages: number[]
  regions: SourceRegion[]
  provenance?: TextProvenance[]
  captionRegions?: SourceRegion[]
  inBody?: boolean
  cells?: DocumentCell[]
  images: DocumentImage[]
  level?: number
  anchor?: string
  table?: DocumentTable
  formulaFormat?: 'latex' | 'mathml'
}
export interface ParsedDocument { version: 1; items: DocumentItem[]; warnings: string[] }
export interface DoclingRecord { document: ParsedDocument; sourceHash: string; configHash: string; cached: boolean }
const FIGURE_CAPTION = /^\s*(?:figure|fig\.?)\s+\d+[a-z]?(?:\s*[-–]\s*\d+)?\s*[:.]\s*\S/i
export function isEligibleFigure(item: DocumentItem): boolean {
  if (item.kind !== 'picture' || item.inBody !== true || !FIGURE_CAPTION.test(item.caption)) return false
  return item.regions.some(picture => item.captionRegions?.some(caption =>
    caption.page === picture.page && caption.y >= picture.y + picture.height - 0.005
    && caption.y - picture.y - picture.height <= 0.08
    && caption.x < picture.x + picture.width && caption.x + caption.width > picture.x)) ?? false
}
export function assignTypedDocumentIds(document: ParsedDocument): ParsedDocument {
  const counts: Record<DocumentItem['kind'], number> = { text: 0, heading: 0, picture: 0, table: 0, formula: 0 }
  for (const item of document.items) item.id = `${item.kind}-${++counts[item.kind]}`
  return document
}
export const IMAGE_DATA_PATTERN = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024
export const ASSET_ID_PATTERN = /^[a-f0-9]{64}$/

type JsonObject = Record<string, any>
const object = (value: unknown): JsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
const list = (value: unknown): any[] => Array.isArray(value) ? value : []
const string = (value: unknown): string => typeof value === 'string' ? value : ''

function isDocumentTable(value: unknown): value is DocumentTable {
  const table = object(value)
  return Number.isInteger(table.numRows) && table.numRows >= 0 && Number.isInteger(table.numCols) && table.numCols >= 0
    && Array.isArray(table.cells) && table.cells.every((value: unknown) => {
      const cell = object(value)
      return typeof cell.text === 'string' && Number.isInteger(cell.row) && cell.row >= 0
        && Number.isInteger(cell.column) && cell.column >= 0
        && Number.isInteger(cell.rowSpan) && cell.rowSpan > 0 && cell.row + cell.rowSpan <= table.numRows
        && Number.isInteger(cell.colSpan) && cell.colSpan > 0 && cell.column + cell.colSpan <= table.numCols
        && typeof cell.columnHeader === 'boolean' && typeof cell.rowHeader === 'boolean'
    })
}

export function isParsedDocument(value: unknown): value is ParsedDocument {
  const doc = object(value)
  return doc.version === 1 && Array.isArray(doc.items) && Array.isArray(doc.warnings)
    && doc.warnings.every((w: unknown) => typeof w === 'string') && doc.items.every((item: unknown) => {
      const i = object(item)
      return typeof i.id === 'string' && ['text', 'heading', 'picture', 'table', 'formula'].includes(i.kind)
        && (i.id.startsWith(`${i.kind}-`) && /^[1-9]\d*$/.test(i.id.slice(i.kind.length + 1)) || /^item-\d+$/.test(i.id))
        && typeof i.text === 'string' && typeof i.caption === 'string'
        && (i.level === undefined || i.kind === 'heading' && Number.isInteger(i.level) && i.level > 0)
        && (i.anchor === undefined || typeof i.anchor === 'string')
        && (i.table === undefined || i.kind === 'table' && isDocumentTable(i.table))
        && (i.formulaFormat === undefined || i.kind === 'formula' && ['latex', 'mathml'].includes(i.formulaFormat))
        && Array.isArray(i.pages) && i.pages.every((p: unknown) => Number.isInteger(p) && Number(p) >= 0)
        && Array.isArray(i.regions) && i.regions.every((r: SourceRegion) => r && Number.isInteger(r.page) && r.page >= 0
          && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0 && r.x + r.width <= 1.00001 && r.y + r.height <= 1.00001)
        && (i.captionRegions === undefined || Array.isArray(i.captionRegions) && i.captionRegions.every((r: SourceRegion) => r && Number.isInteger(r.page) && r.page >= 0
          && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0 && r.x + r.width <= 1.00001 && r.y + r.height <= 1.00001))
        && (i.provenance === undefined || Array.isArray(i.provenance) && i.provenance.every((p: TextProvenance) =>
          p && Number.isInteger(p.page) && i.pages.includes(p.page) && Number.isInteger(p.start) && Number.isInteger(p.end)
          && p.start >= 0 && p.end > p.start && p.end <= i.text.length
          && (p.region === undefined || p.region.page === p.page && i.regions.some((r: SourceRegion) =>
            (['page', 'x', 'y', 'width', 'height'] as const).every(key => r[key] === p.region![key])))))
        && (i.inBody === undefined || typeof i.inBody === 'boolean')
        && (i.cells === undefined || Array.isArray(i.cells) && i.kind === 'table' && i.cells.every((cell: DocumentCell) =>
          cell && typeof cell.text === 'string' && cell.region && Number.isInteger(cell.region.page) && cell.region.page >= 0
          && [cell.region.x, cell.region.y, cell.region.width, cell.region.height].every(Number.isFinite)
          && cell.region.x >= 0 && cell.region.y >= 0 && cell.region.width > 0 && cell.region.height > 0
          && cell.region.x + cell.region.width <= 1.00001 && cell.region.y + cell.region.height <= 1.00001))
        && Array.isArray(i.images) && i.images.every((im: DocumentImage) => im && (im.page === undefined || Number.isInteger(im.page) && im.page >= 0)
          && (im.data === undefined || typeof im.data === 'string' && IMAGE_DATA_PATTERN.test(im.data) && im.data.length <= MAX_IMAGE_BYTES * 1.4)
          && (im.assetId === undefined || typeof im.assetId === 'string' && ASSET_ID_PATTERN.test(im.assetId)))
    })
}

export function normalizeDoclingDocument(input: unknown, options: { preserveAllPictures?: boolean } = {}): ParsedDocument {
  const doc = object(input)
  const items: DocumentItem[] = []
  const counts: Record<DocumentItem['kind'], number> = { text: 0, heading: 0, picture: 0, table: 0, formula: 0 }
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
  const nearbyFigureCaptions = list(doc.texts).map((value, index) => {
    const raw = object(value)
    return { ref: string(raw.self_ref) || `#/texts/${index}`, text: string(raw.text), regions: regions(raw), label: string(raw.label) }
  }).filter(candidate => candidate.label === 'caption' && (options.preserveAllPictures || FIGURE_CAPTION.test(candidate.text)))
  const usedFigureCaptions = new Set<string>()
  const visit = (raw: JsonObject, path: string, inBody = false) => {
    const key = string(raw.self_ref) || path
    if (visited.has(key)) return
    visited.add(key)
    if (path.startsWith('#/groups/')) {
      for (const ref of list(raw.children)) visit(resolve(ref), string(ref?.$ref), inBody)
      return
    }
    const kind: DocumentItem['kind'] = path.startsWith('#/pictures/') ? 'picture'
      : path.startsWith('#/tables/') ? 'table' : raw.label === 'formula' ? 'formula'
      : ['section_header', 'title'].includes(raw.label) ? 'heading' : 'text'
    if (!(options.preserveAllPictures && (kind === 'picture' || raw.label === 'caption'))
      && (raw.content_layer === 'furniture' || ['caption', 'page_header', 'page_footer'].includes(raw.label))) return
    let text = string(raw.text)
    let cells: DocumentCell[] = []
    let table: DocumentTable | undefined
    if (kind === 'table') {
      const data = object(raw.data)
      const rawCells = list(data.table_cells).map(c => object(c)).sort((a, b) => (a.start_row_offset_idx ?? 0) - (b.start_row_offset_idx ?? 0) || (a.start_col_offset_idx ?? 0) - (b.start_col_offset_idx ?? 0))
      text = rawCells.map(c => `[row ${c.start_row_offset_idx ?? '?'}, col ${c.start_col_offset_idx ?? '?'}] ${string(c.text)}`).join('\n') || text
      if (Array.isArray(data.table_cells)) {
        const structuredCells: DocumentTableCell[] = rawCells.map(cell => ({
          text: string(cell.text), row: cell.start_row_offset_idx, column: cell.start_col_offset_idx,
          rowSpan: cell.row_span ?? (cell.end_row_offset_idx === undefined ? 1 : cell.end_row_offset_idx - cell.start_row_offset_idx),
          colSpan: cell.col_span ?? (cell.end_col_offset_idx === undefined ? 1 : cell.end_col_offset_idx - cell.start_col_offset_idx),
          columnHeader: cell.column_header === true, rowHeader: cell.row_header === true,
        }))
        const candidate = {
          numRows: data.num_rows ?? structuredCells.reduce((size, cell) => Math.max(size, cell.row + cell.rowSpan), 0),
          numCols: data.num_cols ?? structuredCells.reduce((size, cell) => Math.max(size, cell.column + cell.colSpan), 0),
          cells: structuredCells,
        }
        if (isDocumentTable(candidate)) table = candidate
        else if (options.preserveAllPictures) throw new Error('Docling 表格结构不完整，无法生成完整摘要')
      }
      const tablePages = [...new Set<number>(list(raw.prov).map(p => p?.page_no).filter(p => Number.isInteger(p) && p >= 1))]
      cells = rawCells.flatMap(cell => {
        const pageNo = Number.isInteger(cell.page_no) ? cell.page_no : tablePages.length === 1 ? tablePages[0] : null
        const cellRegions = pageNo ? regions({ prov: [{ page_no: pageNo, bbox: cell.bbox }] }) : []
        return cellRegions.length && string(cell.text) ? [{ text: string(cell.text), region: cellRegions[0] }] : []
      })
    }
    let caption = list(raw.captions).map(ref => string(resolve(ref).text)).filter(Boolean).join('\n') || string(raw.caption)
    let captionRegions = kind === 'picture' ? list(raw.captions).flatMap(ref => regions(resolve(ref))) : []
    const pages = [...new Set<number>(list(raw.prov).map(p => p?.page_no).filter(p => Number.isInteger(p) && p >= 1).map(p => p - 1))].sort((a, b) => a - b)
    const uri = string(object(raw.image).uri)
    if (options.preserveAllPictures && uri.startsWith('data:image/') && uri.length > MAX_IMAGE_BYTES * 1.4) {
      throw new Error('Docling 图片超过材料大小上限（12 MiB），无法生成完整摘要')
    }
    const images: DocumentImage[] = IMAGE_DATA_PATTERN.test(uri) && uri.length <= MAX_IMAGE_BYTES * 1.4 ? [{ data: uri, ...(pages[0] !== undefined ? { page: pages[0] } : {}) }] : []
    const pictureRegions = kind === 'picture' ? regions(raw) : []
    if (kind === 'picture' && (inBody || options.preserveAllPictures) && !caption) {
      const nearest = nearbyFigureCaptions.filter(candidate => !usedFigureCaptions.has(candidate.ref))
        .map(candidate => ({ ...candidate, gap: Math.min(...pictureRegions.flatMap(picture => candidate.regions
          .filter(region => region.page === picture.page && region.y >= picture.y + picture.height - 0.005
            && region.y - picture.y - picture.height <= 0.08
            && region.x < picture.x + picture.width && region.x + region.width > picture.x)
          .map(region => region.y - picture.y - picture.height))) }))
        .filter(candidate => Number.isFinite(candidate.gap))
        .sort((a, b) => a.gap - b.gap)[0]
      if (nearest) {
        caption = nearest.text
        captionRegions = nearest.regions
        usedFigureCaptions.add(nearest.ref)
      }
    }
    if (!text && !caption && kind === 'text') return
    // Docling offsets count Unicode code points; renderer offsets use UTF-16.
    const characters = Array.from(text)
    const provenance: TextProvenance[] = kind === 'table' ? [] : list(raw.prov).flatMap(p => {
      const [start, end] = list(p?.charspan)
      if (!Number.isInteger(p?.page_no) || p.page_no < 1 || !Number.isInteger(start) || !Number.isInteger(end)
        || start < 0 || end <= start || end > characters.length) return []
      const region = regions({ prov: [p] })[0]
      return [{ page: p.page_no - 1, start: characters.slice(0, start).join('').length,
        end: characters.slice(0, end).join('').length, ...(region ? { region } : {}) }]
    })
    const item: DocumentItem = { id: `${kind}-${counts[kind] + 1}`, kind, text, caption, pages, regions: kind === 'picture' ? pictureRegions : regions(raw), images,
      ...(provenance.length ? { provenance } : {}),
      ...(kind === 'heading' && Number.isInteger(raw.level) && raw.level > 0 ? { level: raw.level } : {}),
      ...(kind === 'picture' ? { captionRegions, inBody } : {}),
      ...(cells.length ? { cells } : {}),
      ...(table ? { table } : {}) }
    if (kind === 'picture' && !options.preserveAllPictures && !isEligibleFigure(item)) return
    if (options.preserveAllPictures && kind === 'picture' && !images.length) warnings.push(`${item.id}：Docling 未提供可用的嵌入图片，摘要中保留缺失图片说明。`)
    if (options.preserveAllPictures && kind === 'table' && !table) warnings.push(`${item.id}：Docling 未提供表格结构，保留返回的文字内容。`)
    if (kind === 'picture') for (const ref of list(raw.captions)) usedFigureCaptions.add(string(ref?.$ref))
    counts[kind]++
    items.push(item)
  }
  for (const ref of list(object(doc.body).children)) visit(resolve(ref), string(ref?.$ref), true)
  // Old or partial exports can omit body. Include unreferenced evidence without duplicating references.
  for (const collection of ['texts', 'pictures', 'tables']) list(doc[collection]).forEach((raw, index) => visit(object(raw), `#/${collection}/${index}`))
  if (!items.some(i => i.text || i.caption || options.preserveAllPictures && i.kind === 'picture')) throw new Error('Docling 未返回可用于解读的文档内容')
  return { version: 1, items, warnings }
}
