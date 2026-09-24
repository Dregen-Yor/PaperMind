import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { isProxy } from 'vue'

// pageIndex.ts (imported by chat.ts) pulls in pdfjs-dist which needs DOMMatrix — mock it in Node
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  default: {},
  GlobalWorkerOptions: { workerSrc: '' },
}))

import { useChatStore, CAPPED_MAX_TOKENS_DEFAULT } from '../stores/chat'
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

import { createTransformersEmbedder } from '../utils/transformersEmbedder'
import { encodeVectors, type Embedder } from '../utils/embedder'

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
    // 默认「不限制」，而 Messages API 的 max_tokens 必填，故发兜底上限
    expect(body.max_tokens).toBe(CAPPED_MAX_TOKENS_DEFAULT)
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

/** 向量模型身份（`passagesUsable` / `planPassageIndexRebuild` 都按它判断「向量是不是这个模型算的」） */
const EMBEDDER_ID = 'test-embedder'

const fakeEmbedder = {
  id: EMBEDDER_ID,
  embedPassages: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array([1, 0, 0]))),
  embedQuery: vi.fn(async () => new Float32Array([1, 0, 0])),
} as unknown as Embedder

/**
 * 段落索引构建的公共测试环境（`chat.store.test.ts` 用真实管线，不给 `passageIndexBuilder` 打桩）：
 * - `extractPages` 由文件顶部的 mock 给出固定的两页；
 * - `index.get` 是**伪 DB**：`index.set` 写进去的记录由它读回来——提问路径「重读落盘行」
 *   才是真读盘，否则「在途构建 → 阶段① 落盘 → 重读」这条链只能用替身自证；
 * - 卡片调用（阶段③）给一个不返回的应答：不连网，也让「等 ②③」的用例直接超时暴露；
 * - 向量模型按用例默认缺席（第一次加载失败），需要时用例自己换成成功。
 */
function passageBuildEnv() {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.mocked(window.db.paper.readFile).mockResolvedValue('BASE64')
  vi.mocked(window.db.paper.list).mockResolvedValue([])
  vi.mocked(window.db.index.get).mockImplementation(async (paperId: string) => {
    const write = vi.mocked(window.db.index.set).mock.calls.filter(call => call[0] === paperId).at(-1)
    return write ? { indexJson: write[1], pagesJson: write[2] } : null
  })
  vi.mocked(createTransformersEmbedder).mockRejectedValue(new Error('测试不加载向量模型'))
  global.fetch = vi.fn(() => new Promise(() => {})) as never
}

/** 把一个用例要卡住的第一次 `index.get` 换成可控的挂起读（构建停在阶段① 之前）。 */
function holdNextIndexRead(): () => void {
  let release!: () => void
  vi.mocked(window.db.index.get).mockImplementationOnce(
    () => new Promise(resolve => { release = () => resolve(null) }),
  )
  return () => release()
}

describe('冷启动：阶段① 不等向量模型', () => {
  beforeEach(passageBuildEnv)

  it('模型仍在下载（永不返回）时，阶段① 照常落盘并产出段落', async () => {
    // 冷启动的 35 MB 下载挂在那里：阶段①（本地切段 + 落盘）与它无关，绝不能被挡住
    vi.mocked(createTransformersEmbedder).mockImplementation(() => new Promise(() => {}) as never)
    const store = useChatStore()

    await store.indexPaper('paper-1', { syncStage1Only: true })

    const saved = vi.mocked(window.db.index.set).mock.calls.at(-1)!
    const index = JSON.parse(saved[1] as string)
    expect(index.passages.length).toBeGreaterThan(0)
    // 模型缺席是**受支持的降级态**：记录如实没有向量，检索按词法模式服务
    expect(index.passageVectors).toBeUndefined()
  })
})

describe('提问路径与在途构建', () => {
  beforeEach(passageBuildEnv)

  it('导入构建在途时提问：等它的阶段① 落盘再重读，不把这篇论文静默丢掉', async () => {
    const store = useChatStore()
    // 把构建卡在「读已有记录」这一步：此刻它还没进管线，阶段① 尚未落盘
    const releaseBuild = holdNextIndexRead()
    const build = store.indexPaper('paper-1')
    await vi.waitFor(() => expect(vi.mocked(window.db.index.get)).toHaveBeenCalledTimes(1))

    let settled = false
    const question = store.collectIndexedPapers({ id: 'c1', paperIds: ['paper-1'] } as never)
      .then(result => { settled = true; return result })
    // 提问读到的是空记录，接下来必须停在阶段① 里程碑上，而不是立刻放弃这篇论文
    await vi.waitFor(() => expect(vi.mocked(window.db.index.get)).toHaveBeenCalledTimes(2))
    expect(settled).toBe(false)

    releaseBuild()
    const result = await question

    expect(settled).toBe(true)
    // 阶段① 的记录此刻已落盘：这篇论文在回答里（旧实现读完空行就 continue 了）
    expect(result.paperIds).toEqual(['paper-1'])
    expect(result.papers[0].passageIndex).toBeDefined()
    expect(vi.mocked(window.db.index.set)).toHaveBeenCalledTimes(1)
    // 卡片调用还挂在那里（永不返回），提问却已经拿到索引：没有等待卡片调用
    expect(global.fetch).toHaveBeenCalled()
  })
})

