import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { ParsedDocument, SourceRegion, DoclingRecord } from './doclingDocument'
pdfjs.GlobalWorkerOptions.workerSrc = './pdf.worker.min.mjs'

export function cropPixels(region: SourceRegion, width: number, height: number) {
  const x = Math.floor(region.x * width)
  const y = Math.floor(region.y * height)
  return { x, y, width: Math.max(1, Math.min(width - x, Math.round(region.width * width))), height: Math.max(1, Math.min(height - y, Math.round(region.height * height))) }
}
interface CropDependencies {
  load: (base64: string) => Promise<any>
  crop: (pdf: any, region: SourceRegion) => Promise<string>
}
const nativeCrop: CropDependencies = {
  load: base64 => pdfjs.getDocument({ data: Uint8Array.from(atob(base64), char => char.charCodeAt(0)) }).promise,
  async crop(pdf, region) {
    const page = await pdf.getPage(region.page + 1)
    const unit = page.getViewport({ scale: 1 })
    const scale = Math.min(2, 3200 / Math.max(unit.width, unit.height))
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('无法创建 PDF 图片画布')
    await page.render({ canvasContext: context, canvas, viewport }).promise
    const pixels = cropPixels(region, canvas.width, canvas.height)
    const image = document.createElement('canvas')
    image.width = pixels.width; image.height = pixels.height
    const imageContext = image.getContext('2d')
    if (!imageContext) throw new Error('无法裁剪原文图片')
    imageContext.drawImage(canvas, pixels.x, pixels.y, pixels.width, pixels.height, 0, 0, pixels.width, pixels.height)
    const data = image.toDataURL('image/png')
    canvas.width = 0; canvas.height = 0
    image.width = 0; image.height = 0
    page.cleanup()
    return data
  },
}
export async function fillDoclingImages(input: ParsedDocument, base64: string, deps: CropDependencies = nativeCrop): Promise<ParsedDocument> {
  const document: ParsedDocument = JSON.parse(JSON.stringify(input))
  const missing = document.items.filter(item => ['picture', 'table', 'formula'].includes(item.kind))
    .flatMap(item => item.regions.filter(r => !item.images.some(im => im.page === r.page)).map(region => ({ item, region })))
  for (const item of document.items) if (['picture', 'table', 'formula'].includes(item.kind) && !item.images.length && !item.regions.length) {
    document.warnings.push(`${item.caption || item.id} 缺少原文图片和裁剪位置。`)
  }
  if (!missing.length) return document
  let pdf: any
  try {
    pdf = await deps.load(base64)
    for (const { item, region } of missing) {
      try { item.images.push({ page: region.page, data: await deps.crop(pdf, region) }) }
      catch { document.warnings.push(`${item.caption || item.id} 在第 ${region.page + 1} 页的原文截图提取失败。`) }
    }
  } catch { document.warnings.push('本地 PDF 图片提取失败，部分原图无法展示。') }
  finally { if (pdf) { try { await pdf.destroy() } catch { /* Already released. */ } } }
  document.warnings = [...new Set(document.warnings)]
  return document
}

const inFlight = new Map<string, Promise<DoclingRecord>>()
export async function prepareDoclingPaper(paperId: string, onStage: (label: string) => void): Promise<ParsedDocument> {
  onStage('正在解析文档…')
  let task = inFlight.get(paperId)
  if (!task) {
    task = (async () => {
      const record = await window.db.docling.convert(paperId)
      if (record.cached) return record
      onStage('正在整理原文图片、表格和公式…')
      const needsCrop = record.document.items.some(item => item.regions.some(r => !item.images.some(im => im.page === r.page)) && item.kind !== 'text' && item.kind !== 'heading')
      const bytes = needsCrop ? await window.db.paper.readFile(paperId) : ''
      if (needsCrop && !bytes) throw new Error('找不到论文 PDF 文件')
      const document = await fillDoclingImages(record.document, bytes || '')
      return window.db.docling.save(paperId, { ...record, document })
    })()
    inFlight.set(paperId, task)
    const current = task
    void current.finally(() => { if (inFlight.get(paperId) === current) inFlight.delete(paperId) }).catch(() => {})
  }
  return (await task).document
}
