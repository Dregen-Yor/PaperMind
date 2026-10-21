<template>
  <div class="web-preview-view">
    <header class="preview-toolbar" aria-label="网页问答工具栏">
      <div class="navigation-actions">
        <button type="button" data-action="back" class="icon-button" aria-label="后退" title="后退" :disabled="history.mode.value === 'cached' || !previewState.canGoBack" @click="runAction(() => window.preview.back())">
          <ArrowLeft aria-hidden="true" />
        </button>
        <button type="button" data-action="forward" class="icon-button" aria-label="前进" title="前进" :disabled="history.mode.value === 'cached' || !previewState.canGoForward" @click="runAction(() => window.preview.forward())">
          <ArrowRight aria-hidden="true" />
        </button>
      </div>

      <form class="address-form" @submit.prevent="openAddress">
        <span class="address-lock" aria-hidden="true">https</span>
        <input
          ref="addressInput"
          v-model="address"
          type="text"
          inputmode="url"
          autocomplete="url"
          spellcheck="false"
          aria-label="网页地址"
          placeholder="粘贴 HTTPS 链接"
          @input="editing = true"
          @keydown.enter.prevent="openAddress"
          @keydown.esc.prevent="restoreAddress"
        />
        <button type="submit" class="open-button" aria-label="打开网页">打开</button>
      </form>

      <div class="page-actions">
        <button type="button" data-action="reload" class="icon-button" aria-label="刷新" title="刷新" :disabled="history.mode.value === 'cached' || !previewState.url" @click="runAction(() => window.preview.reload())">
          <Refresh aria-hidden="true" />
        </button>
        <button type="button" data-action="external" class="external-button" aria-label="在系统浏览器打开" title="在系统浏览器打开" :disabled="!address.trim() && !previewState.url" @click="openExternal">
          <TopRight aria-hidden="true" />
          <span>浏览器打开</span>
        </button>
      </div>
    </header>

    <div class="cache-actions">
      <span>{{ history.mode.value === 'cached' ? (history.nativeCached.value ? '本地原貌缓存' : '本地缓存阅读') : '在线网页预览' }}</span>
      <span v-if="history.mode.value === 'cached' && history.appearanceNotice.value" class="appearance-notice">{{ history.appearanceNotice.value }}</span>
      <button v-if="history.mode.value === 'live' && previewState.visible && liveDirty" type="button" data-action="save-current" @click="saveCurrent">保存当前网页</button>
      <button v-if="history.selectedPage.value" type="button" data-action="update-cache" @click="updateCache">更新缓存</button>
      <button v-if="history.mode.value === 'live' && history.selectedPage.value" type="button" data-action="return-cache" @click="selectPage(history.selectedPage.value.id)">返回缓存</button>
    </div>

    <div v-if="previewState.loading" class="loading-line" role="progressbar" aria-label="正在加载网页" />
    <p v-if="previewState.notice" class="toolbar-notice" role="status">{{ previewState.notice }}</p>
    <p v-if="inputError && previewState.visible" class="toolbar-notice" role="alert">{{ inputError }}</p>
    <div class="web-mode-switch" role="group" aria-label="网页问答视图">
      <button type="button" aria-label="显示网页面板" :class="{ active: mobilePane === 'web' }" @click="setMobilePane('web')">网页</button>
      <button type="button" aria-label="显示问答面板" :class="{ active: mobilePane === 'qa' }" @click="setMobilePane('qa')">问答</button>
    </div>
    <div ref="readerSplit" class="web-reader-split">
      <main id="web-document" class="web-split-left" :class="{ 'mobile-active': mobilePane === 'web' }" :style="{ flexBasis: splitRatio + '%' }" aria-label="网页内容">
        <div class="preview-stage">
          <div ref="previewSlot" class="preview-slot" @dragover.prevent @drop.prevent="onDrop">
            <WebCachedPreview v-if="history.mode.value === 'cached' && !history.nativeCached.value && history.selectedSnapshotPreview.value" :snapshot="history.selectedSnapshotPreview.value" :load-error="history.cacheLoadError.value" @open-source="openSavedSource" />
            <div v-else-if="!previewState.visible" class="preview-message" :class="{ 'has-error': previewState.error || inputError }">
              <template v-if="previewState.error || inputError">
                <h1 class="message-title font-display">网页未能打开</h1>
                <p role="alert">{{ inputError || previewState.error }}</p>
                <div class="message-actions">
                  <button v-if="previewState.url" type="button" data-action="retry" class="primary-action" @click="retry">重试</button>
                  <button v-if="previewState.url" type="button" class="secondary-action" @click="openExternal">在系统浏览器打开</button>
                </div>
              </template>
              <template v-else>
                <h1 class="message-title font-display">从链接开始阅读</h1>
                <p>粘贴 HTTPS 链接，按 Enter 预览原网页</p>
              </template>
            </div>
          </div>
        </div>
      </main>
      <div class="resizer" role="separator" tabindex="0" aria-orientation="vertical" aria-label="调整网页与问答面板宽度"
        aria-controls="web-document" :aria-valuenow="Math.round(splitRatio)" aria-valuemin="30" aria-valuemax="75"
        @mousedown.prevent="startResize" @keydown.left.prevent="adjustSplit(-2)" @keydown.right.prevent="adjustSplit(2)"
        @keydown.home.prevent="setSplit(30)" @keydown.end.prevent="setSplit(75)" @dblclick="setSplit(58)"><span aria-hidden="true" /></div>
      <aside class="web-split-right" :class="{ 'mobile-active': mobilePane === 'qa' }">
        <div class="right-tabs" role="group" aria-label="网页问答与摘要">
          <button type="button" class="right-tab" :class="{ active: rightTab === 'chat' }" :aria-pressed="rightTab === 'chat'" @click="rightTab = 'chat'"><el-icon aria-hidden="true"><ChatLineRound /></el-icon> 网页问答</button>
          <button type="button" class="right-tab" :class="{ active: rightTab === 'summary' }" :aria-pressed="rightTab === 'summary'" @click="rightTab = 'summary'"><el-icon aria-hidden="true"><Document /></el-icon> 网页摘要</button>
        </div>
        <div v-show="rightTab === 'chat'" class="right-pane-content">
          <WebQaPanel ref="qaPanel" :session="qa.currentSession.value" :sessions="qa.sessions.value"
            :pages="history.pages.value" :selected-page-id="history.selectedPage.value?.id || ''" :busy="qa.busy.value"
            :error="qa.error.value" :streamed-text="qa.streamedText.value" :can-ask="canAsk"
            :source-changed="sourceChanged" :model-name="chatStore.chatProfile.name"
            :profiles="chatStore.profiles" :profile-id="chatStore.chatProfile.id"
            @select-profile="chatStore.setChatProfileId($event)"
            @send="sendQuestion" @retry="qa.retry" @stop="qa.stop" @new="startNewSession"
            @load="loadSession" @select-page="selectPage" @remove-page="removePage" @open-source="openSavedSource" />
        </div>
        <WebAbstractPanel v-if="rightTab === 'summary'" :snapshot="history.selectedSnapshotPreview.value"
          :content="webSummary.state.value?.report?.content || webSummary.state.value?.content || ''"
          :busy="webSummary.busy.value" :loading="webSummary.cacheLoading.value" :progress="webSummary.progress.value"
          :error="webSummary.error.value" :truncated="webSummary.state.value?.report?.truncated || webSummary.state.value?.truncated || false"
          @generate="generateWebSummary" @stop="webSummary.cancel()" />
      </aside>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ArrowLeft, ArrowRight, ChatLineRound, Document, Refresh, TopRight } from '@element-plus/icons-vue'
