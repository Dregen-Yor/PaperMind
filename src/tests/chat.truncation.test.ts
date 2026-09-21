import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import ElementPlus, { ElMessage } from 'element-plus'

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ default: {}, GlobalWorkerOptions: { workerSrc: '' } }))

import ChatPanel from '../components/ChatPanel.vue'
import { useChatStore, type Conversation } from '../stores/chat'

const mockDb = () => (globalThis as any).mockDb
/** 非流式回答（`continueMessage` 仍走非流式请求）。 */
const llm = (content: string, finishReason = 'stop') => ({
  ok: true,
  json: () => Promise.resolve({ choices: [{ message: { content }, finish_reason: finishReason }] }),
})
/** 生成阶段走流式（#6）：OpenAI 兼容 SSE 的分块回答。 */
const sse = (chunks: string[], finishReason = 'stop') => {
  const body = chunks.map(c => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`).join('')
    + `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n\n`
    + 'data: [DONE]\n\n'
  return { ok: true, status: 200, body: new Response(body).body }
}
const anthropicSse = (text: string, stopReason = 'end_turn') => ({
  ok: true,
  status: 200,
  body: new Response(
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text } })}\n\n`
    + `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: stopReason } })}\n\n`,
  ).body,
})
const ollamaSse = (text: string, doneReason = 'stop') => ({
  ok: true,
  status: 200,
  body: new Response(
    `${JSON.stringify({ message: { content: text } })}\n`
    + `${JSON.stringify({ done: true, done_reason: doneReason })}\n`,
  ).body,
})

describe('截断与继续（#3）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockDb().chat.listConversations.mockResolvedValue([])
    mockDb().chat.addMessage.mockClear()
    mockDb().chat.updateMessage.mockClear()
    mockDb().settings.get.mockResolvedValue(null)
    mockDb().index.list.mockResolvedValue([])
  })

  it('finish_reason=length 标记 truncated 并落库', async () => {
    global.fetch = vi.fn().mockResolvedValue(sse(['半截回答'], 'length')) as any
    const store = useChatStore()
    await store.init()
    const conv = await store.newConversation('t', [])
    await store.sendMessage(conv.id, '问题')

    const assistant = conv.messages.find(m => m.role === 'assistant')!
    expect(assistant.truncated).toBe(true)
    const writes = mockDb().chat.addMessage.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m.role === 'assistant')
    expect(writes[0].truncated).toBe(true)
  })

  it('continueMessage 把续写追加到原回答并清除截断标记', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(llm('续写用查询'))     // 历史 ≥2 轮会触发查询改写
      .mockResolvedValueOnce(llm('，这是续写部分。'))
    const store = useChatStore()
    await store.init()
    const conv = await store.newConversation('t', [])
    conv.messages.push(
      { id: 'u1', role: 'user', content: '问题', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: '半截回答', timestamp: 2, truncated: true },
    )
    await store.continueMessage(conv.id, 'a1')

    expect(conv.messages[1].content).toBe('半截回答，这是续写部分。')
    expect(conv.messages[1].truncated).toBe(false)
    const last = mockDb().chat.updateMessage.mock.calls.at(-1)!
    expect(last[0]).toBe('a1')
    expect(last[1].content).toBe('半截回答，这是续写部分。')
  })

  it('「继续」在带划选 context 的用户消息上跳过检索并重放原文片段', async () => {
    global.fetch = vi.fn().mockResolvedValue(llm('，这是续写部分。')) as any
    const store = useChatStore()
    await store.init()
    // 带论文才能证明「继续」没有退回检索路径（与重试带 context 的用例同构）
    const conv = await store.newConversation('t', ['p1'])
    conv.messages.push(
      { id: 'u1', role: 'user', content: '这段怎么理解？', timestamp: 1, context: '被选中的原文片段' },
      { id: 'a1', role: 'assistant', content: '半截回答', timestamp: 2, truncated: true },
    )
    mockDb().index.get.mockClear()
    await store.continueMessage(conv.id, 'a1')

    expect(mockDb().index.get).not.toHaveBeenCalled()
    // 跳过改写与评分：整场只发生生成调用
    expect(global.fetch).toHaveBeenCalledTimes(1)
    const body = String((global.fetch as any).mock.calls.at(-1)![1].body)
    expect(body).toContain('被选中的原文片段')
    expect(conv.messages[1].content).toBe('半截回答，这是续写部分。')
  })

  it('默认 maxTokens 已提升到 4096', async () => {
    const store = useChatStore()
    await store.init()
    expect(store.profiles[0].maxTokens).toBe(4096)
  })

  it('anthropic 的 stop_reason=max_tokens 同样标记截断', async () => {
    global.fetch = vi.fn().mockResolvedValue(anthropicSse('半截回答', 'max_tokens')) as any
    const store = useChatStore()
    await store.init()
    await store.updateProfile(store.chatProfile.id, {
      provider: 'anthropic', model: 'claude-3-5-sonnet', baseUrl: 'https://api.anthropic.com',
    })
    const conv = await store.newConversation('t', [])
    await store.sendMessage(conv.id, '问题')

    expect((global.fetch as any).mock.calls[0][0]).toBe('https://api.anthropic.com/v1/messages')
    expect(conv.messages.find(m => m.role === 'assistant')!.truncated).toBe(true)
  })

  it('ollama 的 done_reason=length 同样标记截断', async () => {
    global.fetch = vi.fn().mockResolvedValue(ollamaSse('半截回答', 'length')) as any
    const store = useChatStore()
    await store.init()
    await store.updateProfile(store.chatProfile.id, {
      provider: 'ollama', model: 'qwen2.5', baseUrl: 'http://localhost:11434',
    })
    const conv = await store.newConversation('t', [])
    await store.sendMessage(conv.id, '问题')

    expect((global.fetch as any).mock.calls[0][0]).toBe('http://localhost:11434/api/chat')
    expect(conv.messages.find(m => m.role === 'assistant')!.truncated).toBe(true)
  })

  it('重试被截断：写回补丁带 truncated=true', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 401, statusText: 'Unauthorized',
      json: () => Promise.resolve({ error: { message: 'Invalid API key' } }),
    }) as any
    const store = useChatStore()
    await store.init()
    const conv = await store.newConversation('t', [])
    await expect(store.sendMessage(conv.id, '问题')).rejects.toThrow('LLM 请求失败 (401)')
    const failed = conv.messages.find(m => m.role === 'assistant')!

    global.fetch = vi.fn().mockResolvedValue(sse(['半截回答'], 'length')) as any
    await store.retryMessage(conv.id, failed.id)

    expect(failed.error).toBe('')
    expect(failed.truncated).toBe(true)
    const last = mockDb().chat.updateMessage.mock.calls.at(-1)!
    expect(last[0]).toBe(failed.id)
    expect(last[1].truncated).toBe(true)
  })
})

