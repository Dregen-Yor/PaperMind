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
    <div v-if="selectionPopup.visible" ref="popupRef" class="selection-popup" :style="popupStyle" role="toolbar" :aria-label="activeHighlight ? '高亮操作' : '选中文字操作'" @pointerdown.stop @mousedown.prevent @mouseup.stop>
      <button type="button" class="popup-btn" @click="sendSelectionToChat">
        <el-icon><ChatLineSquare /></el-icon> 发送到对话
      </button>
      <button v-if="activeHighlight" type="button" class="popup-btn popup-btn-remove" :disabled="highlightBusy" @click="cancelHighlight">
        <el-icon><Delete /></el-icon> 取消高亮
      </button>
      <button v-else type="button" class="popup-btn" :disabled="highlightBusy" @click="highlightSelection">
        <el-icon><EditPen /></el-icon> 高亮
      </button>
    </div>

    <div v-if="undoHighlight || highlightError" class="highlight-feedback" role="status" @pointerdown.stop @mouseup.stop>
      <span v-if="highlightError" role="alert">{{ highlightError }}</span>
      <span v-else>已取消高亮</span>
      <button v-if="undoHighlight" type="button" class="undo-btn" :disabled="highlightBusy" @click="restoreLastHighlight">撤销</button>
      <button type="button" class="feedback-close" aria-label="关闭提示" :disabled="highlightBusy" @click="dismissFeedback">×</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed, nextTick, watch } from 'vue'
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'
import { ArrowUp, ArrowDown, ZoomIn, ZoomOut, ChatLineSquare, EditPen, Delete } from '@element-plus/icons-vue'
import { usePaperStore, type Highlight } from '../stores/paper'
import { mergeSegments, type HighlightSegment } from '../utils/highlightMerge'
import { getHighlightRects, getTextNodes, type HighlightRect } from '../utils/pdfHighlight'

const props = defineProps<{ src: string; paperId: string }>()
const paperStore = usePaperStore()
const emit = defineEmits<{ (e: 'select-text', text: string): void }>()

pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.min.mjs'

const containerRef = ref<HTMLElement>()
const scrollRef = ref<HTMLElement>()
const pagesRef = ref<HTMLElement>()
const popupRef = ref<HTMLElement>()
const currentPage = ref(1)
const totalPages = ref(0)
const scale = ref(1)
let fitOnNextRender = true
let fitMode = true
let lastFitWidth = 0
let renderGeneration = 0
let resizeTimer: number | undefined
// 观察 containerRef（父级面板宽度），不要观察 scrollRef：scrollRef 的 clientWidth 会被
// 自身渲染改变（innerHTML 清空/重建 → 竖向滚动条消失/出现），那会构成自持的
// ResizeObserver 反馈环（整页反复重渲染 → 闪烁/OOM）。
const resizeObserver = new ResizeObserver(() => {
  if (!fitMode) return
  const width = containerRef.value?.clientWidth ?? 0
  if (Math.abs(width - lastFitWidth) < 1) return
  if (resizeTimer) clearTimeout(resizeTimer)
  resizeTimer = window.setTimeout(() => {
    resizeTimer = undefined
    // 复核：防抖窗口内宽度已回稳（自身渲染引起的抖动）就不再重排
    const settled = containerRef.value?.clientWidth ?? 0
    if (!fitMode || Math.abs(settled - lastFitWidth) < 1) return
    fitOnNextRender = true
    void renderPdf()
  }, 150)
})
const selectedText = ref('')

let pdfDoc: any = null
let selectedRange: Range | null = null
const selectionPopup = ref({ visible: false, x: 0, y: 0 })
const highlights = ref<Highlight[]>([])
const activeHighlight = ref<Highlight | null>(null)
const undoHighlight = ref<Highlight | null>(null)
const highlightBusy = ref(false)
const highlightError = ref('')
const hitRegions = new Map<number, Array<{ id: string; rects: HighlightRect[] }>>()
let undoTimer: ReturnType<typeof setTimeout> | undefined
let documentGeneration = 0
let popupGeneration = 0
let pointerStart: { x: number; y: number; moved: boolean } | null = null

