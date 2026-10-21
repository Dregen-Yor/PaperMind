<template>
  <section class="web-qa-panel" aria-label="网页问答">
    <header class="qa-header">
      <p class="model-name">{{ modelName || '尚未选择模型' }}</p>
      <button type="button" class="new-button" data-action="new-session" @click="emit('new')">＋ 新建问答</button>
    </header>

    <div class="session-toolbar">
      <label for="web-page-history">网页历史</label>
      <select id="web-page-history" data-action="history-page" :value="selectedPageId || ''" @change="onPageChange">
        <option value="">选择已保存网页</option>
        <option v-for="page in pages || []" :key="page.id" :value="page.id">{{ page.title || page.canonicalUrl }} · {{ page.sessionCount }} 个会话</option>
      </select>
      <button v-if="selectedPageId" type="button" data-action="remove-page" title="删除此网页和全部会话" @click="emit('remove-page', selectedPageId)">删除</button>
    </div>
    <p v-if="selectedPage" class="page-meta">{{ selectedPage.snapshotCount }} 个缓存版本 · {{ formatSize(selectedPage.totalBytes) }} · 最近打开 {{ formatTime(selectedPage.lastOpenedAt) }}</p>
    <div class="session-toolbar">
      <label for="web-qa-history">历史会话</label>
      <select id="web-qa-history" :value="session?.id || ''" @change="onHistoryChange">
        <option value="">当前页面的新会话</option>
        <option v-for="item in sessions" :key="item.id" :value="item.id">{{ 'firstQuestion' in item && item.firstQuestion ? item.firstQuestion : item.title || item.finalUrl }} · 创建 {{ formatTime(item.createdAt) }} · 更新 {{ formatTime(item.updatedAt) }} · 快照 {{ formatTime(item.capturedAt) }}</option>
      </select>
    </div>

    <div v-if="session" class="source-card">
      <span class="source-kicker">本轮依据的网页快照</span>
      <strong :title="session.title">{{ session.title || '未命名网页' }}</strong>
      <span class="source-url" :title="session.finalUrl">{{ session.finalUrl }}</span>
      <div class="source-meta">
        <span>{{ formatTime(session.capturedAt) }}</span>
        <span>{{ formatSize(session.byteLength) }}</span>
        <button type="button" @click="emit('open-source')">打开原网址 ↗</button>
      </div>
    </div>
    <div v-if="sourceChanged && session" class="source-warning" role="status">
      当前网页已变化；此会话仍依据上方保存的快照。
      <button type="button" @click="emit('new')">为当前网页新建问答</button>
    </div>

    <div class="qa-scroll" ref="messagesRef" aria-live="polite" @scroll="onScroll">
      <div v-if="!session" class="empty-qa">
        <span class="empty-mark" aria-hidden="true">↗</span>
        <h3>从这篇网页开始提问</h3>
        <p>{{ canAsk ? '网页已保存，可以开始提问。' : '先在左侧打开或从历史中选择网页，再从这里提问。' }}</p>
      </div>
      <div v-else class="message-list">
        <article v-for="message in session.messages" :key="message.id" class="qa-message" :class="message.role">
          <span class="message-role">{{ message.role === 'user' ? '你' : 'PaperMind' }}</span>
          <MarkdownContent v-if="message.role === 'assistant' && message.content" :content="message.content" class="message-body" />
          <p v-else-if="message.content" class="message-body plain">{{ message.content }}</p>
          <p v-if="message.role === 'assistant' && message.status === 'streaming' && !streamedText" class="message-status">正在生成…</p>
          <p v-if="message.role === 'assistant' && message.status !== 'completed' && message.status !== 'streaming'" class="message-error">{{ message.error || '回答未完成' }}</p>
        </article>
        <article v-if="busy && streamedText" class="qa-message assistant live-answer">
          <span class="message-role">PaperMind · 正在生成</span>
          <MarkdownContent :content="streamedText" class="message-body" />
        </article>
        <button v-if="canRetry" type="button" class="retry-button" data-action="retry-question" @click="emit('retry')">重试上一问</button>
      </div>
    </div>

    <button v-if="!following" type="button" class="back-to-bottom" aria-label="回到底部" @click="scrollToBottom(true)">回到底部 ↓</button>
    <div class="composer">
      <p v-if="error" class="composer-error" role="alert">{{ error }}</p>
      <p v-if="!session" class="privacy-note">提问会将已保存网页的完整 DOM 发送到所选模型服务，并在本机保存问答。</p>
      <textarea v-model="draft" aria-label="问题输入框" rows="3" placeholder="问问这篇网页…" :disabled="busy || !canAsk" @keydown.enter="handleEnter" />
      <div class="composer-footer">
        <span>{{ busy ? '正在生成回答' : 'Enter 发送，Shift + Enter 换行' }}</span>
        <button v-if="busy" type="button" class="stop-button" data-action="stop-question" @click="emit('stop')">停止</button>
        <button v-else type="button" class="send-button" data-action="send-question" :disabled="!canAsk || !draft.trim()" @click="submit">发送问题 →</button>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useChatScroll } from '../utils/chatScroll'
