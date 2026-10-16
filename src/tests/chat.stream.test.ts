import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import ElementPlus from 'element-plus'

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ default: {}, GlobalWorkerOptions: { workerSrc: '' } }))

// init 一进来就 `void ensureEmbedder()`：真实实现会动态 import transformers 并真的发起
// 权重下载（取缓存时还会碰 jsdom 未实现的 indexedDB）。单测里向量模型一律缺席，
// 启动与问答路径都不依赖它。
vi.mock('../utils/transformersEmbedder', () => ({
  createTransformersEmbedder: vi.fn().mockRejectedValue(new Error('测试不加载向量模型')),
}))

import ChatPanel from '../components/ChatPanel.vue'
import { useChatStore } from '../stores/chat'

const mockDb = () => (globalThis as any).mockDb
const sse = (chunks: string[], finishReason = 'stop') => {
  const body = chunks.map(c => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`).join('')
    + `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n\n`
    + 'data: [DONE]\n\n'
  return { ok: true, status: 200, body: new Response(body).body }
}

describe('流式输出（#6）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockDb().chat.listConversations.mockResolvedValue([])
    mockDb().chat.addMessage.mockClear()
    mockDb().chat.updateMessage.mockClear()
    mockDb().settings.get.mockResolvedValue(null)
    mockDb().index.list.mockResolvedValue([])
  })

  it('增量渲染并在结束时保存完成状态', async () => {
    global.fetch = vi.fn().mockResolvedValue(sse(['你好', '，世界'])) as any
    const store = useChatStore()
    await store.init()
    const conv = await store.newConversation('t', [])
    await store.sendMessage(conv.id, '打个招呼')

    const assistants = conv.messages.filter(m => m.role === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0].content).toBe('你好，世界')
    expect(assistants[0].streaming).toBeFalsy()
    const writes = mockDb().chat.addMessage.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m.role === 'assistant')
    expect(writes).toHaveLength(1)
    expect(writes[0].content).toBe('')
    expect(writes[0].runStatus).toBe('preparing')
    expect(mockDb().chat.updateMessage).toHaveBeenCalledWith(assistants[0].id,
      expect.objectContaining({ content: '你好，世界', runStatus: 'completed' }))
  })

  it('流式中断：保留半截内容并落失败态', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: '半截' } }] })}\n\n`))
        setTimeout(() => controller.error(new Error('network down')), 0)
      },
    })
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, body: stream }) as any
    const store = useChatStore()
    await store.init()
    const conv = await store.newConversation('t', [])

    await expect(store.sendMessage(conv.id, '问题')).rejects.toThrow()
    const assistant = conv.messages.find(m => m.role === 'assistant')!
    expect(assistant.content).toBe('半截')
    expect(assistant.runStatus).toBe('failed')
    expect(assistant.error).toBeTruthy()
    expect(mockDb().chat.updateMessage).toHaveBeenCalledWith(assistant.id, { content: '半截' })
    expect(mockDb().chat.updateMessage).toHaveBeenCalledWith(assistant.id,
      expect.objectContaining({ runStatus: 'failed' }))
  })

  it('stops a live answer and keeps its partial text', async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>
    let aborted = false
    global.fetch = vi.fn().mockImplementation(async (_url, init: RequestInit) => {
      init.signal?.addEventListener('abort', () => {
        aborted = true
        streamController.error(new DOMException('Aborted', 'AbortError'))
      }, { once: true })
      return { ok: true, status: 200, body: new ReadableStream({ start(c) { streamController = c } }) }
    }) as any
    const store = useChatStore()
    await store.init()
    const conv = await store.newConversation('t', [])
    const pending = store.sendMessage(conv.id, '问题')
    await vi.waitFor(() => expect(streamController).toBeDefined())
    streamController.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: '半截' } }] })}\n\n`))
    await vi.waitFor(() => expect(conv.messages.some(m => m.content === '半截')).toBe(true))
    await store.stopConversationRun(conv.id)
    await pending
    const assistant = conv.messages.find(m => m.role === 'assistant')!
    expect(aborted).toBe(true)
    expect(assistant.content).toBe('半截')
    expect(assistant.runStatus).toBe('cancelled')
  })

  it('stops promptly while paper preparation is waiting on storage', async () => {
    let release!: (papers: unknown[]) => void
    mockDb().paper.list.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const store = useChatStore()
    await store.init()
    const conv = await store.newConversation('t', ['paper-1'])
    const pending = store.sendMessage(conv.id, '问题')
    await vi.waitFor(() => expect(conv.messages.find(m => m.role === 'assistant')?.runStatus).toBe('preparing'))
    await store.stopConversationRun(conv.id)
    await vi.waitFor(() => expect(conv.messages.find(m => m.role === 'assistant')?.runStatus).toBe('cancelled'), { timeout: 300 })
    release([])
    await pending
  })

  it('rejects a second send while the first user message is still being saved', async () => {
    let release!: () => void
    mockDb().chat.addMessage.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    global.fetch = vi.fn().mockResolvedValue(sse(['回答'])) as any
    const store = useChatStore()
    await store.init()
    const conv = await store.newConversation('t', [])
    const pending = store.sendMessage(conv.id, '第一问')
    await vi.waitFor(() => expect(mockDb().chat.addMessage).toHaveBeenCalledTimes(1))
    await expect(store.sendMessage(conv.id, '第二问')).rejects.toThrow('正在生成回答')
    release()
    await pending
    expect(conv.messages.filter(m => m.role === 'user')).toHaveLength(1)
  })

  it('recovers the terminal state after an intermediate database write fails', async () => {
    mockDb().chat.updateMessage.mockRejectedValueOnce(new Error('write failed'))
    global.fetch = vi.fn().mockResolvedValue(sse(['回答'])) as any
    const store = useChatStore()
    await store.init()
    const conv = await store.newConversation('t', [])
    await expect(store.sendMessage(conv.id, '问题')).rejects.toThrow('write failed')
    const assistant = conv.messages.find(m => m.role === 'assistant')!
    expect(assistant.runStatus).toBe('failed')
    expect(mockDb().chat.updateMessage).toHaveBeenCalledWith(assistant.id,
      expect.objectContaining({ runStatus: 'failed' }))
  })

  it('restores the previous answer state if starting a retry cannot be saved', async () => {
    global.fetch = vi.fn().mockResolvedValue(sse(['原回答'])) as any
    const store = useChatStore()
    await store.init()
    const conv = await store.newConversation('t', [])
    await store.sendMessage(conv.id, '问题')
    const assistant = conv.messages.find(m => m.role === 'assistant')!
    const firstRunId = assistant.runId
    mockDb().chat.updateMessage.mockRejectedValueOnce(new Error('write failed'))

    await expect(store.retryMessage(conv.id, assistant.id)).rejects.toThrow('write failed')

    expect(assistant.content).toBe('原回答')
    expect(assistant.runId).toBe(firstRunId)
    expect(assistant.runStatus).toBe('completed')
  })

  it('continues a stopped partial answer under a new run ID', async () => {
    global.fetch = vi.fn().mockResolvedValue(sse(['半截'])) as any
    const store = useChatStore()
    await store.init()
    const conv = await store.newConversation('t', [])
    await store.sendMessage(conv.id, '问题')
    const assistant = conv.messages.find(m => m.role === 'assistant')!
    const firstRunId = assistant.runId
    assistant.runStatus = 'cancelled'
    global.fetch = vi.fn().mockResolvedValue(sse(['续上'])) as any

    await store.continueMessage(conv.id, assistant.id)

    expect(assistant.content).toBe('半截续上')
    expect(assistant.runStatus).toBe('completed')
    expect(assistant.runId).not.toBe(firstRunId)
  })

  it('流末尾 finish_reason=length 标记截断', async () => {
    global.fetch = vi.fn().mockResolvedValue(sse(['半截'], 'length')) as any
    const store = useChatStore()
    await store.init()
    const conv = await store.newConversation('t', [])
    await store.sendMessage(conv.id, '问题')
    expect(conv.messages.find(m => m.role === 'assistant')!.truncated).toBe(true)
  })
})

describe('ChatPanel 流式呈现（#6）', () => {
  let wrapper: VueWrapper | undefined
  afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.restoreAllMocks() })

  it('回答气泡增量渲染、带流式光标，且不再叠加 typing 指示器', async () => {
    const pinia = createPinia()
    const chatStore = useChatStore(pinia)
    await chatStore.init()
    await chatStore.newConversation('t', [])
    // 与 ChatView 一致：把 store 里的响应式会话对象交给面板
    const conversation = chatStore.conversations[0]

    let controller: ReadableStreamDefaultController<Uint8Array>
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: new ReadableStream({ start(c) { controller = c } }),
    }) as any

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', component: { template: '<div />' } },
        { path: '/settings', component: { template: '<div />' } },
      ],
    })
    await router.push('/')
    wrapper = mount(ChatPanel, {
      props: { conversation },
      global: { plugins: [pinia, router, ElementPlus] },
    })

    await wrapper.find('textarea').setValue('问题')
    await wrapper.find('button[aria-label="发送消息"]').trigger('click')
    await vi.waitFor(() => expect(controller).toBeDefined())
    await flushPromises()

    // 流式气泡已在场时不能同时显示打字点，否则同一条回答出现两个「正在生成」
    expect(wrapper.find('.typing').exists()).toBe(false)

    controller!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: '你好' } }] })}\n\n`))
    await flushPromises()
    const bubble = wrapper.find('.message.assistant .msg-content')
    expect(bubble.text()).toContain('你好')
    expect(bubble.classes()).toContain('is-streaming')

    controller!.enqueue(new TextEncoder().encode(
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`))
    controller!.close()
    await flushPromises()

    // 结束后光标收起（流式标记是内存态，最终气泡不再带 is-streaming）
    expect(wrapper.find('.message.assistant .msg-content').classes()).not.toContain('is-streaming')
  })
})
