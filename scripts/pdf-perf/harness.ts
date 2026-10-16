import { createApp, nextTick } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import PdfViewer from '../../src/components/PdfViewer.vue'
import { makeFixturePdf } from './fixture'
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'

document.body.style.margin = '0'
document.body.style.background = '#fff'
document.getElementById('app')!.style.cssText = 'width:720px;height:820px;'
;(window as any).db = {
  highlight: { listByPaper: async () => [] },
}
pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'

const waitFor = (predicate: () => boolean, timeoutMs = 30000): Promise<void> => new Promise((resolve, reject) => {
  const start = performance.now()
  const timer = window.setInterval(() => {
    if (predicate()) { clearInterval(timer); resolve() }
    else if (performance.now() - start > timeoutMs) { clearInterval(timer); reject(new Error('PDF benchmark timed out')) }
  }, 10)
})

async function run() {
  console.log('[pdf-perf] mount')
  const bytes = makeFixturePdf()
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }))
  const start = performance.now()
  const app = createApp(PdfViewer, { src: url, paperId: 'benchmark-paper' })
  app.use(createPinia())
  app.use(ElementPlus)
  const viewer = app.mount('#app') as any
  await waitFor(() => !!document.querySelector('.pdf-page[data-page="1"][data-rendered="true"]'))
  console.log('[pdf-perf] first page')
  const firstPageMs = performance.now() - start
  await new Promise(resolve => setTimeout(resolve, 400))
  const renderedAfterOpen = document.querySelectorAll('.pdf-page[data-rendered="true"]').length

  const jumpStart = performance.now()
  const jump = viewer.scrollToPage(50)
  await waitFor(() => !!document.querySelector('.pdf-page[data-page="50"][data-rendered="true"]'))
  await jump
  console.log('[pdf-perf] jump')
  const jumpMs = performance.now() - jumpStart

  const zoomStart = performance.now()
  document.querySelector<HTMLButtonElement>('[aria-label="放大论文"]')!.click()
  await nextTick()
  await waitFor(() => !!document.querySelector('.pdf-page[data-page="50"][data-rendered="true"]'))
  console.log('[pdf-perf] zoom')
  const zoomMs = performance.now() - zoomStart
  await new Promise(resolve => setTimeout(resolve, 400))
  const renderedAfterZoom = document.querySelectorAll('.pdf-page[data-rendered="true"]').length
  const usedJsHeapMiB = ((performance as any).memory?.usedJSHeapSize ?? null) === null
    ? null : (performance as any).memory.usedJSHeapSize / 1024 / 1024
  app.unmount()
  URL.revokeObjectURL(url)
  return { fixturePages: 60, fixtureBytes: bytes.byteLength, firstPageMs, jumpMs, zoomMs,
    renderedAfterOpen, renderedAfterZoom, usedJsHeapMiB }
}

;(window as any).__pdfBenchResult = run().catch(error => ({ error: error instanceof Error ? error.stack : String(error) }))
