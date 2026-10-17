import { ref } from 'vue'
import { useChatStore, type LLMProfile } from '../stores/chat'
import type { DbApi } from '../types/ipcContract'
import type { WebQaPageSessionSummary, WebQaSavedSession } from '../types/webQa'
import { buildWebQaMessages } from '../utils/webQaPrompt'

type Completion = (messages: Array<{ role: string; content: string }>, profileId?: string,
  opts?: { signal?: AbortSignal; onToken?: (token: string) => void }) => Promise<{ content: string; truncated: boolean }>

interface WebQaDependencies {
  repository: Pick<DbApi['webQa'], 'listSessions' | 'getSession' | 'getSnapshot' | 'createSession'
    | 'appendTurn' | 'updateMessage' | 'ensureAssistantForLastUser'>
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
  const sessions = ref<WebQaPageSessionSummary[]>([])
  const currentSession = ref<WebQaSavedSession | null>(null)
  const selectedPageId = ref('')
  const selectedSnapshotId = ref('')
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

  function ownsRun(controller: AbortController): boolean { return activeController === controller }
  function active(controller: AbortController): boolean { return ownsRun(controller) && !controller.signal.aborted }

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

  function selectSnapshot(pageId: string, snapshotId: string) {
    detachRun()
    selectionVersion++
    selectedPageId.value = pageId
    selectedSnapshotId.value = snapshotId
    currentSession.value = null
    sessions.value = []
  }

  async function refresh() {
    const pageId = selectedPageId.value
    if (!pageId) { sessions.value = []; return }
    const version = selectionVersion
    const rows = await deps.repository.listSessions(pageId)
    if (version === selectionVersion) sessions.value = rows
  }

  async function load(id: string) {
    detachRun()
    const version = ++selectionVersion
    let detail = await deps.repository.getSession(id)
    if (version !== selectionVersion) return
    if (detail) {
      for (const message of detail.messages.filter(m => m.role === 'assistant' && m.status === 'streaming')) {
        await deps.repository.updateMessage(message.id, { status: 'interrupted', error: '上次生成未完成，请重试。' })
        if (version !== selectionVersion) return
      }
      if (detail.messages.at(-1)?.role === 'user') {
        detail = await deps.repository.ensureAssistantForLastUser(id, globalThis.crypto.randomUUID(), deps.getProfile().id)
      } else {
        detail = await deps.repository.getSession(id)
      }
      if (version !== selectionVersion) return
      if (detail) {
        selectedPageId.value = detail.pageId
        selectedSnapshotId.value = detail.snapshotId
      }
    }
    currentSession.value = detail
    error.value = ''
    streamedText.value = ''
  }

  function newSession() {
    detachRun()
    selectionVersion++
    currentSession.value = null
  }

