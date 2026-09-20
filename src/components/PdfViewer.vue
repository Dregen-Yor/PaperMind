<template>
  <div class="pdf-viewer" ref="containerRef">
    <div class="pdf-toolbar">
      <div class="tb-group">
        <el-button size="small" text @click="prevPage" :disabled="currentPage <= 1" aria-label="上一页" title="上一页">
          <el-icon><ArrowUp /></el-icon>
        </el-button>
        <span class="page-indicator"><span class="page-current">{{ currentPage }}</span><span class="page-total"> / {{ totalPages }} 页</span></span>
        <el-button size="small" text @click="nextPage" :disabled="currentPage >= totalPages" aria-label="下一页" title="下一页">
          <el-icon><ArrowDown /></el-icon>
        </el-button>
      </div>
      <div class="tb-group">
        <el-button size="small" text @click="zoomOut" :disabled="scale <= 0.1" aria-label="缩小论文" title="缩小"><el-icon><ZoomOut /></el-icon></el-button>
        <button type="button" class="zoom-indicator fit-button" @click="fitToWidth" aria-label="适合宽度" title="点击适合宽度">{{ Math.round(scale * 100) }}%</button>
        <el-button size="small" text @click="zoomIn" aria-label="放大论文" title="放大"><el-icon><ZoomIn /></el-icon></el-button>
      </div>
    </div>

    <div class="pdf-scroll" ref="scrollRef" tabindex="0" aria-label="可滚动的 PDF 原文">
      <div class="pdf-pages" ref="pagesRef" />
    </div>

    <!-- Selection popup -->
    <div v-if="selectionPopup.visible" class="selection-popup" :style="popupStyle">
      <button class="popup-btn" @click="sendSelectionToChat">
        <el-icon><ChatLineSquare /></el-icon> 发送到对话
      </button>
      <button class="popup-btn" @click="highlightSelection">
        <el-icon><EditPen /></el-icon> 高亮
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed } from 'vue'
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'
import { ArrowUp, ArrowDown, ZoomIn, ZoomOut, ChatLineSquare, EditPen } from '@element-plus/icons-vue'
import { usePaperStore } from '../stores/paper'

const props = defineProps<{ src: string; paperId: string }>()
const paperStore = usePaperStore()
const emit = defineEmits<{ (e: 'select-text', text: string): void }>()

pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.min.mjs'

const containerRef = ref<HTMLElement>()
const scrollRef = ref<HTMLElement>()
const pagesRef = ref<HTMLElement>()
const currentPage = ref(1)
const totalPages = ref(0)
const scale = ref(1)
let fitOnNextRender = true
const selectedText = ref('')

let pdfDoc: any = null
let selectedRange: Range | null = null
const selectionPopup = ref({ visible: false, x: 0, y: 0 })
interface HighlightSegment {
  page: number
  start: number
  end: number
}
const highlightSegments: HighlightSegment[] = []

const popupStyle = computed(() => ({ left: `${selectionPopup.value.x}px`, top: `${selectionPopup.value.y}px` }))

function getTextNodes(root: HTMLElement): Text[] {
  const nodes: Text[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node) {
    if (node.textContent) nodes.push(node as Text)
    node = walker.nextNode()
  }
  return nodes
}

function subtractExisting(segment: HighlightSegment): HighlightSegment[] {
  const existing = highlightSegments
    .filter(item => item.page === segment.page)
    .sort((a, b) => a.start - b.start)

  let uncovered = [segment]
  for (const cover of existing) {
    uncovered = uncovered.flatMap(part => {
      if (cover.end <= part.start || cover.start >= part.end) return [part]
      const pieces: HighlightSegment[] = []
      if (cover.start > part.start) pieces.push({ ...part, end: cover.start })
      if (cover.end < part.end) pieces.push({ ...part, start: cover.end })
      return pieces
    })
  }
  return uncovered
}

function caretRect(node: Text, offset: number): DOMRect {
  const range = document.createRange()
  range.setStart(node, offset)
  range.collapse(true)
  const rect = range.getBoundingClientRect()
  range.detach()
  return rect
}

