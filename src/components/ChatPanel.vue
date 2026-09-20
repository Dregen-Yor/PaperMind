<template>
  <div class="chat-panel">
    <div class="chat-messages" ref="messagesRef" aria-live="polite">
      <div v-if="!conversation || conversation.messages.length === 0" class="chat-empty">
        <div class="empty-visual" aria-hidden="true"><el-icon :size="28"><Reading /></el-icon></div>
        <h2 class="font-display">{{ conversation ? '读到这里，想问些什么？' : '与论文展开对话' }}</h2>
        <p>{{ conversation?.paperIds.length ? '从一个问题开始，理解论文背后的思路。\n也可以选中原文，把具体段落带入对话。' : '选择感兴趣的论文，梳理观点、比较方法，\n或从一个研究问题开始探索。' }}</p>
        <div v-if="conversation?.paperIds.length" class="starter-questions">
          <button v-for="starter in starterQuestions" :key="starter.label" type="button" class="starter-question" @click="choosePrompt(starter.question)">
            <span>{{ starter.label }}</span><el-icon aria-hidden="true"><ArrowRight /></el-icon>
          </button>
        </div>
        <el-button v-if="!conversation" class="start-conversation" @click="$emit('create')">开始新对话</el-button>
      </div>

      <div v-for="msg in conversation?.messages" :key="msg.id" class="message" :class="msg.role">
        <div class="msg-avatar" :class="{ 'font-display': msg.role === 'assistant' }" aria-hidden="true">{{ msg.role === 'user' ? '你' : 'P' }}</div>
        <div class="msg-body">
          <div v-if="msg.role === 'assistant'" class="msg-author">PaperMind</div>
          <div v-if="msg.content" class="msg-content" v-html="renderMarkdown(msg.content)" />
          <div v-if="msg.error" class="msg-error" role="alert">
            <div class="msg-error-text">{{ msg.error }}</div>
            <div class="msg-error-actions">
              <el-button size="small" :loading="retrying === msg.id" @click="retry(msg)">重试</el-button>
              <el-button size="small" text @click="router.push('/settings')">打开设置</el-button>
            </div>
          </div>
          <div v-if="msg.truncated && !msg.error" class="msg-truncated">
            <span>回答已达长度上限</span>
            <el-button size="small" text :loading="continuing === msg.id" @click="continueMsg(msg)">继续</el-button>
          </div>
          <div v-if="msg.sources?.length" class="msg-sources">
            <span class="sources-label"><el-icon aria-hidden="true"><Link /></el-icon> 参考来源</span>
            <span v-for="(s, i) in msg.sources" :key="i" class="source-chip">{{ s }}</span>
          </div>
        </div>
      </div>

      <div v-if="loading" class="message assistant">
        <div class="msg-avatar font-display" aria-hidden="true">P</div>
        <div class="msg-body">
          <div class="msg-author">PaperMind</div>
          <div class="typing" role="status" aria-label="正在生成回答"><span /><span /><span /></div>
        </div>
      </div>
    </div>

    <div class="composer-wrap">
      <div class="chat-input-area">
        <div v-if="pendingContext.length" class="context-chips">
          <div v-for="(ctx, i) in pendingContext" :key="i" class="context-chip" :title="ctx">
            <el-icon aria-hidden="true"><Document /></el-icon>
            <span class="chip-text">{{ ctx.slice(0, 60) }}{{ ctx.length > 60 ? '…' : '' }}</span>
            <button type="button" class="chip-close" aria-label="移除上下文" @click="pendingContext.splice(i, 1)"><el-icon><Close /></el-icon></button>
          </div>
        </div>
        <button v-if="showAbstractCommand" type="button" class="command-option" @mousedown.prevent @click="choosePrompt('/abstract')">
          <span class="command-name">/abstract</span>
          <span class="command-desc">总结当前所选论文</span>
        </button>
        <el-input
          ref="inputRef"
          v-model="input"
          type="textarea"
          :autosize="{ minRows: 2, maxRows: 6 }"
          resize="none"
          name="chat-message"
          autocomplete="off"
          :disabled="!conversation"
          :placeholder="conversation ? '围绕论文提问，或输入 / 查看命令…' : '新建对话后，即可在这里提问…'"
          aria-label="输入问题"
          @keydown.enter.exact="handleEnter"
        />
        <div class="composer-footer">
          <span class="composer-model" :title="chatStore.chatProfile?.model"><el-icon aria-hidden="true"><Cpu /></el-icon>{{ chatStore.chatProfile?.name || '对话模型' }}</span>
          <span class="input-hint">Enter 发送<span class="newline-hint">，Shift + Enter 换行</span></span>
          <el-button type="primary" :loading="loading" :disabled="!input.trim() || !conversation" aria-label="发送消息" @click="send" class="send-btn"><el-icon><Top /></el-icon></el-button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Link, Document, Close, Top, Reading, ArrowRight, Cpu } from '@element-plus/icons-vue'
