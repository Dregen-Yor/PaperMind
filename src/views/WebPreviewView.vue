<template>
  <div class="web-preview-view">
    <header class="preview-toolbar" aria-label="网页预览工具栏">
      <div class="navigation-actions">
        <button type="button" data-action="back" class="icon-button" aria-label="后退" title="后退" :disabled="!previewState.canGoBack" @click="runAction(() => window.preview.back())">
          <ArrowLeft aria-hidden="true" />
        </button>
        <button type="button" data-action="forward" class="icon-button" aria-label="前进" title="前进" :disabled="!previewState.canGoForward" @click="runAction(() => window.preview.forward())">
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
        <button type="button" data-action="reload" class="icon-button" aria-label="刷新" title="刷新" :disabled="!previewState.url" @click="runAction(() => window.preview.reload())">
          <Refresh aria-hidden="true" />
        </button>
        <button type="button" data-action="external" class="external-button" aria-label="在系统浏览器打开" title="在系统浏览器打开" :disabled="!address.trim() && !previewState.url" @click="openExternal">
          <TopRight aria-hidden="true" />
          <span>浏览器打开</span>
        </button>
      </div>
    </header>

    <div v-if="previewState.loading" class="loading-line" role="progressbar" aria-label="正在加载网页" />
    <p v-if="previewState.notice" class="toolbar-notice" role="status">{{ previewState.notice }}</p>
    <p v-if="inputError && previewState.visible" class="toolbar-notice" role="alert">{{ inputError }}</p>
    <main class="preview-stage" aria-label="网页内容">
      <div ref="previewSlot" class="preview-slot">
        <div v-if="!previewState.visible" class="preview-message" :class="{ 'has-error': previewState.error || inputError }">
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
    </main>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { ArrowLeft, ArrowRight, Refresh, TopRight } from '@element-plus/icons-vue'
import { isAllowedExternalUrl, normalizePreviewUrl } from '../utils/webPreviewUrl'
import type { PreviewBounds, PreviewState } from '../types/webPreview'

const window = globalThis.window
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

function measuredBounds(): PreviewBounds {
  const rect = previewSlot.value?.getBoundingClientRect()
  return rect
    ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    : { x: 0, y: 0, width: 0, height: 0 }
}

function syncBounds() {
  if (previewState.value.visible || previewState.value.loading) {
    void window.preview.setBounds(measuredBounds())
  }
}

function runAction(action: () => Promise<void>) {
  void action().catch(error => {
    inputError.value = error instanceof Error ? error.message : '操作失败，请重试。'
  })
}

async function openUrl(url: string) {
  inputError.value = ''
  try {
    await window.preview.open(url, measuredBounds())
  } catch (error) {
    inputError.value = error instanceof Error ? error.message : '网页未能打开，请重试。'
  }
}

async function openAddress() {
  try {
    const url = normalizePreviewUrl(address.value)
    address.value = url
    editing.value = false
    await openUrl(url)
  } catch (error) {
    inputError.value = error instanceof Error ? error.message : '请输入有效的 HTTPS 链接'
  }
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
  unsubscribe = window.preview.onState(next => {
    previewState.value = next
    if (!editing.value) address.value = next.url
    if (next.visible) inputError.value = ''
  })
  observer = new ResizeObserver(syncBounds)
  if (previewSlot.value) observer.observe(previewSlot.value)
  window.addEventListener('resize', syncBounds)
  await nextTick()
  addressInput.value?.focus()
})

onBeforeUnmount(() => {
  observer?.disconnect()
  window.removeEventListener('resize', syncBounds)
  unsubscribe?.()
  void window.preview.close()
})
</script>

<style scoped>
.web-preview-view { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--bg-base); }
.preview-toolbar { display: flex; align-items: center; gap: 12px; min-height: 64px; padding: 10px 20px; border-bottom: 1px solid var(--border); background: var(--bg-surface); flex-shrink: 0; }
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
.preview-stage { flex: 1; min-height: 0; padding: 12px; background: var(--bg-reader); }
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
@media (max-width: 520px) { .preview-toolbar { flex-wrap: wrap; min-height: 100px; } .address-form { order: -1; flex-basis: 100%; } .page-actions { margin-left: auto; } .preview-stage { padding: 8px; } }
@media (prefers-reduced-motion: reduce) { .loading-line { animation: none; background: var(--accent); } }
</style>
