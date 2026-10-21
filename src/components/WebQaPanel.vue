<template>
  <section class="web-qa-panel" aria-label="网页问答">
    <header class="qa-header">
      <div class="conversation-picker">
        <select id="web-qa-history" aria-label="当前网页对话" :value="session?.id || ''" @change="onHistoryChange">
          <option value="">新对话</option>
          <option v-for="(item, index) in sessions" :key="item.id" :value="item.id" :title="`${formatTime(item.createdAt)} · ${item.title || item.finalUrl}`">{{ 'firstQuestion' in item && item.firstQuestion ? item.firstQuestion : `对话 ${index + 1}` }}</option>
        </select>
        <ArrowDown aria-hidden="true" />
      </div>
      <button type="button" class="new-button" data-action="new-session" aria-label="新建网页问答" title="新建问答" @click="emit('new')"><Plus aria-hidden="true" /></button>
    </header>

    <details class="page-details">
      <summary><Document aria-hidden="true" /><span>网页与来源</span><ArrowDown class="details-arrow" aria-hidden="true" /></summary>
      <div class="details-content">
        <div class="session-toolbar">
          <label for="web-page-history">网页历史</label>
          <select id="web-page-history" data-action="history-page" :value="selectedPageId || ''" @change="onPageChange">
            <option value="">选择已保存网页</option>
            <option v-for="page in pages || []" :key="page.id" :value="page.id">{{ page.title || page.canonicalUrl }} · {{ page.sessionCount }} 个会话</option>
          </select>
          <button v-if="selectedPageId" type="button" data-action="remove-page" title="删除此网页和全部会话" @click="emit('remove-page', selectedPageId)">删除</button>
        </div>
        <p v-if="selectedPage" class="page-meta">{{ selectedPage.snapshotCount }} 个缓存版本 · {{ formatSize(selectedPage.totalBytes) }} · 最近打开 {{ formatTime(selectedPage.lastOpenedAt) }}</p>
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
      </div>
    </details>
    <div v-if="sourceChanged && session" class="source-warning" role="status">
      当前网页已变化；此会话仍依据上方保存的快照。
      <button type="button" @click="emit('new')">为当前网页新建问答</button>
    </div>

    <div class="qa-scroll" ref="messagesRef" aria-live="polite" @scroll="onScroll">
      <div v-if="!session || !session.messages.length" class="empty-qa">
        <img class="empty-visual" :src="paperMindMark" alt="" />
        <h2 class="font-display">读到这里，想问些什么？</h2>
        <p>{{ canAsk ? '从一个问题开始，理解网页背后的思路。\n梳理核心观点，探索内容中的细节与启发。' : '先在左侧打开或从历史中选择网页，\n再从这里提问。' }}</p>
        <div v-if="canAsk" class="starter-questions">
          <button v-for="starter in starterQuestions" :key="starter.label" type="button" class="starter-question" :disabled="busy" @click="choosePrompt(starter.question)">
            <span>{{ starter.label }}</span><ArrowRight aria-hidden="true" />
          </button>
        </div>
      </div>
      <div v-else class="message-list">
        <article v-for="message in session.messages" :key="message.id" class="qa-message" :class="message.role">
          <div class="msg-avatar" aria-hidden="true"><span v-if="message.role === 'user'">你</span><img v-else :src="paperMindMarkLight" alt="" /></div>
          <div class="msg-body">
            <div v-if="message.role === 'assistant'" class="msg-author">PaperMind</div>
            <MarkdownContent v-if="message.role === 'assistant' && message.content" :content="message.content" class="msg-content" />
            <p v-else-if="message.content" class="msg-content plain">{{ message.content }}</p>
            <div v-if="message.role === 'assistant' && message.status === 'streaming' && !streamedText" class="typing" role="status" aria-label="正在生成回答"><span /><span /><span /></div>
            <p v-if="message.role === 'assistant' && message.status !== 'completed' && message.status !== 'streaming'" class="message-error">{{ message.error || '回答未完成' }}</p>
          </div>
        </article>
        <article v-if="busy && streamedText" class="qa-message assistant live-answer">
          <div class="msg-avatar" aria-hidden="true"><img :src="paperMindMarkLight" alt="" /></div>
          <div class="msg-body">
            <div class="msg-author">PaperMind</div>
            <MarkdownContent :content="streamedText" class="msg-content is-streaming" />
          </div>
        </article>
        <button v-if="canRetry" type="button" class="retry-button" data-action="retry-question" @click="emit('retry')">重试上一问</button>
      </div>
    </div>

    <button v-if="!following" type="button" class="back-to-bottom" aria-label="回到底部" @click="scrollToBottom(true)">回到底部 ↓</button>
    <div class="composer-wrap">
      <p v-if="error" class="composer-error" role="alert">{{ error }}</p>
      <div class="chat-input-area">
        <textarea ref="inputRef" v-model="draft" aria-label="问题输入框" rows="2" placeholder="围绕网页提问…" :disabled="busy || !canAsk" @keydown.enter="handleEnter" />
        <div class="composer-footer">
          <ChatProfileSelect class="composer-model" :profiles="profiles || []" :model-value="profileId || ''" :fallback-name="modelName" :disabled="busy" @update:model-value="emit('select-profile', $event)" />
          <span class="input-hint">Enter 发送<span class="newline-hint">，Shift + Enter 换行</span></span>
          <button v-if="busy" type="button" class="stop-button" data-action="stop-question" @click="emit('stop')">停止</button>
          <button v-else type="button" class="send-button" data-action="send-question" aria-label="发送消息" :disabled="!canAsk || !draft.trim()" @click="submit"><Top aria-hidden="true" /></button>
        </div>
      </div>
      <p v-if="!session" class="privacy-note">提问会将已保存网页的完整 DOM 发送到所选模型服务，并在本机保存问答。</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ArrowDown, ArrowRight, Document, Plus, Top } from '@element-plus/icons-vue'