import { isAllowedExternalUrl, normalizePreviewUrl } from '../utils/webPreviewUrl'
import type { PreviewBounds, PreviewState } from '../types/webPreview'
import WebQaPanel from '../components/WebQaPanel.vue'
import { useWebQa } from '../composables/useWebQa'
import { useChatStore } from '../stores/chat'
import { useWebPageHistory } from '../composables/useWebPageHistory'
import WebCachedPreview from '../components/WebCachedPreview.vue'
import WebAbstractPanel from '../components/WebAbstractPanel.vue'
import { useWebSummary } from '../composables/useWebSummary'
import { ElMessageBox } from 'element-plus'

const window = globalThis.window
const chatStore = useChatStore()
const qa = useWebQa()
const history = useWebPageHistory(window.preview, window.db.webQa, qa, snapshotId => {
  // Captures and model tasks belong to the saved source, independent of selection.
  void window.db.webQa.getPreview(snapshotId).then(snapshot => {
    if (snapshot) return webSummary.prepare(snapshot)
  }).catch(() => {})
})
const webSummary = useWebSummary(history.selectedSnapshotPreview)
const rightTab = ref<'chat' | 'summary'>('chat')
async function generateWebSummary(force: boolean) {
  if (webSummary.busy.value) return
  try { await webSummary.generate(force) } catch { /* Persistent source state displays the error. */ }
}
const qaPanel = ref<InstanceType<typeof WebQaPanel>>()
const readerSplit = ref<HTMLElement>()
const splitRatio = ref(58)
const mobilePane = ref<'web' | 'qa'>('web')
const sourceChanged = ref(false)
const liveDirty = ref(false)
const canAsk = computed(() => !!qa.currentSession.value || (!!qa.selectedSnapshotId.value
  && (history.mode.value === 'cached' || !liveDirty.value)))
