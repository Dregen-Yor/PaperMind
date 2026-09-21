import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(() => ({
    promise: Promise.resolve({
      numPages: 1,
      getPage: async () => ({
        getTextContent: async () => ({ items: [{ str: 'Attention is all you need.', transform: [1, 0, 0, 1, 0, 10], hasEOL: true }] }),
      }),
    }),
  })),
}))

import { useChatStore } from '../stores/chat'

const mockDb = () => (globalThis as any).mockDb
const FLAT_INDEX_JSON = JSON.stringify({ title: '平面标题', nodeId: 'only', startPage: 0, endPage: 0, summary: '', nodes: [] })
const KEYED_PROFILE = [{ id: 'p1', name: 'ds', provider: 'openai', model: 'm', apiKey: 'sk-test', baseUrl: 'https://example.com/v1', temperature: 0, maxTokens: 1024, topK: 0, systemPrompt: '' }]

describe('语义树重建失败原因（#13）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockDb().chat.listConversations.mockResolvedValue([])
    mockDb().settings.get.mockResolvedValue(null)
    mockDb().index.list.mockResolvedValue(['p1'])
    mockDb().index.get.mockResolvedValue({ indexJson: FLAT_INDEX_JSON, pagesJson: JSON.stringify(['一页正文']) })
    mockDb().tree.get.mockResolvedValue(null)
  })

  it('未配置模型时不发请求，直接给出原因', async () => {
    const fetchMock = vi.fn()
    global.fetch = fetchMock as any
    const store = useChatStore()
    await store.init()
    const summary = await store.rebuildAllTrees()
    expect(summary.attempted).toBe(1)
    expect(summary.failed).toBe(1)
    expect(summary.firstReason).toContain('未配置模型')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('本地端点即使没填 Key 也不短路，失败按请求失败归类', async () => {
    const localProfile = [{ ...KEYED_PROFILE[0], apiKey: '', baseUrl: 'http://localhost:1234/v1' }]
    mockDb().settings.get.mockImplementation((key: string) => {
      if (key === 'llm_profiles') return Promise.resolve(localProfile)
      if (key === 'llm_profile_index') return Promise.resolve('p1')
      return Promise.resolve(null)
    })
    global.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 500, statusText: 'Server Error',
      json: () => Promise.resolve({ error: { message: 'boom' } }),
    }) as any
    const store = useChatStore()
    await store.init()
    const summary = await store.rebuildAllTrees()

    expect(global.fetch).toHaveBeenCalled()
    expect(summary.failed).toBe(1)
    expect(summary.firstReason).toContain('请求失败')
  })

  it('服务端错误归类为请求失败并带原始信息', async () => {
    mockDb().settings.get.mockImplementation((key: string) => {
      if (key === 'llm_profiles') return Promise.resolve(KEYED_PROFILE)
      if (key === 'llm_profile_index') return Promise.resolve('p1')
      return Promise.resolve(null)
    })
    global.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 500, statusText: 'Server Error',
      json: () => Promise.resolve({ error: { message: 'boom' } }),
    }) as any
    const store = useChatStore()
    await store.init()
    const summary = await store.rebuildAllTrees()
    expect(summary.failed).toBe(1)
    expect(summary.firstReason).toContain('请求失败')
  })
})