function drawSegment(pageDiv: HTMLElement, segment: HighlightSegment) {
  const nodes = getTextNodes(pageDiv.querySelector<HTMLElement>('.text-layer')!)
  let offset = 0

  for (const node of nodes) {
    const length = node.data.length
    const nodeStart = offset
    const nodeEnd = offset + length
    const start = Math.max(segment.start, nodeStart)
    const end = Math.min(segment.end, nodeEnd)
    if (end > start) {
      const localStart = start - nodeStart
      const localEnd = end - nodeStart
      const startRect = caretRect(node, localStart)
      const endRect = caretRect(node, localEnd)

      const textRange = document.createRange()
      textRange.setStart(node, localStart)
      textRange.setEnd(node, localEnd)
      const textRect = textRange.getBoundingClientRect()
      textRange.detach()

      const left = Math.min(startRect.left, endRect.left)
      const right = Math.max(startRect.left, endRect.left)
      if (right > left && textRect.height > 0) {
        const pageRect = pageDiv.getBoundingClientRect()
        const verticalInset = Math.min(1.5, textRect.height * 0.09)
        const overlay = document.createElement('div')
        overlay.className = 'pdf-highlight-overlay'
        overlay.style.left = `${left - pageRect.left}px`
        overlay.style.top = `${textRect.top - pageRect.top + verticalInset}px`
        overlay.style.width = `${right - left}px`
        overlay.style.height = `${textRect.height - verticalInset * 2}px`
        pageDiv.appendChild(overlay)
      }
    }
    offset = nodeEnd
  }
}

function restorePageHighlights(pageDiv: HTMLElement, page: number) {
  const segments = highlightSegments
    .filter(segment => segment.page === page)
    .sort((a, b) => b.start - a.start)
  for (const segment of segments) drawSegment(pageDiv, segment)
}

async function renderPdf() {
  if (!pagesRef.value) return
  pagesRef.value.innerHTML = ''
  pdfDoc = await pdfjsLib.getDocument({ url: props.src }).promise
  totalPages.value = pdfDoc.numPages
  if (fitOnNextRender && scrollRef.value?.clientWidth) {
    const firstPage = await pdfDoc.getPage(1)
    const pageWidth = firstPage.getViewport({ scale: 1 }).width
    const availableWidth = Math.max(scrollRef.value.clientWidth - 48, 160)
    scale.value = Math.min(availableWidth / pageWidth, 2)
    fitOnNextRender = false
  }

  for (let n = 1; n <= pdfDoc.numPages; n++) {
    await renderPage(n)
  }
}

async function renderPage(num: number) {
  const page = await pdfDoc.getPage(num)
  const viewport = page.getViewport({ scale: scale.value })
  // Canvas dimensions are device pixels, while the viewport dimensions are
  // CSS pixels. Rendering both at the same size makes PDF pages blurry on
  // Retina/high-DPI displays because the browser has to upscale the bitmap.
  const outputScale = window.devicePixelRatio || 1

  const pageDiv = document.createElement('div')
  pageDiv.className = 'pdf-page'
  pageDiv.dataset.page = String(num)
  pageDiv.style.width = `${viewport.width}px`
  pageDiv.style.height = `${viewport.height}px`

  const canvas = document.createElement('canvas')
  canvas.width = Math.floor(viewport.width * outputScale)
  canvas.height = Math.floor(viewport.height * outputScale)
  canvas.style.width = `${viewport.width}px`
  canvas.style.height = `${viewport.height}px`
  const ctx = canvas.getContext('2d')!
  pageDiv.appendChild(canvas)

  // Text layer for selection
  const textLayerDiv = document.createElement('div')
  textLayerDiv.className = 'text-layer'
  textLayerDiv.style.setProperty('--scale-factor', String(viewport.scale))
  pageDiv.appendChild(textLayerDiv)

  pagesRef.value!.appendChild(pageDiv)

  const transform = outputScale === 1
    ? undefined
    : [outputScale, 0, 0, outputScale, 0, 0]
  await page.render({ canvasContext: ctx, viewport, transform }).promise

  const textContent = await page.getTextContent()
  // @ts-ignore - renderTextLayer available in pdfjs
  const textLayer = new pdfjsLib.TextLayer({
    textContentSource: textContent,
    container: textLayerDiv,
    viewport,
  })
  await textLayer.render()

  restorePageHighlights(pageDiv, num)
}

