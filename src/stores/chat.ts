import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { extractPages, buildPageIndex, scoreAndSelect } from '../utils/pageIndex'

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
}

export interface Conversation {
  id: string
  title: string
  paperIds: string[]
  messages: Message[]
  createdAt: number
}

const DEFAULT_PROFILE: LLMProfile = {
  id: 'default',
  name: '默认配置',
  provider: 'openai',
  model: 'gpt-4o',
  apiKey: '',
  baseUrl: 'https://api.openai.com/v1',
  temperature: 0.7,
  maxTokens: 2048,
  topK: 0,
  systemPrompt: '你是一个专业的学术论文阅读助手，帮助用户理解和分析论文内容。',
}

const MATH_FORMAT_INSTRUCTION = '数学公式请使用 LaTeX：行内公式使用 $...$，独立公式使用 $$...$$。不要使用 \\(...\\) 或 \\[...\\] 包裹公式。'

const PROMPT_TEMPLATES = [
  { name: '逐段精读', prompt: '请逐段解析以下内容，解释关键概念、方法和结论。' },
  { name: '通俗解释', prompt: '请用通俗易懂的语言解释这段内容，假设我是该领域的初学者。' },
  { name: '提取要点', prompt: '请提取这段内容的核心要点，以列表形式呈现。' },
  { name: '批判性分析', prompt: '请批判性地分析这段内容的论证逻辑、潜在缺陷和未解决的问题。' },
  { name: '翻译为中文', prompt: '请将这段内容准确翻译为中文，保留专业术语。' },
]

export { PROMPT_TEMPLATES }