describe('代次作废与「已建立索引」标记', () => {
  beforeEach(passageBuildEnv)

  it('正对照：没有失效时构建完成会写盘，并记入「已建立索引」', async () => {
    const store = useChatStore()

    await store.indexPaper('paper-1', { syncStage1Only: true })

    expect(vi.mocked(window.db.index.set)).toHaveBeenCalledTimes(1)
    expect(store.indexedPapers.has('paper-1')).toBe(true)
  })

  it('代次作废的那一代不写盘，也不把论文记成「已建立索引」', async () => {
    const store = useChatStore()
    const releaseBuild = holdNextIndexRead()
    const build = store.indexPaper('paper-1', { syncStage1Only: true })
    await vi.waitFor(() => expect(vi.mocked(window.db.index.get)).toHaveBeenCalledTimes(1))
    // 构建在途时换了索引配置：这一代的写盘整体作废
    await store.updateProfile(store.indexProfileId, { model: 'another-model' })
    releaseBuild()
    await build

    expect(vi.mocked(window.db.index.set)).not.toHaveBeenCalled()
    // 徽标与「重建全部语义树」的目标列表都不该包含一篇实际没有索引的论文
    expect(store.indexedPapers.has('paper-1')).toBe(false)
  })
})

describe('索引配置切换后的重建队列', () => {
  beforeEach(passageBuildEnv)

  it('等在途构建结束再重新入队：刚被作废的那篇不会漏掉', async () => {
    vi.mocked(window.db.paper.list).mockResolvedValue([{ id: 'paper-1' }])
    const store = useChatStore()
    const releaseBuild = holdNextIndexRead()
    const build = store.indexPaper('paper-1', { syncStage1Only: true })   // 在途构建（写盘将被作废）
    await vi.waitFor(() => expect(vi.mocked(window.db.index.get)).toHaveBeenCalledTimes(1))

    await store.updateProfile(store.indexProfileId, { model: 'another-model' })   // 作废 + 启动重建队列
    // 队列必须先等在途构建结束：并发再开一轮只会在 `indexingPapers` 处被去重挡回，
    // 那篇论文就永远等不到新一代的重建
    await vi.waitFor(() => expect(vi.mocked(window.db.paper.list)).toHaveBeenCalledTimes(1))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(vi.mocked(window.db.paper.readFile)).toHaveBeenCalledTimes(1)

    releaseBuild()
    await build
    // 在途构建结束后队列才重新入队：重读原文（重建第一步）是它真的跑起来了的证据
    await vi.waitFor(() => expect(vi.mocked(window.db.paper.readFile)).toHaveBeenCalledTimes(2))
  })
})

describe('向量模型就绪后的补建', () => {
  beforeEach(passageBuildEnv)

  it('只重建缺向量的论文：已有向量的那篇不碰', async () => {
    // 先让 store 自己写出一条阶段① 记录，再把它改造成「向量就是这个模型算的」同款记录：
    // 手工拼记录会漏掉 `passageConfigHash` / `tree` 的形态，于是「有向量」的用例其实走的是解析失败
    vi.mocked(window.db.index.get).mockResolvedValue(null)
    const store = useChatStore()
    await store.indexPaper('p-lex', { syncStage1Only: true })
    const write = vi.mocked(window.db.index.set).mock.calls.at(-1)!
    const stage1 = JSON.parse(write[1] as string) as { passages: unknown[] }
    const dense = JSON.stringify({
      ...stage1,
      stage: 2,
      embedderId: EMBEDDER_ID,
      vectorDim: 3,
      passageVectors: encodeVectors(stage1.passages.map(() => new Float32Array([1, 0, 0]))),
    })
    vi.mocked(window.db.index.set).mockClear()
    vi.mocked(window.db.index.get).mockImplementation(async (paperId: string) => {
      if (paperId === 'p-dense') return { indexJson: dense, pagesJson: write[2] }
      if (paperId === 'p-lex') return { indexJson: write[1], pagesJson: write[2] }
      return null
    })
    // p-dense 排在前：它被跳过、队列走到 p-lex，「没有重建它」才是真读数而非「还没轮到」
    vi.mocked(window.db.paper.list).mockResolvedValue([{ id: 'p-dense' }, { id: 'p-lex' }])
    // 第二次加载成功（第一次是上面那次构建触发的、按环境默认失败）→ 触发补建
    vi.mocked(createTransformersEmbedder).mockResolvedValue(fakeEmbedder)
    // 清掉「造记录」那一步的调用历史：下面两条断言只认补建跑出来的读原文
    vi.mocked(window.db.paper.readFile).mockClear()

    await store.indexPaper('p-trigger', { syncStage1Only: true })

    await vi.waitFor(() => expect(vi.mocked(window.db.paper.readFile)).toHaveBeenCalledWith('p-lex'))
    expect(vi.mocked(window.db.paper.readFile)).not.toHaveBeenCalledWith('p-dense')
  })
})