const previewSlot = ref<HTMLElement>()
const addressInput = ref<HTMLInputElement>()
const address = ref('')
const editing = ref(false)
const inputError = ref('')
const previewState = ref<PreviewState>({
  url: '', loading: false, canGoBack: false, canGoForward: false,
  error: '', notice: '', visible: false,
})
let unsubscribe: (() => void) | undefined
let observer: ResizeObserver | undefined
const superseded = (error: unknown) => error instanceof Error && error.message === '网页选择已变化'

function measuredBounds(): PreviewBounds {
  const rect = previewSlot.value?.getBoundingClientRect()
  return rect
    ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    : { x: 0, y: 0, width: 0, height: 0 }
}

function syncBounds() {
  if (history.mode.value === 'cached') {
    const narrow = globalThis.matchMedia?.('(max-width: 800px)').matches ?? false
    const bounds = history.nativeCached.value && (!narrow || mobilePane.value === 'web')
      ? measuredBounds() : { x: 0, y: 0, width: 0, height: 0 }
    void window.preview.setBounds(bounds)
  } else if (previewState.value.visible || previewState.value.loading) {
    const narrow = globalThis.matchMedia?.('(max-width: 800px)').matches ?? false
    const bounds = narrow && mobilePane.value === 'qa'
      ? { x: 0, y: 0, width: 0, height: 0 }
      : measuredBounds()
    void window.preview.setBounds(bounds)
  }
}

function setMobilePane(pane: 'web' | 'qa') {
  mobilePane.value = pane
  void nextTick(syncBounds)
}

function setSplit(value: number) {
  splitRatio.value = Math.min(75, Math.max(30, value))
  void nextTick(syncBounds)
}

function adjustSplit(delta: number) { setSplit(splitRatio.value + delta) }

let resizing = false
function startResize() {
  resizing = true
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
}
function onMove(event: MouseEvent) {
  if (!resizing || !readerSplit.value) return
  const bounds = readerSplit.value.getBoundingClientRect()
  setSplit(((event.clientX - bounds.left) / bounds.width) * 100)
}
function stopResize() {
  resizing = false
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
}