export const useChatStore = defineStore('chat', () => {
  const conversations = ref<Conversation[]>([])
  const profiles = ref<LLMProfile[]>([{ ...DEFAULT_PROFILE }])
  const chatProfileId = ref<string>('default')
  const indexProfileId = ref<string>('default')
  const loaded = ref(false)
  const indexingPapers = ref<Set<string>>(new Set())
  const indexedPapers = ref<Set<string>>(new Set())

  const chatProfile = computed(() =>
    profiles.value.find(p => p.id === chatProfileId.value) ?? profiles.value[0],
  )
  const indexProfile = computed(() =>
    profiles.value.find(p => p.id === indexProfileId.value) ?? profiles.value[0],
  )

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
      await window.db.settings.set('llm_profiles', profiles.value)
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
    loaded.value = true
  }

  // ---------- Profile CRUD ----------

  async function addProfile(profile: Omit<LLMProfile, 'id'>): Promise<LLMProfile> {
    const newProfile: LLMProfile = { ...profile, id: crypto.randomUUID() }
    profiles.value.push(newProfile)
    await window.db.settings.set('llm_profiles', profiles.value)
    return newProfile
  }

  async function updateProfile(id: string, patch: Partial<Omit<LLMProfile, 'id'>>) {
    const idx = profiles.value.findIndex(p => p.id === id)
    if (idx === -1) return
    profiles.value[idx] = { ...profiles.value[idx], ...patch }
    await window.db.settings.set('llm_profiles', profiles.value)
  }

  async function removeProfile(id: string) {
    if (profiles.value.length <= 1) return  // 至少保留一个
    profiles.value = profiles.value.filter(p => p.id !== id)
    // 若删除的是当前选中项，自动切换到第一个
    if (chatProfileId.value === id) await setChatProfileId(profiles.value[0].id)
    if (indexProfileId.value === id) await setIndexProfileId(profiles.value[0].id)
    await window.db.settings.set('llm_profiles', profiles.value)
  }

  async function setChatProfileId(id: string) {
    chatProfileId.value = id
    await window.db.settings.set('llm_profile_chat', id)
  }

  async function setIndexProfileId(id: string) {
    indexProfileId.value = id
    await window.db.settings.set('llm_profile_index', id)
  }

  // ---------- LLM Call ----------

  async function callLLM(
    messages: { role: string; content: string }[],
    profileId?: string,
  ): Promise<string> {
    const profile =
      (profileId ? profiles.value.find(p => p.id === profileId) : undefined) ??
      chatProfile.value

    if (profile.provider === 'ollama') {
      const body: Record<string, unknown> = { model: profile.model, messages, stream: false }
      if (profile.topK > 0) body.options = { top_k: profile.topK }
      const res = await fetch(`${profile.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      return data.message?.content ?? ''
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (profile.provider === 'openai') headers['Authorization'] = `Bearer ${profile.apiKey}`
    if (profile.provider === 'anthropic') {
      headers['x-api-key'] = profile.apiKey
      headers['anthropic-version'] = '2023-06-01'
    }

    const body: Record<string, unknown> = {
      model: profile.model,
      messages,
      temperature: profile.temperature,
      max_tokens: profile.maxTokens,
    }
    if (profile.provider === 'anthropic' && profile.topK > 0) body.top_k = profile.topK

    const res = await fetch(`${profile.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    const data = await res.json()
    return data.choices?.[0]?.message?.content ?? ''
  }

  // ---------- Query Rewrite ----------

  async function rewriteQuery(
    query: string,
    history: Message[],
    llmFn: (prompt: string) => Promise<string>,
  ): Promise<string> {
    const historyText = history.map(m => `${m.role}: ${m.content}`).join('\n')
    const prompt = `Based on the following conversation, rewrite the user's latest question as a self-contained retrieval query. Resolve pronouns, expand abbreviations, preserve technical terms. Return ONLY the rewritten query, no explanation.

Conversation:
${historyText}

Latest question: ${query}`
    try {
      const result = await llmFn(prompt)
      return result.trim() || query
    } catch {
      return query
    }
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
    } finally {
      indexingPapers.value.delete(paperId)
    }
  }

  // ---------- Conversation CRUD ----------

  async function newConversation(title: string, paperIds: string[]): Promise<Conversation> {
    const conv: Conversation = { id: crypto.randomUUID(), title, paperIds, messages: [], createdAt: Date.now() }
    await window.db.chat.createConversation({ id: conv.id, title, paperIds, createdAt: conv.createdAt })
    conversations.value.unshift(conv)
    return conv
  }

  async function addMessage(convId: string, role: 'user' | 'assistant', content: string, sources?: string[]) {
    const conv = conversations.value.find(c => c.id === convId)
    if (!conv) return
    const msg: Message = { id: crypto.randomUUID(), role, content, sources, timestamp: Date.now() }
    conv.messages.push(msg)
    await window.db.chat.addMessage({ id: msg.id, conversationId: convId, role, content, sources: sources ?? [], timestamp: msg.timestamp })
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

  // ---------- Send Message (RAG 3-call pipeline) ----------

  async function sendMessage(convId: string, userMessage: string, context?: string): Promise<string> {
    const conv = conversations.value.find(c => c.id === convId)
    if (!conv) throw new Error('Conversation not found')

    await addMessage(convId, 'user', userMessage)

    let ragSources: string[] = []
    if (!context && conv.paperIds.length > 0) {
      const parts: string[] = []
      const llmFn = (prompt: string) => callLLM([{ role: 'user', content: prompt }])

      // Call 1（条件）：查询改写 — 取当前消息之前的最近3条历史
      const historyBeforeCurrent = conv.messages.slice(-4, -1)
      const retrievalQuery = historyBeforeCurrent.length >= 2
        ? await rewriteQuery(userMessage, historyBeforeCurrent, llmFn)
        : userMessage

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
        const tree = JSON.parse(stored.indexJson)
        const pages = JSON.parse(stored.pagesJson)
        // Call 2：评分多选
        const { context: ctx, sources } = await scoreAndSelect(tree, pages, retrievalQuery, llmFn)
        parts.push(ctx)
        ragSources.push(...sources)
      }
      if (parts.length > 0) context = parts.join('\n\n---\n\n')
    }

    const profile = chatProfile.value
    const messages = [
      {
        role: 'system',
        content: `${profile.systemPrompt}\n\n${MATH_FORMAT_INSTRUCTION}` +
          (context ? `\n\n参考内容：\n${context}` : ''),
      },
      ...conv.messages.slice(-20).map(m => ({ role: m.role, content: m.content })),
    ]

    // Call 3: generate answer
    const reply = await callLLM(messages)
    await addMessage(convId, 'assistant', reply, ragSources.length ? ragSources : undefined)
    return reply
  }

  return {
    conversations, profiles, chatProfileId, indexProfileId,
    chatProfile, indexProfile,
    loaded, indexingPapers, indexedPapers,
    init,
    addProfile, updateProfile, removeProfile,
    setChatProfileId, setIndexProfileId,
    newConversation, addMessage, removeConversation, syncPaperIds,
    sendMessage, indexPaper,
  }
})
