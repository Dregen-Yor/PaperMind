import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { extractPages, buildPageIndex } from '../utils/pageIndex'
import { runRagPipeline, retrieveRagContext, buildAnswerMessages, type IndexedPaper, type SemanticPaperIndex } from '../utils/ragPipeline'
import { buildEvidenceBlocks, hasExactPagePartition, DEFAULT_EVIDENCE_OPTIONS } from '../utils/evidenceBlock'
import {
  buildSemanticTree,
  validateSemanticTree,
  hashTreeSource,
  semanticTreeConfigHash,
  SEMANTIC_TREE_SCHEMA_VERSION,
  SEMANTIC_TREE_PROMPT_VERSION,
  DEFAULT_MAX_INPUT_CHARS,
  type SemanticTreeBuildConfig,
} from '../utils/semanticTree'
import type { PaperTreeRecord } from '../types/db'
import {
  ABSTRACT_MODEL,
  summarizeAcademicText,
} from '../utils/abstractSummarizer'

export interface LLMProfile {
  id: string
  name: string
  provider: 'openai' | 'anthropic' | 'ollama'
  model: string
  apiKey: string
  baseUrl: string
  temperature: number
  maxTokens: number
  topK: number        // 0 = 不限制
  systemPrompt: string
}

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  sources?: string[]
  timestamp: number
  /** 非空表示这一轮失败，渲染失败卡（#2） */
  error?: string
  /** finish_reason=length：回答被截断（#3） */
  truncated?: boolean
  /** 用户划选原文（externalContext）：重试时按原上下文重放，不退回检索（#2） */
  context?: string
  /** 流式渲染中的占位气泡标记（仅内存态，不落库）（#6） */
  streaming?: boolean
}

export interface Conversation {
  id: string
  title: string
  paperIds: string[]
  messages: Message[]
  createdAt: number
}

/** 单次 LLM 请求上限：超时即失败，避免无声挂死（#2）。 */
const LLM_REQUEST_TIMEOUT_MS = 120_000

const DEFAULT_PROFILE: LLMProfile = {
  id: 'default',
  name: '默认配置',
  provider: 'openai',
  model: 'gpt-4o',
  apiKey: '',
  baseUrl: 'https://api.openai.com/v1',
  temperature: 0.7,
  maxTokens: 4096,
  topK: 0,
  systemPrompt: '你是一个专业的学术论文阅读助手，帮助用户理解和分析论文内容。',
}

/** 强制重建的结果摘要。分开计数是为了不让「全部失败」在 UI 上退化成「没有论文」。 */
export interface TreeRebuildSummary {
  /** 真正尝试建树的篇数（不含跳过） */
  attempted: number
  rebuilt: number
  failed: number
  /** 总开关关闭，或该篇已在建树中 */
  skipped: number
}

const NEW_CONVERSATION_TITLE = '新对话'
const LEGACY_CONVERSATION_TITLE = /^对话\s+\d+$/
/** 语义树开关的持久化键；缺省为开启（方案 §8.2 要求关闭时功能仍完全可用）。 */
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
async function requestWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new Error('请求超时，请检查网络后重试')
    }
    throw error
  }
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
async function readOpenAiStream(res: Response, onToken: (token: string) => void): Promise<{ content: string; truncated: boolean }> {
  if (!res.body) throw new Error('流式响应不可用')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
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
  if (!content.trim()) throw new Error('模型返回了空响应')
  return { content, truncated }
}

/** 解析 Anthropic SSE 流（content_block_delta / message_delta）（#6）。 */
async function readAnthropicStream(res: Response, onToken: (token: string) => void): Promise<{ content: string; truncated: boolean }> {
  if (!res.body) throw new Error('流式响应不可用')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
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
  if (!content.trim()) throw new Error('模型返回了空响应')
  return { content, truncated }
}