import { useChatScroll } from '../utils/chatScroll'
import MarkdownContent from './MarkdownContent.vue'
import ChatProfileSelect, { type ChatProfileOption } from './ChatProfileSelect.vue'
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
  profiles?: ChatProfileOption[]
  profileId?: string
}>()
const emit = defineEmits<{
  'select-profile': [id: string]
  send: [question: string]
  retry: []
  stop: []
  new: []
  load: [id: string]
  'select-page': [id: string]
  'remove-page': [id: string]
  'open-source': []
}>()
const paperMindMark = new URL('../../assets/brand/papermind-mark.svg', import.meta.url).href
const paperMindMarkLight = new URL('../../assets/brand/papermind-mark-light.svg', import.meta.url).href
const starterQuestions = [
  { label: '概括核心观点', question: '请概括这篇网页的核心观点和主要结论。' },
  { label: '解释关键内容', question: '请解释这篇网页中的关键概念，以及它们之间的关系。' },
  { label: '分析局限与启发', question: '这篇网页的观点有哪些局限？有哪些值得进一步思考的启发？' },
]
const inputRef = ref<HTMLTextAreaElement>()
function choosePrompt(question: string) {
  draft.value = question
  inputRef.value?.focus()
}
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
.source-kicker { display: block; color: var(--accent); font-size: 10px; font-weight: 700; letter-spacing: .15em; }
.new-button, .source-meta button, .source-warning button, .retry-button { border: 0; background: transparent; color: var(--accent); cursor: pointer; font-size: 12px; }
.new-button:hover, .source-meta button:hover, .source-warning button:hover, .retry-button:hover { text-decoration: underline; }
.session-toolbar { display: flex; align-items: center; gap: 9px; min-width: 0; padding: 8px 0; }
.session-toolbar label { flex-shrink: 0; color: var(--text-muted); font-size: 11px; }
.session-toolbar select { min-width: 0; flex: 1; padding: 6px 8px; border: 1px solid var(--border); border-radius: 5px; outline-color: var(--accent); background: var(--bg-base); color: var(--text-primary); font-size: 12px; }
.session-toolbar button { border: 0; color: var(--danger); background: transparent; cursor: pointer; font-size: 11px; }
.page-meta { padding: 0 0 9px; color: var(--text-muted); font-size: 10px; }
.source-card { display: flex; flex-direction: column; gap: 5px; margin: 8px 0 0; padding: 12px 14px; border-left: 2px solid var(--accent); background: var(--bg-base); }
.source-card strong { overflow: hidden; font-size: 13px; white-space: nowrap; text-overflow: ellipsis; }
.source-url { overflow: hidden; color: var(--text-muted); font-size: 11px; white-space: nowrap; text-overflow: ellipsis; }
.source-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; color: var(--text-muted); font-size: 10px; }
.source-meta button { margin-left: auto; font-size: 10px; }
.source-warning { margin: 10px 22px 0; padding: 9px 12px; border: 1px solid var(--accent-dim); border-radius: 5px; color: var(--accent); background: var(--bg-base); font-size: 11px; line-height: 1.6; }
.source-warning button { display: block; padding: 3px 0 0; font-weight: 600; }
.message-error, .composer-error { color: var(--danger); font-size: 12px; line-height: 1.5; }
.retry-button { align-self: flex-start; font-weight: 600; }
.empty-qa { width: 100%; max-width: 380px; margin: auto; padding: 20px 0; display: flex; flex-direction: column; align-items: center; text-align: center; }
.empty-visual { display: block; width: 64px; height: 64px; margin-bottom: 24px; object-fit: contain; }
.empty-qa h2 { font-size: 24px; font-weight: 500; line-height: 1.5; color: var(--text-primary); }
.empty-qa p { margin-top: 12px; font-size: 12px; line-height: 1.95; color: var(--text-muted); white-space: pre-line; }
.starter-questions { display: flex; flex-direction: column; gap: 8px; width: 100%; max-width: 280px; margin-top: 28px; }
.starter-question { display: flex; justify-content: space-between; align-items: center; gap: 16px; border: 1px solid var(--border); background: transparent; border-radius: 7px; padding: 11px 14px; color: var(--text-secondary); text-align: left; font-size: 12px; cursor: pointer; transition: background 0.15s, border-color 0.15s; }
.starter-question > svg { width: 12px; height: 12px; flex-shrink: 0; color: var(--text-muted); font-size: 12px; }
.starter-question:hover { border-color: var(--border-light); background: var(--bg-base); color: var(--accent); }
.start-conversation { margin-top: 25px; }
.qa-message { display: flex; gap: 10px; }
.qa-message.user { flex-direction: row-reverse; }
.msg-avatar { width: 28px; height: 28px; border-radius: 6px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-size: 22px; color: var(--bg-surface); background: var(--accent); line-height: 1; }
.msg-avatar img { display: block; width: 26px; height: 26px; }
.qa-message.user .msg-avatar { font-size: 11px; background: var(--bg-elevated); color: var(--text-secondary); border: 1px solid var(--border); }
.msg-body { max-width: calc(100% - 38px); min-width: 0; flex: 1; }
.qa-message.user .msg-body { flex: 0 1 auto; max-width: 85%; }
.msg-author { font-size: 11px; font-weight: 600; color: var(--accent); margin: 5px 0 10px; }
.msg-content { font-size: 14px; line-height: 1.9; color: var(--text-primary); overflow-wrap: anywhere; }
.msg-content.is-streaming::after { content: '▍'; margin-left: 2px; color: var(--accent); animation: caret-blink 1s steps(2) infinite; }
@keyframes caret-blink { 50% { opacity: 0; } }
.msg-error { margin-top: 10px; padding: 10px 12px; border: 1px solid var(--danger-dim); border-radius: 8px; background: var(--danger-dim); }
.msg-error-text { font-size: 12px; line-height: 1.7; color: var(--danger); overflow-wrap: anywhere; }
.msg-error-actions { display: flex; gap: 8px; margin-top: 8px; }
.msg-run-status { display: flex; align-items: center; gap: 8px; margin-top: 8px; font-size: 12px; color: var(--text-muted); }
.qa-message.user .msg-content { background: var(--bg-elevated); border: 1px solid var(--border); padding: 11px 15px; border-radius: 10px 3px 10px 10px; font-size: 13px; line-height: 1.8; }
.msg-content :deep(code) {
  background: var(--bg-elevated);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 13px;
}

