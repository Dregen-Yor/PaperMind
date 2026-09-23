import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { isProxy } from 'vue'

// pageIndex.ts (imported by chat.ts) pulls in pdfjs-dist which needs DOMMatrix — mock it in Node
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  default: {},
  GlobalWorkerOptions: { workerSrc: '' },
}))

// indexPaper 一进来就 `void ensureEmbedder()`：真实实现会动态 import transformers 并真的
// 发起权重下载（取缓存时还会碰 jsdom 未实现的 indexedDB）。单测里向量模型一律缺席——
// 阶段① 与卡片路径都不依赖它。
vi.mock('../utils/transformersEmbedder', () => ({
  createTransformersEmbedder: vi.fn().mockRejectedValue(new Error('测试不加载向量模型')),
}))

// 段落管线整篇替换了平面索引：extractPages 给出确定的页面文本（含标题行与小节），
// 让切段、卡片与落盘都用真实实现跑
vi.mock('../utils/pageIndex', async importOriginal => ({
  ...(await importOriginal<typeof import('../utils/pageIndex')>()),
  extractPages: async () => ['Abstract\nA short abstract.', 'Methods\nWe use BM25.'],
}))

import { useChatStore } from '../stores/chat'

/** 生成阶段走流式（#6）：回答请求按 OpenAI 兼容 SSE 返回。 */
const sse = (chunks: string[], finishReason = 'stop') => {
  const body = chunks.map(c => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`).join('')
    + `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n\n`
    + 'data: [DONE]\n\n'
  return { ok: true, status: 200, body: new Response(body).body }
}
describe('useChatStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    ;(globalThis as any).mockDb.chat.listConversations.mockResolvedValue([])
    ;(globalThis as any).mockDb.settings.get.mockResolvedValue(null)
    ;(globalThis as any).mockDb.index.list.mockResolvedValue([])
  })

  it('init loads conversations and default profile', async () => {
    const store = useChatStore()
    await store.init()
    expect(store.conversations).toHaveLength(0)
    expect(store.profiles).toHaveLength(1)
    expect(store.chatProfile.provider).toBe('openai')
    expect(store.loaded).toBe(true)
  })

  it('init restores saved profiles list', async () => {
    const savedProfiles = [
      { id: 'p1', name: 'Ollama', provider: 'ollama', model: 'llama3',
        apiKey: '', baseUrl: 'http://localhost:11434', temperature: 0.5,
        maxTokens: 1024, topK: 0, systemPrompt: '' },
    ]
    ;(globalThis as any).mockDb.settings.get.mockImplementation((key: string) => {
      if (key === 'llm_profiles') return Promise.resolve(savedProfiles)
      if (key === 'llm_profile_chat') return Promise.resolve('p1')
      if (key === 'llm_profile_index') return Promise.resolve('p1')
      return Promise.resolve(null)
    })
    const store = useChatStore()
    await store.init()
    expect(store.chatProfile.provider).toBe('ollama')
    expect(store.chatProfile.model).toBe('llama3')
  })

  it('newConversation creates and prepends to list', async () => {
    const store = useChatStore()
    await store.init()
    const conv = await store.newConversation('Test', ['p1'])
    expect(store.conversations).toHaveLength(1)
    expect(conv.title).toBe('Test')
    expect(conv.paperIds).toEqual(['p1'])
    expect(conv.messages).toHaveLength(0)
  })

  it('addMessage appends to conversation', async () => {
    const store = useChatStore()
    await store.init()
    const conv = await store.newConversation('Chat', [])
    await store.addMessage(conv.id, 'user', 'Hello')
    expect(conv.messages).toHaveLength(1)
    expect(conv.messages[0].role).toBe('user')
    expect(conv.messages[0].content).toBe('Hello')
  })

  it('autoTitleConversation names an untitled conversation from its first exchange', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: 'DeepSeek-R1 推理能力分析' } }] }),
    }) as any
    const store = useChatStore()
    await store.init()
    const conv = await store.newConversation('新对话', [])
    await store.addMessage(conv.id, 'user', 'DeepSeek R1 的推理能力有什么特点？')
    await store.addMessage(conv.id, 'assistant', '它通过强化学习提升了复杂推理表现。')

    await store.autoTitleConversation(conv.id)

    expect(conv.title).toBe('DeepSeek-R1 推理能力分析')
    expect((globalThis as any).mockDb.chat.updateConversation).toHaveBeenCalledWith(
      conv.id,
      { title: 'DeepSeek-R1 推理能力分析' },
    )
  })

  it('removeConversation deletes from list', async () => {
    const store = useChatStore()
    await store.init()
    const conv = await store.newConversation('Del', [])
    await store.removeConversation(conv.id)
    expect(store.conversations).toHaveLength(0)
  })

  it('updateProfile persists to settings', async () => {
    const store = useChatStore()
    await store.init()
    const id = store.chatProfile.id
    await store.updateProfile(id, { temperature: 1.5, model: 'gpt-4' })
    expect(store.chatProfile.temperature).toBe(1.5)
    expect(store.chatProfile.model).toBe('gpt-4')
    expect((globalThis as any).mockDb.settings.set).toHaveBeenCalledWith(
      'llm_profiles',
      expect.arrayContaining([expect.objectContaining({ temperature: 1.5 })]),
    )

    const profileWrite = (globalThis as any).mockDb.settings.set.mock.calls
      .find(([key]: [string]) => key === 'llm_profiles')
    expect(isProxy(profileWrite[1])).toBe(false)
    expect(profileWrite[1].every((profile: unknown) => !isProxy(profile))).toBe(true)
  })

  it('sendMessage throws for unknown conversation', async () => {
    const store = useChatStore()
    await store.init()
    await expect(store.sendMessage('nonexistent', 'hi')).rejects.toThrow('Conversation not found')
  })

  it('sendMessage calls LLM and appends both messages', async () => {
    global.fetch = vi.fn().mockResolvedValue(sse(['Answer'])) as any
    const store = useChatStore()
    await store.init()
    await store.updateProfile(store.chatProfile.id, { apiKey: 'sk-test' })
    const conv = await store.newConversation('Chat', [])
    const reply = await store.sendMessage(conv.id, 'Question')
    expect(reply).toBe('Answer')
    expect(conv.messages).toHaveLength(2)
    expect(conv.messages[1].role).toBe('assistant')
  })

  it('sendMessage skips query rewriting on first message (1 LLM call: answer only)', async () => {
    // 首条消息，无对话历史，应跳过查询改写：单节点 root 无子节点，scoreAndSelect 不调用 LLM，仅回答 = 1次
    let callCount = 0
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++
      return Promise.resolve(sse(['Answer']))
    }) as any

    ;(globalThis as any).mockDb.index.get.mockResolvedValue({
      indexJson: JSON.stringify({
        title: 'Paper', nodeId: 'root', startPage: 0, endPage: 0,
        summary: 'test paper', nodes: [],
      }),
      pagesJson: JSON.stringify(['page one text']),
    })

    const store = useChatStore()
    await store.init()
    await store.updateProfile(store.chatProfile.id, { apiKey: 'sk-test' })
    const conv = await store.newConversation('test', ['paper-1'])

    await store.sendMessage(conv.id, 'What is this paper about?')

    // 单节点（root 无子节点）scoreAndSelect 不调用 LLM，加上回答 = 1次
    expect(callCount).toBe(1)
  })

  it('sendMessage calls query rewriting when conversation has prior history (3 LLM calls total)', async () => {
    // 多节点 index，有历史时应触发改写：改写(1) + 评分(1) + 回答(1) = 3次
    let callCount = 0
    const scoreJson = { choices: [{ message: { content: '[{"id":0,"score":9},{"id":1,"score":2}]' } }] }
    global.fetch = vi.fn().mockImplementation((_url: string, init: any) => {
      callCount++
      // 只有生成请求带 stream；改写与评分仍是 JSON 响应
      if (JSON.parse(init.body).stream) return Promise.resolve(sse(['Answer']))
      return Promise.resolve({ ok: true, json: () => Promise.resolve(scoreJson) })
    }) as any

    ;(globalThis as any).mockDb.index.get.mockResolvedValue({
      indexJson: JSON.stringify({
        title: 'Paper', nodeId: 'root', startPage: 0, endPage: 3,
        summary: 'multi-section paper',
        nodes: [
          { title: 'Intro',    nodeId: '0', startPage: 0, endPage: 1, summary: 'intro', nodes: [] },
          { title: 'Methods',  nodeId: '1', startPage: 2, endPage: 3, summary: 'methods', nodes: [] },
        ],
      }),
      pagesJson: JSON.stringify(['p0', 'p1', 'p2', 'p3']),
    })

    const store = useChatStore()
    await store.init()
    await store.updateProfile(store.chatProfile.id, { apiKey: 'sk-test' })
    const conv = await store.newConversation('test', ['paper-1'])

    // 第一条消息（建立历史，不触发改写）
    callCount = 0
    await store.sendMessage(conv.id, 'What is this paper about?')
    const firstRoundCalls = callCount   // scoreAndSelect(1) + answer(1) = 2

    // 第二条消息（有历史，触发改写）
    callCount = 0
    await store.sendMessage(conv.id, 'What about the results?')

    // rewrite(1) + scoreAndSelect(1) + answer(1) = 3
    expect(callCount).toBe(3)
    expect(firstRoundCalls).toBe(2)
  })

  it('/abstract summarizes the selected paper with the dedicated Hugging Face model', async () => {
    ;(globalThis as any).mockDb.settings.get.mockImplementation((key: string) => {
      if (key === 'huggingface_token') return Promise.resolve('hf-test')
      return Promise.resolve(null)
    })
    ;(globalThis as any).mockDb.paper.get.mockResolvedValue({
      id: 'paper-1',
      title: 'Attention Is All You Need',
    })
    ;(globalThis as any).mockDb.index.get.mockResolvedValue({
      indexJson: '{}',
      pagesJson: JSON.stringify(['A short academic paper about transformer networks and attention.']),
    })
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{ summary_text: 'A transformer paper summary.' }]),
    }) as any

    const store = useChatStore()
    await store.init()
    const conv = await store.newConversation('Summary', ['paper-1'])
    const reply = await store.sendMessage(conv.id, '/abstract')

    expect(reply).toBe('A transformer paper summary.')
    expect(conv.messages.map(message => message.role)).toEqual(['user', 'assistant'])
    expect(conv.messages[1].sources).toEqual([{ label: 'Attention Is All You Need', paperId: 'paper-1' }])
    expect(global.fetch).toHaveBeenCalledOnce()
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api-inference.huggingface.co/models/Bashaarat1/t5-small-arxiv-summarizer',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer hf-test' }),
      }),
    )
  })

  it('/abstract requires a selected paper', async () => {
    const store = useChatStore()
    await store.init()
    await store.setAbstractToken('hf-test')
    const conv = await store.newConversation('Summary', [])

    await expect(store.sendMessage(conv.id, '/abstract'))
      .rejects.toThrow('请先在当前对话中选择至少一篇论文')
  })

  it('sendMessage rejects with a readable error when the LLM returns non-200', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: () => Promise.resolve({ error: { message: 'Invalid API key' } }),
    }) as any
    const store = useChatStore()
    await store.init()
    await store.updateProfile(store.chatProfile.id, { apiKey: 'sk-bad' })
    const conv = await store.newConversation('Chat', [])

    await expect(store.sendMessage(conv.id, 'hi'))
      .rejects.toThrow(/LLM 请求失败 \(401\).*Invalid API key/)
  })

  it('anthropic provider calls the Messages API and parses content[0].text', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: new Response(
        `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Bonjour' } })}\n\n`
        + `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' } })}\n\n`,
      ).body,
    }) as any
    const store = useChatStore()
    await store.init()
    await store.updateProfile(store.chatProfile.id, {
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      apiKey: 'sk-ant-1',
      baseUrl: 'https://api.anthropic.com',
    })
    const conv = await store.newConversation('Chat', [])
    const reply = await store.sendMessage(conv.id, 'hello')
    expect(reply).toBe('Bonjour')

    const [url, init] = (global.fetch as any).mock.calls[0]
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    expect(init.headers).toMatchObject({ 'x-api-key': 'sk-ant-1', 'anthropic-version': '2023-06-01' })
    const body = JSON.parse(init.body)
    expect(body.model).toBe('claude-3-5-sonnet')
    expect(body.max_tokens).toBe(4096)
    expect(body.messages.every((m: any) => m.role !== 'system')).toBe(true)
    expect(body.system).toContain('学术论文阅读助手')
  })
})

