import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import ElementPlus from 'element-plus'

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ default: {}, GlobalWorkerOptions: { workerSrc: '' } }))

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

  it('增量渲染并在结束时一次性落库，占位气泡不残留', async () => {
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
    expect(writes[0].content).toBe('你好，世界')
  })

  it('流式中断：移除半截占位气泡并落失败态，不留半截内容', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: '半截' } }] })}\n\n`))
        controller.error(new Error('network down'))
      },
    })
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, body: stream }) as any
    const store = useChatStore()
    await store.init()
    const conv = await store.newConversation('t', [])

    await expect(store.sendMessage(conv.id, '问题')).rejects.toThrow()
    expect(conv.messages.some(m => m.content === '半截')).toBe(false)
    const assistant = conv.messages.find(m => m.role === 'assistant')!
    expect(assistant.content).toBe('')
    expect(assistant.error).toBeTruthy()
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

  it('占位气泡增量渲染、带流式光标，且不再叠加 typing 指示器', async () => {
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
