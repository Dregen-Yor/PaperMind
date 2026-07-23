<template>
  <div class="chat-panel">
    <div class="chat-messages" ref="messagesRef" aria-live="polite">
      <div v-if="!conversation || conversation.messages.length === 0" class="chat-empty">
        <div class="empty-visual" aria-hidden="true">
          <el-icon :size="28"><ChatDotRound /></el-icon>
        </div>
        <p>开始对话</p>
        <span>选中论文内容，或直接提问</span>
      </div>

      <div
        v-for="msg in conversation?.messages" :key="msg.id"
        class="message" :class="msg.role"
      >
        <div class="msg-avatar" aria-hidden="true">{{ msg.role === 'user' ? '我' : 'AI' }}</div>
        <div class="msg-body">
          <div class="msg-content" v-html="renderMarkdown(msg.content)" />
          <div v-if="msg.sources?.length" class="msg-sources">
            <el-icon aria-hidden="true"><Link /></el-icon>
            <span v-for="(s, i) in msg.sources" :key="i" class="source-chip">{{ s }}</span>
          </div>
        </div>
      </div>

      <div v-if="loading" class="message assistant">
        <div class="msg-avatar" aria-hidden="true">AI</div>
        <div class="msg-body">
          <div class="typing" aria-label="正在生成回答…">
            <span /><span /><span />
          </div>
        </div>
      </div>
    </div>

    <div v-if="pendingContext.length" class="context-chips">
      <div v-for="(ctx, i) in pendingContext" :key="i" class="context-chip">
        <el-icon aria-hidden="true"><Document /></el-icon>
        <span class="chip-text">{{ ctx.slice(0, 40) }}{{ ctx.length > 40 ? '…' : '' }}</span>
        <button type="button" class="chip-close" aria-label="移除上下文" @click="pendingContext.splice(i, 1)">
          <el-icon><Close /></el-icon>
        </button>
      </div>
    </div>

    <div class="chat-input-area">
      <el-input
        v-model="input"
        type="textarea"
        :rows="2"
        resize="none"
        name="chat-message"
        autocomplete="off"
        placeholder="输入问题，Enter 发送，Shift+Enter 换行…"
        @keydown.enter.exact="handleEnter"
      />
      <el-button
        type="primary"
        :loading="loading"
        :disabled="!input.trim()"
        aria-label="发送消息"
        @click="send"
        class="send-btn"
      >
        <el-icon><Promotion /></el-icon>
      </el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, nextTick, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Link, Document, Close, Promotion, ChatDotRound } from '@element-plus/icons-vue'
import { useChatStore, type Conversation } from '../stores/chat'
import { renderMarkdown } from '../utils/markdown'

const props = defineProps<{ conversation: Conversation | null }>()
const chatStore = useChatStore()

const input = ref('')
const loading = ref(false)
const messagesRef = ref<HTMLElement>()
const pendingContext = ref<string[]>([])

function addContext(text: string) {
  pendingContext.value.push(text)
}
defineExpose({ addContext })

async function scrollToBottom() {
  await nextTick()
  if (messagesRef.value) messagesRef.value.scrollTop = messagesRef.value.scrollHeight
}

watch(() => props.conversation?.messages.length, scrollToBottom)

function handleEnter(event: KeyboardEvent) {
  // Enter confirms the current candidate while an IME is composing. It must
  // not submit the message until composition has finished.
  if (event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  send()
}

async function send() {
  if (!input.value.trim() || !props.conversation) {
    if (!props.conversation) ElMessage.warning('请先选择或创建对话')
    return
  }
  const context = pendingContext.value.join('\n---\n')
  const message = input.value.trim()
  input.value = ''
  pendingContext.value = []
  loading.value = true
  await scrollToBottom()

  try {
    await chatStore.sendMessage(props.conversation.id, message, context || undefined)
  } catch (e: any) {
    ElMessage.error(`请求失败：${e.message}。请检查设置中的 API 配置。`)
  } finally {
    loading.value = false
    await scrollToBottom()
  }
}
</script>

<style scoped>
.chat-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: transparent;
  overflow: hidden;
}

.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 22px 20px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.chat-empty {
  margin: auto;
  text-align: center;
  color: var(--text-muted);
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: center;
}

.empty-visual {
  width: 56px;
  height: 56px;
  border-radius: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 6px;
  color: var(--gold);
  background: var(--gold-dim);
  border: 1px solid color-mix(in srgb, var(--gold) 25%, transparent);
}

.chat-empty p {
  font-size: 15px;
  font-weight: 500;
  color: var(--text-secondary);
}

.chat-empty span { font-size: 13px; }

.message {
  display: flex;
  gap: 10px;
  animation: msg-in 0.22s var(--ease-out);
}

@keyframes msg-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}

.message.user { flex-direction: row-reverse; }

.msg-avatar {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
}

.message.user .msg-avatar {
  background: linear-gradient(145deg, var(--accent-hover), var(--accent));
  color: #0c0e11;
}

.message.assistant .msg-avatar {
  background: var(--gold-dim);
  color: var(--gold);
  border: 1px solid color-mix(in srgb, var(--gold) 22%, transparent);
}

.msg-body {
  max-width: 78%;
  min-width: 0;
}

.msg-content {
  padding: 11px 14px;
  border-radius: 12px;
  font-size: 14px;
  line-height: 1.65;
  background: var(--bg-surface);
  color: var(--text-primary);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-sm);
  overflow-wrap: break-word;
}

.message.user .msg-content {
  background: var(--accent-dim);
  border-color: color-mix(in srgb, var(--accent) 28%, var(--border));
}

.message.assistant .msg-content {
  border-top-left-radius: 4px;
}

.message.user .msg-content {
  border-top-right-radius: 4px;
}

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

.msg-sources {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 6px;
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}

.source-chip {
  background: var(--bg-elevated);
  padding: 2px 7px;
  border-radius: 4px;
  color: var(--text-secondary);
  border: 1px solid var(--border);
}

.typing {
  padding: 14px 16px;
  display: flex;
  gap: 5px;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  border-top-left-radius: 4px;
  width: fit-content;
}

.typing span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--gold);
  opacity: 0.45;
  animation: bounce 1.2s infinite;
}

.typing span:nth-child(2) { animation-delay: 0.2s; }
.typing span:nth-child(3) { animation-delay: 0.4s; }

@keyframes bounce {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.35; }
  30% { transform: translateY(-5px); opacity: 1; }
}

.context-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 16px;
  border-top: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg-surface) 80%, transparent);
}

.context-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  background: var(--gold-dim);
  border: 1px solid color-mix(in srgb, var(--gold) 22%, transparent);
  border-radius: 6px;
  font-size: 12px;
  color: var(--gold);
  max-width: 100%;
}

.chip-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.chip-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  padding: 0;
  border-radius: 4px;
}

.chip-close:hover { color: var(--danger); }

.chat-input-area {
  display: flex;
  gap: 8px;
  padding: 14px 16px;
  border-top: 1px solid var(--border);
  align-items: flex-end;
  background: color-mix(in srgb, var(--bg-surface) 88%, transparent);
}

.send-btn {
  height: 56px;
  width: 48px;
  flex-shrink: 0;
}
</style>
