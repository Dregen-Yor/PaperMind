import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ default: {}, GlobalWorkerOptions: { workerSrc: '' } }))

// init 一进来就 `void ensureEmbedder()`：真实实现会动态 import transformers 并真的发起
// 权重下载（取缓存时还会碰 jsdom 未实现的 indexedDB）。单测里向量模型一律缺席，
// 启动与问答路径都不依赖它。
vi.mock('../utils/transformersEmbedder', () => ({
  createTransformersEmbedder: vi.fn().mockRejectedValue(new Error('测试不加载向量模型')),
}))

import { useChatStore } from '../stores/chat'

const mockDb = () => (globalThis as any).mockDb

describe('空对话清理（#15）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockDb().chat.removeConversation.mockClear()
    mockDb().settings.get.mockResolvedValue(null)
    mockDb().index.list.mockResolvedValue([])
  })

  it('init 清理历史遗留的 0 消息对话', async () => {
    mockDb().chat.listConversations.mockResolvedValue([
      { id: 'e1', title: '对话 1', paperIds: ['p1'], createdAt: 0, messages: [] },
      { id: 'n1', title: '正常', paperIds: [], createdAt: 1, messages: [{ id: 'm', role: 'user', content: 'hi', sources: [], timestamp: 1 }] },
    ])
    const store = useChatStore()
    await store.init()
    expect(store.conversations.map(c => c.id)).toEqual(['n1'])
    expect(mockDb().chat.removeConversation).toHaveBeenCalledWith('e1')
  })

  it('discardEmptyConversation 只删 0 消息会话，有消息的不动', async () => {
    mockDb().chat.listConversations.mockResolvedValue([])
    const store = useChatStore()
    await store.init()
    const empty = await store.newConversation('新对话', [])
    const used = await store.newConversation('有内容', [])
    await store.addMessage(used.id, 'user', 'hi')

    await store.discardEmptyConversation(empty.id)
    await store.discardEmptyConversation(used.id)

    expect(store.conversations.map(c => c.id)).toEqual([used.id])
    expect(mockDb().chat.removeConversation).toHaveBeenCalledTimes(1)
    expect(mockDb().chat.removeConversation).toHaveBeenCalledWith(empty.id)
  })
})