async function sendQuestion(question: string) {
  if (await qa.send(question)) qaPanel.value?.clearDraft()
  await Promise.allSettled([qa.refresh(), history.refreshPages()])
}
function startNewSession() {
  qa.newSession()
  sourceChanged.value = liveDirty.value
}
async function loadSession(id: string) {
  try {
    if (!await history.selectSession(id, measuredBounds())) return
    liveDirty.value = false
    sourceChanged.value = false
    await nextTick(syncBounds)
  } catch (cause) { if (!superseded(cause)) inputError.value = cause instanceof Error ? cause.message : '网页会话加载失败' }
}
function openSavedSource() {
  const url = qa.currentSession.value?.finalUrl ?? history.selectedSnapshotPreview.value?.finalUrl
  if (url) void openUrl(url)
}

function runAction(action: () => Promise<void>) {
  void action().catch(error => {
    inputError.value = error instanceof Error ? error.message : '操作失败，请重试。'
  })
}

async function openUrl(url: string) {
  inputError.value = ''
  try {
    liveDirty.value = true
    await history.openLive(url, measuredBounds())
  } catch (error) {
    if (!superseded(error)) inputError.value = error instanceof Error ? error.message : '网页未能打开，请重试。'
  }
}

async function openAddress() {
  try {
    const url = normalizePreviewUrl(address.value)
    address.value = url
    editing.value = false
    inputError.value = ''
    const page = await history.openExplicit(url, measuredBounds())
    address.value = page.canonicalUrl
    liveDirty.value = false
    sourceChanged.value = false
  } catch (error) {
    if (!superseded(error)) inputError.value = error instanceof Error ? error.message : '请输入有效的 HTTPS 链接'
  }
}

async function onDrop(event: DragEvent) {
  const raw = event.dataTransfer?.getData('text/uri-list').split('\n').find(line => line.trim() && !line.startsWith('#'))
    || event.dataTransfer?.getData('text/plain')
  if (!raw) return
  address.value = raw.trim()
  await openAddress()
}

async function selectPage(id: string) {
  try {
    if (!await history.selectPage(id, measuredBounds())) return
    liveDirty.value = false
    address.value = history.selectedPage.value?.canonicalUrl ?? address.value
    sourceChanged.value = false
    await nextTick(syncBounds)
  } catch (cause) { if (!superseded(cause)) inputError.value = cause instanceof Error ? cause.message : '网页缓存加载失败' }
}

async function saveCurrent() {
  try {
    await history.saveCurrent()
    liveDirty.value = false
    sourceChanged.value = false
  } catch (cause) { if (!superseded(cause)) inputError.value = cause instanceof Error ? cause.message : '当前网页保存失败' }
}

async function updateCache() {
  try {
    await history.refreshPage(measuredBounds())
    liveDirty.value = false
    sourceChanged.value = false
  } catch (cause) { if (!superseded(cause)) inputError.value = cause instanceof Error ? cause.message : '网页缓存更新失败' }
}

async function removePage(id: string) {
  try {
    await ElMessageBox.confirm('将删除此网页的全部缓存版本及其问答会话。确认删除？', '删除网页历史', { type: 'warning' })
  } catch { return }
  try {
    webSummary.cancelPage(id)
    await history.removePage(id)
    sourceChanged.value = false
  } catch (cause) { inputError.value = cause instanceof Error ? cause.message : '网页历史删除失败' }
}

function restoreAddress() {
  address.value = previewState.value.url
  editing.value = false
  inputError.value = ''
}

function retry() {
  if (previewState.value.url) void openUrl(previewState.value.url)
}

function openExternal() {
  const typed = address.value.trim()
  const target = isAllowedExternalUrl(typed) ? typed : previewState.value.url
  if (!target) {
    inputError.value = '请输入 HTTP 或 HTTPS 链接'
    return
  }
  runAction(() => window.preview.openExternal(target))
}