function onScroll() {
  if (!scrollRef.value) return
  const pages = pagesRef.value?.querySelectorAll('.pdf-page')
  if (!pages) return
  const scrollTop = scrollRef.value.scrollTop
  const containerH = scrollRef.value.clientHeight
  for (const p of Array.from(pages)) {
    const el = p as HTMLElement
    if (el.offsetTop <= scrollTop + containerH / 2) {
      currentPage.value = parseInt(el.dataset.page!)
    }
  }
}

async function scrollToPage(num: number, opts: { flash?: boolean } = {}) {
  const flash = opts.flash ?? true
  const pages = pagesRef.value
  if (!pages) return
  // 目标页可能尚未渲染完成（首次打开、缩放重排、跨论文跳转），轮询等待而不是静默失败
  const deadline = Date.now() + 5000
  let el = pages.querySelector<HTMLElement>(`[data-page="${num}"]`)
  while (!el && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 60))
    el = pages.querySelector<HTMLElement>(`[data-page="${num}"]`)
  }
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth' })
  if (flash) {
    el.classList.add('page-flash')
    setTimeout(() => el.classList.remove('page-flash'), 1400)
  }
}

function prevPage() { if (currentPage.value > 1) scrollToPage(--currentPage.value) }
function nextPage() { if (currentPage.value < totalPages.value) scrollToPage(++currentPage.value) }
function fitToWidth() {
  fitOnNextRender = true
  renderPdf()
}

function zoomIn() { scale.value = Math.min(scale.value + 0.2, 3); renderPdf() }
function zoomOut() {
  const nextScale = Math.max(scale.value - 0.2, 0.1)
  if (nextScale >= scale.value) return
  scale.value = nextScale
  renderPdf()
}

function onMouseUp() {
  const sel = window.getSelection()
  const text = sel?.toString().trim() ?? ''
  if (text.length > 0 && sel && sel.rangeCount > 0) {
    selectedText.value = text
    selectedRange = sel.getRangeAt(0).cloneRange()
    const rect = selectedRange.getBoundingClientRect()
    const containerRect = containerRef.value!.getBoundingClientRect()
    selectionPopup.value = {
      visible: true,
      x: rect.left - containerRect.left + rect.width / 2 - 70,
      y: rect.top - containerRect.top - 44,
    }
  } else {
    selectedRange = null
    selectionPopup.value.visible = false
  }
}

function sendSelectionToChat() {
  emit('select-text', selectedText.value)
  selectedRange = null
  selectionPopup.value.visible = false
  window.getSelection()?.removeAllRanges()
}

function highlightSelection() {
  if (!selectedRange) return
  const pages = Array.from(pagesRef.value?.querySelectorAll<HTMLElement>('.pdf-page') ?? [])

  for (const pageDiv of pages) {
    const textLayer = pageDiv.querySelector<HTMLElement>('.text-layer')
    if (!textLayer || !selectedRange.intersectsNode(textLayer)) continue

    const candidates: HighlightSegment[] = []
    const nodes = getTextNodes(textLayer)
    let offset = 0
    for (const node of nodes) {
      const length = node.data.length
      if (selectedRange.intersectsNode(node)) {
        let localStart = node === selectedRange.startContainer ? selectedRange.startOffset : 0
        let localEnd = node === selectedRange.endContainer ? selectedRange.endOffset : length
        while (localStart < localEnd && /\s/.test(node.data[localStart])) localStart++
        while (localEnd > localStart && /\s/.test(node.data[localEnd - 1])) localEnd--
        if (localEnd > localStart) {
          candidates.push({
            page: Number(pageDiv.dataset.page),
            start: offset + localStart,
            end: offset + localEnd,
          })
        }
      }
      offset += length
    }

    const added: HighlightSegment[] = []
    for (const candidate of candidates) {
      for (const segment of subtractExisting(candidate)) {
        highlightSegments.push(segment)
        added.push(segment)
        paperStore.addHighlight({
          paperId: props.paperId,
          text: selectedText.value,
          pageNum: segment.page,
          color: '#c9a84c',
          note: '',
          startOffset: segment.start,
          endOffset: segment.end,
        }).catch(() => {})
      }
    }
    for (const segment of added.sort((a, b) => b.start - a.start)) {
      drawSegment(pageDiv, segment)
    }
  }

  selectedRange = null
  selectionPopup.value.visible = false
  window.getSelection()?.removeAllRanges()
}

