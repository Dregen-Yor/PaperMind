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

  it('/ABSTRACT 大小写不敏感；原文缺失直接报错且不调用 Docling', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('should not be called')) as any
    mockDb().docling.convert.mockReset().mockRejectedValue(new Error('未配置测试解析结果'))
    mockDb().paper.get.mockResolvedValue(null)
    mockDb().paper.readFile.mockResolvedValue(null)
    const store = useChatStore()
    await store.init()
    const conv = await store.newConversation('t', ['paper-1'])

    await expect(store.sendMessage(conv.id, '/ABSTRACT')).rejects.toThrow('论文不存在或 PDF 文件缺失')
    expect(mockDb().docling.convert).not.toHaveBeenCalled()
    const assistant = conv.messages.find(m => m.role === 'assistant')!
    expect(assistant.error).toBe('论文不存在或 PDF 文件缺失，请重新导入')
    expect(assistant.error).not.toContain('请检查设置中的 API 配置')
  })
})