onMounted(async () => {
  void history.refreshPages()
  unsubscribe = window.preview.onState(next => {
    if (history.mode.value === 'live' && history.selectedPage.value
      && (next.url !== history.selectedPage.value.canonicalUrl
        || (next.loading && !previewState.value.loading))) {
      liveDirty.value = true
      sourceChanged.value = true
    }
    previewState.value = next
    if (!editing.value) address.value = next.url
    if (next.visible) inputError.value = ''
  })
  observer = new ResizeObserver(syncBounds)
  if (previewSlot.value) observer.observe(previewSlot.value)
  window.addEventListener('resize', syncBounds)
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', stopResize)
  await nextTick()
  addressInput.value?.focus()
})

onBeforeUnmount(() => {
  qa.stop()
  stopResize()
  observer?.disconnect()
  window.removeEventListener('resize', syncBounds)
  window.removeEventListener('mousemove', onMove)
  window.removeEventListener('mouseup', stopResize)
  unsubscribe?.()
  void window.preview.close()
})

watch(splitRatio, () => { void nextTick(syncBounds) })
watch(() => history.nativeCached.value, () => { void nextTick(syncBounds) })
watch(() => history.selectedSnapshotPreview.value, () => { void nextTick(syncBounds) })
watch(() => history.mode.value, () => { void nextTick(syncBounds) })
</script>