describe('ChatPanel 截断条（#3）', () => {
  let wrapper: VueWrapper | undefined
  afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.restoreAllMocks() })

  const truncatedConv = (): Conversation => ({
    id: 'c1', title: 't', paperIds: [], createdAt: 0,
    messages: [
      { id: 'm1', role: 'user', content: '问题', timestamp: 1 },
      { id: 'm2', role: 'assistant', content: '半截回答', timestamp: 2, truncated: true },
    ],
  })

  /** 挂载 ChatPanel；onError 接管 app.config.errorHandler，用于捕获逃逸出事件处理器的错误。 */
  async function mountPanel(conversation: Conversation, onError?: (error: unknown) => void) {
    const pinia = createPinia()
    const chatStore = useChatStore(pinia)
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
      global: {
        plugins: [pinia, router, ElementPlus],
        ...(onError ? { config: { errorHandler: (error: unknown) => onError(error) } } : {}),
      },
    })
    return { chatStore }
  }

  it('截断回答显示截断条，点「继续」调用 store.continueMessage', async () => {
    const { chatStore } = await mountPanel(truncatedConv())
    const continueMessage = vi.spyOn(chatStore, 'continueMessage').mockResolvedValue()

    const bar = wrapper!.find('.msg-truncated')
    expect(bar.exists()).toBe(true)
    expect(bar.text()).toContain('回答已达长度上限')

    await bar.findAll('button').find(b => b.text() === '继续')!.trigger('click')
    await flushPromises()
    expect(continueMessage).toHaveBeenCalledWith('c1', 'm2')
  })

  it('失败轮不叠加截断条（失败卡优先）', async () => {
    const conversation = truncatedConv()
    conversation.messages[1] = { ...conversation.messages[1], content: '', error: 'LLM 请求失败 (401)' }
    await mountPanel(conversation)

    expect(wrapper!.find('.msg-error').exists()).toBe(true)
    expect(wrapper!.find('.msg-truncated').exists()).toBe(false)
  })

  it('续写失败不逃逸：toast 兜底，按钮可再次点击', async () => {
    const errors: unknown[] = []
    const { chatStore } = await mountPanel(truncatedConv(), error => errors.push(error))
    const continueMessage = vi
      .spyOn(chatStore, 'continueMessage')
      .mockRejectedValue(new Error('请求超时，请检查网络后重试'))
    const toast = vi.spyOn(ElMessage, 'error')
    const continueButton = () => wrapper!.find('.msg-truncated').findAll('button').find(b => b.text() === '继续')!

    await continueButton().trigger('click')
    await flushPromises()

    expect(errors).toEqual([])
    expect(toast).toHaveBeenCalledWith('请求超时，请检查网络后重试')
    // 失败不动原回答：截断条仍在，可再次点击
    expect(wrapper!.find('.msg-truncated').exists()).toBe(true)
    await continueButton().trigger('click')
    await flushPromises()
    expect(continueMessage).toHaveBeenCalledTimes(2)
  })
})
