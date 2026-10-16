import { describe, expect, it, vi } from 'vitest'
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ GlobalWorkerOptions: { workerSrc: '' } }))
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
    const result = await fillDoclingImages(document, 'AA==', { load: vi.fn().mockResolvedValue({ destroy }), crop })
    expect(result.items[1].images[0].page).toBe(0)
    expect(result.warnings.join()).toContain('2')
    expect(destroy).toHaveBeenCalledOnce()
    expect(document.items[1].images).toHaveLength(0)
  })
})