import MarkdownContent from './MarkdownContent.vue'
import type { WebPageSummary, WebQaMessage, WebQaSessionSummary } from '../types/webQa'

const props = defineProps<{
  session: (WebQaSessionSummary & { messages: WebQaMessage[] }) | null
  sessions: WebQaSessionSummary[]
  pages?: WebPageSummary[]
  selectedPageId?: string
  busy: boolean
  error: string
  streamedText: string
  canAsk: boolean
  sourceChanged: boolean
  modelName: string
}>()
const emit = defineEmits<{
  send: [question: string]
  retry: []
  stop: []
  new: []
  load: [id: string]
  'select-page': [id: string]
  'remove-page': [id: string]
  'open-source': []
}>()
const draft = ref('')
const messagesRef = ref<HTMLElement>()
const { following, onScroll, scrollToBottom } = useChatScroll(messagesRef)
watch(() => props.session?.id, () => { void scrollToBottom(true) }, { immediate: true })
watch(() => [props.streamedText, props.session?.messages.length, props.session?.messages.at(-1)?.content], () => { void scrollToBottom() })
const selectedPage = computed(() => props.pages?.find(page => page.id === props.selectedPageId))
watch(() => [props.session?.id, props.session?.messages.at(-1)?.status] as const,
  ([id, status], [oldId, oldStatus]) => {
    if (id !== oldId) {
      draft.value = ''
      return
    }
    if (status === 'completed' && oldStatus !== 'completed') {
      const lastQuestion = props.session?.messages.findLast(message => message.role === 'user')?.content
      if (draft.value === lastQuestion) draft.value = ''
    }
  })
const canRetry = computed(() => {
  const last = props.session?.messages.at(-1)
  return !props.busy && last?.role === 'assistant'
    && (last.status === 'failed' || last.status === 'cancelled' || last.status === 'interrupted')
})

