import { createEk5Store } from '../utils/ek5/store'
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { extractPages, type IndexNode } from '../utils/pageIndex'
import { runRagPipeline, retrieveRagContext, buildAnswerMessages, type IndexedPaper, type SemanticPaperIndex, type RagPipelineDeps } from '../utils/ragPipeline'
import { buildEvidenceBlocks, hasExactPagePartition, DEFAULT_EVIDENCE_OPTIONS } from '../utils/evidenceBlock'
import type { Embedder } from '../utils/embedder'
import { createTransformersEmbedder } from '../utils/transformersEmbedder'
import {
  buildSemanticTree,
  validateSemanticTree,
  hashTreeSource,
  semanticTreeConfigHash,
  SemanticTreeBuildError,
  SEMANTIC_TREE_SCHEMA_VERSION,
  SEMANTIC_TREE_PROMPT_VERSION,
  DEFAULT_MAX_INPUT_CHARS,
  type SemanticTreeBuildConfig,
} from '../utils/semanticTree'
import type { PaperTreeRecord } from '../types/db'
import type { SourceRef } from '../utils/sourceRef'
import type { ChatRunStatus } from '../types/chatRun'
import type { Message, Conversation } from '../types/chat'
import type { PaperAbstractReport } from '../utils/paperAbstract'
import { DEFAULT_DOCLING_SETTINGS, DOCLING_SETTINGS_KEY, normalizeDoclingSettings, type DoclingSettings } from '../utils/doclingDocument'
import { prepareDoclingPaper } from '../utils/doclingPdf'
import { abstractRunKey, generateDoclingAbstract } from '../utils/doclingAbstract'
import {
  ABSTRACT_MODEL,
} from '../utils/abstractSummarizer'

export interface LLMProfile {
  id: string
  name: string
  provider: 'openai' | 'anthropic' | 'ollama'
  model: string
  apiKey: string
  baseUrl: string
  temperature: number
  /** 回答输出上限；0 = 不限制（不向上游发送该参数，由模型自身决定） */
  maxTokens: number
  topK: number        // 0 = 不限制
  systemPrompt: string
}

export type { Message, Conversation } from '../types/chat'

interface ActiveChatRun {
  id: string
  conversationId: string
  assistant: Message
  controller: AbortController
  requestedStop: boolean
  replacing: boolean
  flushTimer?: ReturnType<typeof setTimeout>
  lastSavedContent: string
  writes: Promise<void>
  writeError?: unknown
}

interface AbstractResume {
  kind: 'docling-abstract'
  paperIds: string[]
  index: number
  previous: string
}
function readAbstractResume(context?: string): AbstractResume | undefined {
  try {
    const state = JSON.parse(context || '')
    if (state?.kind === 'docling-abstract' && Array.isArray(state.paperIds) && state.paperIds.length
      && state.paperIds.every((id: unknown) => typeof id === 'string' && id.length > 0)
      && Number.isInteger(state.index) && state.index >= 0 && state.index < state.paperIds.length
      && typeof state.previous === 'string') return state
  } catch { /* Older messages do not have continuation metadata. */ }
}

/** 单次 LLM 请求上限：超时即失败，避免无声挂死（#2）。 */
const LLM_REQUEST_TIMEOUT_MS = 120_000

class RunCancelledError extends Error {
  constructor() {
    super('已停止生成')
    this.name = 'RunCancelledError'
  }
}

function throwIfCancelled(signal: AbortSignal) {
  if (signal.aborted) throw new RunCancelledError()
}

async function awaitOrCancel<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfCancelled(signal)
  let onAbort: () => void = () => {}
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new RunCancelledError())
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try { return await Promise.race([work, cancelled]) }
  finally { signal.removeEventListener('abort', onAbort) }
}

/** 输出上限的「不限制」哨兵：0 表示不向上游发送该参数。 */
export const UNLIMITED_MAX_TOKENS = 0

/**
 * 「不限制」时 Anthropic 的兜底上限。Messages API 的 `max_tokens` 是**必填**字段，
 * 不能像 OpenAI 兼容端点与 Ollama 那样直接省略；8192 是 Claude 3.5 一代起所有模型
 * 都接受的值（更早的 claude-3-haiku / claude-3-opus 上限 4096，会被 API 拒绝）。
 * 同时用作设置页把「不限制」关回去时的起点值。
 */
export const CAPPED_MAX_TOKENS_DEFAULT = 8192

/** 老一代 Claude（claude-3-opus / claude-3-haiku / claude-2.x）的输出上限。 */
export const ANTHROPIC_LEGACY_MAX_TOKENS = 4096

/**
 * 设置页滑块的量程上限。默认不限制，但显式设上限时不该被 8192 卡住——
 * 现代模型的输出上限动辄 32k 起。
 */
export const MAX_TOKENS_LIMIT = 32768

/**
 * 已探明的 Anthropic 模型上限（key = `baseUrl|model`）。老模型只接受 4096，
 * 撞一次 400 就记下来，后续调用直接按它发送，不必每次提问都失败重试一轮。
 */
const anthropicTokenCeilings = new Map<string, number>()

/** 旧版本的出厂输出上限：升级时按「从未显式设置」处理，迁到不限制。 */
const LEGACY_DEFAULT_MAX_TOKENS = 4096
/** 一次性迁移标记：迁过之后用户再显式设回 4096 也不会被下次启动抹掉。 */
const MAX_TOKENS_MIGRATED_KEY = 'llm_max_tokens_unlimited_migrated'

const DEFAULT_PROFILE: LLMProfile = {
  id: 'default',
  name: '默认配置',
  provider: 'openai',
  model: 'gpt-4o',
  apiKey: '',
  baseUrl: 'https://api.openai.com/v1',
  temperature: 0.7,
  maxTokens: UNLIMITED_MAX_TOKENS,
  topK: 0,
  systemPrompt: '你是一个专业的学术论文阅读助手，帮助用户理解和分析论文内容。',
}

/**
 * 合法化输出上限：缺失、非数字、`≤0` 一律视为「不限制」，小数向下取整。
 * 备份导入（`data:import`）进来的 settings 不受设置页滑块约束，发送前仍需过一遍，
 * 否则一个 `maxTokens: 0.5` 会变成上游 400。
 */
function normalizeMaxTokens(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return UNLIMITED_MAX_TOKENS
  return Math.floor(value)
}

/**
 * 升级迁移：上限语义从「恒有上限」变成「0 = 不限制」之后，旧版本写盘的 4096
 * 是当时的**出厂值**而非用户选择，按「从未设置」迁到不限制。
 * 只在带迁移标记的首次启动里调用——否则用户之后显式设的 4096 会被反复抹掉。
 */
function migrateMaxTokens(value: unknown): number {
  const normalized = normalizeMaxTokens(value)
  return normalized === LEGACY_DEFAULT_MAX_TOKENS ? UNLIMITED_MAX_TOKENS : normalized
}

/**
 * OpenAI 兼容端点里「与模型代次有关」的采样参数。o 系与 gpt-5 起改用
 * `max_completion_tokens`（老字段被直接拒绝），并且不接受非默认的 `temperature`
 * ——只发上限不发温度，等于还是每次都被拒。其余模型（含第三方兼容端点）维持原样。
 * 模型名是自由文本，这里按最保守的前缀判断（顺带剥掉 `openai/` 这类厂商前缀）。
 */
function generationParams(model: string, maxTokens: number, temperature: number): Record<string, number> {
  const bare = model.trim().split('/').pop() ?? ''
  if (/^(o[1-9]|gpt-[5-9])/i.test(bare)) {
    return maxTokens > 0 ? { max_completion_tokens: maxTokens } : {}
  }
  return { temperature, ...(maxTokens > 0 ? { max_tokens: maxTokens } : {}) }
}

/** 单篇建树结果：失败必须带可展示的原因（#13）。 */
export interface TreeBuildOutcome {
  ok: boolean
  reason?: string
}

/** 索引构建选项。导入路径与提问路径共用 `indexPaper`，差别只在等不等得到后台阶段。 */
/** Kept for callers compiled against the old store API; E-k5 always waits for a complete index. */
export interface IndexPaperOptions {
  /** @deprecated E-k5 has no partial lexical stage. */
  syncStage1Only?: boolean
}

/** 强制重建的结果摘要。分开计数是为了不让「全部失败」在 UI 上退化成「没有论文」。 */
export interface TreeRebuildSummary {
  /** 真正尝试建树的篇数（不含跳过） */
  attempted: number
  rebuilt: number
  failed: number
  /** 总开关关闭，或该篇已在建树中 */
  skipped: number
  /** 首个失败原因（人类可读），供设置页展示（#13） */
  firstReason?: string
}

