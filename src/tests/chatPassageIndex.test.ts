import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import type { PassagePipelineDeps } from '../utils/passageIndexBuilder'
import type { PassageIndex } from '../utils/passageIndex'
import { serializePassageIndex } from '../utils/passageIndex'
import { buildPassages, createEstimatingTokenCounter } from '../utils/passages'
import { buildTitleCards, cardsToIndexNodes } from '../utils/structureCards'
import * as ragPipeline from '../utils/ragPipeline'
import { useChatStore } from '../stores/chat'

// pageIndex.ts (imported by chat.ts) pulls in pdfjs-dist which needs DOMMatrix — mock it in Node
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  default: {},
  GlobalWorkerOptions: { workerSrc: '' },
}))

// R10：indexPaper 第一件事就是 `void ensureEmbedder()`，而真实实现会动态 import transformers
// 并真的发起权重下载（取缓存时还会碰 jsdom 未实现的 indexedDB）。单测里模型一律缺席。
vi.mock('../utils/transformersEmbedder', () => ({
  createTransformersEmbedder: vi.fn().mockRejectedValue(new Error('测试不加载向量模型')),
}))

vi.mock('../utils/pageIndex', async importOriginal => ({
  ...(await importOriginal<typeof import('../utils/pageIndex')>()),
  extractPages: async () => ['Abstract\nA short abstract.', 'Methods\nWe use BM25.'],
}))

/** 捕获 store 交给管线的 persist，由测试决定何时、以哪一代调用它。 */
let capturedPersist: PassagePipelineDeps['persist'] | undefined

vi.mock('../utils/passageIndexBuilder', () => ({
  startPassagePipeline: vi.fn(async (_pages: string[], deps: PassagePipelineDeps) => {
    capturedPersist = deps.persist
    const stage1 = {
      version: 2, stage: 1, passages: [], tree: {}, passageConfigHash: deps.passageConfigHash, separatorTokens: 0,
    } as unknown as PassageIndex
    return { index: stage1, rest: Promise.resolve(stage1) }
  }),
}))

const finalIndex = {
  version: 2, stage: 3, passages: [], tree: {}, passageConfigHash: 'h', separatorTokens: 0,
} as unknown as PassageIndex

describe('indexPaper 的代次保护', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    capturedPersist = undefined
    vi.mocked(window.db.paper.readFile).mockResolvedValue('BASE64')
    vi.mocked(window.db.index.get).mockResolvedValue(null)
    // 索引配置变更会顺带启动重建队列（它先遍历论文表）：本组用例不涉及重建，给个空表，
    // 也免得上一个用例的实现泄漏过来
    vi.mocked(window.db.paper.list).mockResolvedValue([])
  })

  it('正对照：没有失效时 persist 确实写盘', async () => {
    const store = useChatStore()
    await store.indexPaper('paper-1')
    await capturedPersist!(finalIndex, 3)
    expect(window.db.index.set).toHaveBeenCalledTimes(1)
  })

  it('同一篇被重新触发构建后，旧代次的写入被丢弃（新一代照常写盘）', async () => {
    const store = useChatStore()
    await store.indexPaper('paper-1')
    const stalePersist = capturedPersist!
    await store.indexPaper('paper-1')          // 新一代，旧代次随即作废
    const freshPersist = capturedPersist!      // 新一代交给管线的 persist
    await stalePersist(finalIndex, 3)
    expect(window.db.index.set).not.toHaveBeenCalled()
    // 正对照：新一代的写盘照常生效——证明「旧代次被丢弃」不是「这个键被永久弄坏」，
    // 否则「一次都没写」也会让上面的断言通过
    await freshPersist(finalIndex, 3)
    expect(window.db.index.set).toHaveBeenCalledTimes(1)
  })

  it('切换索引 profile 后，在途代次的写入被丢弃（换代之后照常写盘）', async () => {
    const store = useChatStore()
    await store.indexPaper('paper-1')
    const stalePersist = capturedPersist!
    await store.updateProfile(store.indexProfileId, { model: 'another-model' })
    // 先让旧代次写：此刻没有任何新一代开始（否则「新一代的 begin」也会让旧代次作废，
    // 这个断言就证明不了「切换 profile 本身会作废在途构建」）
    await stalePersist(finalIndex, 3)
    expect(window.db.index.set).not.toHaveBeenCalled()

    // 正对照：换 profile 之后重新构建的一代照常写盘——「一次都没写」不能证明守卫在起作用
    await store.indexPaper('paper-1')
    await capturedPersist!(finalIndex, 3)
    expect(window.db.index.set).toHaveBeenCalledTimes(1)
  })

  it('切换索引配置（setIndexProfileId）同样让在途代次的写入作废', async () => {
    const store = useChatStore()
    await store.indexPaper('paper-1')
    const stalePersist = capturedPersist!
    await store.setIndexProfileId('another-profile')
    await stalePersist(finalIndex, 3)
    expect(window.db.index.set).not.toHaveBeenCalled()

    // 正对照：换代之后重新构建的一代照常写盘（见上一个用例的说明）
    await store.indexPaper('paper-1')
    await capturedPersist!(finalIndex, 3)
    expect(window.db.index.set).toHaveBeenCalledTimes(1)
  })
})

