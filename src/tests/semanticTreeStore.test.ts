import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

// pageIndex 顶层初始化 pdfjs worker；同时让 extractPages 在 Node 下可跑
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(() => ({
    promise: Promise.resolve({
      numPages: 1,
      getPage: async () => ({
        getTextContent: async () => ({
          items: [{ str: 'Attention is all you need.', transform: [1, 0, 0, 1, 0, 10], hasEOL: true }],
        }),
      }),
      // extractPages 的默认适配器在 finally 里经 loadingTask 拆除（pdfjs 6 无 PDFDocumentProxy.destroy）。
      loadingTask: { destroy: async () => {} },
    }),
  })),
}))

// indexPaper 一进来就 `void ensureEmbedder()`（段落索引的阶段②）：真实实现会动态 import
// transformers 并真的发起权重下载（取缓存时还会碰 jsdom 未实现的 indexedDB）。
// 单测里模型一律缺席，阶段① 与卡片路径都不依赖它。
vi.mock('../utils/transformersEmbedder', () => ({
  createTransformersEmbedder: vi.fn().mockRejectedValue(new Error('测试不加载向量模型')),
}))

import { useChatStore } from '../stores/chat'
import {
  hashTreeSource, semanticTreeConfigHash, SEMANTIC_TREE_SCHEMA_VERSION,
  SEMANTIC_TREE_PROMPT_VERSION, DEFAULT_MAX_INPUT_CHARS,
} from '../utils/semanticTree'
import { DEFAULT_EVIDENCE_OPTIONS } from '../utils/evidenceBlock'

const mockDb = () => (globalThis as any).mockDb
const llmReply = (content: string) => ({
  ok: true,
  json: () => Promise.resolve({ choices: [{ message: { content } }] }),
})

/** 生成阶段走流式（#6）：回答请求按 OpenAI 兼容 SSE 返回。 */
const sseReply = (content: string) => {
  const body = `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
    + `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`
    + 'data: [DONE]\n\n'
  return { ok: true, status: 200, body: new Response(body).body }
}

const VALID_TREE = JSON.stringify({
  root: {
    id: 'r', label: '核心主张', description: '论文的中心结论', relationToParent: null,
    evidenceRefs: ['B001'],
    children: [{
      id: 'a1', label: '机制甲', description: '达成该主张的机制', relationToParent: 'constitutes',
      evidenceRefs: ['B001'], children: [],
    }],
  },
})

/** 按 prompt 内容区分「平面索引」与「语义建树」两类 LLM 请求；带 stream 的是流式生成（#6）。 */
function fakeFetch() {
  return vi.fn().mockImplementation((_url: string, init: any) => {
    const payload = JSON.parse(init.body)
    if (payload.stream) return Promise.resolve(sseReply('Answer'))
    const prompt: string = payload.messages[0].content
    if (prompt.includes('轻量语义导航树')) return Promise.resolve(llmReply(VALID_TREE))
    // 候选 = 语义节点 [0..n-1] + 平面叶节点，必须全覆盖否则判为 incomplete-score-coverage
    if (prompt.includes('用户问题：')) return Promise.resolve(llmReply('[{"id":0,"score":3},{"id":1,"score":9},{"id":2,"score":1}]'))
    return Promise.resolve(llmReply('{"title":"平面标题","summary":"摘要"}'))
  })
}

/** 平面索引：单叶节点，scoreAndSelect 短路不发打分请求 */
const FLAT_INDEX_JSON = JSON.stringify({
  title: '平面标题', nodeId: 'only', startPage: 0, endPage: 0, summary: '', nodes: [],
})

const storedIndex = (pagesJson: string) => ({ indexJson: FLAT_INDEX_JSON, pagesJson })

/** 建树单测统一用的原文：单页、单块（B001）。 */
const PAGES = ['Attention is all you need.']
const PAGES_JSON = JSON.stringify(PAGES)

/**
 * 建树用例默认用一份填好 API Key 的索引配置：没配模型时 buildPaperTree 会在发请求前
 * 短路成「未配置模型」（#13），而这些用例要验证的是真实请求路径（成功/失败/复用）。
 * 除 apiKey 外与 DEFAULT_PROFILE 保持一致，避免顺带改变其他行为。
 */
const KEYED_PROFILE = [{
  id: 'default', name: '默认配置', provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test',
  baseUrl: 'https://api.openai.com/v1', temperature: 0.7, maxTokens: 4096, topK: 0,
  systemPrompt: '你是一个专业的学术论文阅读助手，帮助用户理解和分析论文内容。',
}]

/**
 * settings.get：给出填好 Key 的配置，其余键返回 null（与无保存设置等价）。
 * 语义树必须显式返回 true：自方案 §6.3 起它默认关闭，而这一组用例验证的正是
 * 「用户把开关打开后」的建树/检索行为——不显式开启的话它们只会撞上总开关的短路。
 * 每次返回新的数组与对象：init 拿到的就是 store 自己的副本，
 * 用例里的 updateProfile 才不会把模块级常量改掉、泄漏给后面的用例。
 */
const keyedSettings = (key: string) => {
  if (key === 'llm_profiles') return Promise.resolve(KEYED_PROFILE.map(profile => ({ ...profile })))
  if (key === 'semantic_tree_enabled') return Promise.resolve(true)
  return Promise.resolve(null)
}

/** 默认索引配置（provider openai / model gpt-4o）下、指定模型对应的建树配置指纹。 */
const configHashFor = (model: string) => semanticTreeConfigHash({
  schemaVersion: SEMANTIC_TREE_SCHEMA_VERSION,
  promptVersion: SEMANTIC_TREE_PROMPT_VERSION,
  evidence: DEFAULT_EVIDENCE_OPTIONS,
  maxInputChars: DEFAULT_MAX_INPUT_CHARS,
  model: `openai:${model}@https://api.openai.com/v1`,
})