function formatTime(value: number) { return new Date(value).toLocaleString('zh-CN') }
function formatSize(value: number) { return `${Math.max(1, Math.round(value / 1024))} KB` }
function onHistoryChange(event: Event) {
  const id = (event.target as HTMLSelectElement).value
  if (id) emit('load', id)
  else emit('new')
}
function onPageChange(event: Event) {
  const id = (event.target as HTMLSelectElement).value
  if (id) emit('select-page', id)
}
function handleEnter(event: KeyboardEvent) {
  if (event.shiftKey || event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  submit()
}
function submit() {
  if (!props.busy && props.canAsk && draft.value.trim()) {
    void scrollToBottom(true)
    emit('send', draft.value.trim())
  }
}
function clearDraft() { draft.value = '' }
defineExpose({ clearDraft })
</script>

<style scoped>
.back-to-bottom { align-self: center; margin: 6px; padding: 6px 12px; border: 1px solid var(--border); border-radius: 14px; background: var(--bg-base); color: var(--accent); cursor: pointer; font-size: 12px; }
.web-qa-panel { display: flex; flex-direction: column; width: 100%; min-width: 0; height: 100%; min-height: 0; overflow: hidden; background: var(--bg-surface); color: var(--text-primary); }
.qa-header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; min-height: 43px; padding: 6px 20px; border-bottom: 1px solid var(--border); }
.source-kicker { display: block; color: var(--accent); font-size: 10px; font-weight: 700; letter-spacing: .15em; }
.model-name { color: var(--text-muted); font-size: 11px; }
.new-button, .source-meta button, .source-warning button, .retry-button { border: 0; background: transparent; color: var(--accent); cursor: pointer; font-size: 12px; }
.new-button { flex-shrink: 0; padding: 8px 0; font-weight: 600; }
.new-button:hover, .source-meta button:hover, .source-warning button:hover, .retry-button:hover { text-decoration: underline; }
.session-toolbar { display: flex; align-items: center; gap: 9px; min-width: 0; padding: 10px 22px; border-bottom: 1px solid var(--border-light); }
.session-toolbar label { flex-shrink: 0; color: var(--text-muted); font-size: 11px; }
.session-toolbar select { min-width: 0; flex: 1; padding: 6px 8px; border: 1px solid var(--border); border-radius: 5px; outline-color: var(--accent); background: var(--bg-base); color: var(--text-primary); font-size: 12px; }
.session-toolbar button { border: 0; color: var(--danger); background: transparent; cursor: pointer; font-size: 11px; }
.page-meta { padding: 0 22px 9px; border-bottom: 1px solid var(--border-light); color: var(--text-muted); font-size: 10px; }
.source-card { display: flex; flex-direction: column; gap: 5px; margin: 14px 22px 0; padding: 12px 14px; border-left: 2px solid var(--accent); background: var(--bg-base); }
.source-card strong { overflow: hidden; font-size: 13px; white-space: nowrap; text-overflow: ellipsis; }
.source-url { overflow: hidden; color: var(--text-muted); font-size: 11px; white-space: nowrap; text-overflow: ellipsis; }
.source-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; color: var(--text-muted); font-size: 10px; }
.source-meta button { margin-left: auto; font-size: 10px; }
.source-warning { margin: 10px 22px 0; padding: 9px 12px; border: 1px solid var(--accent-dim); border-radius: 5px; color: var(--accent); background: var(--bg-base); font-size: 11px; line-height: 1.6; }
.source-warning button { display: block; padding: 3px 0 0; font-weight: 600; }
.qa-scroll { flex: 1; min-width: 0; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 18px 22px; }
.empty-qa { display: flex; flex-direction: column; align-items: flex-start; justify-content: center; min-height: 100%; max-width: 340px; margin: 0 auto; }
.empty-mark { margin-bottom: 12px; color: var(--accent); font-family: var(--font-reading); font-size: 34px; }
.empty-qa h3 { font-family: var(--font-reading); font-size: 21px; font-weight: 500; }
.empty-qa p { margin-top: 8px; color: var(--text-muted); font-size: 12px; line-height: 1.8; }
.message-list { display: flex; flex-direction: column; min-width: 0; gap: 20px; }
.qa-message { min-width: 0; max-width: 100%; }
.qa-message.user { align-self: flex-end; width: max-content; max-width: 88%; padding: 12px 14px; border: 1px solid var(--border); border-radius: 12px 12px 2px 12px; background: var(--bg-base); }
.qa-message.assistant { align-self: stretch; }
.message-role { display: block; margin-bottom: 6px; color: var(--accent); font-size: 10px; font-weight: 700; letter-spacing: .08em; }
.message-body { max-width: 100%; overflow-x: auto; color: var(--text-primary); font-size: 13px; line-height: 1.8; overflow-wrap: anywhere; }
.message-body.plain { white-space: pre-wrap; }
.message-status { color: var(--text-muted); font-size: 12px; }
.message-error, .composer-error { color: var(--danger); font-size: 12px; line-height: 1.5; }
.retry-button { align-self: flex-start; font-weight: 600; }
.composer { flex-shrink: 0; padding: 14px 22px 18px; border-top: 1px solid var(--border); background: var(--bg-surface); }
.privacy-note { margin-bottom: 9px; color: var(--text-muted); font-size: 10px; line-height: 1.5; }
.composer textarea { width: 100%; min-height: 76px; resize: vertical; padding: 10px 11px; border: 1px solid var(--border); border-radius: 7px; outline: 0; background: var(--bg-base); color: var(--text-primary); font: 12px/1.6 var(--font-ui); }
.composer textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-dim); }
.composer textarea:disabled { opacity: .55; }
.composer-footer { display: flex; align-items: center; justify-content: space-between; margin-top: 8px; color: var(--text-muted); font-size: 10px; }
.send-button, .stop-button { min-height: 32px; padding: 0 12px; border: 0; border-radius: 5px; cursor: pointer; font-size: 11px; font-weight: 600; }
.send-button { color: var(--bg-surface); background: var(--accent); }
.send-button:disabled { opacity: .45; cursor: default; }
.stop-button { color: var(--accent); background: var(--accent-dim); }
</style>