describe('collectIndexedPapers 的索引形态分派', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // 调用历史逐用例清空：「后台重建已启动」是靠 readFile 的调用当证据的
    vi.clearAllMocks()
    vi.mocked(window.db.paper.readFile).mockResolvedValue('BASE64')
  })

  it('自称 v2 却解析失败的记录不会被当成平面索引（跳过该篇并后台重建）', async () => {
    // tree 形态非法：`parsePassageIndex` 拒绝，但记录自称 version 2 —— 绝不能被塞进 `tree`
    // （`PassageIndex` 没有 `nodes`，下游 `.length` / `.map` 会抛）
    vi.mocked(window.db.index.get).mockResolvedValue({
      indexJson: JSON.stringify({ version: 2, stage: 1, passages: [], tree: {} }),
      pagesJson: JSON.stringify(['page one']),
    })
    const store = useChatStore()

    const papers = await store.collectIndexedPapers({ id: 'c1', paperIds: ['paper-1'] } as never)

    expect(papers.papers).toHaveLength(0)
    expect(papers.paperIds).toHaveLength(0)
    // 后台重建已启动（读原文是它的第一步），下一问就有真索引
    expect(vi.mocked(window.db.paper.readFile)).toHaveBeenCalledWith('paper-1')
  })

  it('连平面树都拼不出来的旧记录同样跳过并重建', async () => {
    vi.mocked(window.db.index.get).mockResolvedValue({
      indexJson: '{}',
      pagesJson: JSON.stringify(['page one']),
    })
    const store = useChatStore()

    const papers = await store.collectIndexedPapers({ id: 'c1', paperIds: ['paper-1'] } as never)

    expect(papers.papers).toHaveLength(0)
    expect(vi.mocked(window.db.paper.readFile)).toHaveBeenCalledWith('paper-1')
  })
})

function passageRecord(text = 'Methods\nWe use BM25.', stage: 1 | 2 | 3 = 2) {
  const pages = [text]
  const passages = buildPassages(pages, createEstimatingTokenCounter(), { minTokens: 1 })
  const cards = buildTitleCards(passages)
  const index: PassageIndex = {
    version: 2,
    stage,
    passages,
    tree: cardsToIndexNodes(cards, passages),
    passageConfigHash: 'test-config',
    separatorTokens: 2,
    ...(stage >= 2 ? {
      embedderId: 'test-embedder',
      vectorDim: 2,
      passageVectors: passages.map(() => new Float32Array([1, 0])),
    } : {}),
    ...(stage === 3 ? { cards } : {}),
  }
  return { indexJson: JSON.stringify(serializePassageIndex(index)), pagesJson: JSON.stringify(pages) }
}