const NEW_CONVERSATION_TITLE = '新对话'
const LEGACY_CONVERSATION_TITLE = /^对话\s+\d+$/
/**
 * 语义树开关的持久化键。语义树自方案 §6.3 起**默认关闭**（退出默认检索路径）：
 * 只有显式存过「开」才开启；设置页开关与建树代码保留，是否删除另议。
 */
const TREE_ENABLED_KEY = 'semantic_tree_enabled'

function isUntitledConversation(title: string): boolean {
  return title === NEW_CONVERSATION_TITLE || LEGACY_CONVERSATION_TITLE.test(title)
}

function normalizeConversationTitle(value: string): string {
  return value
    .trim()
    .replace(/^标题\s*[:：]\s*/i, '')
    .replace(/^[『「“'\"]+|[』」”'\"]+$/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 24)
    .trim()
}

async function readErrorBody(res: Response): Promise<string> {
  try {
    const data = await res.json()
    const err = data?.error
    if (typeof err === 'string' && err) return err
    if (err && typeof err === 'object' && typeof err.message === 'string') return err.message
    if (typeof data?.message === 'string' && data.message) return data.message
    if (typeof data?.detail === 'string' && data.detail) return data.detail
  } catch { /* fall through to status text */ }
  return `${res.status} ${res.statusText}`.trim()
}

/**
 * 带超时的 fetch。`AbortSignal.timeout` 触发时抛出的是英文 DOMException，
 * 原样落进失败轮的 `error` 会中英混杂，这里统一映射为中文提示（#2）。
 */
async function requestWithTimeout(url: string, init: RequestInit, timeoutMs: number, userSignal?: AbortSignal): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const signal = userSignal ? AbortSignal.any([timeoutSignal, userSignal]) : timeoutSignal
  try {
    return await fetch(url, { ...init, signal })
  } catch (error) {
    if (userSignal?.aborted) throw error
    if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new Error('请求超时，请检查网络后重试')
    }
    throw error
  }
}

function cancelStreamOnAbort(reader: ReadableStreamDefaultReader<Uint8Array>, signal?: AbortSignal): () => void {
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) cancel()
  return () => signal?.removeEventListener('abort', cancel)
}

const PROMPT_TEMPLATES = [
  { name: '逐段精读', prompt: '请逐段解析以下内容，解释关键概念、方法和结论。' },
  { name: '通俗解释', prompt: '请用通俗易懂的语言解释这段内容，假设我是该领域的初学者。' },
  { name: '提取要点', prompt: '请提取这段内容的核心要点，以列表形式呈现。' },
  { name: '批判性分析', prompt: '请批判性地分析这段内容的论证逻辑、潜在缺陷和未解决的问题。' },
  { name: '翻译为中文', prompt: '请将这段内容准确翻译为中文，保留专业术语。' },
]

export { PROMPT_TEMPLATES }

/** 流式请求整体上限（#6）：流式回答比非流式长，给更宽的预算。 */
const LLM_STREAM_TIMEOUT_MS = 300_000

/** 解析 OpenAI 兼容 SSE 流：增量回调 + 末尾 finish_reason（#6）。 */
async function readOpenAiStream(res: Response, onToken: (token: string) => void, signal?: AbortSignal): Promise<{ content: string; truncated: boolean }> {
  if (!res.body) throw new Error('流式响应不可用')
  const reader = res.body.getReader()
  const stopObserving = cancelStreamOnAbort(reader, signal)
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let truncated = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      signal?.throwIfAborted()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        let parsed: any
        try { parsed = JSON.parse(payload) } catch { continue }
        const delta = parsed.choices?.[0]?.delta?.content
        if (typeof delta === 'string' && delta) { content += delta; onToken(delta) }
        if (parsed.choices?.[0]?.finish_reason === 'length') truncated = true
      }
    }
  } finally { stopObserving() }
  signal?.throwIfAborted()
  if (!content.trim()) throw new Error('模型返回了空响应')
  return { content, truncated }
}

/** 解析 Anthropic SSE 流（content_block_delta / message_delta）（#6）。 */
async function readAnthropicStream(res: Response, onToken: (token: string) => void, signal?: AbortSignal): Promise<{ content: string; truncated: boolean }> {
  if (!res.body) throw new Error('流式响应不可用')
  const reader = res.body.getReader()
  const stopObserving = cancelStreamOnAbort(reader, signal)
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let truncated = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      signal?.throwIfAborted()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        let parsed: any
        try { parsed = JSON.parse(trimmed.slice(5).trim()) } catch { continue }
        if (parsed.type === 'content_block_delta' && typeof parsed.delta?.text === 'string') {
          content += parsed.delta.text
          onToken(parsed.delta.text)
        }
        if (parsed.type === 'message_delta' && parsed.delta?.stop_reason === 'max_tokens') truncated = true
      }
    }
  } finally { stopObserving() }
  signal?.throwIfAborted()
  if (!content.trim()) throw new Error('模型返回了空响应')
  return { content, truncated }
}

/** 解析 Ollama NDJSON 流（#6）。 */
async function readOllamaStream(res: Response, onToken: (token: string) => void, signal?: AbortSignal): Promise<{ content: string; truncated: boolean }> {
  if (!res.body) throw new Error('流式响应不可用')
  const reader = res.body.getReader()
  const stopObserving = cancelStreamOnAbort(reader, signal)
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let truncated = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      signal?.throwIfAborted()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        let parsed: any
        try { parsed = JSON.parse(trimmed) } catch { continue }
        if (typeof parsed.message?.content === 'string' && parsed.message.content) {
          content += parsed.message.content
          onToken(parsed.message.content)
        }
        if (parsed.done && parsed.done_reason === 'length') truncated = true
      }
    }
  } finally { stopObserving() }
  signal?.throwIfAborted()
  if (!content.trim()) throw new Error('模型返回了空响应')
  return { content, truncated }
}

/** 本地推理端点通常不需要 API Key（LM Studio / vLLM / llama.cpp 等）。 */
function isLocalEndpoint(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1'
  } catch {
    return false
  }
}

/** 建树失败原因分类（#13）。 */
function treeFailureReason(error: unknown): string {
  if (error instanceof SemanticTreeBuildError) {
    switch (error.reason) {
      case 'no-evidence': return '没有可用的原文证据块'
      case 'input-too-large': return '论文过长，超出单次建树输入上限'
      case 'llm-failed': return `请求失败：${error.message.slice(0, 80)}`
      default: return `输出不合规：${error.message.slice(0, 80)}`
    }
  }
  return error instanceof Error ? `未知错误：${error.message.slice(0, 80)}` : '未知错误'
}

