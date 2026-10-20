import { describe, expect, it, vi } from 'vitest'
const { getDocument } = vi.hoisted(() => ({ getDocument: vi.fn() }))
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument }))
import { fillDoclingImages, cropPixels } from '../utils/doclingPdf'
import { normalizeDoclingDocument } from '../utils/doclingDocument'
describe('original PDF region images', () => {
  it('maps normalized regions onto high resolution page pixels', () => {
    expect(cropPixels({ page: 0, x: .1, y: .2, width: .8, height: .6 }, 200, 200)).toEqual({ x: 20, y: 40, width: 160, height: 120 })
  })
  it('recovers all missing regions and releases the PDF even when one crop fails', async () => {
    const document = normalizeDoclingDocument({ texts: [{ text: 'Evidence' }], tables: [{ prov: [{ page_no: 1, bbox: { l: 0, t: 0, r: 50, b: 50, coord_origin: 'TOPLEFT' } }, { page_no: 2, bbox: { l: 0, t: 0, r: 50, b: 50, coord_origin: 'TOPLEFT' } }] }], pages: { '1': { size: { width: 100, height: 100 } }, '2': { size: { width: 100, height: 100 } } } })
    const destroy = vi.fn()
    const crop = vi.fn().mockResolvedValueOnce('data:image/png;base64,aGVsbG8=').mockRejectedValueOnce(new Error('bad page'))
    const result = await fillDoclingImages(document, 'AA==', { load: () => ({ promise: Promise.resolve({}), destroy }), crop })
    expect(result.items[1].images[0].page).toBe(0)
    expect(result.warnings.join()).toContain('2')
    expect(destroy).toHaveBeenCalledOnce()
    expect(document.items[1].images).toHaveLength(0)
  })
})


describe('PDF.js loading task ownership', () => {
  const input = () => normalizeDoclingDocument({ texts: [{ text: 'Evidence' }], tables: [{ prov: [{ page_no: 1, bbox: { l: 0, t: 0, r: 50, b: 50, coord_origin: 'TOPLEFT' } }] }], pages: { '1': { size: { width: 100, height: 100 } } } })
  it('crops successfully using a proxy without destroy and releases its task and page canvas', async () => {
    const destroy = vi.fn().mockResolvedValue(undefined)
    const cleanup = vi.fn()
    let canvas: HTMLCanvasElement | undefined
    getDocument.mockReturnValue({ promise: Promise.resolve({ getPage: async () => ({
      getViewport: () => ({ width: 100, height: 100 }),
      render: (options: { canvas: HTMLCanvasElement }) => { canvas = options.canvas; return { promise: Promise.resolve() } },
      cleanup,
    }) }), destroy })
    const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage() {} } as unknown as CanvasRenderingContext2D)
    const encode = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,aGVsbG8=')
    try {
      const result = await fillDoclingImages(input(), 'AA==')
      expect(result.items[1].images).toEqual([{ page: 0, data: 'data:image/png;base64,aGVsbG8=' }])
      expect(result.warnings).toEqual([])
      expect(canvas?.width).toBe(0)
      expect(canvas?.height).toBe(0)
      expect(cleanup).toHaveBeenCalledOnce()
      expect(destroy).toHaveBeenCalledOnce()
    } finally { context.mockRestore(); encode.mockRestore() }
  })
  it('destroys the real-contract loading task when document loading fails', async () => {
    const destroy = vi.fn().mockResolvedValue(undefined)
    getDocument.mockReturnValue({ promise: Promise.reject(new Error('invalid pdf')), destroy })
    const result = await fillDoclingImages(input(), 'AA==')
    expect(result.warnings.join()).toContain('PDF')
    expect(destroy).toHaveBeenCalledOnce()
  })
  it('destroys the loading task when cropping fails, without requiring PDFDocumentProxy.destroy', async () => {
    const destroy = vi.fn().mockResolvedValue(undefined)
    getDocument.mockReturnValue({ promise: Promise.resolve({ getPage: async () => { throw new Error('bad page') } }), destroy })
    await fillDoclingImages(input(), 'AA==')
    expect(destroy).toHaveBeenCalledOnce()
  })
  it('destroys an in-flight loading task immediately on cancellation', async () => {
    const destroy = vi.fn().mockResolvedValue(undefined)
    getDocument.mockReturnValue({ promise: new Promise(() => {}), destroy })
    const controller = new AbortController()
    const pending = fillDoclingImages(input(), 'AA==', undefined, controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(destroy).toHaveBeenCalledOnce()
  })
})
