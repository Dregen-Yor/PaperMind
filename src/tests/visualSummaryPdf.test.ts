import { afterEach, describe, expect, it, vi } from 'vitest'
const fake = vi.hoisted(() => ({ render: vi.fn(), cleanup: vi.fn(), destroy: vi.fn() }))
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(() => ({ promise: Promise.resolve({ numPages: 1, getPage: async () => ({
    getViewport: ({ scale }: { scale: number }) => ({ width: 100 * scale, height: 200 * scale }),
    render: fake.render, cleanup: fake.cleanup,
  }) }), destroy: fake.destroy })),
}))
import { renderSummaryPdf } from '../utils/visualSummaryPdf'
afterEach(() => vi.restoreAllMocks())
describe('background original-page rendering', () => {
  it('uses print scheduling to render while the application window is hidden', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as any)
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,YQ==')
    fake.render.mockImplementation(({ intent }) => ({ promise: intent === 'print' ? Promise.resolve() : Promise.reject(new Error('Display scheduler requires visible requestAnimationFrame')) }))
    const pages = await renderSummaryPdf('YQ==')
    expect(fake.render).toHaveBeenCalledWith(expect.objectContaining({ intent: 'print' }))
    expect(pages).toEqual([{ page: 0, width: 800, height: 1600, data: 'data:image/jpeg;base64,YQ==' }])
    expect(fake.cleanup).toHaveBeenCalled()
    expect(fake.destroy).toHaveBeenCalled()
  })
})
