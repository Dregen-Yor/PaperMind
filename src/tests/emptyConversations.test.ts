import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ default: {}, GlobalWorkerOptions: { workerSrc: '' } }))

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
