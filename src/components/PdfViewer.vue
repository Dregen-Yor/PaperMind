<template>
  <div class="pdf-viewer" ref="containerRef">
    <div class="pdf-toolbar">
      <div class="tb-group">
        <el-button size="small" text @click="prevPage" :disabled="currentPage <= 1">
          <el-icon><ArrowUp /></el-icon>
        </el-button>
        <span class="page-indicator">{{ currentPage }} / {{ totalPages }}</span>
        <el-button size="small" text @click="nextPage" :disabled="currentPage >= totalPages">
          <el-icon><ArrowDown /></el-icon>
        </el-button>
      </div>
      <div class="tb-group">
        <el-button size="small" text @click="zoomOut"><el-icon><ZoomOut /></el-icon></el-button>
        <span class="zoom-indicator">{{ Math.round(scale * 100) }}%</span>
        <el-button size="small" text @click="zoomIn"><el-icon><ZoomIn /></el-icon></el-button>
      </div>
    </div>

    <div class="pdf-scroll" ref="scrollRef">
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

const props = defineProps<{ src: string }>()
const emit = defineEmits<{ (e: 'select-text', text: string): void }>()

pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.min.mjs'

const containerRef = ref<HTMLElement>()
const scrollRef = ref<HTMLElement>()
const pagesRef = ref<HTMLElement>()
const currentPage = ref(1)
const totalPages = ref(0)
const scale = ref(1.3)
const selectedText = ref('')

let pdfDoc: any = null
const selectionPopup = ref({ visible: false, x: 0, y: 0 })

const popupStyle = computed(() => ({ left: `${selectionPopup.value.x}px`, top: `${selectionPopup.value.y}px` }))

async function renderPdf() {
  if (!pagesRef.value) return
  pagesRef.value.innerHTML = ''
  pdfDoc = await pdfjsLib.getDocument({ url: props.src }).promise
  totalPages.value = pdfDoc.numPages

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

function scrollToPage(num: number) {
  const el = pagesRef.value?.querySelector(`[data-page="${num}"]`) as HTMLElement
  el?.scrollIntoView({ behavior: 'smooth' })
}

function prevPage() { if (currentPage.value > 1) scrollToPage(--currentPage.value) }
function nextPage() { if (currentPage.value < totalPages.value) scrollToPage(++currentPage.value) }
function zoomIn() { scale.value = Math.min(scale.value + 0.2, 3); renderPdf() }
function zoomOut() { scale.value = Math.max(scale.value - 0.2, 0.5); renderPdf() }

function onMouseUp() {
  const sel = window.getSelection()
  const text = sel?.toString().trim() ?? ''
  if (text.length > 0 && sel && sel.rangeCount > 0) {
    selectedText.value = text
    const rect = sel.getRangeAt(0).getBoundingClientRect()
    const containerRect = containerRef.value!.getBoundingClientRect()
    selectionPopup.value = {
      visible: true,
      x: rect.left - containerRect.left + rect.width / 2 - 70,
      y: rect.top - containerRect.top - 44,
    }
  } else {
    selectionPopup.value.visible = false
  }
}

function sendSelectionToChat() {
  emit('select-text', selectedText.value)
  selectionPopup.value.visible = false
  window.getSelection()?.removeAllRanges()
}

function highlightSelection() {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return
  try {
    const range = sel.getRangeAt(0)
    const mark = document.createElement('mark')
    mark.className = 'pdf-highlight'
    range.surroundContents(mark)
  } catch { /* cross-node selection, skip */ }
  selectionPopup.value.visible = false
  sel.removeAllRanges()
}

onMounted(() => {
  renderPdf()
  scrollRef.value?.addEventListener('scroll', onScroll)
  containerRef.value?.addEventListener('mouseup', onMouseUp)
})

onBeforeUnmount(() => {
  scrollRef.value?.removeEventListener('scroll', onScroll)
  containerRef.value?.removeEventListener('mouseup', onMouseUp)
})
</script>

<style scoped>
.pdf-viewer { display: flex; flex-direction: column; height: 100%; position: relative; background: #1a1a22; }

.pdf-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  background: color-mix(in srgb, var(--bg-surface) 94%, transparent);
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
  overflow-y: auto;
  padding: 20px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}

:deep(.pdf-page) {
  position: relative;
  background: white;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
  border-radius: 3px;
}
:deep(.pdf-page canvas) { display: block; }
:deep(.text-layer) {
  position: absolute;
  inset: 0;
  overflow: hidden;
  line-height: 1;
  opacity: 0.25;
  --scale-factor: 1;
}
:deep(.text-layer span) {
  color: transparent;
  position: absolute;
  white-space: pre;
  cursor: text;
  transform-origin: 0 0;
}
:deep(.text-layer ::selection) { background: rgba(61, 184, 160, 0.4); }
:deep(.pdf-highlight) { background: var(--gold); opacity: 0.4; border-radius: 2px; }

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
</style>