/** 解析 Ollama NDJSON 流（#6）。 */
async function readOllamaStream(res: Response, onToken: (token: string) => void): Promise<{ content: string; truncated: boolean }> {
  if (!res.body) throw new Error('流式响应不可用')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
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
  if (!content.trim()) throw new Error('模型返回了空响应')
  return { content, truncated }
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
  /** 轻量语义树总开关；关闭时全部检索退回现有平面路径 */
  const treeEnabled = ref(true)
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

    // 加载配置列表
    const savedProfiles = await window.db.settings.get('llm_profiles')
    if (savedProfiles && Array.isArray(savedProfiles) && savedProfiles.length > 0) {
      profiles.value = savedProfiles
    } else {
      // 迁移旧版单一 llm_config（首次升级时）
      const oldConfig = await window.db.settings.get('llm_config')
      if (oldConfig) {
        profiles.value = [{
          id: crypto.randomUUID(),
          name: '默认配置',
          topK: 0,
          ...oldConfig,
        }]
      }
      // 无论是迁移还是全新安装，都将当前 profiles 写入磁盘，确保下次启动可恢复
      await persistProfiles()
    }

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
    indexedPapers.value = new Set(ids)
    abstractToken.value = (await window.db.settings.get('huggingface_token')) ?? ''
    // 语义树默认开启；只有显式存过 false 才关闭
    treeEnabled.value = (await window.db.settings.get(TREE_ENABLED_KEY)) !== false
    // 只把「当前构建配置下能直接复用」的记录算作已就绪：模型或提示词换过之后
    // 仍留在集合里，UI 会谎报可用树的篇数（真正的校验在 parseTreeRecord）
    await refreshTreeReadyPapers()
    loaded.value = true
  }

  // ---------- Profile CRUD ----------

  async function addProfile(profile: Omit<LLMProfile, 'id'>): Promise<LLMProfile> {
    const newProfile: LLMProfile = { ...profile, id: crypto.randomUUID() }
    profiles.value.push(newProfile)
    await persistProfiles()
    return newProfile
  }

  async function updateProfile(id: string, patch: Partial<Omit<LLMProfile, 'id'>>) {
    const idx = profiles.value.findIndex(p => p.id === id)
    if (idx === -1) return
    profiles.value[idx] = { ...profiles.value[idx], ...patch }
    await persistProfiles()
    // 改的若是当前索引配置（模型/端点），已建好的树随即失效，就绪集合要重算
    if (id === indexProfileId.value) await refreshTreeReadyPapers()
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
    // 换了索引配置就直接换了一套建树配置：就绪集合必须跟着重算
    await refreshTreeReadyPapers()
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
  async function requestCompletion(
    messages: { role: string; content: string }[],
    profileOrId?: string | LLMProfile,
    opts: { onToken?: (token: string) => void } = {},
  ): Promise<{ content: string; truncated: boolean }> {
    const profile = resolveLlmProfile(profileOrId)

    if (profile.provider === 'ollama') {
      const body: Record<string, unknown> = { model: profile.model, messages, stream: !!opts.onToken }
      if (profile.topK > 0) body.options = { top_k: profile.topK }
      const res = await requestWithTimeout(`${profile.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, opts.onToken ? LLM_STREAM_TIMEOUT_MS : LLM_REQUEST_TIMEOUT_MS)
      if (!res.ok) throw new Error(`LLM 请求失败 (${res.status})：${await readErrorBody(res)}`)
      if (opts.onToken) return readOllamaStream(res, opts.onToken)
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
        max_tokens: profile.maxTokens,
        messages: chatMessages,
        temperature: Math.min(profile.temperature, 1),
      }
      if (system) body.system = system
      if (profile.topK > 0) body.top_k = profile.topK
      if (opts.onToken) body.stream = true

      const res = await requestWithTimeout(`${profile.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': profile.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      }, opts.onToken ? LLM_STREAM_TIMEOUT_MS : LLM_REQUEST_TIMEOUT_MS)
      if (!res.ok) throw new Error(`LLM 请求失败 (${res.status})：${await readErrorBody(res)}`)
      if (opts.onToken) return readAnthropicStream(res, opts.onToken)
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
      temperature: profile.temperature,
      max_tokens: profile.maxTokens,
      ...(opts.onToken ? { stream: true } : {}),
    }

    const res = await requestWithTimeout(`${profile.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }, opts.onToken ? LLM_STREAM_TIMEOUT_MS : LLM_REQUEST_TIMEOUT_MS)
    if (!res.ok) throw new Error(`LLM 请求失败 (${res.status})：${await readErrorBody(res)}`)
    if (opts.onToken) return readOpenAiStream(res, opts.onToken)
    const data = await res.json()
    const content = data.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) throw new Error('模型返回了空响应')
    return { content, truncated: data.choices?.[0]?.finish_reason === 'length' }
  }

  /** 只要文本的调用路径（索引、标题、查询改写等）继续走这个薄包装。 */
  async function callLLM(
    messages: { role: string; content: string }[],
    profileOrId?: string | LLMProfile,
  ): Promise<string> {
    return (await requestCompletion(messages, profileOrId)).content
  }

  // ---------- Index Paper ----------

  async function indexPaper(paperId: string): Promise<void> {
    if (indexingPapers.value.has(paperId)) return
    indexingPapers.value.add(paperId)
    try {
      const base64 = await window.db.paper.readFile(paperId)
      if (!base64) throw new Error('paper file not found')
      const pages = await extractPages(base64)
      const llmFn = (prompt: string) =>
        callLLM([{ role: 'user', content: prompt }], indexProfileId.value)
      const tree = await buildPageIndex(pages, llmFn)
      await window.db.index.set(paperId, JSON.stringify(tree), JSON.stringify(pages))
      indexedPapers.value = new Set([...indexedPapers.value, paperId])
      // 语义树在后台构建：不阻塞导入、阅读与首次提问（§8.2）。
      // 失败/超时/输出非法都只是没有树，检索自动回落平面路径。
      void buildPaperTree(paperId, pages).catch(() => {})
    } finally {
      indexingPapers.value.delete(paperId)
    }
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
   * 每篇论文恰好一次 LLM 调用；任何失败都返回 false 并保持平面路径可用，
   * 不写入半成品树。原文指纹与构建配置指纹都未变、且记录内容校验通过时
   * 直接复用已存树（§10.3）；`force` 无条件重建。
   */
  async function buildPaperTree(
    paperId: string,
    providedPages?: string[],
    opts: { force?: boolean } = {},
  ): Promise<boolean> {
    if (!treeEnabled.value) return false
    if (treeIndexingPapers.value.has(paperId)) return false
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
        if (!stored) return false
        pages = JSON.parse(stored.pagesJson)
      }
      if (!Array.isArray(pages) || pages.length === 0) return false

      const sourceHash = hashTreeSource(JSON.stringify(pages))
      // 缓存键必须同时覆盖原文与构建配置：只比内容指纹会让提示词/模型/分块的
      // 变更永远不生效，同一篇论文一直复用提示词时代产出的旧树（§10.3）
      const existing = opts.force ? null : await window.db.tree.get(paperId)
      if (existing && existing.sourceHash === sourceHash && existing.buildConfigHash === configHash) {
        // 键相同不等于内容可用：损坏的记录当作没有树，走重建（§13 不猜测修复）
        if (parseTreeRecord(existing, configHash)) {
          markTreeReady(paperId, configHash)
          return false
        }
      }

      const blocks = buildEvidenceBlocks(pages, TREE_BUILD_CONFIG.evidence)
      const llmFn = (prompt: string) =>
        callLLM([{ role: 'user', content: prompt }], buildProfile)
      const { tree, meta } = await buildSemanticTree(blocks, llmFn, {
        maxInputChars: TREE_BUILD_CONFIG.maxInputChars,
      })

      // 期间发生了重新建树，本次结果已过期
      if (treeBuildTokens.get(paperId) !== token) return false

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
      return true
    } catch {
      // 建树是可选的增强：失败即降级，不向导入/提问路径抛错
      return false
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
   * 强制重建所有已索引论文的语义树（设置页的显式路径）。
   * 缓存键已覆盖构建配置，这里服务的是「配置没变但就是想换一棵树」：
   * 只重建树（每篇一次调用），不必连带重跑成本更高的平面索引。逐篇串行，避免同时打出 N 个请求。
   */
  async function rebuildAllTrees(): Promise<TreeRebuildSummary> {
    const summary: TreeRebuildSummary = { attempted: 0, rebuilt: 0, failed: 0, skipped: 0 }
    for (const paperId of [...indexedPapers.value]) {
      if (!treeEnabled.value || treeIndexingPapers.value.has(paperId)) {
        summary.skipped++
        continue
      }
      summary.attempted++
      if (await buildPaperTree(paperId, undefined, { force: true })) summary.rebuilt++
      else summary.failed++
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
    sources?: string[],
    extra?: { error?: string; truncated?: boolean; context?: string },
  ) {
    const conv = conversations.value.find(c => c.id === convId)
    if (!conv) return
    if (role === 'assistant' && !content.trim() && !extra?.error) throw new Error('拒绝写入空回答')
    const msg: Message = { id: crypto.randomUUID(), role, content, sources, timestamp: Date.now(), ...extra }
    conv.messages.push(msg)
    await window.db.chat.addMessage({
      id: msg.id, conversationId: convId, role, content,
      sources: sources ?? [], timestamp: msg.timestamp,
      error: extra?.error, truncated: extra?.truncated, context: extra?.context,
    })
  }

  async function updateMessage(
    convId: string,
    messageId: string,
    patch: { content?: string; sources?: string[]; error?: string; truncated?: boolean; context?: string },
  ) {
    const conv = conversations.value.find(c => c.id === convId)
    const msg = conv?.messages.find(m => m.id === messageId)
    if (!conv || !msg) return
    Object.assign(msg, patch)
    await window.db.chat.updateMessage(messageId, patch)
  }

  async function removeConversation(id: string) {
    await window.db.chat.removeConversation(id)
    conversations.value = conversations.value.filter(c => c.id !== id)
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

  async function readPaperPages(paperId: string): Promise<string[]> {
    const stored = await window.db.index.get(paperId)
    if (stored) return JSON.parse(stored.pagesJson)

    const base64 = await window.db.paper.readFile(paperId)
    if (!base64) throw new Error('找不到论文 PDF 文件')
    return extractPages(base64)
  }

  async function generateAbstract(conv: Conversation): Promise<{ content: string; sources: string[] }> {
    if (conv.paperIds.length === 0) throw new Error('请先在当前对话中选择至少一篇论文')
    if (!abstractToken.value) throw new Error('请先在设置中填写 Hugging Face Token')

    const sections: string[] = []
    const sources: string[] = []
    for (const paperId of conv.paperIds) {
      const [paper, pages] = await Promise.all([
        window.db.paper.get(paperId),
        readPaperPages(paperId),
      ])
      const title = paper?.title || `论文 ${sources.length + 1}`
      const text = pages.join('\n\n')
      const summary = await summarizeAcademicText(text, abstractToken.value)
      sections.push(conv.paperIds.length > 1 ? `## ${title}\n\n${summary}` : summary)
      sources.push(title)
    }

    return {
      content: sections.join('\n\n---\n\n'),
      sources,
    }
  }

  // ---------- Send Message (RAG 3-call pipeline) ----------

  async function collectIndexedPapers(conv: Conversation): Promise<{ papers: IndexedPaper[]; paperIds: string[] }> {
    const papers: IndexedPaper[] = []
    const paperIds: string[] = []
    for (const paperId of conv.paperIds) {
      let stored = await window.db.index.get(paperId)
      // 兜底：导入时后台预处理未完成（LLM未配置等），首次对话时按需构建
      if (!stored) {
        try {
          await indexPaper(paperId)
          stored = await window.db.index.get(paperId)
        } catch { /* ignore — no index available for this paper */ }
      }
      if (!stored) continue
      const semantic = await loadSemanticIndex(paperId)
      papers.push({
        tree: JSON.parse(stored.indexJson),
        pages: JSON.parse(stored.pagesJson),
        ...(semantic ? { semantic } : {}),
      })
      paperIds.push(paperId)
    }
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
    context?: string,
    historyEnd?: number,
    opts?: { writeBack?: string },
  ) {
    let papers: IndexedPaper[] = []
    if (!context && conv.paperIds.length > 0) {
      papers = (await collectIndexedPapers(conv)).papers
    }
    // 历史不含当前提问：默认排除最后一条（刚追加的用户消息）；重试时由调用方给 historyEnd
    const history = conv.messages.slice(0, historyEnd ?? -1).map(m => ({ role: m.role, content: m.content }))
    // 生成回调负责把 finish_reason 带回来：截断的回答要能提示「已达长度上限」并续写（#3）
    let lastTruncated = false
    let placeholder: Message | undefined
    // 重试是原地更新目标消息：直接把它当流式气泡，失败卡先撤下（错误态由外层 catch 兜底写回）
    const target = opts?.writeBack ? conv.messages.find(m => m.id === opts.writeBack) : undefined
    const clearStreaming = () => {
      if (placeholder) {
        const at = conv.messages.indexOf(placeholder)
        if (at !== -1) conv.messages.splice(at, 1)
        placeholder = undefined
      }
      if (target) target.streaming = false
    }
    const generate = async (msgs: { role: string; content: string }[]) => {
      let sink: Message
      if (target) {
        target.content = ''
        target.error = ''
        target.streaming = true
        sink = target
      } else {
        conv.messages.push({ id: crypto.randomUUID(), role: 'assistant', content: '', timestamp: Date.now(), streaming: true })
        // 从数组读回响应式代理再写入：直接改本地原始对象不经代理，逐 token 不会触发渲染
        placeholder = conv.messages[conv.messages.length - 1]
        sink = placeholder
      }
      try {
        // 流式增量直接写进气泡；成功后仍走各自的写回分支一次性落库
        const outcome = await requestCompletion(msgs, undefined, { onToken: token => { sink.content += token } })
        lastTruncated = outcome.truncated
        return outcome.content
      } finally {
        clearStreaming()
      }
    }
    const { answer, sources } = await runRagPipeline(
      papers,
      userMessage,
      history,
      (prompt: string) => callLLM([{ role: 'user', content: prompt }]),
      generate,
      chatProfile.value.systemPrompt,
      { externalContext: context },
    )
    // 重试是原地更新失败轮；首次提问才追加新消息
    if (opts?.writeBack) {
      await updateMessage(conv.id, opts.writeBack, {
        content: answer,
        sources: sources.length ? sources : undefined,
        error: '',
        truncated: lastTruncated,
      })
    } else {
      await addMessage(conv.id, 'assistant', answer, sources.length ? sources : undefined, { truncated: lastTruncated })
    }
  }

  async function sendMessage(convId: string, userMessage: string, context?: string): Promise<string> {
    const conv = conversations.value.find(c => c.id === convId)
    if (!conv) throw new Error('Conversation not found')

    // 划选原文随用户消息持久化：失败轮重试时才能重放同一上下文（#2）
    await addMessage(convId, 'user', userMessage, undefined, context ? { context } : undefined)

    try {
      if (userMessage.trim().toLowerCase() === '/abstract') {
        const result = await generateAbstract(conv)
        await addMessage(convId, 'assistant', result.content, result.sources)
        return result.content
      }
      await generateReply(conv, userMessage, context)
      return conv.messages[conv.messages.length - 1].content
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

    try {
      if (userMessage.content.trim().toLowerCase() === '/abstract') {
        const result = await generateAbstract(conv)
        await updateMessage(convId, messageId, { content: result.content, sources: result.sources, error: '' })
        return
      }
      // 单次写回：成功才落内容，失败由 catch 保持失败态，中途崩溃不留空窗
      await generateReply(conv, userMessage.content, userMessage.context || undefined, index, { writeBack: messageId })
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

    const papers = conv.paperIds.length > 0 ? (await collectIndexedPapers(conv)).papers : []
    const history = conv.messages.slice(0, index).map(m => ({ role: m.role, content: m.content }))
    // 改写阶段把「已输出的半截回答」也算作上一轮：与正常追问时的上下文一致，
    // 否则续写往往会因历史轮数不足而跳过查询改写（#3）
    const priorTurns = [...history, { role: 'assistant' as const, content: target.content }]
    const retrieval = await retrieveRagContext(
      papers,
      userMessage.content,
      priorTurns,
      (prompt: string) => callLLM([{ role: 'user', content: prompt }]),
    )
    const messages = buildAnswerMessages(
      retrieval.context,
      '请接着上一条回答继续输出，从中断处直接续写，不要重复已经输出过的内容。',
      priorTurns,
      chatProfile.value.systemPrompt,
    )
    const outcome = await requestCompletion(messages)
    await updateMessage(convId, messageId, {
      content: target.content + outcome.content,
      truncated: outcome.truncated,
    })
  }

  return {
    conversations, profiles, chatProfileId, indexProfileId,
    chatProfile, indexProfile,
    loaded, indexingPapers, indexedPapers, abstractToken,
    treeEnabled, treeReadyPapers, treeIndexingPapers,
    init,
    addProfile, updateProfile, removeProfile,
    setChatProfileId, setIndexProfileId, setAbstractToken, setTreeEnabled,
    newConversation, addMessage, updateMessage, removeConversation, syncPaperIds, autoTitleConversation,
    sendMessage, retryMessage, continueMessage, requestCompletion,
    collectIndexedPapers, indexPaper, buildPaperTree, rebuildAllTrees, loadSemanticIndex,
    ABSTRACT_MODEL,
  }
})