export const useChatStore = defineStore('chat', () => {
  const conversations = ref<Conversation[]>([])
  const profiles = ref<LLMProfile[]>([{ ...DEFAULT_PROFILE }])
  const chatProfileId = ref<string>('default')
  const indexProfileId = ref<string>('default')
  const loaded = ref(false)
  const indexingPapers = ref<Set<string>>(new Set())
  const indexedPapers = ref<Set<string>>(new Set())
  const abstractToken = ref('')
  const doclingConfig = ref<DoclingSettings>({ ...DEFAULT_DOCLING_SETTINGS })
  const doclingConfigError = ref('')
  const abstractProgress = ref<Record<string, string>>({})
  const paperAbstractJobs = new Map<string, Promise<PaperAbstractReport>>()
  const activeChatRuns = new Map<string, ActiveChatRun>()
  const startingChatRuns = new Set<string>()
  /**
   * 轻量语义树总开关；默认关闭（方案 §6.3：语义树退出默认检索路径）。
   * 仅保留旧数据维护 API，不参与产品检索，设置页不再提供开关。
   */
  const treeEnabled = ref(false)
  /** 已有可用语义树的论文 */
  const treeReadyPapers = ref<Set<string>>(new Set())
  /** 正在后台建树的论文 */
  const treeIndexingPapers = ref<Set<string>>(new Set())
  /**
   * 每篇论文的建树代次。后台任务在写入前比对代次，
   * 代次已变（被取消或重新建树）即丢弃结果，不写入过期语义树。
   */
  const treeBuildTokens = new Map<string, number>()
  /** 就绪集合刷新的代次；并发刷新时只让最新一次的结果落地 */
  let treeReadyToken = 0

  const chatProfile = computed(() =>
    profiles.value.find(p => p.id === chatProfileId.value) ?? profiles.value[0],
  )
  const indexProfile = computed(() =>
    profiles.value.find(p => p.id === indexProfileId.value) ?? profiles.value[0],
  )

  // Electron IPC uses structured clone and cannot serialize Vue reactive proxies.
  // Copy the array and every profile into plain objects before crossing the bridge.
  async function persistProfiles() {
    const plainProfiles = profiles.value.map(profile => ({ ...profile }))
    await window.db.settings.set('llm_profiles', plainProfiles)
  }

  async function init() {
    if (loaded.value) return
    conversations.value = await window.db.chat.listConversations()
    // 清理历史遗留的 0 消息对话（#15）：启动时不会有正在进行的空会话
    const emptyConversations = conversations.value.filter(c => c.messages.length === 0)
    for (const conv of emptyConversations) {
      await window.db.chat.removeConversation(conv.id)
    }
    conversations.value = conversations.value.filter(c => c.messages.length > 0)

    // 加载配置列表。
    // 首次启动要做「4096 → 不限制」的一次性迁移：旧记录里的 4096 是当时的出厂值
    // （也可能是根本没有这个字段的旧记录），不是用户选择。只有真的改了值才回写，
    // 避免每次启动都无条件写一遍 settings。
    const tokensMigrated = (await window.db.settings.get(MAX_TOKENS_MIGRATED_KEY)) === true
    const normalizeTokens = tokensMigrated ? normalizeMaxTokens : migrateMaxTokens
    const savedProfiles = await window.db.settings.get('llm_profiles')
    if (savedProfiles && Array.isArray(savedProfiles) && savedProfiles.length > 0) {
      profiles.value = savedProfiles
      if (profiles.value.some(p => p.maxTokens !== normalizeTokens(p.maxTokens))) {
        profiles.value = profiles.value.map(p => ({ ...p, maxTokens: normalizeTokens(p.maxTokens) }))
        await persistProfiles()
      }
    } else {
      // 迁移旧版单一 llm_config（首次升级时）
      const oldConfig = await window.db.settings.get('llm_config')
      if (oldConfig) {
        profiles.value = [{
          id: crypto.randomUUID(),
          name: '默认配置',
          topK: 0,
          ...oldConfig,
          maxTokens: normalizeTokens(oldConfig.maxTokens),
        }]
      }
      // 无论是迁移还是全新安装，都将当前 profiles 写入磁盘，确保下次启动可恢复
      await persistProfiles()
    }
    // 标记必须在配置落盘之后写：中途失败时下次启动仍会重跑迁移，不会漏掉用户
    if (!tokensMigrated) await window.db.settings.set(MAX_TOKENS_MIGRATED_KEY, true)

    const savedChatId = await window.db.settings.get('llm_profile_chat')
    if (savedChatId && profiles.value.some(p => p.id === savedChatId)) {
      chatProfileId.value = savedChatId
    } else {
      chatProfileId.value = profiles.value[0].id
    }

    const savedIndexId = await window.db.settings.get('llm_profile_index')
    if (savedIndexId && profiles.value.some(p => p.id === savedIndexId)) {
      indexProfileId.value = savedIndexId
    } else {
      indexProfileId.value = profiles.value[0].id
    }

    const ids = await window.db.index.list()
    const currentIds: string[] = []
    for (const id of ids) {
      try {
        const record = await window.db.index.get(id)
        if (record && JSON.parse(record.indexJson).version === 'ek5-product-v1') currentIds.push(id)
      } catch { /* Legacy or damaged indexes are rebuilt on first use. */ }
    }
    indexedPapers.value = new Set(currentIds)
    abstractToken.value = (await window.db.settings.get('huggingface_token')) ?? ''
    try { doclingConfig.value = normalizeDoclingSettings(await window.db.settings.get(DOCLING_SETTINGS_KEY)) }
    catch (error) { doclingConfigError.value = error instanceof Error ? error.message : 'Docling 配置无效' }
    // 语义树默认关闭（方案 §6.3）：只有显式存过「开」才开启，未存过一律保持关闭。
    // 值经 IPC 边界 JSON 往返（settings.get 是 JSON.parse(row.value)），设置页写入的是
    // 布尔、历史或外部来源可能是字符串，两种编码都认——只认其中一种会把用户的开启吞掉
    const storedTreeEnabled = await window.db.settings.get(TREE_ENABLED_KEY)
    if (storedTreeEnabled !== undefined) {
      treeEnabled.value = storedTreeEnabled === true || storedTreeEnabled === 'true'
    }
    // 只把「当前构建配置下能直接复用」的记录算作已就绪：模型或提示词换过之后
    // 仍留在集合里，UI 会谎报可用树的篇数（真正的校验在 parseTreeRecord）
    await refreshTreeReadyPapers()
    const contextChars = await window.db.settings.get('ek5_context_chars')
    if (typeof contextChars === 'number' && Number.isInteger(contextChars) && contextChars >= 4000 && contextChars <= 1_000_000) retrievalContextChars.value = contextChars
    loaded.value = true
    // 向量模型在启动时就点火下载（不阻塞启动）：等第一次导入才下载等于让首个用户白等一轮
    void ensureEmbedder()
  }

  // ---------- Profile CRUD ----------

  async function addProfile(profile: Omit<LLMProfile, 'id'>): Promise<LLMProfile> {
    const newProfile: LLMProfile = { ...profile, id: crypto.randomUUID() }
    profiles.value.push(newProfile)
    await persistProfiles()
    return newProfile
  }

  /**
   * 能改变建树指纹的字段（`modelIdentity` 的三要素）。改这些之外的东西
   * （温度、输出上限、名称…）不会让任何一棵树失效，不必重查树表。
   */
  const TREE_CONFIG_PATCH_KEYS = ['provider', 'model', 'baseUrl'] as const

  async function updateProfile(id: string, patch: Partial<Omit<LLMProfile, 'id'>>) {
    const idx = profiles.value.findIndex(p => p.id === id)
    if (idx === -1) return
    profiles.value[idx] = { ...profiles.value[idx], ...patch }
    await persistProfiles()
    // 仅刷新旧语义树维护状态；E-k5 索引与聊天 LLM 配置无关。
    if (id === indexProfileId.value && TREE_CONFIG_PATCH_KEYS.some(key => key in patch)) {
      await refreshTreeReadyPapers()
    }
  }

  async function removeProfile(id: string) {
    if (profiles.value.length <= 1) return  // 至少保留一个
    profiles.value = profiles.value.filter(p => p.id !== id)
    // 若删除的是当前选中项，自动切换到第一个
    if (chatProfileId.value === id) await setChatProfileId(profiles.value[0].id)
    if (indexProfileId.value === id) await setIndexProfileId(profiles.value[0].id)
    await persistProfiles()
  }

  async function setChatProfileId(id: string) {
    chatProfileId.value = id
    await window.db.settings.set('llm_profile_chat', id)
  }

  async function setIndexProfileId(id: string) {
    indexProfileId.value = id
    await window.db.settings.set('llm_profile_index', id)
    // 保留旧配置兼容接口，不重建 E-k5 索引。
    await refreshTreeReadyPapers()
  }

  async function setDoclingConfig(value: DoclingSettings) {
    const config = normalizeDoclingSettings(value)
    await window.db.settings.set(DOCLING_SETTINGS_KEY, { ...config })
    doclingConfig.value = config
    doclingConfigError.value = ''
  }

  async function setAbstractToken(token: string) {
    abstractToken.value = token.trim()
    await window.db.settings.set('huggingface_token', abstractToken.value)
  }

  async function setTreeEnabled(enabled: boolean) {
    treeEnabled.value = enabled
    await window.db.settings.set(TREE_ENABLED_KEY, enabled)
  }

  // ---------- LLM Call ----------

  /**
   * 解析本次调用用哪份配置。
   * 接受 profile 对象而不只是 id：建树这类含 await 的长流程需要「开始时的快照」，
   * 否则中途切换配置会让请求体里的模型与落库元数据对不上。
   */
  function resolveLlmProfile(target?: string | LLMProfile): LLMProfile {
    if (target && typeof target !== 'string') return target
    return (target ? profiles.value.find(p => p.id === target) : undefined) ?? chatProfile.value
  }

  /**
   * 单次对话补全的底层请求：记录 finish_reason 供截断提示使用（#3）。
   *
   * `opts` 供后续流式输出使用（#6），本任务先保留形参。
   */
  async function requestCompletionRaw(
    messages: { role: string; content: string }[],
    profileOrId?: string | LLMProfile,
    opts: { onToken?: (token: string) => void; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<{ content: string; truncated: boolean }> {
    const profile = resolveLlmProfile(profileOrId)
    // 落库值可能是备份导入进来的任意数字，发送前统一合法化（0 = 不限制）
    const maxTokens = normalizeMaxTokens(profile.maxTokens)

    if (profile.provider === 'ollama') {
      const body: Record<string, unknown> = { model: profile.model, messages, stream: !!opts.onToken }
      // Ollama 用 `num_predict` 表达输出上限；不限制时整个 options 都不出现
      const options: Record<string, number> = {}
      if (profile.topK > 0) options.top_k = profile.topK
      if (maxTokens > 0) options.num_predict = maxTokens
      if (Object.keys(options).length > 0) body.options = options
      const res = await requestWithTimeout(`${profile.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, opts.timeoutMs ?? (opts.onToken ? LLM_STREAM_TIMEOUT_MS : LLM_REQUEST_TIMEOUT_MS), opts.signal)
      if (!res.ok) throw new Error(`LLM 请求失败 (${res.status})：${await readErrorBody(res)}`)
      if (opts.onToken) return readOllamaStream(res, opts.onToken, opts.signal)
      const data = await res.json()
      if (typeof data.message?.content !== 'string' || !data.message.content.trim()) throw new Error('模型返回了空响应')
      return { content: data.message.content, truncated: data.done_reason === 'length' }
    }

    if (profile.provider === 'anthropic') {
      const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n')
      const chatMessages = messages
        .filter(m => m.role !== 'system')
        .map(m => ({ role: m.role, content: m.content }))
      while (chatMessages.length > 0 && chatMessages[0].role === 'assistant') chatMessages.shift()

      const body: Record<string, unknown> = {
        model: profile.model,
        // 必填字段，占位值在下面的循环里覆盖（不限制时退到兜底上限，不能省略）
        max_tokens: CAPPED_MAX_TOKENS_DEFAULT,
        messages: chatMessages,
        temperature: Math.min(profile.temperature, 1),
      }
      if (system) body.system = system
      if (profile.topK > 0) body.top_k = profile.topK
      if (opts.onToken) body.stream = true

      const ceilingKey = `${profile.baseUrl}|${profile.model}`
      let requested = maxTokens > 0
        ? maxTokens
        : anthropicTokenCeilings.get(ceilingKey) ?? CAPPED_MAX_TOKENS_DEFAULT
      let res: Response
      for (;;) {
        body.max_tokens = requested
        res = await requestWithTimeout(`${profile.baseUrl}/v1/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': profile.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(body),
        }, opts.timeoutMs ?? (opts.onToken ? LLM_STREAM_TIMEOUT_MS : LLM_REQUEST_TIMEOUT_MS), opts.signal)
        if (res.ok) break
        const detail = await readErrorBody(res)
        // 兜底上限被模型上限拒掉时降级重试：老 Claude（claude-3-opus / haiku）只接受 4096，
        // 而「不限制」的用户并不会在意 8192 与 4096 的差别，报错卡才是真问题。
        // 只在自动兜底路径上降级——用户显式设的上限照旧原样报错，不替他改配置。
        const downgradable = maxTokens === UNLIMITED_MAX_TOKENS
          && res.status === 400
          && requested > ANTHROPIC_LEGACY_MAX_TOKENS
          && /max_?tokens?/i.test(detail)
        if (!downgradable) throw new Error(`LLM 请求失败 (${res.status})：${detail}`)
        requested = ANTHROPIC_LEGACY_MAX_TOKENS
        anthropicTokenCeilings.set(ceilingKey, ANTHROPIC_LEGACY_MAX_TOKENS)
      }
      if (opts.onToken) return readAnthropicStream(res, opts.onToken, opts.signal)
      const data = await res.json()
      const content = data.content?.[0]?.text
      if (typeof content !== 'string' || !content.trim()) throw new Error('模型返回了空响应')
      return { content, truncated: data.stop_reason === 'max_tokens' }
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${profile.apiKey}`,
    }
    const body: Record<string, unknown> = {
      model: profile.model,
      messages,
      // 温度与输出上限按模型代次决定发不发、发哪个字段名（见 generationParams）
      ...generationParams(profile.model, maxTokens, profile.temperature),
      ...(opts.onToken ? { stream: true } : {}),
    }

    const res = await requestWithTimeout(`${profile.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }, opts.timeoutMs ?? (opts.onToken ? LLM_STREAM_TIMEOUT_MS : LLM_REQUEST_TIMEOUT_MS), opts.signal)
    if (!res.ok) throw new Error(`LLM 请求失败 (${res.status})：${await readErrorBody(res)}`)
    if (opts.onToken) return readOpenAiStream(res, opts.onToken, opts.signal)
    const data = await res.json()
    const content = data.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) throw new Error('模型返回了空响应')
    return { content, truncated: data.choices?.[0]?.finish_reason === 'length' }
  }

  async function requestCompletion(
    messages: { role: string; content: string }[],
    profileOrId?: string | LLMProfile,
    opts: { onToken?: (token: string) => void; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<{ content: string; truncated: boolean }> {
    try {
      const result = await requestCompletionRaw(messages, profileOrId, opts)
      if (opts.signal?.aborted) throw new RunCancelledError()
      return result
    }
    catch (error) {
      if (opts.signal?.aborted) throw new RunCancelledError()
      const message = error instanceof Error ? error.message : String(error)
      const name = error instanceof Error ? error.name : ''
      if (name === 'AbortError' || name === 'TimeoutError' || /The user aborted a request/i.test(message)) {
        throw new Error('请求超时，请检查网络后重试')
      }
      throw error
    }
  }

  /** 只要文本的调用路径（索引、标题、查询改写等）继续走这个薄包装。 */
  async function callLLM(
    messages: { role: string; content: string }[],
    profileOrId?: string | LLMProfile,
    signal?: AbortSignal,
  ): Promise<string> {
    return (await requestCompletion(messages, profileOrId, { signal })).content
  }

  // ---------- E-k5 model and indexes ----------

  /** E-k5 必须具备向量模型；模型失败时保留问题并提示重试。 */
  const vectorModelState = ref<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  let embedderInstance: Embedder | undefined
  let embedderPromise: Promise<Embedder | undefined> | undefined

  /** 启动预加载；论文提问与索引构建会等待同一个模型实例。 */
  async function currentEmbedder(): Promise<Embedder | undefined> {
    if (embedderInstance) return embedderInstance
    embedderPromise ??= loadEmbedder()
    return embedderPromise
  }

  async function loadEmbedder(): Promise<Embedder | undefined> {
    vectorModelState.value = 'loading'
    try {
      embedderInstance = await createTransformersEmbedder({ wasmPaths: new URL('./ort/', window.location.href).href })
      vectorModelState.value = 'ready'
      // E-k5 indexes are built lazily with the loaded model.
      return embedderInstance
    } catch {
      // 不提供词法降级；下次提问或手动重建时可以重试下载。
      vectorModelState.value = 'failed'
      embedderPromise = undefined
      return undefined
    }
  }

  /** 启动时预加载模型，不阻塞应用界面。 */
  function ensureEmbedder(): Promise<Embedder | undefined> {
    return currentEmbedder()
  }

  /** 复用 RAG 的模型注入接口；collectIndexedPapers 已等待模型就绪。 */
  function passageDeps(): RagPipelineDeps {
    return embedderInstance
      ? { passage: { embedder: embedderInstance } }
      : {}
  }

  /** E-k5 服务合并同篇并发构建，并在完整索引就绪后原子替换旧记录。 */
  const ek5Store = createEk5Store(currentEmbedder)
  const retrievalContextChars = ref(120_000)
  async function setRetrievalContextChars(value: number) {
    if (!Number.isInteger(value) || value < 4000 || value > 1_000_000) throw new Error('参考内容上限应为 4,000–1,000,000 字符')
    await window.db.settings.set('ek5_context_chars', value)
    retrievalContextChars.value = value
  }
  async function indexPaper(paperId: string, _opts: IndexPaperOptions = {}): Promise<void> {
    indexingPapers.value.add(paperId)
    try {
      await ek5Store.load(paperId)
      indexedPapers.value.add(paperId)
    } finally { indexingPapers.value.delete(paperId) }
  }
  async function rebuildEk5Indexes() {
    let rebuilt = 0
    const errors: string[] = []
    for (const paper of await window.db.paper.list()) {
      indexingPapers.value.add(paper.id)
      try { await ek5Store.load(paper.id, true); indexedPapers.value.add(paper.id); rebuilt++ }
      catch (e) { errors.push(`${paper.title}: ${errorMessageOf(e)}`) }
      finally { indexingPapers.value.delete(paper.id) }
    }
    return { rebuilt, errors }
  }

  // ---------- Semantic Tree (Stage C) ----------

  /**
   * 建树配置（§10.3）。指纹与实际传给 buildEvidenceBlocks / buildSemanticTree 的
   * 参数取自同一个对象，避免「改了参数但指纹没跟上」的静默失效。
   */
  const TREE_BUILD_CONFIG = {
    evidence: DEFAULT_EVIDENCE_OPTIONS,
    maxInputChars: DEFAULT_MAX_INPUT_CHARS,
  } as const

  /** 模型身份（含端点）：同名模型换端点未必是同一个模型，端点必须进指纹。 */
  function modelIdentity(profile: LLMProfile): string {
    return `${profile.provider}:${profile.model}@${profile.baseUrl}`
  }

  /** 建树配置指纹。传入 profile 快照而非实时读取，调用方才能保证「建树用的配置」与「指纹」是同一份。 */
  function semanticTreeConfig(profile: LLMProfile): SemanticTreeBuildConfig {
    return {
      schemaVersion: SEMANTIC_TREE_SCHEMA_VERSION,
      promptVersion: SEMANTIC_TREE_PROMPT_VERSION,
      evidence: TREE_BUILD_CONFIG.evidence,
      maxInputChars: TREE_BUILD_CONFIG.maxInputChars,
      model: modelIdentity(profile),
    }
  }

  /** 「现在」这一份索引配置对应的建树指纹（每条路径都按它判断新旧）。 */
  function currentTreeConfigHash(): string {
    return semanticTreeConfigHash(semanticTreeConfig(indexProfile.value))
  }

  /**
   * 按当前建树配置重新统计可用语义树。索引模型或端点一换，旧树在
   * `parseTreeRecord` 处就会被拒，这个集合必须跟着变——否则设置页会继续
   * 显示一批其实已经用不上的树（§10.3）。
   *
   * 刷新是异步的，而配置可以被连续切换，因此用代次 + 返回后复核配置双重把关：
   * 只有「最后一次发起」且「配置至今没再变」的结果才允许落地。
   */
  async function refreshTreeReadyPapers(): Promise<void> {
    const token = ++treeReadyToken
    const configHash = currentTreeConfigHash()
    const ids = await window.db.tree.list({
      schemaVersion: SEMANTIC_TREE_SCHEMA_VERSION,
      buildConfigHash: configHash,
    })
    if (token !== treeReadyToken || configHash !== currentTreeConfigHash()) return
    treeReadyPapers.value = new Set(ids)
  }

  /**
   * 标记某篇已有可用语义树。`configHash` 是这棵树实际所属的配置：
   * 建树期间用户可能已经切换索引配置，那这棵树就属于旧配置，
   * 不能计入当前配置的就绪集合（否则设置页又显示一份用不上的数量）。
   */
  function markTreeReady(paperId: string, configHash: string): void {
    if (configHash !== currentTreeConfigHash()) return
    treeReadyPapers.value = new Set([...treeReadyPapers.value, paperId])
  }

  /**
   * 把持久化记录还原成可用索引。内容不可信：schema 过期、构建配置指纹不匹配、
   * 块为空、树结构非法一律返回 undefined，由调用方回落平面检索（§9 / §13）。
   *
   * `expectedConfigHash` 由调用方给出，两条路径的判断标准不同：
   * 复用判断比的是**本次建树的配置快照**（记录只要对这个快照有效就该复用），
   * 检索载入比的是**当前配置**（配置变过的树一律不许参与回答）。
   * 若在这里统一读实时 profile，`tree.get` 等待期间切换配置会把一份
   * 对快照完全匹配的有效缓存误判为失效，白白重建。
   */
  function parseTreeRecord(
    record: PaperTreeRecord,
    expectedConfigHash: string,
  ): SemanticPaperIndex | undefined {
    try {
      if (record.schemaVersion !== SEMANTIC_TREE_SCHEMA_VERSION) return undefined
      if (record.buildConfigHash !== expectedConfigHash) return undefined
      const blocks = JSON.parse(record.blocksJson)
      if (!Array.isArray(blocks) || blocks.length === 0) return undefined
      // schema v2 的块必须带精确逐页分区：缺件或拼不回原文一律整树作废（§13）
      if (!blocks.every(hasExactPagePartition)) return undefined
      // 坏树整体作废而非局部修补
      const validation = validateSemanticTree(JSON.parse(record.treeJson), blocks)
      if (!validation.ok || !validation.tree) return undefined
      return { tree: validation.tree, blocks }
    } catch {
      return undefined
    }
  }

  /**
   * 后台构建单篇论文的轻量语义树（§8.2）。
   *
   * 每篇论文恰好一次 LLM 调用；任何失败都带原因返回并保持平面路径可用，
   * 不写入半成品树。原文指纹与构建配置指纹都未变、且记录内容校验通过时
   * 直接复用已存树（§10.3）；`force` 无条件重建。
   */
  async function buildPaperTree(
    paperId: string,
    providedPages?: string[],
    opts: { force?: boolean } = {},
  ): Promise<TreeBuildOutcome> {
    if (!treeEnabled.value) return { ok: false, reason: '语义树总开关已关闭' }
    if (treeIndexingPapers.value.has(paperId)) return { ok: false, reason: '该论文正在建树中' }
    treeIndexingPapers.value.add(paperId)
    // 递增代次：内容变更后旧任务的结果会被丢弃，避免写入过期树
    const token = (treeBuildTokens.get(paperId) ?? 0) + 1
    treeBuildTokens.set(paperId, token)

    try {
      // 建树是一条含 await 的长流程，期间用户可能切换索引配置。开始时一次性快照，
      // 后续指纹、LLM 调用与落库元数据全部取自这一份——否则会出现
      // 「用模型 B 建树，却按模型 A 的指纹保存」，以后切回 A 会错误复用这棵树。
      const buildProfile: LLMProfile = { ...indexProfile.value }
      const configHash = semanticTreeConfigHash(semanticTreeConfig(buildProfile))

      let pages = providedPages
      if (!pages) {
        const stored = await window.db.index.get(paperId)
        // 没有平面索引就没有可靠原文，不做无根据的建树
        if (!stored) return { ok: false, reason: '缺少可用原文（请先建立索引）' }
        pages = JSON.parse(stored.pagesJson)
      }
      if (!Array.isArray(pages) || pages.length === 0) {
        return { ok: false, reason: '缺少可用原文（请先建立索引）' }
      }

      const sourceHash = hashTreeSource(JSON.stringify(pages))
      // 缓存键必须同时覆盖原文与构建配置：只比内容指纹会让提示词/模型/分块的
      // 变更永远不生效，同一篇论文一直复用提示词时代产出的旧树（§10.3）
      const existing = opts.force ? null : await window.db.tree.get(paperId)
      if (existing && existing.sourceHash === sourceHash && existing.buildConfigHash === configHash) {
        // 键相同不等于内容可用：损坏的记录当作没有树，走重建（§13 不猜测修复）
        if (parseTreeRecord(existing, configHash)) {
          markTreeReady(paperId, configHash)
          return { ok: false, reason: '已有可复用的语义树' }
        }
      }

      // 没配模型就不必发这一次注定失败的请求：直接给出可执行的原因（#13）。
      // 本地端点（LM Studio / vLLM 等）免 Key，照常请求，真失败由 treeFailureReason 归类。
      if (buildProfile.provider !== 'ollama' && !buildProfile.apiKey.trim() && !isLocalEndpoint(buildProfile.baseUrl)) {
        return { ok: false, reason: '未配置模型（请在设置中填写 API Key）' }
      }

      const blocks = buildEvidenceBlocks(pages, TREE_BUILD_CONFIG.evidence)
      const llmFn = (prompt: string) =>
        callLLM([{ role: 'user', content: prompt }], buildProfile)
      const { tree, meta } = await buildSemanticTree(blocks, llmFn, {
        maxInputChars: TREE_BUILD_CONFIG.maxInputChars,
      })

      // 期间发生了重新建树，本次结果已过期
      if (treeBuildTokens.get(paperId) !== token) {
        return { ok: false, reason: '建树任务已被更新的任务取代' }
      }

      await window.db.tree.set(paperId, {
        treeJson: JSON.stringify(tree),
        blocksJson: JSON.stringify(blocks),
        schemaVersion: tree.schemaVersion,
        promptVersion: tree.promptVersion,
        buildModel: buildProfile.model,
        sourceHash,
        buildConfigHash: configHash,
        inputTokens: meta.inputTokens,
        outputTokens: meta.outputTokens,
        buildLatencyMs: meta.latencyMs,
      })
      markTreeReady(paperId, configHash)
      return { ok: true }
    } catch (error) {
      // 建树是可选的增强：失败即降级，不向导入/提问路径抛错
      return { ok: false, reason: treeFailureReason(error) }
    } finally {
      treeIndexingPapers.value.delete(paperId)
    }
  }

  /**
   * 载入已持久化的语义树，供检索使用。
   * 任何一步不对（无记录、schema 变更、结构非法）都返回 undefined，
   * 由调用方回落到平面检索（§9）。
   */
  async function loadSemanticIndex(paperId: string): Promise<SemanticPaperIndex | undefined> {
    if (!treeEnabled.value) return undefined
    try {
      const record = await window.db.tree.get(paperId)
      // 构建配置变过的树在这里就被判为不可用，不会带着旧提示词/旧模型的树继续答题
      return record ? parseTreeRecord(record, currentTreeConfigHash()) : undefined
    } catch {
      return undefined
    }
  }

  /**
   * 旧语义树维护接口，仅用于兼容旧数据；不参与当前问答。
   * 缓存键已覆盖构建配置，这里服务的是「配置没变但就是想换一棵树」：
   * 只重建树（每篇一次调用），不必连带重跑成本更高的平面索引。逐篇串行，避免同时打出 N 个请求。
   * 失败篇数之外还回收首个可展示的原因，否则设置页只能报「失败」而说不出为什么（#13）。
   */
  async function rebuildAllTrees(): Promise<TreeRebuildSummary> {
    const summary: TreeRebuildSummary = { attempted: 0, rebuilt: 0, failed: 0, skipped: 0 }
    for (const paperId of await window.db.index.list()) {
      if (!treeEnabled.value || treeIndexingPapers.value.has(paperId)) {
        summary.skipped++
        continue
      }
      summary.attempted++
      const outcome = await buildPaperTree(paperId, undefined, { force: true })
      if (outcome.ok) summary.rebuilt++
      else {
        summary.failed++
        if (!summary.firstReason && outcome.reason) summary.firstReason = outcome.reason
      }
    }
    return summary
  }

  // ---------- Conversation CRUD ----------

  async function newConversation(title: string, paperIds: string[]): Promise<Conversation> {
    const conv: Conversation = { id: crypto.randomUUID(), title, paperIds, messages: [], createdAt: Date.now() }
    await window.db.chat.createConversation({ id: conv.id, title, paperIds, createdAt: conv.createdAt })
    conversations.value.unshift(conv)
    return conv
  }

  async function addMessage(
    convId: string,
    role: 'user' | 'assistant',
    content: string,
    sources?: SourceRef[],
    extra?: { error?: string; truncated?: boolean; context?: string; runId?: string; runStatus?: ChatRunStatus },
  ): Promise<Message | undefined> {
    const conv = conversations.value.find(c => c.id === convId)
    if (!conv) return
    if (role === 'assistant' && !content.trim() && !extra?.error && extra?.runStatus !== 'preparing') throw new Error('拒绝写入空回答')
    const msg: Message = { id: crypto.randomUUID(), role, content, sources, timestamp: Date.now(), ...extra }
    conv.messages.push(msg)
    try {
      await window.db.chat.addMessage({
        id: msg.id, conversationId: convId, role, content,
        sources: sources ?? [], timestamp: msg.timestamp,
        error: extra?.error, truncated: extra?.truncated, context: extra?.context,
        runId: extra?.runId, runStatus: extra?.runStatus,
      })
    } catch (error) {
      const index = conv.messages.findIndex(item => item.id === msg.id)
      if (index !== -1) conv.messages.splice(index, 1)
      throw error
    }
    return conv.messages[conv.messages.length - 1]
  }

  async function updateMessage(
    convId: string,
    messageId: string,
    patch: { content?: string; sources?: SourceRef[]; error?: string; truncated?: boolean; context?: string; runId?: string; runStatus?: ChatRunStatus },
  ) {
    const conv = conversations.value.find(c => c.id === convId)
    const msg = conv?.messages.find(m => m.id === messageId)
    if (!conv || !msg) return
    Object.assign(msg, patch)
    await window.db.chat.updateMessage(messageId, patch)
  }

  function queueRunPatch(run: ActiveChatRun, patch: Parameters<typeof updateMessage>[2]): Promise<void> {
    Object.assign(run.assistant, patch)
    // A failed partial write must not prevent the terminal status from being saved.
    run.writes = run.writes.catch(() => {}).then(() => window.db.chat.updateMessage(run.assistant.id, patch))
    return run.writes
  }

  function persistRunContent(run: ActiveChatRun): Promise<void> {
    if (run.flushTimer) clearTimeout(run.flushTimer)
    run.flushTimer = undefined
    const content = run.assistant.content
    if (content === run.lastSavedContent) return run.writes.catch(() => {})
    run.lastSavedContent = content
    return queueRunPatch(run, { content })
  }

  function scheduleRunContentSave(run: ActiveChatRun) {
    if (run.flushTimer) return
    run.flushTimer = setTimeout(() => {
      void persistRunContent(run).catch(error => {
        run.writeError = error
        run.controller.abort()
      })
    }, 350)
  }

  async function beginChatRun(conv: Conversation, existing?: Message): Promise<ActiveChatRun> {
    if (activeChatRuns.has(conv.id)) throw new Error('这段对话正在生成回答，请先停止当前任务')
    const id = crypto.randomUUID()
    const assistant = existing ?? await addMessage(conv.id, 'assistant', '', undefined, { runId: id, runStatus: 'preparing' })
    if (!assistant) throw new Error('无法创建回答')
    const run: ActiveChatRun = {
      id, conversationId: conv.id, assistant, controller: new AbortController(), requestedStop: false,
      replacing: !!existing, lastSavedContent: assistant.content, writes: Promise.resolve(),
    }
    activeChatRuns.set(conv.id, run)
    if (existing) {
      const previous = {
        runId: assistant.runId, runStatus: assistant.runStatus,
        error: assistant.error, truncated: assistant.truncated,
      }
      try { await queueRunPatch(run, { runId: id, runStatus: 'preparing', error: '', truncated: false }) }
      catch (error) {
        Object.assign(assistant, previous)
        activeChatRuns.delete(conv.id)
        throw error
      }
    }
    return run
  }

  async function finishChatRun(run: ActiveChatRun, status: Extract<ChatRunStatus, 'failed' | 'cancelled'>, error: unknown) {
    await persistRunContent(run)
    await queueRunPatch(run, {
      content: run.assistant.content,
      runStatus: status,
      error: status === 'failed' ? errorMessageOf(error) : '',
    })
    run.assistant.streaming = false
  }

  async function stopConversationRun(convId: string): Promise<boolean> {
    const run = activeChatRuns.get(convId)
    if (!run) return false
    run.requestedStop = true
    run.controller.abort()
    return true
  }

  async function removeConversation(id: string) {
    await window.db.chat.removeConversation(id)
    conversations.value = conversations.value.filter(c => c.id !== id)
  }

  /** 丢弃「已创建但从未发问」的空会话（#15）。 */
  async function discardEmptyConversation(id: string) {
    const conv = conversations.value.find(c => c.id === id)
    if (!conv || conv.messages.length > 0) return
    await removeConversation(id)
  }

  async function syncPaperIds(convId: string, paperIds: string[]) {
    const conv = conversations.value.find(c => c.id === convId)
    if (!conv) return
    conv.paperIds = [...paperIds]
    await window.db.chat.updateConversation(convId, { paperIds })
  }

  async function autoTitleConversation(convId: string): Promise<void> {
    const conversation = conversations.value.find(c => c.id === convId)
    if (!conversation || !isUntitledConversation(conversation.title)) return

    const firstUserMessage = conversation.messages.find(message => message.role === 'user')
    const firstAssistantMessage = conversation.messages.find(message => message.role === 'assistant')
    if (!firstUserMessage || !firstAssistantMessage) return

    try {
      const generatedTitle = normalizeConversationTitle(await callLLM([
        {
          role: 'system',
          content: '根据首轮对话生成一个准确、简洁的中文会话标题。只返回标题本身，不要引号、前缀或句号；不超过 24 个字符。',
        },
        {
          role: 'user',
          content: `用户提问：${firstUserMessage.content.slice(0, 800)}\n\n助手回答：${firstAssistantMessage.content.slice(0, 1200)}`,
        },
      ]))
      const latestConversation = conversations.value.find(c => c.id === convId)
      if (!generatedTitle || !latestConversation || !isUntitledConversation(latestConversation.title)) return

      latestConversation.title = generatedTitle
      await window.db.chat.updateConversation(convId, { title: generatedTitle })
    } catch {
      // 标题只是辅助信息，模型不可用时保留“新对话”即可。
    }
  }

  // ---------- /abstract ----------

  async function generateAbstract(conv: Conversation, resume?: AbstractResume): Promise<{ content: string; sources: SourceRef[]; truncated: boolean; context: string }> {
    const paperIds = [...(resume?.paperIds ?? conv.paperIds)]
    if (!paperIds.length) throw new Error('请先在当前对话中选择至少一篇论文')
    if (doclingConfigError.value) throw new Error(doclingConfigError.value)
    if (!doclingConfig.value.baseUrl) throw new Error('请先在设置中填写 Docling 服务地址')
    const profile = { ...chatProfile.value }
    if (!profile.model.trim()) throw new Error('请先配置当前对话模型')
    const sections: string[] = []
    const sources: SourceRef[] = []
    let truncated = false
    let context = ''
    const progress = (label: string) => { abstractProgress.value[conv.id] = label }
    try {
      for (let index = resume?.index ?? 0; index < paperIds.length; index++) {
        const paperId = paperIds[index]
        const previous = resume?.index === index ? resume.previous : ''
        const paper = await window.db.paper.get(paperId)
        const title = paper?.title || paperId
        const document = await prepareDoclingPaper(paperId, progress)
        const profileIdentity = JSON.stringify({ provider: profile.provider, model: profile.model, baseUrl: profile.baseUrl,
          temperature: profile.temperature, maxTokens: profile.maxTokens, topK: profile.topK, systemPrompt: profile.systemPrompt })
        const runKey = await abstractRunKey(document, title, profileIdentity, previous)
        const checkpoint = {
          load: (stage: string, position: number) => window.db.abstractCheckpoint.get(paperId, runKey, stage, position),
          save: (stage: string, position: number, content: string) => window.db.abstractCheckpoint.save(paperId, runKey, stage, position, content),
        }
        const result = await generateDoclingAbstract(document, paperId, title, messages => {
          const configured = messages.map(message => ({ ...message }))
          configured[0].content = profile.systemPrompt + '\n\n' + configured[0].content
          return requestCompletion(configured, profile, { timeoutMs: 300_000 })
        }, progress, previous, checkpoint)
        sections.push(paperIds.length > 1 && !previous ? `## ${title}\n\n${result.content}` : result.content)
        sources.push(...(result.sources.length ? result.sources.map(ref => ({ ...ref, label: `${title} · ${ref.label}` })) : [{ label: title, paperId }]))
        truncated ||= result.truncated
        if (result.truncated) {
          context = JSON.stringify({ kind: 'docling-abstract', paperIds, index, previous: (previous + '\n\n' + result.content).slice(-9000) } satisfies AbstractResume)
          break
        }
      }
      return { content: sections.join('\n\n---\n\n'), sources, truncated, context }
    } finally { delete abstractProgress.value[conv.id] }
  }

  /** The summary tab reuses the exact Docling/LLM pipeline without adding chat messages. */
  async function generatePaperAbstract(paperId: string, force = false): Promise<PaperAbstractReport> {
    const ongoing = paperAbstractJobs.get(paperId)
    if (ongoing) return ongoing
    const task = (async () => {
      const saved = await window.db.paperAbstract.get(paperId)
      if (saved && !saved.truncated && !force) return saved
      const conv: Conversation = { id: `paper-abstract:${paperId}`, title: '', paperIds: [paperId], messages: [], createdAt: 0 }
      const resume: AbstractResume | undefined = saved?.truncated && !force
        ? { kind: 'docling-abstract', paperIds: [paperId], index: 0, previous: saved.content.slice(-9000) }
        : undefined
      const result = await generateAbstract(conv, resume)
      const sources = [...new Map([...(resume ? saved?.sources ?? [] : []), ...result.sources]
        .map(source => [`${source.paperId}:${source.startPage}:${source.label}`, source])).values()]
      return window.db.paperAbstract.save({ paperId,
        content: resume ? `${saved!.content}\n\n${result.content}` : result.content,
        sources, truncated: result.truncated })
    })()
    paperAbstractJobs.set(paperId, task)
    try { return await task } finally { paperAbstractJobs.delete(paperId) }
  }

  async function singlePaperAbstract(paperId: string, force = false): Promise<{ content: string; sources: SourceRef[]; truncated: boolean; context: string }> {
    const saved = force ? null : await window.db.paperAbstract.get(paperId)
    const report = saved ?? await generatePaperAbstract(paperId, force)
    return { content: report.content, sources: report.sources, truncated: report.truncated, context: '' }
  }

  // ---------- Send Message (RAG 3-call pipeline) ----------

  async function collectIndexedPapers(conv: Conversation, signal?: AbortSignal): Promise<{ papers: IndexedPaper[]; paperIds: string[] }> {
    const paperIds = [...conv.paperIds]
    const papers: IndexedPaper[] = []
    const records = signal
      ? await awaitOrCancel(window.db.paper.list(), signal)
      : await window.db.paper.list()
    for (const paperId of paperIds) {
      signal && throwIfCancelled(signal)
      indexingPapers.value.add(paperId)
      try {
        const { index, pages } = signal
          ? await awaitOrCancel(ek5Store.load(paperId), signal)
          : await ek5Store.load(paperId)
        indexedPapers.value.add(paperId)
        papers.push({ ek5: index, pages, paperLabel: records.find(p => p.id === paperId)?.title ?? paperId,
          tree: { nodeId: 'root', title: '', summary: '', startPage: 0, endPage: pages.length - 1, nodes: [] } })
      } catch (e) {
        throw new Error(`${records.find(p => p.id === paperId)?.title ?? paperId}：${errorMessageOf(e)}`)
      } finally { indexingPapers.value.delete(paperId) }
    }
    signal && throwIfCancelled(signal)
    return { papers, paperIds }
  }

  function errorMessageOf(error: unknown): string {
    return error instanceof Error ? error.message : '未知错误'
  }

  async function recordFailure(convId: string, error: unknown) {
    await addMessage(convId, 'assistant', '', undefined, { error: errorMessageOf(error) })
  }

  async function generateReply(
    conv: Conversation,
    userMessage: string,
    run: ActiveChatRun,
    context?: string,
    historyEnd?: number,
  ): Promise<{ answer: string; sources: SourceRef[]; truncated: boolean }> {
    const signal = run.controller.signal
    let papers: IndexedPaper[] = []
    // 保留 paperIds：来源 refs 需要「第 i 篇检索结果」对应的论文 id（ids 与 papers 一一对齐）
    let indexedIds: string[] = []
    if (!context && conv.paperIds.length > 0) {
      const collected = await collectIndexedPapers(conv, signal)
      papers = collected.papers
      indexedIds = collected.paperIds
    }
    // 历史不含当前提问：默认排除最后一条（刚追加的用户消息）；重试时由调用方给 historyEnd
    const history = conv.messages.slice(0, historyEnd ?? -2).map(m => ({ role: m.role, content: m.content }))
    // 生成回调负责把 finish_reason 带回来：截断的回答要能提示「已达长度上限」并续写（#3）
    let lastTruncated = false
    const generate = async (msgs: { role: string; content: string }[]) => {
      throwIfCancelled(signal)
      run.assistant.streaming = true
      await queueRunPatch(run, { runStatus: 'streaming' })
      const outcome = await requestCompletion(msgs, undefined, {
        signal,
        onToken: token => {
          if (signal.aborted) return
          if (run.replacing) {
            run.assistant.content = ''
            run.replacing = false
          }
          run.assistant.content += token
          scheduleRunContentSave(run)
        },
      })
      lastTruncated = outcome.truncated
      return outcome.content
    }
    const result = await awaitOrCancel(runRagPipeline(
      papers,
      userMessage,
      history,
      (prompt: string) => callLLM([{ role: 'user', content: prompt }], undefined, signal),
      generate,
      chatProfile.value.systemPrompt,
      { externalContext: context, retrievalMode: 'ek5', maxContextChars: retrievalContextChars.value },
      // collectIndexedPapers 已等待 E-k5 所需的模型与索引。
      passageDeps(),
    ), signal)
    throwIfCancelled(signal)
    // 来源只在这里构造一次，首次提问与重试两条写回分支共用。
    // `retrievals[i].selected[j]` 与 `retrievals[i].sources[j]` 一一对齐
    // （两条检索路径都是 `sources = selected.map(formatSource)`），缺件时退化为纯标签。
    const sourceRefs: SourceRef[] = result.sources.length
      ? result.retrievals.flatMap((r, i) => r.sources.map((label, j) => {
          const node = r.selected[j]
          const paperId = indexedIds[i]
          return node && paperId
            ? { label, paperId, startPage: node.startPage, endPage: node.endPage }
            : { label }
        }))
      : []
    return { answer: result.answer, sources: sourceRefs, truncated: lastTruncated }
  }

  async function settleChatRun(
    run: ActiveChatRun,
    work: () => Promise<{ answer: string; sources?: SourceRef[]; truncated: boolean }>,
  ): Promise<string> {
    try {
      const result = await work()
      throwIfCancelled(run.controller.signal)
      await persistRunContent(run)
      await queueRunPatch(run, {
        content: result.answer,
        sources: result.sources?.length ? result.sources : undefined,
        error: '',
        truncated: result.truncated,
        runStatus: 'completed',
      })
      return result.answer
    } catch (error) {
      const failure = run.writeError ?? error
      await finishChatRun(run, run.requestedStop ? 'cancelled' : 'failed', failure)
      if (run.requestedStop) return run.assistant.content
      throw failure
    } finally {
      if (run.flushTimer) clearTimeout(run.flushTimer)
      run.assistant.streaming = false
      if (activeChatRuns.get(run.conversationId)?.id === run.id) activeChatRuns.delete(run.conversationId)
    }
  }

  async function runChatReply(
    conv: Conversation,
    userMessage: string,
    context?: string,
    historyEnd?: number,
    existing?: Message,
  ): Promise<string> {
    const run = await beginChatRun(conv, existing)
    return settleChatRun(run, () => generateReply(conv, userMessage, run, context, historyEnd))
  }

  async function sendMessage(convId: string, userMessage: string, context?: string): Promise<string> {
    const conv = conversations.value.find(c => c.id === convId)
    if (!conv) throw new Error('Conversation not found')
    if (activeChatRuns.has(convId) || startingChatRuns.has(convId)) throw new Error('这段对话正在生成回答，请先停止当前任务')

    const normalized = userMessage.trim().toLowerCase()
    if (!normalized.startsWith('/')) {
      startingChatRuns.add(convId)
      try {
        await addMessage(convId, 'user', userMessage, undefined, context ? { context } : undefined)
        return await runChatReply(conv, userMessage, context)
      } finally { startingChatRuns.delete(convId) }
    }

    // 划选原文随用户消息持久化：失败轮重试时才能重放同一上下文（#2）
    await addMessage(convId, 'user', userMessage, undefined, context ? { context } : undefined)

    try {
      // 命令只在本地识别一次：未知的 `/xxx` 直接回提示，不发模型（#8）
      if (normalized.startsWith('/') && normalized !== '/abstract') {
        await addMessage(convId, 'assistant', `未识别的命令：${userMessage.trim()}。当前可用命令：/abstract（总结当前所选论文）。`)
        return userMessage
      }
      if (normalized === '/abstract') {
        const result = conv.paperIds.length === 1
          ? await singlePaperAbstract(conv.paperIds[0])
          : await generateAbstract(conv)
        await addMessage(convId, 'assistant', result.content, result.sources, { truncated: result.truncated, context: result.context })
        return result.content
      }
      return userMessage
    } catch (error) {
      await recordFailure(convId, error)
      throw error
    }
  }

  async function retryMessage(convId: string, messageId: string): Promise<void> {
    const conv = conversations.value.find(c => c.id === convId)
    const index = conv ? conv.messages.findIndex(m => m.id === messageId) : -1
    if (!conv || index === -1) return
    const target = conv.messages[index]
    const userMessage = [...conv.messages.slice(0, index)].reverse().find(m => m.role === 'user')
    if (!target || !userMessage) return

    if (userMessage.content.trim().toLowerCase() !== '/abstract') {
      await runChatReply(conv, userMessage.content, userMessage.context || undefined, index - 1, target)
      return
    }
    try {
      const result = conv.paperIds.length === 1
        ? await singlePaperAbstract(conv.paperIds[0], true)
        : await generateAbstract(conv)
      await updateMessage(convId, messageId, { content: result.content, sources: result.sources, error: '', truncated: result.truncated, context: result.context })
    } catch (error) {
      await updateMessage(convId, messageId, { content: '', error: errorMessageOf(error) })
      throw error
    }
  }

  /** 「继续」：对截断的回答就地续写（#3）。检索按原问题重跑，生成时把已输出部分作为上文。 */
  async function continueMessage(convId: string, messageId: string): Promise<void> {
    const conv = conversations.value.find(c => c.id === convId)
    const index = conv ? conv.messages.findIndex(m => m.id === messageId) : -1
    if (!conv || index === -1) return
    const target = conv.messages[index]
    const userMessage = [...conv.messages.slice(0, index)].reverse().find(m => m.role === 'user')
    if (!userMessage) return
    if (userMessage.content.trim().toLowerCase() === '/abstract') {
      const paperIds = [...new Set((target.sources ?? []).map(source => source.paperId).filter((id): id is string => !!id))]
      const resume = readAbstractResume(target.context) ?? { kind: 'docling-abstract', paperIds: paperIds.length ? paperIds : conv.paperIds, index: 0, previous: target.content }
      const result = await generateAbstract(conv, resume)
      const sources = [...new Map([...(target.sources ?? []), ...result.sources].map(ref => [`${ref.paperId}:${ref.startPage}`, ref])).values()]
      await updateMessage(convId, messageId, { content: target.content + '\n\n' + result.content, sources, truncated: result.truncated, context: result.context })
      if (resume.paperIds.length === 1) {
        await window.db.paperAbstract.save({ paperId: resume.paperIds[0], content: target.content, sources, truncated: result.truncated })
      }
      return
    }

    // 划选提问的原文已随用户消息持久化：与重试同构，直接重放该上下文并跳过
    // 论文收集/改写/评分——否则续写会换一个问题继续写，与首答语义分叉（#2）
    const run = await beginChatRun(conv, target)
    run.replacing = false
    await settleChatRun(run, async () => {
      const signal = run.controller.signal
      const previous = target.content
      const papers = userMessage.context ? [] : conv.paperIds.length > 0
        ? (await collectIndexedPapers(conv, signal)).papers : []
      const history = conv.messages.slice(0, index).map(m => ({ role: m.role, content: m.content }))
      // Keep the saved partial answer in the prompt so continuation starts at its end.
      const priorTurns = [...history, { role: 'assistant' as const, content: previous }]
      const retrieval = await awaitOrCancel(retrieveRagContext(
        papers,
        userMessage.content,
        priorTurns,
        (prompt: string) => callLLM([{ role: 'user', content: prompt }], undefined, signal),
        { externalContext: userMessage.context || undefined, retrievalMode: 'ek5', maxContextChars: retrievalContextChars.value },
        passageDeps(),
      ), signal)
      throwIfCancelled(signal)
      const messages = buildAnswerMessages(
        retrieval.context,
        '请接着上一条回答继续输出，从中断处直接续写，不要重复已经输出过的内容。',
        priorTurns,
        chatProfile.value.systemPrompt,
      )
      target.streaming = true
      await queueRunPatch(run, { runStatus: 'streaming' })
      const outcome = await requestCompletion(messages, undefined, {
        signal,
        onToken: token => {
          if (signal.aborted) return
          target.content += token
          scheduleRunContentSave(run)
        },
      })
      return { answer: previous + outcome.content, truncated: outcome.truncated }
    })
  }

  return {
    retrievalContextChars, setRetrievalContextChars, rebuildEk5Indexes, vectorModelState,
    conversations, profiles, chatProfileId, indexProfileId,
    chatProfile, indexProfile,
    loaded, indexingPapers, indexedPapers, abstractToken, doclingConfig, doclingConfigError, abstractProgress, setDoclingConfig,
    treeEnabled, treeReadyPapers, treeIndexingPapers,
    init,
    addProfile, updateProfile, removeProfile,
    setChatProfileId, setIndexProfileId, setAbstractToken, setTreeEnabled,
    newConversation, addMessage, updateMessage, removeConversation, discardEmptyConversation, syncPaperIds, autoTitleConversation,
    sendMessage, retryMessage, continueMessage, stopConversationRun, generatePaperAbstract, requestCompletion,
    collectIndexedPapers, indexPaper, buildPaperTree, rebuildAllTrees, loadSemanticIndex,
    ABSTRACT_MODEL,
  }
})
