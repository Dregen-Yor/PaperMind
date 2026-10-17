import { ref } from 'vue'
import { useChatStore, type LLMProfile } from '../stores/chat'
import type { DbApi } from '../types/ipcContract'
import type { PreviewApi } from '../types/webPreview'
import type { WebQaMessage, WebQaSessionDetail, WebQaSessionSummary } from '../types/webQa'
import { buildWebQaMessages } from '../utils/webQaPrompt'

type Completion = (messages: Array<{ role: string; content: string }>, profileId?: string,
  opts?: { signal?: AbortSignal; onToken?: (token: string) => void }) => Promise<{ content: string; truncated: boolean }>

interface WebQaDependencies {
  preview: Pick<PreviewApi, 'captureSnapshot'>
  repository: DbApi['webQa']
  getProfile: () => LLMProfile
  requestCompletion: Completion
}

function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/context.{0,30}(length|window)|token.{0,30}(limit|exceed)|maximum context/i.test(message)) {
    return '网页内容超出模型上下文；请换用更长上下文模型，或改用较短页面。'
  }
  return message || '问答失败，请重试。'
}

function validProfile(profile: LLMProfile): boolean {
  return !!profile?.baseUrl?.trim() && !!profile.model?.trim()
    && (profile.provider === 'ollama' || !!profile.apiKey?.trim())
}

