<template>
  <div class="reader-view" v-if="paper">
    <header class="reader-topbar">
      <el-button text class="back-button" @click="$router.push('/library')" aria-label="返回文献库">
        <el-icon aria-hidden="true"><ArrowLeft /></el-icon><span>文献库</span>
      </el-button>
      <div class="reader-heading">
        <h1 class="reader-title font-display" :title="paper.title || paper.fileName">{{ paper.title || paper.fileName }}</h1>
        <p class="reader-meta">{{ paper.authors?.slice(0, 2).join(', ') || '作者信息待补充' }}<span v-if="paper.year">{{ paper.year }}</span></p>
      </div>
      <el-select :model-value="paper.status" class="reading-status" size="small" aria-label="阅读状态" @update:model-value="updateStatus">
        <el-option label="未读" value="unread" />
        <el-option label="阅读中" value="reading" />
        <el-option label="已完成" value="done" />
      </el-select>
    </header>

    <div class="reader-mode-switch" role="group" aria-label="阅读视图">
      <button type="button" :class="{ active: mobilePane === 'paper' }" :aria-pressed="mobilePane === 'paper'" @click="mobilePane = 'paper'"><el-icon aria-hidden="true"><Document /></el-icon> 论文原文</button>
      <button type="button" :class="{ active: mobilePane === 'discussion' }" :aria-pressed="mobilePane === 'discussion'" @click="mobilePane = 'discussion'"><el-icon aria-hidden="true"><ChatLineRound /></el-icon> 问答与笔记</button>
    </div>

    <div class="reader-split" ref="readerSplitRef">
      <section id="reader-document" class="split-left" :class="{ 'mobile-active': mobilePane === 'paper' }" :style="{ flexBasis: splitRatio + '%' }" aria-label="论文原文">
        <PdfViewer ref="pdfViewerRef" v-if="pdfUrl" :src="pdfUrl" :paper-id="paper.id" @select-text="onSelectText" />
        <div v-else class="pdf-placeholder" role="status">
          <el-icon :size="32" aria-hidden="true"><Document /></el-icon>
          <p>{{ loadingPdf ? '正在打开论文…' : fileError }}</p>
          <el-button v-if="!loadingPdf" text @click="$router.push('/library')">返回文献库</el-button>
        </div>
      </section>

      <div
        class="resizer"
        role="separator"
        tabindex="0"
        aria-orientation="vertical"
        aria-label="调整原文与问答面板宽度"
        aria-controls="reader-document"
        :aria-valuenow="Math.round(splitRatio)"
        :aria-valuemin="30"
        :aria-valuemax="75"
        @mousedown.prevent="startResize"
        @keydown.left.prevent="adjustSplit(-2)"
        @keydown.right.prevent="adjustSplit(2)"
        @keydown.home.prevent="splitRatio = 30"
        @keydown.end.prevent="splitRatio = 75"
        @dblclick="splitRatio = 58"
      ><span aria-hidden="true" /></div>

      <section class="split-right" :class="{ 'mobile-active': mobilePane === 'discussion' }" aria-label="论文讨论">
        <div class="right-tabs" role="group" aria-label="问答与笔记">
          <button type="button" class="right-tab" :class="{ active: rightTab === 'chat' }" :aria-pressed="rightTab === 'chat'" @click="rightTab = 'chat'"><el-icon aria-hidden="true"><ChatLineRound /></el-icon> 论文问答</button>
          <button type="button" class="right-tab" :class="{ active: rightTab === 'notes' }" :aria-pressed="rightTab === 'notes'" @click="rightTab = 'notes'"><el-icon aria-hidden="true"><EditPen /></el-icon> 阅读笔记</button>
        </div>
        <template v-if="rightTab === 'chat'">
          <div class="chat-header">
            <el-select v-model="activeConvId" size="small" placeholder="选择对话" aria-label="当前论文对话" class="conversation-select">
              <el-option v-for="c in paperConversations" :key="c.id" :label="c.title" :value="c.id" />
            </el-select>
            <el-button size="small" text @click="createConv" aria-label="新建论文对话" title="新建对话"><el-icon aria-hidden="true"><Plus /></el-icon></el-button>
          </div>
          <ChatPanel ref="chatPanelRef" :conversation="activeConv" @create="createConv" @open-source="onOpenSource" />
        </template>
        <NotesPanel v-else :paper-id="paper.id" @jump="jumpToPage" />
      </section>
    </div>
  </div>
  <div v-else class="reader-missing">
    <el-empty :description="paperStore.loaded ? '未找到这篇论文' : '正在打开文献库…'">
      <el-button v-if="paperStore.loaded" @click="$router.push('/library')">返回文献库</el-button>
    </el-empty>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowLeft, Plus, Document, ChatLineRound, EditPen } from '@element-plus/icons-vue'