const highlightSegments = computed<HighlightSegment[]>(() => highlights.value.map(h => ({ page: h.pageNum, start: h.startOffset, end: h.endOffset })))

const popupStyle = computed(() => ({ left: `${selectionPopup.value.x}px`, top: `${selectionPopup.value.y}px` }))

function subtractExisting(segment: HighlightSegment): HighlightSegment[] {
  const existing = highlightSegments.value
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

function drawRects(parent: HTMLElement, rects: HighlightRect[], className: string) {
  for (const rect of rects) {
    const overlay = document.createElement('div')
    overlay.className = className
    overlay.style.left = `${rect.left}px`
    overlay.style.top = `${rect.top}px`
    overlay.style.width = `${rect.width}px`
    overlay.style.height = `${rect.height}px`
    parent.appendChild(overlay)
  }
}

function restorePageHighlights(pageDiv: HTMLElement, page: number) {
  // Repaint the union so extending an existing mark also fills its internal spaces.
  const layer = pageDiv.querySelector<HTMLElement>('.pdf-highlight-layer')!
  const textLayer = pageDiv.querySelector<HTMLElement>('.text-layer')!
  const pageRect = pageDiv.getBoundingClientRect()
  layer.replaceChildren()
  const segments = mergeSegments(highlightSegments.value.filter(segment => segment.page === page))
  for (const segment of segments) {
    drawRects(layer, getHighlightRects(textLayer, segment.start, segment.end, pageRect), 'pdf-highlight-overlay')
  }
  // Keep identity separate from the painted union. The newest mark wins in an overlap.
  hitRegions.set(page, highlights.value.filter(h => h.pageNum === page).sort((a, b) => b.createdAt - a.createdAt).map(h => ({
    id: h.id, rects: getHighlightRects(textLayer, h.startOffset, h.endOffset, pageRect),
  })))
}

function repaintHighlights(page: number) {
  const pageDiv = pagesRef.value?.querySelector<HTMLElement>(`[data-page="${page}"]`)
  if (pageDiv?.querySelector('.text-layer span')) restorePageHighlights(pageDiv, page)
}

async function renderPdf() {
  const generation = ++renderGeneration
  closePopup()
  hitRegions.clear()
  if (!pagesRef.value) return
  pagesRef.value.innerHTML = ''
  const loadedPdf = await pdfjsLib.getDocument({ url: props.src }).promise
  if (generation !== renderGeneration) return
  pdfDoc = loadedPdf
  totalPages.value = pdfDoc.numPages
  if (fitOnNextRender && scrollRef.value?.clientWidth) {
    const firstPage = await pdfDoc.getPage(1)
    if (generation !== renderGeneration) return
    const pageWidth = firstPage.getViewport({ scale: 1 }).width
    const availableWidth = Math.max(scrollRef.value.clientWidth - 48, 160)
    scale.value = Math.min(availableWidth / pageWidth, 2)
    // 基线取自 containerRef（稳定面宽），与 observer 的判定同源
    lastFitWidth = containerRef.value?.clientWidth ?? lastFitWidth
    fitOnNextRender = false
  }

  for (let n = 1; n <= pdfDoc.numPages; n++) {
    if (generation !== renderGeneration) return
    await renderPage(n, generation)
  }
}

async function renderPage(num: number, generation: number) {
  const page = await pdfDoc.getPage(num)
  if (generation !== renderGeneration) return
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

  // Blend all saved marks as one layer: overlapping rectangles keep the same yellow.
  const highlightLayerDiv = document.createElement('div')
  highlightLayerDiv.className = 'pdf-highlight-layer'
  highlightLayerDiv.setAttribute('aria-hidden', 'true')
  pageDiv.appendChild(highlightLayerDiv)

  // Text layer for selection
  const textLayerDiv = document.createElement('div')
  textLayerDiv.className = 'text-layer'
  textLayerDiv.style.setProperty('--total-scale-factor', String(viewport.scale))
  pageDiv.appendChild(textLayerDiv)

  pagesRef.value!.appendChild(pageDiv)

  const transform = outputScale === 1
    ? undefined
    : [outputScale, 0, 0, outputScale, 0, 0]
  await page.render({ canvasContext: ctx, viewport, transform }).promise
  if (generation !== renderGeneration) return

  const textContent = await page.getTextContent()
  if (generation !== renderGeneration) return
  const textLayer = new pdfjsLib.TextLayer({
    textContentSource: textContent,
    container: textLayerDiv,
    viewport,
  })
  await textLayer.render()
  if (generation !== renderGeneration) return

  restorePageHighlights(pageDiv, num)
}

function onScroll() {
  closePopup()
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
  fitMode = true
  fitOnNextRender = true
  renderPdf()
}

function zoomIn() { fitMode = false; scale.value = Math.min(scale.value + 0.2, 3); renderPdf() }
function zoomOut() {
  const nextScale = Math.max(scale.value - 0.2, 0.1)
  if (nextScale >= scale.value) return
  fitMode = false
  scale.value = nextScale
  renderPdf()
}

function closePopup() {
  popupGeneration++
  selectionPopup.value.visible = false
  activeHighlight.value = null
  selectedRange = null
  pagesRef.value?.querySelectorAll('.pdf-highlight-focus').forEach(el => el.remove())
}

async function showPopup(rect: DOMRect | HighlightRect) {
  const generation = ++popupGeneration
  selectionPopup.value.visible = true
  await nextTick()
  if (generation !== popupGeneration || !popupRef.value || !containerRef.value || !scrollRef.value) return
  const container = containerRef.value.getBoundingClientRect()
  const viewport = scrollRef.value.getBoundingClientRect()
  const { width, height } = popupRef.value.getBoundingClientRect()
  const minY = viewport.top - container.top + 8
  const maxY = Math.max(minY, viewport.bottom - container.top - height - 8)
  const above = rect.top - container.top - height - 8
  selectionPopup.value.x = Math.max(8, Math.min(rect.left - container.left + rect.width / 2 - width / 2, container.width - width - 8))
  selectionPopup.value.y = Math.min(maxY, Math.max(minY, above >= minY ? above : rect.top + rect.height - container.top + 8))
}

function onPointerDown(event: PointerEvent) {
  pointerStart = null
  const target = event.target as Element | null
  if (target?.closest('.selection-popup, .highlight-feedback')) return
  closePopup()
  if (event.button === 0 && target?.closest('.text-layer') && pagesRef.value?.contains(target)) {
    pointerStart = { x: event.clientX, y: event.clientY, moved: false }
  }
}

function onPointerMove(event: PointerEvent) {
  if (pointerStart && Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 4) pointerStart.moved = true
}

function onPointerCancel() { pointerStart = null }

function onKeyDown(event: KeyboardEvent) {
  if (event.key === 'Escape') closePopup()
}

function onMouseUp(event: MouseEvent) {
  if (event.button !== 0 || (event.target as Element)?.closest('.selection-popup, .highlight-feedback')) return
  const click = pointerStart
  pointerStart = null
  const sel = window.getSelection()
  const text = sel?.toString().trim() ?? ''
  if (text.length > 0 && sel && sel.rangeCount > 0) {
    const range = sel.getRangeAt(0)
    if (!pagesRef.value?.contains(range.startContainer) || !pagesRef.value.contains(range.endContainer)) return
    closePopup()
    selectedText.value = text
    selectedRange = range.cloneRange()
    void showPopup(range.getBoundingClientRect())
    return
  }
  closePopup()
  if (!click || click.moved || Math.hypot(event.clientX - click.x, event.clientY - click.y) > 4) return
  const pageDiv = (event.target as Element)?.closest<HTMLElement>('.pdf-page')
  if (!pageDiv || !pagesRef.value?.contains(pageDiv)) return
  const pageRect = pageDiv.getBoundingClientRect()
  const x = event.clientX - pageRect.left
  const y = event.clientY - pageRect.top
  for (const region of hitRegions.get(Number(pageDiv.dataset.page)) ?? []) {
    const rect = region.rects.find(r => x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height)
    if (!rect) continue
    activeHighlight.value = highlights.value.find(h => h.id === region.id) ?? null
    if (!activeHighlight.value) continue
    drawRects(pageDiv, region.rects, 'pdf-highlight-focus')
    const left = Math.min(...region.rects.map(r => r.left))
    const top = Math.min(...region.rects.map(r => r.top))
    const right = Math.max(...region.rects.map(r => r.left + r.width))
    const bottom = Math.max(...region.rects.map(r => r.top + r.height))
    void showPopup({ left: left + pageRect.left, top: top + pageRect.top, width: right - left, height: bottom - top })
    break
  }
}

function sendSelectionToChat() {
  emit('select-text', activeHighlight.value?.text ?? selectedText.value)
  closePopup()
  window.getSelection()?.removeAllRanges()
}

function clearUndoTimer() {
  if (undoTimer !== undefined) clearTimeout(undoTimer)
  undoTimer = undefined
}

function startUndoTimer() {
  clearUndoTimer()
  undoTimer = setTimeout(() => { undoHighlight.value = null; undoTimer = undefined }, 8000)
}

function dismissFeedback() {
  clearUndoTimer()
  undoHighlight.value = null
  highlightError.value = ''
}

async function cancelHighlight() {
  if (!activeHighlight.value || highlightBusy.value) return
  const snapshot = { ...activeHighlight.value }
  const generation = documentGeneration
  highlightBusy.value = true
  highlightError.value = ''
  try {
    await paperStore.removeHighlight(snapshot.id)
    if (generation !== documentGeneration) return
    highlights.value = highlights.value.filter(h => h.id !== snapshot.id)
    closePopup()
    repaintHighlights(snapshot.pageNum)
    undoHighlight.value = snapshot
    startUndoTimer()
  } catch {
    if (generation === documentGeneration) highlightError.value = '取消高亮失败，请重试'
  } finally {
    if (generation === documentGeneration) highlightBusy.value = false
  }
}

async function restoreLastHighlight() {
  if (!undoHighlight.value || highlightBusy.value) return
  const snapshot = { ...undoHighlight.value }
  const generation = documentGeneration
  clearUndoTimer()
  highlightBusy.value = true
  highlightError.value = ''
  try {
    await paperStore.restoreHighlight(snapshot)
    if (generation !== documentGeneration) return
    highlights.value.push(snapshot)
    closePopup()
    repaintHighlights(snapshot.pageNum)
    undoHighlight.value = null
  } catch {
    if (generation === documentGeneration) {
      highlightError.value = '恢复高亮失败，请重试'
      startUndoTimer()
    }
  } finally {
    if (generation === documentGeneration) highlightBusy.value = false
  }
}

async function highlightSelection() {
  if (!selectedRange || highlightBusy.value) return
  const generation = documentGeneration
  const paperId = props.paperId
  const text = selectedText.value
  const pages = Array.from(pagesRef.value?.querySelectorAll<HTMLElement>('.pdf-page') ?? [])
  const additions: HighlightSegment[] = []
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

    for (const candidate of mergeSegments(candidates)) {
      additions.push(...subtractExisting(candidate))
    }
  }

  closePopup()
  window.getSelection()?.removeAllRanges()
  highlightBusy.value = true
  highlightError.value = ''
  try {
    for (const segment of additions) {
      if (generation !== documentGeneration) return
      const record = await paperStore.addHighlight({
        paperId,
        text,
        pageNum: segment.page,
        color: '#ffe66a',
        note: '',
        startOffset: segment.start,
        endOffset: segment.end,
      })
      if (generation !== documentGeneration) return
      highlights.value.push(record)
      repaintHighlights(segment.page)
    }
  } catch {
    if (generation === documentGeneration) highlightError.value = '保存高亮失败，请重试'
  } finally {
    if (generation === documentGeneration) highlightBusy.value = false
  }
}