.msg-content :deep(p) { margin: 0 0 0.75em; }
.msg-content :deep(p:last-child) { margin-bottom: 0; }

.msg-content :deep(h1),
.msg-content :deep(h2),
.msg-content :deep(h3),
.msg-content :deep(h4),
.msg-content :deep(h5),
.msg-content :deep(h6) {
  margin: 1em 0 0.5em;
  color: var(--text-primary);
  line-height: 1.35;
}
.msg-content :deep(h1:first-child),
.msg-content :deep(h2:first-child),
.msg-content :deep(h3:first-child) { margin-top: 0; }
.msg-content :deep(h1) { font-size: 1.35em; }
.msg-content :deep(h2) { font-size: 1.2em; }
.msg-content :deep(h3) { font-size: 1.08em; }

.msg-content :deep(ul),
.msg-content :deep(ol) {
  margin: 0.5em 0 0.75em;
  padding-left: 1.5em;
}
.msg-content :deep(li + li) { margin-top: 0.25em; }
.msg-content :deep(li > p) { margin-bottom: 0.35em; }

.msg-content :deep(blockquote) {
  margin: 0.75em 0;
  padding: 0.25em 0 0.25em 0.9em;
  color: var(--text-secondary);
  border-left: 3px solid var(--accent);
}

.msg-content :deep(pre) {
  margin: 0.75em 0;
  padding: 12px 14px;
  overflow-x: auto;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 7px;
  line-height: 1.5;
}
.msg-content :deep(pre code) {
  padding: 0;
  background: transparent;
  white-space: pre;
}

.msg-content :deep(.katex-display) {
  margin: 0.85em 0;
  padding: 0.2em 0;
  overflow-x: auto;
  overflow-y: hidden;
}

.msg-content :deep(table) {
  display: block;
  width: max-content;
  max-width: 100%;
  margin: 0.75em 0;
  overflow-x: auto;
  border-collapse: collapse;
}
.msg-content :deep(th),
.msg-content :deep(td) {
  padding: 6px 9px;
  border: 1px solid var(--border);
  text-align: left;
}
.msg-content :deep(th) { background: var(--bg-elevated); }

