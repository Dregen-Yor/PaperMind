import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { extractPages, type IndexNode } from '../utils/pageIndex'
import { runRagPipeline, retrieveRagContext, buildAnswerMessages, type IndexedPaper, type SemanticPaperIndex, type RagPipelineDeps } from '../utils/ragPipeline'
import { buildEvidenceBlocks, hasExactPagePartition, DEFAULT_EVIDENCE_OPTIONS } from '../utils/evidenceBlock'
import { createBuildGeneration } from '../utils/buildGeneration'
import type { Embedder } from '../utils/embedder'
import {
  PASSAGE_INDEX_SCHEMA_VERSION, PASSAGE_INDEX_VERSION,
  parsePassageIndex, serializePassageIndex,
  passageConfigHash, structureHash, type PassageIndex,
} from '../utils/passageIndex'
import { startPassagePipeline } from '../utils/passageIndexBuilder'
import { createEstimatingTokenCounter, DEFAULT_PASSAGE_OPTIONS } from '../utils/passages'
import { STRUCTURE_CARD_PROMPT_VERSION } from '../utils/structureCards'
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
  /** 回答输出上限；0 = 不限制（不向上游发送该参数，由模型自身决定） */
  maxTokens: number
  topK: number        // 0 = 不限制
  systemPrompt: string
}

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** 结构化来源：芯片文案 + 跳转所需的论文与页区间（#1） */
  sources?: SourceRef[]
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
export interface IndexPaperOptions {
  /**
   * 只等阶段①（本地切段 + 落盘）就返回。提问路径用：卡片调用是每篇一次计费的 LLM 请求，
   * 不该把用户的问题挡在后面（方案 §6.1）。
   */
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

/** 段落 token 计数用估算器：产品不引入真分词器（bench 才注入冻结的 BGE-M3）。 */
const COUNT_TOKENS = createEstimatingTokenCounter()

/**
 * 索引模型身份：端点 + 模型名（模型换了语义就换了，卡片必须重做）。
 *
 * 刻意比语义树的 `modelIdentity`（`provider:model@baseUrl`）**窄**：卡片只取决于
 * 「哪个模型、在哪个端点」——同一个模型挂在同一个端点上，无论 profile 标签叫 openai
 * 还是别的，产出的卡片逐字相同。把 provider 也拼进来，改一个标签就会让全部论文的
 * `structureHash` 失效，每篇重付一次卡片调用（R33）。
 *
 * **apiKey 绝不进指纹**：它会随 `paper_indexes.index_json` 落盘、也会进 bench 结果 JSON
 * （全局约束第 6 条）。
 */
function indexModelIdentity(profile: LLMProfile): string {
  return `${profile.baseUrl ?? ''}|${profile.model ?? ''}`
}

/**
 * 本节两个指纹是**产品侧自己的失效令牌**，bench 的 `runner/passageIndexHook.ts` 也有一对同名概念。
 *
 * 两侧的指纹值**永远不可比、也永远不该被比较**：它们由各自侧的输入算出（产品是默认切段参数 +
 * `baseUrl|model`，bench 是配置旋钮 + `env.model`），两侧的 token 计数器（产品的估算器 / bench 冻结的
 * BGE-M3）不进哈希——哈希只覆盖输入里被显式写进去的那几项，所以「数值相等」既不能推出「两侧口径
 * 相同」，也不能推出「这份索引在对面可用」。
 * 哪天真需要跨侧核对，比的是**输入**（schemaVersion / 切段参数 / maxInputChars / 模型身份），
 * 而不是这两个摘要。
 */

/** 当前切段配置指纹。产品不传 `segmentation`（管线用同一份默认值），两处必须同源。 */
function currentPassageConfigHash(): string {
  return passageConfigHash({ schemaVersion: PASSAGE_INDEX_SCHEMA_VERSION, segmentation: DEFAULT_PASSAGE_OPTIONS })
}

/** 当前卡片配置指纹：切段 + 提示词版本 + 输入上限 + 索引模型（端点与模型名）。 */
function currentStructureHash(profile: LLMProfile): string {
  return structureHash({
    schemaVersion: PASSAGE_INDEX_SCHEMA_VERSION,
    passageConfigHash: currentPassageConfigHash(),
    promptVersion: STRUCTURE_CARD_PROMPT_VERSION,
    maxInputChars: DEFAULT_MAX_INPUT_CHARS,
    model: indexModelIdentity(profile),
  })
}

/**
 * 记录是否**自称**段落索引（`version === 2`）。
 *
 * `parsePassageIndex` 的 `undefined` 有两种含义，处理方式相反：旧版（v1 平面）记录还能
 * 按旧路径服务，而「自称 v2 却解析失败」的记录绝不能当平面树用——`PassageIndex` 没有
 * `nodes`，下游的 `.length` / `.map` 会抛异常，正确处置是让这篇走后台重建。
 */
function claimsPassageIndex(raw: unknown): boolean {
  return typeof raw === 'object' && raw !== null
    && (raw as { version?: unknown }).version === PASSAGE_INDEX_VERSION
}

/**
 * 存量段落索引是否缺向量：只有「向量与当前模型同源且自洽」才算不缺。
 *
 * 判据与 `planPassageIndexRebuild` 的向量项逐字一致（来源模型不一致 / 没有向量 / 阶段不到 2），
 * 刻意不另立一套口径：两处一旦分叉，补建要么漏掉本该重算的那批（换了模型仍被判为「有向量」），
 * 要么每次模型就绪都白跑一遍。
 */
function lacksPassageVectors(index: PassageIndex, embedderId: string): boolean {
  return index.embedderId !== embedderId || index.passageVectors === undefined || index.stage < 2
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
  /**
   * 轻量语义树总开关；默认关闭（方案 §6.3：语义树退出默认检索路径）。
   * 用户显式开启后功能完全可用，代码与设置页开关都保留。
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
    indexedPapers.value = new Set(ids)
    abstractToken.value = (await window.db.settings.get('huggingface_token')) ?? ''
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
    // 改的若是当前索引配置的模型/端点（`TREE_CONFIG_PATCH_KEYS` = 建树指纹 `provider:model@baseUrl`
    // 的三要素），已建好的树随即失效，就绪集合要重算；拖温度或输出上限滑块不必付一次 tree.list
    // 的 IPC 开销。对段落索引这是个**超集**门（`indexModelIdentity` 只取 `baseUrl|model`，
    // 不含 provider），只改 provider 时多跑一次索引校验、不会漏作废（见 #R33）
    if (id === indexProfileId.value && TREE_CONFIG_PATCH_KEYS.some(key => key in patch)) {
      // 段落索引同理：在途构建按旧端点算出的结构卡片与 structureHash 已经不对了，
      // 作废让它们停止写盘（方案 §8），再把受影响的论文重新入队
      buildGeneration.invalidateAll()
      await refreshTreeReadyPapers()
      void reindexStalePapers().catch(() => {})
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
    // 换了索引配置就直接换了一套建树配置：就绪集合必须跟着重算。
    // 段落索引同理（与 updateProfile 的同一分支等价）：在途构建按旧端点算出的结构卡片
    // 与 structureHash 已经不对了，作废让它们停止写盘（方案 §8），再把受影响的论文重新入队
    buildGeneration.invalidateAll()
    await refreshTreeReadyPapers()
    void reindexStalePapers().catch(() => {})
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
        }, opts.onToken ? LLM_STREAM_TIMEOUT_MS : LLM_REQUEST_TIMEOUT_MS)
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
      // 温度与输出上限按模型代次决定发不发、发哪个字段名（见 generationParams）
      ...generationParams(profile.model, maxTokens, profile.temperature),
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

  // ---------- Passage Index (Staged Build) ----------

  /** 向量模型状态：设置页与诊断可读；失败只是没有向量，不影响阶段① */
  const vectorModelState = ref<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  let embedderInstance: Embedder | undefined
  let embedderPromise: Promise<Embedder | undefined> | undefined

  /**
   * 取向量模型。问答热路径**不 await** 它（提问不等待模型加载）：
   * 已就绪就用，没就绪这次问题就按可用信号降级。
   */
  async function currentEmbedder(): Promise<Embedder | undefined> {
    if (embedderInstance) return embedderInstance
    embedderPromise ??= loadEmbedder()
    return embedderPromise
  }

  async function loadEmbedder(): Promise<Embedder | undefined> {
    vectorModelState.value = 'loading'
    try {
      embedderInstance = await createTransformersEmbedder({ wasmPaths: './ort/' })
      vectorModelState.value = 'ready'
      // 模型刚就绪：此前按词法降级建好的论文还缺向量，补建一次（卡片复用，无 LLM 调用）
      void backfillPassageVectors().catch(() => {})
      return embedderInstance
    } catch {
      // 下载失败 / 离线无缓存：停留阶段①，下次导入或切换索引配置时重试
      vectorModelState.value = 'failed'
      embedderPromise = undefined
      return undefined
    }
  }

  /** 触发下载但不阻塞调用方（init / indexPaper / 切换索引 profile 时各调一次）。 */
  function ensureEmbedder(): Promise<Embedder | undefined> {
    return currentEmbedder()
  }

  /**
   * 段落混合检索的注入项（`deps.passage`）：模型**已就绪就用**，没就绪这次提问就按
   * 可用信号降级（词法模式）。
   *
   * 写成函数而不是常量：实例是随加载进度出现的，取用的那一刻才是它是否就绪的答案。
   * **绝不 await**（R35）——提问不等待模型下载，否则冷启动的第一问会被 35 MB 下载挡住。
   */
  function passageDeps(): RagPipelineDeps {
    return embedderInstance
      ? { passage: { embedder: embedderInstance, countTokens: COUNT_TOKENS } }
      : { passage: { countTokens: COUNT_TOKENS } }
  }

  /** 构建代次保护（方案 §8）：写盘前复核，过期的一代整体丢弃。 */
  const buildGeneration = createBuildGeneration()

  /**
   * 在途构建的两个里程碑。`indexingPapers` 只回答「有没有在途构建」，这里回答
   * 「阶段① 落盘了没有」与「整轮跑完没有」：提问路径等前者（不等卡片调用），
   * 重建队列等后者（等在途构建结束，才能以新一代重新入队）。
   */
  const inFlightBuilds = new Map<string, { stage1: Promise<void>; build: Promise<void> }>()

  async function indexPaper(paperId: string, opts: IndexPaperOptions = {}): Promise<void> {
    if (indexingPapers.value.has(paperId)) return
    indexingPapers.value.add(paperId)
    const token = buildGeneration.begin(paperId)
    // 构建一开始就把模型下载的「火」点起来（不 await，也不阻塞阶段①）；
    // 这次构建若正好赶上模型就绪，`loadEmbedder` 的补建会把缺向量的论文一起收走
    void ensureEmbedder()
    let markStage1!: () => void
    const stage1 = new Promise<void>(resolve => { markStage1 = resolve })
    // 先挂里程碑再开跑：构建体第一行就有 await，不会抢在挂载之前写盘
    const build = runIndexBuild(paperId, token, markStage1, opts)
    inFlightBuilds.set(paperId, { stage1, build })
    try {
      await build
    } finally {
      inFlightBuilds.delete(paperId)
      indexingPapers.value.delete(paperId)
    }
  }

  /** `indexPaper` 的构建体（拆出来只为让代次快照、里程碑与收尾各有唯一出口）。 */
  async function runIndexBuild(
    paperId: string,
    token: number,
    markStage1: () => void,
    opts: IndexPaperOptions,
  ): Promise<void> {
    try {
      const base64 = await window.db.paper.readFile(paperId)
      if (!base64) throw new Error('论文文件缺失')
      const pages = await extractPages(base64)
      // 配置快照：整轮构建（含阶段③ 的卡片调用）都用开始这一刻的 profile，
      // 中途切 profile 只会让这一代作废（见 persist 里的代次复核）
      const buildProfile: LLMProfile = { ...indexProfile.value }
      const stored = await window.db.index.get(paperId)
      const existing = stored ? parsePassageIndex(stored.indexJson) : undefined
      // 只用**已经加载好**的向量模型实例，绝不 await：冷启动时它可能要下载 35 MB，
      // 阶段①（本地切段 + 标题卡片 + 落盘）不能被它挡在前面——「阶段① <1 秒即可提问」
      // 与「提问不等待卡片调用」是同一件事的两面。模型缺席是**受支持的降级态**：
      // 阶段① 与卡片照常产出、记录按词法模式服务，模型就绪后由 `backfillPassageVectors` 补齐
      const embedder = embedderInstance

      const { rest } = await startPassagePipeline(
        pages,
        {
          llm: prompt => callLLM([{ role: 'user', content: prompt }], buildProfile),
          countTokens: COUNT_TOKENS,
          ...(embedder ? { embedder } : {}),
          passageConfigHash: currentPassageConfigHash(),
          structureHash: currentStructureHash(buildProfile),
          maxInputChars: DEFAULT_MAX_INPUT_CHARS,
          // 产品不传 `segmentation`：管线回落到与 `passageConfigHash` 同源的那份默认值
          persist: (next: PassageIndex) => {
            // 期间切了索引 profile 或这一篇被重新触发构建：这一代结果整体丢弃，不写盘。
            // 注意是「整体」——不能只丢卡片而把段落写进去，混合代数会让索引
            // 与它自称的 structureHash 对不上
            if (!buildGeneration.isCurrent(paperId, token)) return
            return window.db.index.set(paperId, JSON.stringify(serializePassageIndex(next)), JSON.stringify(pages))
          },
        },
        { existing },
      )
      // 阶段① 已落盘（上一步的 persist 与这里用同一个代次复核）：放行等里程碑的提问路径
      markStage1()
      // 写盘被代次守卫拦下时这一代什么都没落盘，绝不能把这篇记进「已建立索引」：
      // 那个集合是索引徽标与「重建全部语义树」的目标列表，谎报会去重建一篇没有索引的论文
      if (buildGeneration.isCurrent(paperId, token)) {
        indexedPapers.value = new Set([...indexedPapers.value, paperId])
      }
      // 阶段②③ 继续在后台跑：提问路径（`syncStage1Only`）只等阶段①，不等待卡片调用（方案 §6.1）
      void rest.catch(() => {})
      if (!opts.syncStage1Only) await rest.catch(() => {})
    } finally {
      // 失败或提前返回都要放行等里程碑的人：否则提问会一直等一篇永远写不出记录的论文
      markStage1()
    }
  }

  /**
   * 让某篇论文的阶段① 落盘，供提问路径在「读不到记录」时补齐（方案 §6.1）。
   *
   * - 已有在途构建（导入构建 / 后台重建）→ 等它的阶段① 里程碑就返回：提问**不等待卡片调用**，
   *   也绝不因为 `indexingPapers` 去重让 `indexPaper` 立刻返回、再读一行还空着的记录，
   *   就把这篇论文从回答里静默丢掉；
   * - 没有在途构建 → 同步跑一次阶段①（本地切段 + 落盘，不碰模型、不碰 LLM）。
   */
  async function waitForStage1(paperId: string): Promise<void> {
    const pending = inFlightBuilds.get(paperId)
    if (pending) return pending.stage1
    await indexPaper(paperId, { syncStage1Only: true })
    // 这一次可能刚好被在途构建去重挡回（别的构建抢先开始）：再认一次它的里程碑
    await inFlightBuilds.get(paperId)?.stage1
  }

  /**
   * 重新入队：先等在途构建跑完，再以**新一代**重建这篇论文。
   *
   * 在途构建恰恰是「刚被作废」的那一批（配置一变 `invalidateAll` 就丢掉了它的写盘），
   * 而 `indexPaper` 对在途论文直接返回（去重）——不等就跑等于把这篇漏掉，它手里那条
   * 旧哈希的记录永远等不到重建。旧构建结束、`indexingPapers` 清空之后，新一代才起得来。
   */
  async function reindexPaper(paperId: string): Promise<void> {
    await inFlightBuilds.get(paperId)?.build
    await indexPaper(paperId)
  }

  /**
   * 索引 profile 变了（端点 / 模型）→ 每篇论文的 structureHash 随之改变 → 卡片与卡片向量全部过期。
   * 逐个重新入队，**串行**（`await` 每一篇）而不是并发铺开：阶段③ 是要计费的 LLM 调用，
   * 一次导入几十篇论文时并发会把服务商打爆。调用方用 `void` 脱离，不阻塞设置页。
   * 具体重建到哪一阶段交给 `planPassageIndexRebuild` 判断（结构没变时只重算向量）。
   */
  async function reindexStalePapers(): Promise<void> {
    const papers = (await window.db.paper.list()) as Array<{ id: string }>
    for (const paper of papers) {
      try {
        await reindexPaper(paper.id)
      } catch {
        // 单篇失败不影响其余论文：与 collectIndexedPapers 的容错口径一致
      }
    }
  }

  /**
   * 向量模型就绪后补齐「只有词法层」的论文：逐篇读记录，只重建确实缺向量的那些。
   *
   * 判据沿用 `planPassageIndexRebuild` 的向量规则（见 `lacksPassageVectors`），不另立一套口径。
   * 结构哈希没变 → 卡片原样复用，这次补齐**不产生任何 LLM 调用**；串行且逐篇容错
   * （与 `reindexStalePapers` 同口径），调用方用 `void` 脱离。
   */
  async function backfillPassageVectors(): Promise<void> {
    const embedder = embedderInstance
    if (!embedder) return
    const papers = (await window.db.paper.list()) as Array<{ id: string }>
    for (const paper of papers) {
      try {
        const stored = await window.db.index.get(paper.id)
        const index = stored ? parsePassageIndex(stored.indexJson) : undefined
        // 没有记录 / 记录根本解析不出来：那不是「缺向量」，交给导入与提问路径各自重建
        if (!index || !lacksPassageVectors(index, embedder.id)) continue
        await reindexPaper(paper.id)
      } catch {
        // 单篇失败不影响其余论文：与 reindexStalePapers 的容错口径一致
      }
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
   * 强制重建所有已索引论文的语义树（设置页的显式路径）。
   * 缓存键已覆盖构建配置，这里服务的是「配置没变但就是想换一棵树」：
   * 只重建树（每篇一次调用），不必连带重跑成本更高的平面索引。逐篇串行，避免同时打出 N 个请求。
   * 失败篇数之外还回收首个可展示的原因，否则设置页只能报「失败」而说不出为什么（#13）。
   */
  async function rebuildAllTrees(): Promise<TreeRebuildSummary> {
    const summary: TreeRebuildSummary = { attempted: 0, rebuilt: 0, failed: 0, skipped: 0 }
    for (const paperId of [...indexedPapers.value]) {
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
    patch: { content?: string; sources?: SourceRef[]; error?: string; truncated?: boolean; context?: string },
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

  async function readPaperPages(paperId: string): Promise<string[]> {
    const stored = await window.db.index.get(paperId)
    if (stored) return JSON.parse(stored.pagesJson)

    const base64 = await window.db.paper.readFile(paperId)
    if (!base64) throw new Error('找不到论文 PDF 文件')
    return extractPages(base64)
  }

  /**
   * `/abstract` 的来源只有论文标题与 id（摘要没有页码，芯片不可跳页）。
   */
  async function generateAbstract(conv: Conversation): Promise<{ content: string; sources: SourceRef[] }> {
    if (conv.paperIds.length === 0) throw new Error('请先在当前对话中选择至少一篇论文')
    if (!abstractToken.value) throw new Error('请先在设置中填写 Hugging Face Token')

    const sections: string[] = []
    const sources: SourceRef[] = []
    for (const paperId of conv.paperIds) {
      const [paper, pages] = await Promise.all([
        window.db.paper.get(paperId),
        readPaperPages(paperId),
      ])
      const title = paper?.title || `论文 ${sources.length + 1}`
      const text = pages.join('\n\n')
      const summary = await summarizeAcademicText(text, abstractToken.value)
      sections.push(conv.paperIds.length > 1 ? `## ${title}\n\n${summary}` : summary)
      sources.push({ label: title, paperId })
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
      if (!stored) {
        // 没有记录：导入时后台预处理未完成（LLM 未配置等），或这一篇正在构建中。
        // 前者同步补阶段①（本地切段，<1 秒）；后者等它的阶段① 里程碑再重读——
        // 绝不因为 `indexingPapers` 去重让 `indexPaper` 立刻返回、再读到一行空记录
        // 就把这篇论文从回答里静默丢掉（方案 §6.1）。两条路径都只等阶段①：
        // ②③ 继续在后台跑，提问不等待卡片调用
        try {
          await waitForStage1(paperId)
          stored = await window.db.index.get(paperId)
        } catch { /* ignore — no index available for this paper */ }
      }
      if (!stored) continue

      const pages: string[] = JSON.parse(stored.pagesJson)
      let rawIndex: unknown
      try {
        rawIndex = JSON.parse(stored.indexJson)
      } catch {
        rawIndex = undefined
      }
      const passageIndex = parsePassageIndex(rawIndex)
      if (passageIndex) {
        // 段落路径：`tree` 用卡片/标题推导的那棵，检索交由 `passageIndex`。
        // D57：这里**不挂 `semantic`**——两者互斥是 `treeRouted` 保持诚实的前提
        papers.push({ tree: passageIndex.tree, pages, passageIndex })
        paperIds.push(paperId)
        continue
      }

      // 到此为止都拿不到可用的 v2 索引。两种记录必须分开处置（R25）：
      // 旧版（v1 平面）索引自己还能用，先按旧路径服务，同时后台重建——重建完成前
      // 绝不静默切换路径（方案 §6.2 的失效规则）；而「自称 v2 却解析失败」（或连平面
      // 树都拼不出来）的记录绝不能塞进 `tree`：`PassageIndex` 没有 `nodes`，下游的
      // `.length` / `.map` 会抛异常，本次跳过该篇、让后台重建补齐
      const usableAsFlatTree = !claimsPassageIndex(rawIndex)
        && Array.isArray((rawIndex as { nodes?: unknown } | undefined)?.nodes)
      void indexPaper(paperId, { syncStage1Only: true }).catch(() => {})
      if (!usableAsFlatTree) continue

      const semantic = await loadSemanticIndex(paperId)
      papers.push({ tree: rawIndex as IndexNode, pages, ...(semantic ? { semantic } : {}) })
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
    // 保留 paperIds：来源 refs 需要「第 i 篇检索结果」对应的论文 id（ids 与 papers 一一对齐）
    let indexedIds: string[] = []
    if (!context && conv.paperIds.length > 0) {
      const collected = await collectIndexedPapers(conv)
      papers = collected.papers
      indexedIds = collected.paperIds
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
    const result = await runRagPipeline(
      papers,
      userMessage,
      history,
      (prompt: string) => callLLM([{ role: 'user', content: prompt }]),
      generate,
      chatProfile.value.systemPrompt,
      { externalContext: context },
      // 向量模型只在这里注入（不等它）：已就绪就走向量混合检索，没就绪按词法降级（R35）
      passageDeps(),
    )
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
    // 重试是原地更新失败轮；首次提问才追加新消息
    if (opts?.writeBack) {
      await updateMessage(conv.id, opts.writeBack, {
        content: result.answer,
        sources: sourceRefs.length ? sourceRefs : undefined,
        error: '',
        truncated: lastTruncated,
      })
    } else {
      await addMessage(conv.id, 'assistant', result.answer, sourceRefs.length ? sourceRefs : undefined, { truncated: lastTruncated })
    }
  }

  async function sendMessage(convId: string, userMessage: string, context?: string): Promise<string> {
    const conv = conversations.value.find(c => c.id === convId)
    if (!conv) throw new Error('Conversation not found')

    // 划选原文随用户消息持久化：失败轮重试时才能重放同一上下文（#2）
    await addMessage(convId, 'user', userMessage, undefined, context ? { context } : undefined)

    try {
      // 命令只在本地识别一次：未知的 `/xxx` 直接回提示，不发模型（#8）
      const normalized = userMessage.trim().toLowerCase()
      if (normalized.startsWith('/') && normalized !== '/abstract') {
        await addMessage(convId, 'assistant', `未识别的命令：${userMessage.trim()}。当前可用命令：/abstract（总结当前所选论文）。`)
        return userMessage
      }
      if (normalized === '/abstract') {
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
      // 单次写回：成功才落内容，失败由 catch 保持失败态，中途崩溃不留空窗。
      // history 截至失败轮的前一条（index-1 即本次提问）：问题只作为 query 出现一次，
      // 与首答的 slice(0, -1) 口径一致
      await generateReply(conv, userMessage.content, userMessage.context || undefined, index - 1, { writeBack: messageId })
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

    // 划选提问的原文已随用户消息持久化：与重试同构，直接重放该上下文并跳过
    // 论文收集/改写/评分——否则续写会换一个问题继续写，与首答语义分叉（#2）
    const papers = userMessage.context ? [] : conv.paperIds.length > 0 ? (await collectIndexedPapers(conv)).papers : []
    const history = conv.messages.slice(0, index).map(m => ({ role: m.role, content: m.content }))
    // 改写阶段把「已输出的半截回答」也算作上一轮：与正常追问时的上下文一致，
    // 否则续写往往会因历史轮数不足而跳过查询改写（#3）
    const priorTurns = [...history, { role: 'assistant' as const, content: target.content }]
    const retrieval = await retrieveRagContext(
      papers,
      userMessage.content,
      priorTurns,
      (prompt: string) => callLLM([{ role: 'user', content: prompt }]),
      userMessage.context ? { externalContext: userMessage.context } : {},
      // 续写与首答同一条检索口径：向量模型已就绪就用，不等它（R35）
      passageDeps(),
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
    treeEnabled, treeReadyPapers, treeIndexingPapers, vectorModelState,
    init,
    addProfile, updateProfile, removeProfile,
    setChatProfileId, setIndexProfileId, setAbstractToken, setTreeEnabled,
    newConversation, addMessage, updateMessage, removeConversation, discardEmptyConversation, syncPaperIds, autoTitleConversation,
    sendMessage, retryMessage, continueMessage, requestCompletion,
    collectIndexedPapers, indexPaper, buildPaperTree, rebuildAllTrees, loadSemanticIndex,
    ABSTRACT_MODEL,
  }
})