describe('段落索引的分阶段构建', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // 调用历史必须逐用例清空：下面「后台重建已启动」是拿 readFile 的调用当证据的
    vi.clearAllMocks()
    vi.mocked(window.db.paper.readFile).mockResolvedValue('BASE64')
    vi.mocked(window.db.index.get).mockResolvedValue(null)
  })

  it('indexPaper 落盘阶段① 后即可用，不等卡片调用', async () => {
    // 卡片调用永不返回：只有「阶段① 先落盘、提问路径不等卡片」的实现才能在这里拿到记录，
    // 老实现（等 LLM 建完平面索引再写盘）会让这个用例直接超时
    global.fetch = vi.fn(() => new Promise(() => {})) as never
    const store = useChatStore()

    await store.indexPaper('paper-1', { syncStage1Only: true })

    const saved = vi.mocked(window.db.index.set).mock.calls.at(-1)!
    const index = JSON.parse(saved[1] as string)
    expect(index.version).toBe(2)
    expect(index.passages.length).toBeGreaterThan(0)
    // 只写了阶段① 这一次：②③ 还在后台（卡片调用甚至没有返回）
    expect(vi.mocked(window.db.index.set)).toHaveBeenCalledTimes(1)
  })

  it('旧版（v1）索引不被解析为段落索引，且触发后台重建', async () => {
    vi.mocked(window.db.index.get).mockResolvedValue({
      indexJson: JSON.stringify({ title: 'Paper', nodeId: 'root', startPage: 0, endPage: 1, summary: '', nodes: [] }),
      pagesJson: JSON.stringify(['page one']),
    })
    // 重建的第一步就是读原文；这里让它失败，正好证明「本次提问不依赖重建完成」
    vi.mocked(window.db.paper.readFile).mockResolvedValue(null)
    const store = useChatStore()

    const papers = await store.collectIndexedPapers({ id: 'c1', paperIds: ['paper-1'] } as never)

    expect(papers.papers[0].passageIndex).toBeUndefined()
    expect(papers.papers[0].tree.nodeId).toBe('root')
    expect(vi.mocked(window.db.paper.readFile)).toHaveBeenCalledWith('paper-1')
  })
})