import { useChatStore, type Conversation } from '../stores/chat'
import { renderMarkdown } from '../utils/markdown'

const props = defineProps<{ conversation: Conversation | null }>()
defineEmits<{ (e: 'create'): void }>()
const chatStore = useChatStore()
const router = useRouter()
const retrying = ref('')
const continuing = ref('')

const input = ref('')
const inputRef = ref<{ focus: () => void }>()
const starterQuestions = [
  { label: '概括核心贡献', question: '这篇论文解决了什么问题？请概括它的核心贡献。' },
  { label: '解释研究方法', question: '请解释这篇论文的研究方法，以及方法背后的关键假设。' },
  { label: '分析局限与启发', question: '这篇论文有哪些局限？有哪些值得进一步研究的方向？' },
]

function choosePrompt(question: string) {
  input.value = question
  inputRef.value?.focus()
}
const loading = ref(false)
const messagesRef = ref<HTMLElement>()
const pendingContext = ref<string[]>([])
const showAbstractCommand = computed(() => {
  const value = input.value.trim().toLowerCase()
  return value.startsWith('/') && '/abstract'.startsWith(value) && value !== '/abstract'
})

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

async function retry(msg: { id: string }) {
  if (retrying.value || !props.conversation) return
  retrying.value = msg.id
  try {
    await chatStore.retryMessage(props.conversation.id, msg.id)
  } catch {
    // 失败已由 store 就地改写失败卡（msg.error）；这里只负责收尾
  } finally {
    retrying.value = ''
  }
}

async function continueMsg(msg: { id: string }) {
  if (continuing.value || !props.conversation) return
  continuing.value = msg.id
  try {
    await chatStore.continueMessage(props.conversation.id, msg.id)
  } catch (error) {
    // 续写失败不动原回答，截断条仍在可再点；这里只兜底提示，避免静默失败
    ElMessage.error(error instanceof Error ? error.message : '继续失败，请稍后重试')
  } finally {
    continuing.value = ''
  }
}

async function send() {
  if (loading.value) return
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
    void chatStore.autoTitleConversation(props.conversation.id)
  } catch (error) {
    // 正常失败由 store 落成气泡级失败态（msg.error），卡即反馈；
    // 未落卡（会话不存在 / 用户消息落库失败 / 失败卡自身写库失败）时用 toast 兜底
    const recorded = props.conversation?.messages.some(m => m.role === 'assistant' && m.error)
    if (!recorded) ElMessage.error(error instanceof Error ? error.message : '请求失败，请稍后重试')
  } finally {
    loading.value = false
    await scrollToBottom()
  }
}
</script>