export function createWebQaController(deps: WebQaDependencies) {
  const sessions = ref<WebQaSessionSummary[]>([])
  const currentSession = ref<WebQaSessionDetail | null>(null)
  const busy = ref(false)
  const error = ref('')
  const streamedText = ref('')
  let activeController: AbortController | null = null
  let selectionVersion = 0

  function beginRun(): AbortController {
    const controller = new AbortController()
    activeController = controller
    busy.value = true
    streamedText.value = ''
    error.value = ''
    return controller
  }

  function ownsRun(controller: AbortController): boolean {
    return activeController === controller
  }

  function requireActive(controller: AbortController) {
    if (!ownsRun(controller) || controller.signal.aborted) throw new Error('已停止生成')
  }

  function finishRun(controller: AbortController) {
    if (!ownsRun(controller)) return
    activeController = null
    busy.value = false
    streamedText.value = ''
  }

  function detachRun() {
    activeController?.abort()
    activeController = null
    busy.value = false
    streamedText.value = ''
    error.value = ''
  }

  async function refresh() {
    sessions.value = await deps.repository.list()
  }

  async function load(id: string) {
    detachRun()
    const version = ++selectionVersion
    const detail = await deps.repository.get(id)
    if (version !== selectionVersion) return
    if (detail) {
      for (const message of detail.messages.filter(m => m.role === 'assistant' && m.status === 'streaming')) {
        await deps.repository.updateMessage(message.id, { status: 'interrupted', error: '上次生成未完成，请重试。' })
        if (version !== selectionVersion) return
      }
      currentSession.value = await deps.repository.get(id)
      if (version !== selectionVersion) return
    } else {
      currentSession.value = null
    }
    error.value = ''
    streamedText.value = ''
  }

  function newSession() {
    detachRun()
    selectionVersion++
    currentSession.value = null
    streamedText.value = ''
    error.value = ''
  }

  async function run(question: string, session: WebQaSessionDetail, assistantId: string,
    retrying: boolean, controller: AbortController): Promise<boolean> {
    const profile = { ...deps.getProfile() }
    let partial = ''
    try {
      requireActive(controller)
      if (retrying) {
        await deps.repository.updateMessage(assistantId, { content: '', status: 'streaming', error: '', modelId: profile.id })
      } else {
        const assistant: WebQaMessage = {
          id: assistantId, sessionId: session.id, role: 'assistant', content: '', status: 'streaming',
          error: '', modelId: profile.id, createdAt: Date.now(),
        }
        await deps.repository.addMessage(assistant)
      }
      requireActive(controller)
      const pending = await deps.repository.get(session.id)
      requireActive(controller)
      if (pending && currentSession.value?.id === session.id) currentSession.value = pending
      const messages = buildWebQaMessages(session.snapshot, pending?.messages ?? session.messages,
        question, profile.systemPrompt)
      const result = await deps.requestCompletion(messages, profile.id, {
        signal: controller.signal,
        onToken: token => {
          if (controller.signal.aborted) return
          partial += token
          if (ownsRun(controller) && currentSession.value?.id === session.id) streamedText.value = partial
        },
      })
      requireActive(controller)
      partial = result.content
      if (result.truncated) throw new Error('回答因模型输出长度限制被截断；请重试上一问，或在设置中提高输出上限。')
      await deps.repository.updateMessage(assistantId, {
        content: result.content, status: 'completed', error: '', modelId: profile.id,
      })
      if (ownsRun(controller) && currentSession.value?.id === session.id) currentSession.value = await deps.repository.get(session.id)
      if (ownsRun(controller)) await refresh()
      return true
    } catch (cause) {
      const cancelled = controller.signal.aborted
      const message = cancelled ? '已停止生成' : readableError(cause)
      if (ownsRun(controller)) error.value = message
      await deps.repository.updateMessage(assistantId, {
        content: partial, status: cancelled ? 'cancelled' : 'failed', error: message,
      }).catch(() => {})
      if (ownsRun(controller) && currentSession.value?.id === session.id) currentSession.value = await deps.repository.get(session.id)
      return false
    } finally {
      finishRun(controller)
    }
  }

  async function send(question: string): Promise<boolean> {
    if (busy.value || !question.trim()) return false
    error.value = ''
    if (!validProfile(deps.getProfile())) {
      error.value = '请先在设置中配置可用的对话模型。'
      return false
    }
    const content = question.trim()
    let session = currentSession.value
    let createdSessionId: string | null = null
    const controller = beginRun()
    try {
      if (!session) {
        const snapshot = await deps.preview.captureSnapshot()
        requireActive(controller)
        session = await deps.repository.create({
          sessionId: globalThis.crypto.randomUUID(), messageId: globalThis.crypto.randomUUID(),
          snapshot, question: content, createdAt: Date.now(),
        })
        createdSessionId = session.id
        requireActive(controller)
        currentSession.value = session
        await refresh()
        requireActive(controller)
      } else {
        await deps.repository.addMessage({
          id: globalThis.crypto.randomUUID(), sessionId: session.id, role: 'user', content,
          status: 'completed', error: '', modelId: '', createdAt: Date.now(),
        })
        requireActive(controller)
        session = (await deps.repository.get(session.id)) ?? session
        requireActive(controller)
        currentSession.value = session
      }
    } catch (cause) {
      if (createdSessionId) {
        try {
          await deps.repository.remove(createdSessionId)
          if (currentSession.value?.id === createdSessionId) currentSession.value = null
          await refresh()
        } catch { /* Keep the original preparation error for the user. */ }
      }
      if (ownsRun(controller)) error.value = controller.signal.aborted ? '已停止生成' : readableError(cause)
      finishRun(controller)
      return false
    }
    return run(content, session, globalThis.crypto.randomUUID(), false, controller)
  }

  async function retry(): Promise<boolean> {
    if (busy.value || !currentSession.value || !validProfile(deps.getProfile())) return false
    const messages = currentSession.value.messages
    const index = messages.findLastIndex(m => m.role === 'assistant'
      && (m.status === 'failed' || m.status === 'cancelled' || m.status === 'interrupted'))
    if (index < 1 || messages[index - 1].role !== 'user') return false
    return run(messages[index - 1].content, currentSession.value, messages[index].id, true, beginRun())
  }

  function stop() { activeController?.abort() }

  return { sessions, currentSession, busy, error, streamedText, refresh, load, newSession, send, retry, stop }
}

export function useWebQa() {
  const chatStore = useChatStore()
  return createWebQaController({
    preview: window.preview,
    repository: window.db.webQa,
    getProfile: () => chatStore.chatProfile,
    requestCompletion: (messages, profileId, opts) => chatStore.requestCompletion(messages, profileId, opts),
  })
}