/** 语义建树请求（与平面索引请求靠 prompt 区分）。 */
const treeBuildCalls = () => (global.fetch as any).mock.calls.filter(
  ([, init]: [string, any]) => JSON.parse(init.body).messages[0].content.includes('轻量语义导航树'))

describe('useChatStore — 语义树开关与状态', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    mockDb().chat.listConversations.mockResolvedValue([])
    mockDb().settings.get.mockResolvedValue(null)
    mockDb().index.list.mockResolvedValue([])
    mockDb().tree.list.mockResolvedValue([])
    mockDb().tree.get.mockResolvedValue(null)
    mockDb().tree.set.mockResolvedValue(undefined)
    global.fetch = fakeFetch() as any
  })

  it('treeEnabled 默认关闭（方案 §6.3，无需任何已保存设置）', async () => {
    const store = useChatStore()
    await store.init()
    expect(store.treeEnabled).toBe(false)
  })

  it('已保存的非开启值（字符串 false）同样保持关闭', async () => {
    // 存的是字符串编码：加载判据在 true 一侧刻意接受 'true'，它的同胞 'false' 就绝不能被
    // 当成真值。用布尔 false 测不出这一点——布尔 false 恰好等于新默认值，
    // 把加载点整个删掉也照样绿（存在性/真值判据的实现才会在这里露馅）
    mockDb().settings.get.mockImplementation((key: string) =>
      Promise.resolve(key === 'semantic_tree_enabled' ? 'false' : null))
    const store = useChatStore()
    await store.init()
    expect(store.treeEnabled).toBe(false)
  })

  it('setTreeEnabled 持久化到 settings', async () => {
    const store = useChatStore()
    await store.init()
    await store.setTreeEnabled(false)
    expect(store.treeEnabled).toBe(false)
    expect(mockDb().settings.set).toHaveBeenCalledWith('semantic_tree_enabled', false)
  })

  it('init 载入已建好语义树的论文集合', async () => {
    mockDb().tree.list.mockResolvedValue(['p1', 'p2'])
    const store = useChatStore()
    await store.init()
    expect([...store.treeReadyPapers].sort()).toEqual(['p1', 'p2'])
  })
})

