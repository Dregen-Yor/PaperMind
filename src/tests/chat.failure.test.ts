import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  default: {},
  GlobalWorkerOptions: { workerSrc: '' },
}))

// init 一进来就 `void ensureEmbedder()`：真实实现会动态 import transformers 并真的发起
// 权重下载（取缓存时还会碰 jsdom 未实现的 indexedDB）。单测里向量模型一律缺席，
// 启动与问答路径都不依赖它。
vi.mock('../utils/transformersEmbedder', () => ({
  createTransformersEmbedder: vi.fn().mockRejectedValue(new Error('测试不加载向量模型')),
}))

import { useChatStore } from '../stores/chat'

const mockDb = () => (globalThis as any).mockDb
/** 生成阶段走流式（#6）：回答请求按 OpenAI 兼容 SSE 返回。 */
const sse = (chunks: string[], finishReason = 'stop') => {
  const body = chunks.map(c => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`).join('')
    + `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n\n`
    + 'data: [DONE]\n\n'
  return { ok: true, status: 200, body: new Response(body).body }
}
const llmOk = (content: string) => sse([content])
const llmEmpty = () => sse([])
const llm401 = () => ({
  ok: false, status: 401, statusText: 'Unauthorized',
  json: () => Promise.resolve({ error: { message: "You didn't provide an API key" } }),
})
const timeoutError = () => new DOMException('The operation timed out.', 'TimeoutError')

describe('问答失败路径（#2）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockDb().chat.listConversations.mockResolvedValue([])
    mockDb().chat.addMessage.mockClear()
    mockDb().chat.updateMessage.mockClear()
    mockDb().index.get.mockClear()
    mockDb().settings.get.mockResolvedValue(null)
    mockDb().index.list.mockResolvedValue([])
  })

  it('空回答被拒：不写脏 content，而是落带 error 的失败轮', async () => {
    global.fetch = vi.fn().mockResolvedValue(llmEmpty()) as any
    const store = useChatStore()
    await store.init()
    const conv = await store.newConversation('t', [])

    await expect(store.sendMessage(conv.id, '你好')).rejects.toThrow('模型返回了空响应')

    const assistant = conv.messages.filter(m => m.role === 'assistant')
    expect(assistant).toHaveLength(1)
    expect(assistant[0].content).toBe('')
    expect(assistant[0].error).toBe('模型返回了空响应')
    const writes = mockDb().chat.addMessage.mock.calls.map((c: any[]) => c[0])
    expect(writes.some((m: any) => m.role === 'assistant' && m.content === '' && !m.error)).toBe(false)
  })

  it('401 失败轮可重试：重试成功后原地更新，不追加重复提问', async () => {
    global.fetch = vi.fn().mockResolvedValue(llm401()) as any
    const store = useChatStore()
    await store.init()
    const conv = await store.newConversation('t', [])

    await expect(store.sendMessage(conv.id, '介绍一下')).rejects.toThrow('LLM 请求失败 (401)')
    const failed = conv.messages.find(m => m.role === 'assistant')!
    expect(failed.error).toContain('LLM 请求失败 (401)')

    global.fetch = vi.fn().mockResolvedValue(llmOk('最终回答')) as any
    await store.retryMessage(conv.id, failed.id)

    expect(failed.content).toBe('最终回答')
    expect(failed.error).toBe('')
    expect(conv.messages.filter(m => m.role === 'user')).toHaveLength(1)
    const lastUpdate = mockDb().chat.updateMessage.mock.calls.at(-1)!
    expect(lastUpdate[0]).toBe(failed.id)
    expect(lastUpdate[1].content).toBe('最终回答')
  })

  it('划选提问失败：用户消息带 context 且落库载荷含 context', async () => {
    global.fetch = vi.fn().mockResolvedValue(llm401()) as any
    const store = useChatStore()
    await store.init()
    const conv = await store.newConversation('t', [])

    await expect(store.sendMessage(conv.id, '这段怎么理解？', '被选中的原文片段'))
      .rejects.toThrow('LLM 请求失败 (401)')

    const user = conv.messages.find(m => m.role === 'user')!
    expect(user.context).toBe('被选中的原文片段')
    const userWrite = mockDb().chat.addMessage.mock.calls
      .map((c: any[]) => c[0])
      .find((m: any) => m.role === 'user')!
    expect(userWrite.context).toBe('被选中的原文片段')
  })

  it('重试带 context：跳过检索并把原文片段重放进生成请求', async () => {
    global.fetch = vi.fn().mockResolvedValue(llm401()) as any
    const store = useChatStore()
    await store.init()
    // 带论文才能证明「重试没有退回检索路径」
    const conv = await store.newConversation('t', ['paper-1'])

    await expect(store.sendMessage(conv.id, '这段怎么理解？', '被选中的原文片段'))
      .rejects.toThrow('LLM 请求失败 (401)')
    const failed = conv.messages.find(m => m.role === 'assistant')!

    mockDb().index.get.mockClear()
    global.fetch = vi.fn().mockResolvedValue(llmOk('最终回答')) as any
    await store.retryMessage(conv.id, failed.id)

    expect(mockDb().index.get).not.toHaveBeenCalled()
    const body = String((global.fetch as any).mock.calls.at(-1)![1].body)
    expect(body).toContain('被选中的原文片段')
  })

  it('重试成功只写一次：不再有开头的预清 error 调用', async () => {
    global.fetch = vi.fn().mockResolvedValue(llm401()) as any
    const store = useChatStore()
    await store.init()
    const conv = await store.newConversation('t', [])

    await expect(store.sendMessage(conv.id, '介绍一下')).rejects.toThrow('LLM 请求失败 (401)')
    const failed = conv.messages.find(m => m.role === 'assistant')!

    global.fetch = vi.fn().mockResolvedValue(llmOk('最终回答')) as any
    await store.retryMessage(conv.id, failed.id)

    const updates = mockDb().chat.updateMessage.mock.calls
    expect(updates).toHaveLength(1)
    expect(updates[0][0]).toBe(failed.id)
    // 重试写回同时刷新截断标记（#3），未截断即显式写 false
    expect(updates[0][1]).toEqual({ content: '最终回答', error: '', truncated: false })
  })

  it('超时映射中文文案：AbortSignal.timeout 的 TimeoutError 不进失败卡', async () => {
    global.fetch = vi.fn().mockRejectedValue(timeoutError()) as any
    const store = useChatStore()
    await store.init()
    const conv = await store.newConversation('t', [])

    await expect(store.sendMessage(conv.id, '你好')).rejects.toThrow('请求超时，请检查网络后重试')

    const failed = conv.messages.find(m => m.role === 'assistant')!
    expect(failed.error).toBe('请求超时，请检查网络后重试')
  })
})
