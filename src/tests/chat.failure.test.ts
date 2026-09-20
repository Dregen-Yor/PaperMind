import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  default: {},
  GlobalWorkerOptions: { workerSrc: '' },
}))

import { useChatStore } from '../stores/chat'

const mockDb = () => (globalThis as any).mockDb
const llmOk = (content: string) => ({
  ok: true,
  json: () => Promise.resolve({ choices: [{ message: { content }, finish_reason: 'stop' }] }),
})
const llmEmpty = () => ({
  ok: true,
  json: () => Promise.resolve({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }),
})
const llm401 = () => ({
  ok: false, status: 401, statusText: 'Unauthorized',
  json: () => Promise.resolve({ error: { message: "You didn't provide an API key" } }),
})

describe('问答失败路径（#2）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockDb().chat.listConversations.mockResolvedValue([])
    mockDb().chat.addMessage.mockClear()
    mockDb().chat.updateMessage.mockClear()
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
})