  async function run(question: string, session: WebQaSavedSession, assistantId: string,
    retrying: boolean, controller: AbortController, profile: LLMProfile): Promise<boolean> {
    let partial = ''
    try {
      if (!active(controller)) throw new Error('已停止生成')
      if (retrying) {
        await deps.repository.updateMessage(assistantId, { content: '', status: 'streaming', error: '', modelId: profile.id })
      }
      if (!active(controller)) throw new Error('已停止生成')
      const snapshot = await deps.repository.getSnapshot(session.snapshotId)
      if (!snapshot) throw new Error('网页快照不存在')
      if (!active(controller)) throw new Error('已停止生成')
      const messages = buildWebQaMessages(snapshot, session.messages, question, profile.systemPrompt)
      const result = await deps.requestCompletion(messages, profile.id, {
        signal: controller.signal,
        onToken: token => {
          if (!active(controller)) return
          partial += token
          if (currentSession.value?.id === session.id) streamedText.value = partial
        },
      })
      if (!active(controller)) throw new Error('已停止生成')
      partial = result.content
      if (result.truncated) throw new Error('回答因模型输出长度限制被截断；请重试上一问，或在设置中提高输出上限。')
      await deps.repository.updateMessage(assistantId, {
        content: result.content, status: 'completed', error: '', modelId: profile.id,
      })
      if (active(controller) && currentSession.value?.id === session.id) {
        const updated = await deps.repository.getSession(session.id).catch(() => null)
        if (active(controller) && currentSession.value?.id === session.id) {
          currentSession.value = updated ?? { ...currentSession.value,
            messages: currentSession.value.messages.map(message => message.id === assistantId
              ? { ...message, content: result.content, status: 'completed' as const, error: '', modelId: profile.id }
              : message) }
        }
      }
      if (active(controller)) await refresh().catch(() => {})
      return active(controller)
    } catch (cause) {
      const cancelled = controller.signal.aborted || !ownsRun(controller)
      const message = cancelled ? '已停止生成' : readableError(cause)
      if (ownsRun(controller)) error.value = message
      await deps.repository.updateMessage(assistantId, {
        content: partial, status: cancelled ? 'cancelled' : 'failed', error: message,
      }).catch(() => {})
      if (ownsRun(controller) && currentSession.value?.id === session.id) {
        currentSession.value = await deps.repository.getSession(session.id).catch(() => session)
      }
      return false
    } finally {
      finishRun(controller)
    }
  }

  async function send(question: string): Promise<boolean> {
    if (busy.value || !question.trim()) return false
    const profile = { ...deps.getProfile() }
    if (!validProfile(profile)) {
      error.value = '请先在设置中配置可用的对话模型。'
      return false
    }
    if (!currentSession.value && !selectedSnapshotId.value) {
      error.value = '请先打开并保存网页。'
      return false
    }
    const content = question.trim()
    const controller = beginRun()
    const questionId = globalThis.crypto.randomUUID()
    const assistantId = globalThis.crypto.randomUUID()
    let saved: WebQaSavedSession
    try {
      const input = { sessionId: currentSession.value?.id ?? globalThis.crypto.randomUUID(),
        questionId, assistantId, question: content, createdAt: Date.now(), modelId: profile.id }
      saved = currentSession.value
        ? await deps.repository.appendTurn(input)
        : await deps.repository.createSession({ ...input, snapshotId: selectedSnapshotId.value })
    } catch (cause) {
      if (ownsRun(controller)) error.value = readableError(cause)
      finishRun(controller)
      return false
    }
    if (!active(controller)) {
      await deps.repository.updateMessage(assistantId, {
        status: 'cancelled', error: '已停止生成',
      }).catch(() => {})
      finishRun(controller)
      return false
    }
    currentSession.value = saved
    await refresh().catch(() => {})
    if (!active(controller)) {
      await deps.repository.updateMessage(assistantId, {
        status: 'cancelled', error: '已停止生成',
      }).catch(() => {})
      finishRun(controller)
      return false
    }
    return run(content, saved, assistantId, false, controller, profile)
  }

  async function retry(): Promise<boolean> {
    const session = currentSession.value
    const profile = { ...deps.getProfile() }
    if (busy.value || !session || !validProfile(profile)) return false
    const messages = session.messages
    const index = messages.findLastIndex(m => m.role === 'assistant'
      && (m.status === 'failed' || m.status === 'cancelled' || m.status === 'interrupted'))
    if (index < 1 || messages[index - 1].role !== 'user') return false
    return run(messages[index - 1].content, session, messages[index].id, true, beginRun(), profile)
  }

  function stop() { activeController?.abort() }

  return { sessions, currentSession, selectedPageId, selectedSnapshotId, busy, error, streamedText,
    selectSnapshot, refresh, load, newSession, send, retry, stop }
}

export function useWebQa() {
  const chatStore = useChatStore()
  return createWebQaController({
    repository: window.db.webQa,
    getProfile: () => chatStore.chatProfile,
    requestCompletion: (messages, profileId, opts) => chatStore.requestCompletion(messages, profileId, opts),
  })
}