/**
 * 语义树退出默认路径（方案 §6.3）：默认关闭，只有显式存过「开」才开启。
 * 设置页开关与建树代码都保留，变的只是默认值与加载判据。
 */
describe('语义树默认值', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    vi.mocked(window.db.chat.listConversations).mockResolvedValue([])
    vi.mocked(window.db.index.list).mockResolvedValue([])
    // 没有这一行时真实桥返回的是 null（electron/db/index.ts：`row ? JSON.parse(row.value) : null`），
    // 不是 undefined——mock 成 undefined 会走一条生产不存在的分支
    vi.mocked(window.db.settings.get).mockResolvedValue(null)
  })

  it('未存过偏好时 treeEnabled 默认 false', async () => {
    const store = useChatStore()
    await store.init()
    expect(store.treeEnabled).toBe(false)
  })

  it('存过 true 时不被强制覆盖', async () => {
    vi.mocked(window.db.settings.get).mockImplementation(async (key: string) =>
      key === 'semantic_tree_enabled' ? 'true' : null)
    const store = useChatStore()
    await store.init()
    expect(store.treeEnabled).toBe(true)
  })

  it('存过布尔 true（设置页写入的真实编码）同样不被强制覆盖', async () => {
    // settings.get 在 IPC 那头是 JSON.parse(row.value)：setTreeEnabled(true) 写进去的是布尔，
    // 读回来也是布尔。只认字符串 'true' 会让开关在重启后被自己的默认值悄悄吃掉。
    vi.mocked(window.db.settings.get).mockImplementation(async (key: string) =>
      key === 'semantic_tree_enabled' ? true : null)
    const store = useChatStore()
    await store.init()
    expect(store.treeEnabled).toBe(true)
  })
})

/**
 * 向量模型生命周期（方案 §6.3 / §8）：启动点火、但任何一条提问路径都不等它加载。
 */