import PdfViewer from '../components/PdfViewer.vue'
import ChatPanel from '../components/ChatPanel.vue'
import NotesPanel from '../components/NotesPanel.vue'
import { usePaperStore, type Paper } from '../stores/paper'
import { useChatStore } from '../stores/chat'
import { base64ToUrl } from '../utils/pdfUtils'
import type { SourceRef } from '../utils/sourceRef'

const route = useRoute()
const router = useRouter()
const paperStore = usePaperStore()
const chatStore = useChatStore()
const paper = computed(() => paperStore.getPaper(route.params.id as string))
const pdfUrl = ref('')
const loadingPdf = ref(true)
const fileError = ref('')
const splitRatio = ref(58)
const readerSplitRef = ref<HTMLElement>()
const chatPanelRef = ref<InstanceType<typeof ChatPanel>>()
const pdfViewerRef = ref<InstanceType<typeof PdfViewer>>()
const rightTab = ref<'chat' | 'notes'>('chat')
const mobilePane = ref<'paper' | 'discussion'>('paper')
const activeConvId = ref('')
let paperGeneration = 0

async function jumpToPage(page: number) {
  mobilePane.value = 'paper'
  await nextTick()
  pdfViewerRef.value?.scrollToPage(page)
}

/** 来源芯片跳页：本页内滚动，跨论文带上 `?page=` 跳进对应阅读页（#1）。 */
function onOpenSource(ref: SourceRef) {
  if (!ref.paperId || ref.startPage === undefined) return
  if (ref.paperId === paper.value?.id) {
    void jumpToPage(ref.startPage + 1)
    return
  }
  void router.push({ path: '/library/' + ref.paperId, query: { page: String(ref.startPage + 1) } })
}

const paperConversations = computed(() =>
  chatStore.conversations.filter(c => c.paperIds.includes(paper.value?.id ?? '')),
)
const activeConv = computed(() => chatStore.conversations.find(c => c.id === activeConvId.value) ?? null)

function updateStatus(status: Paper['status']) {
  if (paper.value) paperStore.updatePaper(paper.value.id, { status })
}

async function createConv() {
  const paperId = paper.value?.id
  const generation = paperGeneration
  if (!paperId || !chatStore.loaded) return
  const conv = await chatStore.newConversation('对话 ' + (paperConversations.value.length + 1), [paperId])
  if (generation === paperGeneration && paper.value?.id === paperId) activeConvId.value = conv.id
}

async function onSelectText(text: string) {
  const generation = paperGeneration
  if (!activeConv.value) await createConv()
  if (generation !== paperGeneration) return
  rightTab.value = 'chat'
  mobilePane.value = 'discussion'
  await nextTick()
  if (generation === paperGeneration) chatPanelRef.value?.addContext(text)
}

function adjustSplit(delta: number) {
  splitRatio.value = Math.min(Math.max(splitRatio.value + delta, 30), 75)
}

let resizing = false
function startResize() {
  resizing = true
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
}
function onMove(event: MouseEvent) {
  if (!resizing || !readerSplitRef.value) return
  const bounds = readerSplitRef.value.getBoundingClientRect()
  const ratio = ((event.clientX - bounds.left) / bounds.width) * 100
  splitRatio.value = Math.min(Math.max(ratio, 30), 75)
}
function stopResize() {
  resizing = false
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
}

// Wait for the local stores on direct links, and reload when the paper changes.
watch([() => paper.value?.id, () => chatStore.loaded], async ([id, chatReady], _previous, onCleanup) => {
  paperGeneration += 1
  if (!id || !chatReady) return
  let cancelled = false
  onCleanup(() => { cancelled = true })
  loadingPdf.value = true
  fileError.value = ''
  if (pdfUrl.value) URL.revokeObjectURL(pdfUrl.value)
  pdfUrl.value = ''
  if (activeConvId.value) void chatStore.discardEmptyConversation(activeConvId.value)
  activeConvId.value = ''
  try {
    const base64 = await paperStore.readPaperFile(id)
    if (cancelled) return
    if (base64) pdfUrl.value = base64ToUrl(base64)
    else fileError.value = '找不到论文文件，请返回文献库重新导入。'
    // 跨论文跳转：`?page=` 定位到目标页（页元素可能尚未渲染完，scrollToPage 内部等待）
    const targetPage = Number(route.query.page)
    if (Number.isInteger(targetPage) && targetPage > 0) {
      await nextTick()
      pdfViewerRef.value?.scrollToPage(targetPage)
    }
    if (paper.value?.status === 'unread') await paperStore.updatePaper(id, { status: 'reading' })
    if (cancelled) return
    if (paperConversations.value.length) activeConvId.value = paperConversations.value[0].id
    else await createConv()
  } catch {
    if (!cancelled) fileError.value = '论文未能打开，请返回文献库后重试。'
  } finally {
    if (!cancelled) loadingPdf.value = false
  }
}, { immediate: true })

