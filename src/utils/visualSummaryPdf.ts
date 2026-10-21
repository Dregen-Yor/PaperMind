import type { VisualSummaryPage } from './visualSummary'

/** Dynamic loading avoids PDF.js side effects in stores which only read cached summaries. */
export async function renderSummaryPdf(base64: string, onProgress?: (label: string) => void): Promise<VisualSummaryPage[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  pdfjs.GlobalWorkerOptions.workerSrc = './pdf.worker.min.mjs'
  const binary = atob(base64.replace(/^data:application\/pdf;base64,/, ''))
  const loading = pdfjs.getDocument({ data: Uint8Array.from(binary, c => c.charCodeAt(0)) })
  const pdf = await loading.promise
  try {
    if (pdf.numPages > 120) throw new Error('文档超过本次完整视觉摘要的 120 页上限，未省略任何页面')
    const pages: VisualSummaryPage[] = []
    for (let i = 1; i <= pdf.numPages; i++) {
      onProgress?.(`渲染原文页面 ${i}/${pdf.numPages}`)
      const page = await pdf.getPage(i)
      const original = page.getViewport({ scale: 1 })
      const viewport = page.getViewport({ scale: 1600 / Math.max(original.width, original.height) })
      const canvas = document.createElement('canvas')
      canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height)
      const context = canvas.getContext('2d')
      if (!context) throw new Error('无法渲染 PDF 原文页面')
      // Display intent waits for requestAnimationFrame, which Chromium pauses
      // in hidden/minimized windows. Summary preparation must keep running there.
      await page.render({ canvasContext: context, canvas, viewport, intent: 'print' }).promise
      pages.push({ page: i - 1, width: canvas.width, height: canvas.height, data: canvas.toDataURL('image/jpeg', 0.88) })
      canvas.width = 0; canvas.height = 0; page.cleanup()
    }
    return pages
  } finally { await loading.destroy() }
}