describe('collectIndexedPapers 的解析缓存', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    vi.mocked(window.db.paper.readFile).mockResolvedValue('BASE64')
    vi.mocked(window.db.paper.list).mockResolvedValue([])
  })

  afterEach(() => vi.restoreAllMocks())

  it('同一记录重复收集时复用段落、页面、树和解码向量', async () => {
    const record = passageRecord()
    vi.mocked(window.db.index.get).mockImplementation(async () => ({ ...record }))
    const store = useChatStore()
    const conv = { id: 'c1', paperIds: ['paper-1'] } as never

    const first = (await store.collectIndexedPapers(conv)).papers[0]
    const second = (await store.collectIndexedPapers(conv)).papers[0]

    expect(first.passageIndex?.passageVectors?.[0]).toEqual(new Float32Array([1, 0]))
    expect(second.passageIndex).toBe(first.passageIndex)
    expect(second.pages).toBe(first.pages)
    expect(second.tree).toBe(first.tree)
    expect(second.passageIndex?.passageVectors?.[0]).toBe(first.passageIndex?.passageVectors?.[0])
  })

  it('记录被删除后不复用旧索引，即使随后恢复相同的 JSON', async () => {
    const saved = passageRecord()
    let record: typeof saved | null = saved
    vi.mocked(window.db.index.get).mockImplementation(async () => record)
    const store = useChatStore()
    const conv = { id: 'c1', paperIds: ['paper-1'] } as never
    const first = (await store.collectIndexedPapers(conv)).papers[0]

    record = null
    expect(await store.collectIndexedPapers(conv)).toEqual({ papers: [], paperIds: [] })
    expect(window.db.paper.readFile).toHaveBeenCalledWith('paper-1')
    record = saved
    const restored = (await store.collectIndexedPapers(conv)).papers[0]
    expect(restored.passageIndex).toEqual(first.passageIndex)
    expect(restored.passageIndex).not.toBe(first.passageIndex)
  })

  it('首次读取缺失时立即失效，阶段① 后相同记录也会重新解析', async () => {
    const record = passageRecord()
    vi.mocked(window.db.index.get).mockResolvedValue(record)
    const store = useChatStore()
    const conv = { id: 'c1', paperIds: ['paper-1'] } as never
    const first = (await store.collectIndexedPapers(conv)).papers[0]

    vi.mocked(window.db.index.get).mockResolvedValueOnce(null)
    const rebuilt = (await store.collectIndexedPapers(conv)).papers[0]
    expect(rebuilt.passageIndex).toEqual(first.passageIndex)
    expect(rebuilt.passageIndex).not.toBe(first.passageIndex)
    expect(window.db.paper.readFile).toHaveBeenCalledWith('paper-1')
  })

  it('损坏的 v2 替换会跳过并重建，不保留上一份有效缓存', async () => {
    const saved = passageRecord()
    let record = saved
    vi.mocked(window.db.index.get).mockImplementation(async () => record)
    const store = useChatStore()
    const conv = { id: 'c1', paperIds: ['paper-1'] } as never
    const first = (await store.collectIndexedPapers(conv)).papers[0]

    record = { ...saved, indexJson: JSON.stringify({ version: 2, stage: 1, passages: [], tree: {} }) }
    expect(await store.collectIndexedPapers(conv)).toEqual({ papers: [], paperIds: [] })
    expect(window.db.paper.readFile).toHaveBeenCalledWith('paper-1')
    record = saved
    expect((await store.collectIndexedPapers(conv)).papers[0].passageIndex).not.toBe(first.passageIndex)
  })

  it('旧版有效平面索引仍走原检索路径，同时后台重建且不缓存', async () => {
    const saved = passageRecord()
    const tree = JSON.parse(saved.indexJson).tree
    vi.mocked(window.db.index.get).mockResolvedValue({ ...saved, indexJson: JSON.stringify(tree) })
    const store = useChatStore()
    const conv = { id: 'c1', paperIds: ['paper-1'] } as never
    const first = (await store.collectIndexedPapers(conv)).papers[0]
    const repeated = (await store.collectIndexedPapers(conv)).papers[0]

    expect(first.tree).toEqual(tree)
    expect(first.passageIndex).toBeUndefined()
    expect(repeated.tree).not.toBe(first.tree)
    expect(repeated.pages).not.toBe(first.pages)
    expect(window.db.paper.readFile).toHaveBeenCalledWith('paper-1')
  })

  it('坏页面 JSON 仍抛错，并清除此前有效缓存', async () => {
    const saved = passageRecord()
    let record = saved
    vi.mocked(window.db.index.get).mockImplementation(async () => record)
    const store = useChatStore()
    const conv = { id: 'c1', paperIds: ['paper-1'] } as never
    const first = (await store.collectIndexedPapers(conv)).papers[0]

    record = { indexJson: '{broken', pagesJson: '{broken' }
    await expect(store.collectIndexedPapers(conv)).rejects.toThrow(SyntaxError)
    record = saved
    expect((await store.collectIndexedPapers(conv)).papers[0].passageIndex).not.toBe(first.passageIndex)
  })

  it('不同 store 实例之间不共享解析对象', async () => {
    vi.mocked(window.db.index.get).mockResolvedValue(passageRecord())
    const firstStore = useChatStore(createPinia())
    const secondStore = useChatStore(createPinia())
    const conv = { id: 'c1', paperIds: ['paper-1'] } as never
    const first = (await firstStore.collectIndexedPapers(conv)).papers[0]
    const second = (await secondStore.collectIndexedPapers(conv)).papers[0]

    expect(second.passageIndex).not.toBe(first.passageIndex)
    expect(second.pages).not.toBe(first.pages)
    expect(second.tree).not.toBe(first.tree)
  })

  it('重复发送复用索引，持久化记录改变后下一次发送读取新页面和阶段', async () => {
    let record = passageRecord('Methods\nWe use BM25.', 1)
    vi.mocked(window.db.index.get).mockImplementation(async () => ({ ...record }))
    const pipeline = vi.spyOn(ragPipeline, 'runRagPipeline')
    const body = `data: ${JSON.stringify({ choices: [{ delta: { content: 'answer' } }] })}\n\n`
      + `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`
      + 'data: [DONE]\n\n'
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, body: new Response(body).body })))
    const store = useChatStore()
    const conv = await store.newConversation('Cached paper', ['paper-1'])
    try {
      expect(await store.sendMessage(conv.id, 'How does BM25 work?')).toBe('answer')
      expect(await store.sendMessage(conv.id, 'Explain BM25 again.')).toBe('answer')
      const first = pipeline.mock.calls[0][0][0]
      const repeated = pipeline.mock.calls[1][0][0]
      expect(repeated.passageIndex).toBe(first.passageIndex)
      expect(repeated.pages).toBe(first.pages)
      expect(repeated.tree).toBe(first.tree)

      record = passageRecord('Results\nUpdated BM25 evaluation.', 3)
      expect(await store.sendMessage(conv.id, 'What are the BM25 results?')).toBe('answer')
      const updated = pipeline.mock.calls[2][0][0]
      expect(updated.passageIndex).not.toBe(first.passageIndex)
      expect(updated.passageIndex?.stage).toBe(3)
      expect(updated.pages).toEqual(['Results\nUpdated BM25 evaluation.'])
      expect(updated.tree).not.toBe(first.tree)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