onMounted(() => {
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', stopResize)
})
onBeforeUnmount(() => {
  paperGeneration += 1
  if (activeConvId.value) void chatStore.discardEmptyConversation(activeConvId.value)
  stopResize()
  if (pdfUrl.value) URL.revokeObjectURL(pdfUrl.value)
  window.removeEventListener('mousemove', onMove)
  window.removeEventListener('mouseup', stopResize)
})
</script>

<style scoped>
.reader-view { display: flex; flex-direction: column; height: 100%; overflow: hidden; }
.reader-topbar { display: flex; align-items: center; gap: 22px; padding: 18px 24px; border-bottom: 1px solid var(--border); flex-shrink: 0; background: var(--bg-base); min-height: 82px; }
.back-button { font-size: 12px; color: var(--text-secondary); padding-left: 0; flex-shrink: 0; }
.reader-heading { flex: 1; min-width: 0; border-left: 1px solid var(--border); padding-left: 22px; }
.reader-title { font-size: 18px; font-weight: 600; line-height: 1.4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.reader-meta { margin-top: 5px; font-size: 11px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.reader-meta span { margin-left: 12px; padding-left: 12px; border-left: 1px solid var(--border); }
.reading-status { width: 100px; flex-shrink: 0; }
.reader-split { flex: 1; min-height: 0; display: flex; overflow: hidden; }
.split-left { flex-grow: 0; flex-shrink: 1; min-width: 0; overflow: hidden; height: 100%; }
.split-right { flex: 1; min-width: 300px; overflow: hidden; height: 100%; display: flex; flex-direction: column; background: var(--bg-surface); container-type: inline-size; }
.resizer { display: flex; align-items: center; justify-content: center; width: 7px; background: var(--bg-elevated); border-left: 1px solid var(--border); border-right: 1px solid var(--border); cursor: col-resize; flex-shrink: 0; transition: background 0.15s; }
.resizer span { width: 2px; height: 30px; background: var(--border-light); border-radius: 2px; }
.resizer:hover, .resizer:focus-visible { background: var(--accent-dim); }
.resizer:hover span { background: var(--accent); }
.chat-header { display: flex; align-items: center; gap: 8px; padding: 12px 20px 4px; flex-shrink: 0; }
.conversation-select { flex: 1; min-width: 0; }
.conversation-select :deep(.el-select__wrapper) { box-shadow: none; background: transparent; padding-left: 0; }
.conversation-select :deep(.el-select__wrapper.is-focused) { box-shadow: 0 0 0 1px var(--accent); padding-left: 8px; }
.right-tabs { display: flex; align-items: stretch; gap: 24px; padding: 0 20px; min-height: 51px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.right-tab { display: flex; align-items: center; justify-content: center; gap: 7px; padding: 15px 1px 13px; border: 0; border-bottom: 2px solid transparent; background: transparent; font-size: 12px; color: var(--text-muted); cursor: pointer; }
.right-tab .el-icon { font-size: 15px; }
.right-tab.active { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }
.right-tab:hover { color: var(--accent); }
.pdf-placeholder, .reader-missing { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 18px; height: 100%; padding: 30px; background: var(--bg-reader); color: var(--text-muted); font-size: 13px; line-height: 1.8; text-align: center; }
.reader-missing { background: var(--bg-base); }
.reader-mode-switch { display: none; }
@media (max-width: 800px) {
  .reader-topbar { gap: 12px; padding: 15px 18px; min-height: 74px; }
  .reader-heading { padding-left: 12px; }
  .reader-title { font-size: 16px; }
  .back-button span { display: none; }
  .reader-mode-switch { display: flex; padding: 7px 18px; gap: 8px; border-bottom: 1px solid var(--border); background: var(--bg-surface); }
  .reader-mode-switch button { display: flex; align-items: center; justify-content: center; gap: 7px; flex: 1; padding: 9px 8px; border: 0; border-radius: 6px; background: transparent; color: var(--text-secondary); font-size: 12px; cursor: pointer; }
  .reader-mode-switch button.active { background: var(--accent-dim); color: var(--accent); }
  .split-left, .split-right { display: none; flex-basis: 100% !important; width: 100%; min-width: 0; }
  .split-left.mobile-active { display: block; }
  .split-right.mobile-active { display: flex; }
  .resizer { display: none; }
}
@media (max-width: 520px) {
  .reader-topbar { padding: 12px 14px; gap: 8px; }
  .reader-heading { padding-left: 10px; }
  .reader-title { font-size: 15px; }
  .reading-status { width: 85px; }
  .reader-meta { font-size: 10px; }
}
</style>
