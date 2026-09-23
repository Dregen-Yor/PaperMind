import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import type { PassagePipelineDeps } from '../utils/passageIndexBuilder'
import type { PassageIndex } from '../utils/passageIndex'
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