describe('useChatStore — 后台建树（§8.2）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    mockDb().chat.listConversations.mockResolvedValue([])
    mockDb().settings.get.mockImplementation(keyedSettings)
    mockDb().index.list.mockResolvedValue([])
    mockDb().tree.list.mockResolvedValue([])
    mockDb().tree.get.mockResolvedValue(null)
    mockDb().tree.set.mockResolvedValue(undefined)
    global.fetch = fakeFetch() as any
  })

  it('建树成功后写入 paper_trees 并载入模型与提示版本', async () => {
    mockDb().index.get.mockResolvedValue(storedIndex(JSON.stringify(['Attention is all you need.'])))
    const store = useChatStore()
    await store.init()

    expect((await store.buildPaperTree('p1')).ok).toBe(true)
    expect(mockDb().tree.set).toHaveBeenCalledTimes(1)
    const [paperId, record] = mockDb().tree.set.mock.calls[0]
    expect(paperId).toBe('p1')
    expect(record).toMatchObject({ schemaVersion: 2 })
    expect(record.buildModel).toEqual(expect.any(String))
    expect(record.buildLatencyMs).toEqual(expect.any(Number))
    expect(record.sourceHash).toBe(hashTreeSource(JSON.stringify(['Attention is all you need.'])))
  })

  it('建树只发生一次 LLM 调用（§8.1 单次调用原则）', async () => {
    mockDb().index.get.mockResolvedValue(storedIndex(JSON.stringify(['body text'])))
    const store = useChatStore()
    await store.init()
    await store.buildPaperTree('p1')

    const treeCalls = (global.fetch as any).mock.calls.filter(
      ([, init]: [string, any]) => JSON.parse(init.body).messages[0].content.includes('轻量语义导航树'))
    expect(treeCalls).toHaveLength(1)
  })

  it('建树失败时不写入任何半成品树，也不抛出（§8.2 降级）', async () => {
    mockDb().index.get.mockResolvedValue(storedIndex(JSON.stringify(['body text'])))
    global.fetch = vi.fn().mockResolvedValue(llmReply('不是 JSON')) as any
    const store = useChatStore()
    await store.init()

    const outcome = await store.buildPaperTree('p1')
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toContain('输出不合规')
    expect(mockDb().tree.set).not.toHaveBeenCalled()
    expect(store.treeReadyPapers.has('p1')).toBe(false)
  })

  it('LLM 请求失败时不写入、不抛出', async () => {
    mockDb().index.get.mockResolvedValue(storedIndex(JSON.stringify(['body text'])))
    global.fetch = vi.fn().mockRejectedValue(new Error('network down')) as any
    const store = useChatStore()
    await store.init()

    const outcome = await store.buildPaperTree('p1')
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toContain('请求失败')
    expect(mockDb().tree.set).not.toHaveBeenCalled()
  })

  it('平面索引缺失时不做无根据的建树', async () => {
    mockDb().index.get.mockResolvedValue(null)
    const store = useChatStore()
    await store.init()

    const outcome = await store.buildPaperTree('p1')
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toContain('缺少可用原文')
    expect(mockDb().tree.set).not.toHaveBeenCalled()
  })

  it('语义树关闭时不建树', async () => {
    mockDb().settings.get.mockImplementation((key: string) =>
      Promise.resolve(key === 'semantic_tree_enabled' ? false : null))
    mockDb().index.get.mockResolvedValue(storedIndex(JSON.stringify(['body text'])))
    const store = useChatStore()
    await store.init()

    const outcome = await store.buildPaperTree('p1')
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toContain('语义树总开关已关闭')
    expect(mockDb().tree.set).not.toHaveBeenCalled()
  })

  /**
   * 先真的建一次树，把 store 写盘的记录取回来当作「已就绪」状态。
   * 手工拼记录会漏掉构建配置指纹，测出来的复用行为与生产口径不一致。
   */
  const realTreeRecord = async (
    store: ReturnType<typeof useChatStore>,
    overrides: Record<string, unknown> = {},
  ) => {
    mockDb().tree.get.mockResolvedValue(null)
    mockDb().index.get.mockResolvedValue(storedIndex(PAGES_JSON))
    await store.buildPaperTree('p1')
    const [paperId, record] = mockDb().tree.set.mock.calls.at(-1)!
    mockDb().tree.set.mockClear()
    return { paperId, createdAt: 0, ...record, ...overrides }
  }

  it('内容未变化时复用已有树，不重新调用模型（§10.3）', async () => {
    const store = useChatStore()
    await store.init()
    const record = await realTreeRecord(store)
    mockDb().index.get.mockResolvedValue(storedIndex(PAGES_JSON))
    mockDb().tree.get.mockResolvedValue(record)

    const outcome = await store.buildPaperTree('p1')
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toContain('已有可复用的语义树')
    expect(mockDb().tree.set).not.toHaveBeenCalled()
    // 只有 realTreeRecord 里那一次建树调用
    expect(treeBuildCalls()).toHaveLength(1)
  })

  it('建树模型变更后旧树不再复用（缓存键覆盖构建配置）', async () => {
    const store = useChatStore()
    await store.init()
    const record = await realTreeRecord(store)
    await store.updateProfile('default', { model: 'gpt-4o-mini' })
    mockDb().index.get.mockResolvedValue(storedIndex(PAGES_JSON))
    mockDb().tree.get.mockResolvedValue(record)

    expect((await store.buildPaperTree('p1')).ok).toBe(true)
    expect(mockDb().tree.set).toHaveBeenCalledTimes(1)
    expect(treeBuildCalls()).toHaveLength(2)
  })

  it('存盘记录损坏时既不复用也不标记 ready，直接重建', async () => {
    const store = useChatStore()
    await store.init()
    // schema 与指纹都匹配，但树引用了不存在的证据块 —— 缓存键相同不等于内容可用
    const record = await realTreeRecord(store, {
      treeJson: JSON.stringify({
        root: { id: 'r', label: '根', description: 'd', relationToParent: null, evidenceRefs: ['B999'], children: [] },
      }),
    })
    mockDb().index.get.mockResolvedValue(storedIndex(PAGES_JSON))
    mockDb().tree.get.mockResolvedValue(record)

    expect((await store.buildPaperTree('p1')).ok).toBe(true)
    expect(mockDb().tree.set).toHaveBeenCalledTimes(1)
  })

  it('schema v1 的记录一律作废重建（v2 起块必须带逐页分区）', async () => {
    const store = useChatStore()
    await store.init()
    // 缓存键（原文 + 构建配置）相同，只有 schema 过期
    const record = await realTreeRecord(store, { schemaVersion: 1 })
    mockDb().index.get.mockResolvedValue(storedIndex(PAGES_JSON))
    mockDb().tree.get.mockResolvedValue(record)

    expect((await store.buildPaperTree('p1')).ok).toBe(true)
    expect(mockDb().tree.set).toHaveBeenCalledTimes(1)
  })

  it('schema v2 记录缺少 pieces 时视为损坏，整树作废重建', async () => {
    const store = useChatStore()
    await store.init()
    const base = await realTreeRecord(store)
    const withoutPieces = JSON.parse(base.blocksJson).map(({ pieces, ...rest }: any) => rest)
    mockDb().index.get.mockResolvedValue(storedIndex(PAGES_JSON))
    mockDb().tree.get.mockResolvedValue({ ...base, blocksJson: JSON.stringify(withoutPieces) })

    expect((await store.buildPaperTree('p1')).ok).toBe(true)
    expect(mockDb().tree.set).toHaveBeenCalledTimes(1)
  })

  it('schema v2 记录的 pieces 拼不回 rawText 时同样作废重建', async () => {
    const store = useChatStore()
    await store.init()
    const base = await realTreeRecord(store)
    const tampered = JSON.parse(base.blocksJson).map((block: any) => ({
      ...block, pieces: [{ page: block.startPage, text: 'TAMPERED' }],
    }))
    mockDb().index.get.mockResolvedValue(storedIndex(PAGES_JSON))
    mockDb().tree.get.mockResolvedValue({ ...base, blocksJson: JSON.stringify(tampered) })

    expect((await store.buildPaperTree('p1')).ok).toBe(true)
    expect(mockDb().tree.set).toHaveBeenCalledTimes(1)
  })

  it('force 时即使配置与内容都匹配也强制重建', async () => {
    const store = useChatStore()
    await store.init()
    const record = await realTreeRecord(store)
    mockDb().index.get.mockResolvedValue(storedIndex(PAGES_JSON))
    mockDb().tree.get.mockResolvedValue(record)

    expect((await store.buildPaperTree('p1', undefined, { force: true })).ok).toBe(true)
    expect(mockDb().tree.set).toHaveBeenCalledTimes(1)
  })

  it('建树期间切换索引配置时，指纹、LLM 调用与元数据都取自同一份快照', async () => {
    const store = useChatStore()
    await store.init()
    // 读取平面索引的 await 期间，用户把索引模型换成了另一个
    mockDb().index.get.mockImplementation(async () => {
      void store.updateProfile('default', { model: 'gpt-4o-mini' })
      return storedIndex(PAGES_JSON)
    })

    expect((await store.buildPaperTree('p1')).ok).toBe(true)
    const [, record] = mockDb().tree.set.mock.calls.at(-1)!
    // 树实际由 gpt-4o 建（LLM 调用也用快照），元数据与缓存键必须与之一致 ——
    // 否则以后切回 gpt-4o 会错误复用一个并非它建的树
    expect(JSON.parse(treeBuildCalls().at(-1)[1].body).model).toBe('gpt-4o')
    expect(record.buildModel).toBe('gpt-4o')
    expect(record.buildConfigHash).toBe(configHashFor('gpt-4o'))
  })

  it('tree.get 等待期间切换配置，不会误判快照匹配的缓存为无效', async () => {
    const store = useChatStore()
    await store.init()
    const record = await realTreeRecord(store)  // 由当前配置（gpt-4o）建成的树
    mockDb().index.get.mockResolvedValue(storedIndex(PAGES_JSON))
    // 读取旧记录期间用户换了索引模型：这棵树对「本次快照」仍然有效，
    // 不该因为它对切换后的新配置无效就白白重建一次
    mockDb().tree.get.mockImplementation(async () => {
      void store.updateProfile('default', { model: 'gpt-4o-mini' })
      return record
    })

    const outcome = await store.buildPaperTree('p1')
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toContain('已有可复用的语义树')
    expect(mockDb().tree.set).not.toHaveBeenCalled()
  })

  it('建树期间切换配置时，完成的旧配置任务不再计入就绪集合', async () => {
    const store = useChatStore()
    await store.init()
    global.fetch = vi.fn().mockImplementation(async (_url: string, init: any) => {
      const prompt = JSON.parse(init.body).messages[0].content
      if (prompt.includes('轻量语义导航树')) {
        // 建树请求发出后、结果落盘前切换索引配置
        await store.updateProfile('default', { model: 'gpt-4o-mini' })
        return llmReply(VALID_TREE)
      }
      return llmReply('{"title":"平面标题","summary":"摘要"}')
    }) as any
    mockDb().index.get.mockResolvedValue(storedIndex(PAGES_JSON))

    expect((await store.buildPaperTree('p1')).ok).toBe(true)
    // 这棵树属于旧配置，loadSemanticIndex 会拒它，UI 也不能把它算成可用
    expect(store.treeReadyPapers.has('p1')).toBe(false)
  })

  it('并发刷新就绪集合时以最后一次配置为准，不被乱序响应覆盖', async () => {
    const pending: Array<{ configHash: string; resolve: (ids: string[]) => void }> = []
    mockDb().tree.list.mockImplementation((filter: any) => new Promise((resolve) => {
      pending.push({ configHash: filter.buildConfigHash, resolve })
    }))
    const store = useChatStore()
    const initPromise = store.init()
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    const updatePromise = store.updateProfile('default', { model: 'gpt-4o-mini' })
    await vi.waitFor(() => expect(pending).toHaveLength(2))

    // 新配置（B）先返回，旧配置（A）后返回
    pending[1].resolve(['p2'])
    pending[0].resolve(['p1'])
    await Promise.all([initPromise, updatePromise])

    expect([...store.treeReadyPapers]).toEqual(['p2'])
  })

  it('换索引模型后就绪集合按新配置刷新（旧树不再计入可用）', async () => {
    mockDb().tree.list.mockImplementation((filter: any) =>
      Promise.resolve(filter?.buildConfigHash === configHashFor('gpt-4o') ? ['p1', 'p2'] : []))
    const store = useChatStore()
    await store.init()
    expect(store.treeReadyPapers.size).toBe(2)

    await store.updateProfile('default', { model: 'gpt-4o-mini' })
    expect(store.treeReadyPapers.size).toBe(0)
  })

  it('rebuildAllTrees 区分「尝试 / 成功 / 失败 / 跳过」，不把失败说成没有论文', async () => {
    mockDb().index.list.mockResolvedValue(['p1', 'p2'])
    mockDb().index.get.mockResolvedValue(storedIndex(PAGES_JSON))
    mockDb().tree.get.mockResolvedValue(null)
    // 两篇的建树请求都直接失败
    global.fetch = vi.fn().mockImplementation((_url: string, init: any) => {
      const prompt = JSON.parse(init.body).messages[0].content
      if (prompt.includes('轻量语义导航树')) return Promise.reject(new Error('network down'))
      return Promise.resolve(llmReply('{"title":"平面标题","summary":"摘要"}'))
    }) as any
    const store = useChatStore()
    await store.init()

    // 失败计数之外必须带上首个失败原因（#13），否则 UI 只能报「失败」说不出为什么
    expect(await store.rebuildAllTrees()).toEqual({
      attempted: 2, rebuilt: 0, failed: 2, skipped: 0,
      firstReason: expect.stringContaining('请求失败'),
    })
  })

  it('rebuildAllTrees 在语义树关闭时全部跳过而非报成失败', async () => {
    mockDb().index.list.mockResolvedValue(['p1'])
    mockDb().settings.get.mockImplementation((key: string) =>
      Promise.resolve(key === 'semantic_tree_enabled' ? false : null))
    const store = useChatStore()
    await store.init()

    const summary = await store.rebuildAllTrees()
    expect(summary).toEqual({
      attempted: 0, rebuilt: 0, failed: 0, skipped: 1,
    })
    // 没有失败就不该编造原因
    expect(summary.firstReason).toBeUndefined()
  })

  it('rebuildAllTrees 对每篇已索引论文强制重建', async () => {
    mockDb().index.list.mockResolvedValue(['p1', 'p2'])
    mockDb().index.get.mockImplementation((paperId: string) =>
      Promise.resolve(storedIndex(PAGES_JSON)))
    mockDb().tree.get.mockImplementation((paperId: string) =>
      Promise.resolve({ paperId, treeJson: VALID_TREE, blocksJson: '[]', schemaVersion: SEMANTIC_TREE_SCHEMA_VERSION,
        promptVersion: 'v1', buildModel: 'm', sourceHash: hashTreeSource(PAGES_JSON),
        buildConfigHash: '', inputTokens: 0, outputTokens: 0, buildLatencyMs: 0, createdAt: 0 }))
    const store = useChatStore()
    await store.init()

    const summary = await store.rebuildAllTrees()
    expect(summary).toEqual({
      attempted: 2, rebuilt: 2, failed: 0, skipped: 0,
    })
    expect(summary.firstReason).toBeUndefined()
    expect(mockDb().tree.set.mock.calls.map(([paperId]: [string]) => paperId).sort()).toEqual(['p1', 'p2'])
  })

  it('论文内容变化时重建（指纹不匹配）', async () => {
    mockDb().index.get.mockResolvedValue(storedIndex(JSON.stringify(['new body'])))
    mockDb().tree.get.mockResolvedValue({
      paperId: 'p1', treeJson: VALID_TREE, blocksJson: '[]', schemaVersion: SEMANTIC_TREE_SCHEMA_VERSION,
      promptVersion: 'v1', buildModel: 'm', sourceHash: 'stale-hash',
      inputTokens: 0, outputTokens: 0, buildLatencyMs: 0, createdAt: 0,
    })
    const store = useChatStore()
    await store.init()

    expect((await store.buildPaperTree('p1')).ok).toBe(true)
    expect(mockDb().tree.set).toHaveBeenCalledTimes(1)
  })

})