<style scoped>
.chat-panel { display: flex; flex-direction: column; flex: 1; min-height: 0; min-width: 0; overflow: hidden; background: var(--bg-surface); }
.chat-messages { flex: 1; min-height: 0; overflow-y: auto; padding: 28px 24px; display: flex; flex-direction: column; gap: 28px; }
.chat-empty { width: 100%; max-width: 380px; margin: auto; padding: 20px 0; display: flex; flex-direction: column; align-items: center; text-align: center; }
.empty-visual { display: flex; align-items: center; justify-content: center; width: 58px; height: 62px; margin-bottom: 24px; background: var(--bg-elevated); color: var(--accent); border-radius: 5px 10px 10px 5px; box-shadow: inset 3px 0 0 var(--border); }
.chat-empty h2 { font-size: 24px; font-weight: 500; line-height: 1.5; color: var(--text-primary); }
.chat-empty p { margin-top: 12px; font-size: 12px; line-height: 1.95; color: var(--text-muted); white-space: pre-line; }
.starter-questions { display: flex; flex-direction: column; gap: 8px; width: 100%; max-width: 280px; margin-top: 28px; }
.starter-question { display: flex; justify-content: space-between; align-items: center; gap: 16px; border: 1px solid var(--border); background: transparent; border-radius: 7px; padding: 11px 14px; color: var(--text-secondary); text-align: left; font-size: 12px; cursor: pointer; transition: background 0.15s, border-color 0.15s; }
.starter-question > .el-icon { color: var(--text-muted); font-size: 12px; }
.starter-question:hover { border-color: var(--border-light); background: var(--bg-base); color: var(--accent); }
.start-conversation { margin-top: 25px; }
.message { display: flex; gap: 10px; }
.message.user { flex-direction: row-reverse; }
.msg-avatar { width: 28px; height: 28px; border-radius: 6px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-size: 22px; color: var(--bg-surface); background: var(--accent); line-height: 1; }
.message.user .msg-avatar { font-size: 11px; background: var(--bg-elevated); color: var(--text-secondary); border: 1px solid var(--border); }
.msg-body { max-width: calc(100% - 38px); min-width: 0; flex: 1; }
.message.user .msg-body { flex: 0 1 auto; max-width: 85%; }
.msg-author { font-size: 11px; font-weight: 600; color: var(--accent); margin: 5px 0 10px; }
.msg-content { font-size: 14px; line-height: 1.9; color: var(--text-primary); overflow-wrap: anywhere; }
.msg-error { margin-top: 10px; padding: 10px 12px; border: 1px solid var(--danger-dim); border-radius: 8px; background: var(--danger-dim); }
.msg-error-text { font-size: 12px; line-height: 1.7; color: var(--danger); overflow-wrap: anywhere; }
.msg-error-actions { display: flex; gap: 8px; margin-top: 8px; }
.message.user .msg-content { background: var(--bg-elevated); border: 1px solid var(--border); padding: 11px 15px; border-radius: 10px 3px 10px 10px; font-size: 13px; line-height: 1.8; }
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
.msg-sources { font-size: 11px; color: var(--text-muted); margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--border); display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.msg-truncated { display: flex; align-items: center; gap: 8px; margin-top: 8px; font-size: 12px; color: var(--gold); }
.sources-label { display: flex; align-items: center; gap: 4px; margin-right: 4px; }
.source-chip { background: var(--bg-base); padding: 3px 7px; border-radius: 4px; color: var(--text-secondary); border: 1px solid var(--border); overflow-wrap: anywhere; }
.typing { padding: 10px 0; display: flex; gap: 5px; width: fit-content; }
.typing span { width: 5px; height: 5px; border-radius: 50%; background: var(--accent); opacity: 0.45; animation: pulse 1.3s infinite; }
.typing span:nth-child(2) { animation-delay: 0.2s; }
.typing span:nth-child(3) { animation-delay: 0.4s; }
@keyframes pulse { 0%, 60%, 100% { opacity: 0.3; } 30% { opacity: 1; } }
.composer-wrap { flex-shrink: 0; padding: 0 20px 20px; }
.chat-input-area { position: relative; border: 1px solid var(--border-light); border-radius: 11px; background: var(--bg-surface); box-shadow: var(--shadow-sm); transition: border-color 0.15s, box-shadow 0.15s; }
.chat-input-area:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-dim); }
.chat-input-area :deep(.el-textarea__inner) { background: transparent; border: 0; box-shadow: none; padding: 15px 15px 8px; font-size: 13px; line-height: 1.8; }
.chat-input-area :deep(.el-textarea.is-disabled .el-textarea__inner) { background: transparent; }
.context-chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 10px 10px 0; }
.context-chip { display: flex; align-items: center; gap: 6px; padding: 5px 7px; background: var(--gold-dim); border: 1px solid #e2d2ab; border-radius: 5px; font-size: 11px; color: var(--gold); max-width: 100%; }
.chip-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.chip-close { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; flex-shrink: 0; border: 0; background: transparent; color: inherit; cursor: pointer; border-radius: 4px; }
.chip-close:hover { color: var(--danger); }
.composer-footer { display: flex; align-items: center; gap: 10px; padding: 0 10px 10px 14px; }
.composer-model { display: flex; align-items: center; gap: 6px; color: var(--text-secondary); font-size: 10px; max-width: 42%; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.composer-model .el-icon { font-size: 13px; flex-shrink: 0; }
.input-hint { font-size: 10px; color: var(--text-muted); margin-left: auto; white-space: nowrap; }
.send-btn { width: 32px; height: 32px; padding: 0; flex-shrink: 0; border-radius: 7px; }
.send-btn .el-icon { font-size: 17px; }
.command-option { position: absolute; z-index: 2; left: 0; right: 0; bottom: calc(100% + 8px); display: flex; align-items: center; gap: 12px; padding: 12px 14px; border: 1px solid var(--border-light); border-radius: 8px; background: var(--bg-surface); box-shadow: var(--shadow-card); cursor: pointer; text-align: left; }
.command-option:hover { background: var(--bg-elevated); }
.command-name { color: var(--accent); font-weight: 600; font-size: 12px; }
.command-desc { color: var(--text-muted); font-size: 11px; }
@container (max-width: 480px) {
  .newline-hint { display: none; }
  .composer-model { max-width: 50%; }
}
@media (max-width: 900px) {
  .chat-messages { padding: 22px 18px; gap: 24px; }
  .composer-wrap { padding-left: 14px; padding-right: 14px; }
  .newline-hint { display: none; }
}
@media (max-width: 520px) {
  .chat-empty h2 { font-size: 23px; }
  .chat-messages { padding: 20px 16px; }
}
</style>