onMounted(async () => {
  try {
    const stored = await paperStore.getHighlights(props.paperId)
    highlightSegments.push(...stored.map((h: any) => ({ page: h.pageNum, start: h.startOffset, end: h.endOffset })))
  } catch { /* highlights unavailable */ }
  renderPdf()
  scrollRef.value?.addEventListener('scroll', onScroll)
  containerRef.value?.addEventListener('mouseup', onMouseUp)
})

onBeforeUnmount(() => {
  scrollRef.value?.removeEventListener('scroll', onScroll)
  containerRef.value?.removeEventListener('mouseup', onMouseUp)
})

defineExpose({ scrollToPage })
</script>

<style scoped>
.pdf-viewer { display: flex; flex-direction: column; height: 100%; position: relative; background: var(--bg-reader); }

.pdf-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 18px;
  min-height: 51px;
  background: var(--bg-base);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.tb-group { display: flex; align-items: center; gap: 4px; }
.page-indicator, .zoom-indicator {
  font-size: 12px;
  color: var(--text-secondary);
  min-width: 50px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.pdf-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 24px;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 16px;
}

.pdf-pages { display: flex; flex-direction: column; align-items: center; gap: 22px; width: max-content; min-width: 100%; margin: 0 auto; }
.page-current { color: var(--text-primary); }
.page-total { color: var(--text-muted); }
.fit-button { padding: 5px; background: transparent; border: 1px solid transparent; border-radius: 4px; cursor: pointer; }
.fit-button:hover { background: var(--bg-hover); border-color: var(--border); }

:deep(.pdf-page) {
  position: relative;
  background: white;
  box-shadow: 0 2px 8px rgb(53 45 38 / 12%), 0 0 0 1px rgb(53 45 38 / 6%);
  border-radius: 1px;
}
:deep(.pdf-page canvas) { display: block; }
:deep(.pdf-page.page-flash) { animation: page-flash 1.4s var(--ease-out); }
@keyframes page-flash {
  0% { outline: 3px solid var(--accent); outline-offset: 2px; }
  100% { outline: 3px solid transparent; outline-offset: 2px; }
}
:deep(.text-layer) {
  position: absolute;
  inset: 0;
  z-index: 2;
  overflow: hidden;
  line-height: 1;
}
:deep(.text-layer span) {
  color: transparent;
  position: absolute;
  white-space: pre;
  cursor: text;
  transform-origin: 0 0;
}
:deep(.text-layer ::selection) { background: rgba(155, 121, 68, 0.28); }
:deep(.pdf-highlight-overlay) {
  position: absolute;
  z-index: 1;
  pointer-events: none;
  background: rgba(230, 193, 104, 0.38);
  border-radius: 1px;
  mix-blend-mode: multiply;
}

.selection-popup {
  position: absolute;
  z-index: 100;
  display: flex;
  gap: 2px;
  padding: 4px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-light);
  border-radius: 8px;
  box-shadow: var(--shadow-card);
}
.popup-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  background: transparent;
  border: none;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  border-radius: 5px;
  font-family: inherit;
  transition: background 0.15s var(--ease-out), color 0.15s var(--ease-out);
}
.popup-btn:hover { background: var(--accent-dim); color: var(--accent); }
@media (max-width: 520px) {
  .pdf-toolbar { padding-left: 12px; padding-right: 12px; }
  .pdf-scroll { padding: 18px 24px; }
}
</style>