.msg-content :deep(a) {
  color: var(--accent);
  text-decoration: none;
  overflow-wrap: anywhere;
}
.msg-content :deep(a:hover) { text-decoration: underline; }
.msg-content :deep(hr) {
  margin: 1em 0;
  border: 0;
  border-top: 1px solid var(--border);
}


.msg-content :deep(img) { max-width: 100%; height: auto; }
.typing { padding: 10px 0; display: flex; gap: 5px; width: fit-content; }
.typing span { width: 5px; height: 5px; border-radius: 50%; background: var(--accent); opacity: 0.45; animation: pulse 1.3s infinite; }
.typing span:nth-child(2) { animation-delay: 0.2s; }
.typing span:nth-child(3) { animation-delay: 0.4s; }
@keyframes pulse { 0%, 60%, 100% { opacity: 0.3; } 30% { opacity: 1; } }
.composer-wrap { flex-shrink: 0; padding: 0 20px 20px; }
.chat-input-area { position: relative; border: 1px solid var(--border-light); border-radius: 11px; background: var(--bg-surface); box-shadow: var(--shadow-sm); transition: border-color 0.15s, box-shadow 0.15s; }
.chat-input-area:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-dim); }
textarea { display: block; width: 100%; min-height: 76px; max-height: 200px; resize: none; border: 0; outline: 0; box-shadow: none; border-radius: 11px; padding: 15px 15px 8px; background: transparent; color: var(--text-primary); font: 13px/1.8 var(--font-ui); }
textarea::placeholder { color: var(--text-muted); }
textarea:disabled { opacity: .55; }

.qa-header { display: flex; align-items: center; gap: 8px; padding: 12px 20px 4px; flex-shrink: 0; }
.conversation-picker { position: relative; flex: 1; min-width: 0; }
.conversation-picker select { width: 100%; min-height: 24px; padding: 0 24px 0 0; appearance: none; background: transparent; border: 0; outline-color: var(--accent); color: var(--text-secondary); font: 12px var(--font-ui); text-overflow: ellipsis; cursor: pointer; }
.conversation-picker > svg { position: absolute; right: 8px; top: 7px; width: 12px; height: 12px; pointer-events: none; color: var(--text-muted); }
.conversation-picker option { background: var(--bg-surface); color: var(--text-primary); }
.new-button { display: flex; align-items: center; justify-content: center; flex-shrink: 0; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 4px; color: var(--text-muted); background: transparent; cursor: pointer; }
.new-button svg { width: 14px; height: 14px; }
.new-button:hover { background: var(--bg-base); color: var(--accent); }
.page-details { flex-shrink: 0; max-height: 35%; overflow-y: auto; margin: 0 20px; color: var(--text-muted); }
.page-details summary { display: flex; align-items: center; gap: 6px; width: fit-content; padding: 6px 0; font-size: 10px; list-style: none; cursor: pointer; }
.page-details summary::-webkit-details-marker { display: none; }
.page-details summary svg { width: 12px; height: 12px; }
.page-details[open] .details-arrow { transform: rotate(180deg); }
.details-content { padding: 0 0 8px; }
.qa-scroll { display: flex; flex-direction: column; flex: 1; min-height: 0; min-width: 0; overflow-y: auto; overflow-x: hidden; padding: 28px 24px; }
.message-list { display: flex; flex-direction: column; gap: 28px; min-width: 0; }
.plain { white-space: pre-wrap; }
.composer-footer { display: flex; align-items: center; gap: 10px; padding: 0 10px 10px 14px; }
.composer-model { max-width: 42%; }
.input-hint { margin-left: auto; color: var(--text-muted); font-size: 10px; white-space: nowrap; }
.send-button { display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; flex-shrink: 0; padding: 0; border: 0; border-radius: 7px; background: var(--accent); color: var(--bg-surface); cursor: pointer; }
.send-button svg { width: 17px; height: 17px; }
.send-button:disabled { opacity: .45; cursor: default; }
.stop-button { padding: 4px 6px; border: 0; background: transparent; color: var(--accent); font-size: 12px; cursor: pointer; }
.privacy-note { margin: 8px 4px 0; color: var(--text-muted); font-size: 10px; line-height: 1.5; }
.composer-error { margin-bottom: 10px; }
@container (max-width: 480px) {
  .newline-hint { display: none; }
  .composer-model { max-width: 50%; }
}
@media (max-width: 900px) {
  .qa-scroll { padding: 22px 18px; }
  .message-list { gap: 24px; }
  .composer-wrap { padding-left: 14px; padding-right: 14px; }
  .newline-hint { display: none; }
}
</style>