describe('向量模型生命周期与提问热路径', () => {
  beforeEach(passageBuildEnv)

  it('init 在后台点火加载向量模型：下载还没回来也不阻塞启动', async () => {
    // 下载永不返回：init 只负责点火（模型在启动时就开始下，而不是等到第一次导入）
    vi.mocked(createTransformersEmbedder).mockImplementation(() => new Promise(() => {}) as never)
    const store = useChatStore()

    await store.init()

    expect(vi.mocked(createTransformersEmbedder)).toHaveBeenCalledTimes(1)
    expect(store.loaded).toBe(true)
    expect(store.vectorModelState).toBe('loading')
  })

  it('模型仍在下载时提问：不等待模型，按词法模式照常回答', async () => {
    // 阶段① 与提问都不依赖模型：这两条路径一旦 await 了它，本用例会直接超时
    vi.mocked(createTransformersEmbedder).mockImplementation(() => new Promise(() => {}) as never)
    const store = useChatStore()
    await store.init()
    await store.indexPaper('paper-1', { syncStage1Only: true })
    const write = vi.mocked(window.db.index.set).mock.calls.at(-1)!
    vi.mocked(window.db.index.get).mockResolvedValue({
      indexJson: write[1] as string, pagesJson: write[2] as string,
    })
    // 卡片调用（阶段③）挂起不管；生成请求按 SSE 返回
    global.fetch = vi.fn((_url: string, init: any) =>
      JSON.parse(init.body).stream ? Promise.resolve(sse(['Answer'])) : new Promise(() => {})) as never

    const conv = await store.newConversation('c', ['paper-1'])
    const reply = await store.sendMessage(conv.id, '这篇论文的核心机制是什么？')

    expect(reply).toBe('Answer')
    // 模型自始至终没就绪：这一次提问就是按词法模式服务的
    expect(store.vectorModelState).toBe('loading')
  })

  it('模型就绪后提问走向量混合检索（实例真的注入到检索依赖里）', async () => {
    vi.mocked(window.db.index.get).mockResolvedValue(null)
    const store = useChatStore()
    await store.indexPaper('paper-1', { syncStage1Only: true })
    // 阶段① 记录由 store 自己写（形态与生产逐字一致），再补成「向量就是这个模型算的」
    const write = vi.mocked(window.db.index.set).mock.calls.at(-1)!
    const stage1 = JSON.parse(write[1] as string) as { passages: unknown[] }
    const dense = JSON.stringify({
      ...stage1, stage: 2, embedderId: EMBEDDER_ID, vectorDim: 3,
      passageVectors: encodeVectors(stage1.passages.map(() => new Float32Array([1, 0, 0]))),
    })
    vi.mocked(window.db.index.get).mockResolvedValue({ indexJson: dense, pagesJson: write[2] as string })
    // 模型这次加载成功：init 的点火会把实例留在 store 里
    vi.mocked(createTransformersEmbedder).mockResolvedValue(fakeEmbedder)
    await store.init()
    await vi.waitFor(() => expect(store.vectorModelState).toBe('ready'))
    global.fetch = vi.fn((_url: string, init: any) =>
      JSON.parse(init.body).stream ? Promise.resolve(sse(['Answer'])) : new Promise(() => {})) as never

    const conv = await store.newConversation('c', ['paper-1'])
    const reply = await store.sendMessage(conv.id, '这篇论文用了什么方法？')

    expect(reply).toBe('Answer')
    // 少了这条断言：把 embedder 从检索依赖里漏掉也照样全绿（检索静默退回词法）
    expect(fakeEmbedder.embedQuery).toHaveBeenCalled()
  })

  it('模型就绪后续写（continueMessage）同样走向量混合检索：依赖真的到了那条路径', async () => {
    // 与上一条同构，但换到另一条真实回答路径：`continueMessage` 漏接 passageDeps 时，
    // 上一条用例照样全绿（它只钉住 generateReply 那一处调用点）
    vi.mocked(window.db.index.get).mockResolvedValue(null)
    const store = useChatStore()
    await store.indexPaper('paper-1', { syncStage1Only: true })
    const write = vi.mocked(window.db.index.set).mock.calls.at(-1)!
    const stage1 = JSON.parse(write[1] as string) as { passages: unknown[] }
    const dense = JSON.stringify({
      ...stage1, stage: 2, embedderId: EMBEDDER_ID, vectorDim: 3,
      passageVectors: encodeVectors(stage1.passages.map(() => new Float32Array([1, 0, 0]))),
    })
    vi.mocked(window.db.index.get).mockResolvedValue({ indexJson: dense, pagesJson: write[2] as string })
    vi.mocked(createTransformersEmbedder).mockResolvedValue(fakeEmbedder)
    await store.init()
    await vi.waitFor(() => expect(store.vectorModelState).toBe('ready'))
    // 续写走非流式：改写与生成都是 JSON 应答（不带 stream）
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: '，这是续写部分。' } }] }),
    }) as never

    const conv = await store.newConversation('c', ['paper-1'])
    conv.messages.push(
      { id: 'u1', role: 'user', content: '这篇论文用了什么方法？', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: '半截回答', timestamp: 2, truncated: true },
    )
    await store.continueMessage(conv.id, 'a1')

    expect(conv.messages[1].content).toBe('半截回答，这是续写部分。')
    // 续写这条路也必须把实例交给检索：没接上就静默退回词法，embedQuery 不会被调用
    expect(fakeEmbedder.embedQuery).toHaveBeenCalled()
  })

  it('模型仍在下载时续写：不等模型，续写照常落库', async () => {
    // 续写若改成 await 模型，本用例会一直挂到超时（与「提问不等待」同一条 R35 约束）
    vi.mocked(createTransformersEmbedder).mockImplementation(() => new Promise(() => {}) as never)
    const store = useChatStore()
    await store.init()
    await store.indexPaper('paper-1', { syncStage1Only: true })
    const write = vi.mocked(window.db.index.set).mock.calls.at(-1)!
    vi.mocked(window.db.index.get).mockResolvedValue({
      indexJson: write[1] as string, pagesJson: write[2] as string,
    })
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: '，这是续写部分。' } }] }),
    }) as never

    const conv = await store.newConversation('c', ['paper-1'])
    conv.messages.push(
      { id: 'u1', role: 'user', content: '这篇论文用了什么方法？', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: '半截回答', timestamp: 2, truncated: true },
    )
    await store.continueMessage(conv.id, 'a1')

    expect(conv.messages[1].content).toBe('半截回答，这是续写部分。')
    // 模型自始至终没就绪：这一次续写就是按词法模式服务的
    expect(store.vectorModelState).toBe('loading')
  })
})