<style scoped>
.web-preview-view { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--bg-base); }
.right-tabs { display: flex; align-items: stretch; gap: clamp(10px, 2vw, 22px); padding: 0 20px; min-height: 51px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.right-tab { display: flex; align-items: center; justify-content: center; gap: 7px; padding: 15px 1px 13px; border: 0; border-bottom: 2px solid transparent; background: transparent; font-size: 12px; color: var(--text-muted); cursor: pointer; white-space: nowrap; }
.right-tab .el-icon { font-size: 15px; }
.right-tab.active { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }
.right-tab:hover { color: var(--accent); }
.web-reader-split { display: flex; flex: 1; min-height: 0; overflow: hidden; }
.web-split-left { display: flex; flex-direction: column; height: 100%; min-width: 0; overflow: hidden; flex-grow: 0; flex-shrink: 1; }
.web-split-right { display: flex; flex-direction: column; flex: 1; min-width: 340px; height: 100%; overflow: hidden; border-left: 1px solid var(--border); }
.right-pane-content, .web-split-right > .web-abstract-panel { flex: 1; min-height: 0; height: auto; }
.right-pane-content { overflow: hidden; }
.resizer { display: flex; align-items: center; justify-content: center; width: 7px; flex-shrink: 0; border-left: 1px solid var(--border); border-right: 1px solid var(--border); background: var(--bg-elevated); cursor: col-resize; }
.resizer span { width: 2px; height: 30px; border-radius: 2px; background: var(--border-light); }
.resizer:hover, .resizer:focus-visible { background: var(--accent-dim); }
.resizer:hover span { background: var(--accent); }
.web-mode-switch { display: none; }
.preview-toolbar { display: flex; align-items: center; gap: 12px; min-height: 64px; padding: 10px 20px; border-bottom: 1px solid var(--border); background: var(--bg-surface); flex-shrink: 0; }
.cache-actions { display: flex; align-items: center; gap: 12px; min-height: 35px; padding: 5px 20px; border-bottom: 1px solid var(--border); color: var(--text-muted); background: var(--bg-surface); font-size: 11px; }
.cache-actions button { border: 0; color: var(--accent); background: transparent; cursor: pointer; font-size: 11px; }
.appearance-notice { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--accent); }
.navigation-actions, .page-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
.icon-button, .external-button, .open-button { display: inline-flex; align-items: center; justify-content: center; border: 0; cursor: pointer; color: var(--text-secondary); background: transparent; }
.icon-button { width: 40px; height: 40px; border-radius: var(--radius-sm); }
.icon-button svg, .external-button svg { width: 17px; height: 17px; }
.icon-button:hover:not(:disabled), .external-button:hover:not(:disabled) { color: var(--accent); background: var(--bg-hover); }
.icon-button:disabled, .external-button:disabled { opacity: .38; cursor: default; }
.address-form { display: flex; align-items: center; gap: 8px; min-width: 0; height: 40px; flex: 1; padding: 0 4px 0 12px; border: 1px solid var(--border-light); border-radius: 7px; background: var(--bg-base); }
.address-form:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-dim); }
.address-lock { flex-shrink: 0; font-size: 10px; font-weight: 600; color: var(--success); letter-spacing: .02em; }
.address-form input { flex: 1; width: 100%; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--text-primary); font-size: 13px; }
.address-form input::placeholder { color: var(--text-muted); }
.open-button { height: 30px; padding: 0 11px; border-radius: 5px; color: var(--accent); font-size: 12px; font-weight: 600; }
.open-button:hover { background: var(--accent-dim); }
.external-button { gap: 6px; height: 40px; padding: 0 10px; border-radius: var(--radius-sm); font-size: 12px; white-space: nowrap; }
.loading-line { height: 2px; flex-shrink: 0; background: linear-gradient(90deg, transparent 0%, var(--accent) 45%, transparent 90%); background-size: 180% 100%; animation: loading-move 1.2s linear infinite; }
.toolbar-notice { padding: 7px 20px; border-bottom: 1px solid var(--border); color: var(--danger); background: var(--danger-dim); font-size: 12px; }
.preview-stage { flex: 1; height: 100%; min-height: 0; padding: 12px; background: var(--bg-reader); }
.preview-slot { position: relative; width: 100%; height: 100%; min-height: 0; background: var(--bg-surface); }
.preview-message { display: flex; flex-direction: column; align-items: flex-start; justify-content: center; gap: 10px; width: min(520px, calc(100% - 48px)); height: 100%; margin: 0 auto; color: var(--text-secondary); }
.message-title { font-size: clamp(23px, 3vw, 30px); line-height: 1.25; font-weight: 500; color: var(--text-primary); }
.preview-message p { font-size: 13px; line-height: 1.7; }
.message-actions { display: flex; gap: 9px; margin-top: 12px; }
.primary-action, .secondary-action { min-height: 38px; padding: 0 14px; border-radius: 6px; border: 1px solid var(--accent); cursor: pointer; font-size: 12px; }
.primary-action { color: var(--bg-surface); background: var(--accent); }
.secondary-action { color: var(--accent); background: transparent; }
.primary-action:hover { background: var(--accent-hover); }
.secondary-action:hover { background: var(--accent-dim); }
@keyframes loading-move { from { background-position: 180% 0; } to { background-position: -180% 0; } }
@media (max-width: 760px) { .preview-toolbar { gap: 6px; padding: 9px 12px; } .external-button span { display: none; } .external-button { width: 40px; padding: 0; } }
@media (max-width: 800px) {
  .web-mode-switch { display: flex; gap: 8px; padding: 7px 18px; border-bottom: 1px solid var(--border); background: var(--bg-surface); }
  .web-mode-switch button { flex: 1; padding: 9px 8px; border: 0; border-radius: 6px; background: transparent; color: var(--text-secondary); cursor: pointer; font-size: 12px; }
  .web-mode-switch button.active { background: var(--accent-dim); color: var(--accent); }
  .web-split-left, .web-split-right { display: none; flex-basis: 100% !important; width: 100%; min-width: 0; }
  .web-split-left.mobile-active { display: flex; }
  .web-split-right.mobile-active { display: flex; }
  .resizer { display: none; }
}
@media (max-width: 520px) { .preview-toolbar { flex-wrap: wrap; min-height: 100px; } .address-form { order: -1; flex-basis: 100%; } .page-actions { margin-left: auto; } .preview-stage { padding: 8px; } }
@media (prefers-reduced-motion: reduce) { .loading-line { animation: none; background: var(--accent); } }
</style>
