import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ default: {}, GlobalWorkerOptions: { workerSrc: '' } }))

import { useChatStore } from '../stores/chat'

const mockDb = () => (globalThis as any).mockDb

describe('命令识别（#8）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockDb().chat.listConversations.mockResolvedValue([])
    mockDb().chat.addMessage.mockClear()
    mockDb().settings.get.mockResolvedValue(null)
    mockDb().index.list.mockResolvedValue([])
  })

  it('未知命令本地回应、不发模型、不落用户问题以外的脏数据', async () => {
    const fetchMock = vi.fn()
    global.fetch = fetchMock as any
    const store = useChatStore()
    await store.init()
    const conv = await store.newConversation('t', [])

    await store.sendMessage(conv.id, '/ab')
    expect(fetchMock).not.toHaveBeenCalled()
    const assistant = conv.messages.find(m => m.role === 'assistant')!
    expect(assistant.content).toContain('未识别的命令')
    expect(assistant.content).toContain('/abstract')
  })

  it('/ABSTRACT 大小写不敏感仍按命令处理；缺 token 的失败文案只有一句', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('should not be called')) as any
    const store = useChatStore()
    await store.init()
    // 必须带论文才会走到「缺 token」守卫：无论文时先报「请先在当前对话中选择至少一篇论文」
    const conv = await store.newConversation('t', ['paper-1'])

    await expect(store.sendMessage(conv.id, '/ABSTRACT')).rejects.toThrow('请先在设置中填写 Hugging Face Token')
    const assistant = conv.messages.find(m => m.role === 'assistant')!
    expect(assistant.error).toBe('请先在设置中填写 Hugging Face Token')
    expect(assistant.error).not.toContain('请检查设置中的 API 配置')
  })
})