async function loadDocument() {
  const generation = ++documentGeneration
  renderGeneration++
  closePopup()
  dismissFeedback()
  highlightBusy.value = true
  highlights.value = []
  hitRegions.clear()
  fitOnNextRender = fitMode
  try {
    const stored = await paperStore.getHighlights(props.paperId)
    if (generation !== documentGeneration) return
    highlights.value = stored
  } catch {
    if (generation !== documentGeneration) return
    highlightError.value = '加载高亮失败，请重新打开论文'
  }
  if (generation !== documentGeneration) return
  highlightBusy.value = false
  await renderPdf()
}

watch(() => [props.src, props.paperId], () => { void loadDocument() })

onMounted(() => {
  void loadDocument()
  if (containerRef.value) {
    lastFitWidth = containerRef.value.clientWidth
    resizeObserver.observe(containerRef.value)
  }
  scrollRef.value?.addEventListener('scroll', onScroll)
  containerRef.value?.addEventListener('mouseup', onMouseUp)
  document.addEventListener('pointerdown', onPointerDown)
  document.addEventListener('pointermove', onPointerMove)
  document.addEventListener('pointercancel', onPointerCancel)
  document.addEventListener('keydown', onKeyDown)
})

onBeforeUnmount(() => {
  documentGeneration++
  renderGeneration++
  clearUndoTimer()
  resizeObserver.disconnect()
  if (resizeTimer) clearTimeout(resizeTimer)
  scrollRef.value?.removeEventListener('scroll', onScroll)
  containerRef.value?.removeEventListener('mouseup', onMouseUp)
  document.removeEventListener('pointerdown', onPointerDown)
  document.removeEventListener('pointermove', onPointerMove)
  document.removeEventListener('pointercancel', onPointerCancel)
  document.removeEventListener('keydown', onKeyDown)
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
  isolation: isolate;
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
  /* PDF.js 6 writes --font-height / --scale-x instead of inline font-size / transform.
     Keep this layout contract in sync with pdfjs-dist/web/pdf_viewer.css. */
  --min-font-size: 1;
  --text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size));
  --min-font-size-inv: calc(1 / var(--min-font-size));
  --scale-round-x: 1px;
  --scale-round-y: 1px;
  position: absolute;
  inset: 0;
  z-index: 2;
  overflow: hidden;
  line-height: 1;
  text-align: initial;
  letter-spacing: normal;
  word-spacing: normal;
  text-size-adjust: none;
  forced-color-adjust: none;
  transform-origin: 0 0;
  mix-blend-mode: multiply;
}
:deep(.text-layer :is(span, br)) {
  color: transparent;
  position: absolute;
  white-space: pre;
  cursor: text;
  transform-origin: 0 0;
  user-select: text;
}
:deep(.text-layer > :not(.markedContent)),
:deep(.text-layer .markedContent span:not(.markedContent)) {
  --font-height: 0;
  --scale-x: 1;
  --rotate: 0deg;
  font-size: calc(var(--text-scale-factor) * var(--font-height));
  transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv));
}
:deep(.text-layer .markedContent) { display: contents; }
/* Keep the selectable text invisible, including when global ::selection sets a color. */
:deep(.text-layer ::selection) { background: #fff4bf; color: transparent; }
:deep(.text-layer br::selection) { background: transparent; }
:deep(.pdf-highlight-layer) {
  position: absolute;
  inset: 0;
  z-index: 1;
  pointer-events: none;
  mix-blend-mode: multiply;
}
:deep(.pdf-highlight-overlay) {
  position: absolute;
  background: #ffe66a;
}
:deep(.pdf-highlight-focus) {
  position: absolute;
  z-index: 3;
  pointer-events: none;
  outline: 1px solid #a98524;
  outline-offset: 1px;
  border-radius: 1px;
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
.popup-btn-remove:hover { color: var(--danger); background: var(--danger-dim); }
.popup-btn:disabled, .undo-btn:disabled, .feedback-close:disabled { opacity: 0.5; cursor: wait; }
.popup-btn:focus-visible, .undo-btn:focus-visible, .feedback-close:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.highlight-feedback {
  position: absolute;
  z-index: 101;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 12px;
  max-width: calc(100% - 32px);
  padding: 9px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-elevated);
  color: var(--text-primary);
  box-shadow: var(--shadow-card);
  font-size: 12px;
}
.undo-btn, .feedback-close { flex-shrink: 0; border: 0; padding: 4px; background: transparent; font: inherit; cursor: pointer; border-radius: 3px; }
.undo-btn { color: var(--accent); font-weight: 600; }
.undo-btn:hover { text-decoration: underline; }
.feedback-close { color: var(--text-muted); font-size: 18px; line-height: 1; }
@media (max-width: 520px) {
  .pdf-toolbar { padding-left: 12px; padding-right: 12px; }
  .pdf-scroll { padding: 18px 24px; }
}
</style>
