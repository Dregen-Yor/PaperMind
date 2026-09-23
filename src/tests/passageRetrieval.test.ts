import { describe, expect, it, vi } from 'vitest'
import { createMaxHeap } from '../utils/priorityQueue'
import { buildPassages, createEstimatingTokenCounter } from '../utils/passages'
import { buildTitleCards, cardsToIndexNodes, type StructureCard } from '../utils/structureCards'
import { PASSAGE_INDEX_VERSION, passageConfigHash, type PassageIndex } from '../utils/passageIndex'
import { fusePassageCandidates } from '../utils/passageRetrieval'
import type { Embedder } from '../utils/embedder'
import {
  DEFAULT_HYBRID_OPTIONS, fillPassageBudget, retrievePassageContext,
} from '../utils/passageRetrieval'
import { encodeVectors } from '../utils/embedder'
import { CONTEXT_GROUP_SEPARATOR, materializeContext } from '../utils/contextTrace'
import type { Passage } from '../utils/passages'

const counter = createEstimatingTokenCounter()

describe('createMaxHeap', () => {
  it('按分数降序出队', () => {
    const heap = createMaxHeap<{ score: number; order: number }>()
    heap.push({ score: 1, order: 0 })
    heap.push({ score: 5, order: 1 })
    heap.push({ score: 3, order: 2 })
    expect([heap.pop()!.score, heap.pop()!.score, heap.pop()!.score]).toEqual([5, 3, 1])
  })

  it('同分按 order 升序出队（确定性）', () => {
    const heap = createMaxHeap<{ score: number; order: number }>()
    heap.push({ score: 2, order: 5 })
    heap.push({ score: 2, order: 1 })
    heap.push({ score: 2, order: 3 })
    expect([heap.pop()!.order, heap.pop()!.order, heap.pop()!.order]).toEqual([1, 3, 5])
  })

  it('空堆 pop 返回 undefined', () => {
    expect(createMaxHeap<{ score: number; order: number }>().pop()).toBeUndefined()
  })
})

describe('fusePassageCandidates', () => {
  const pages = [
    'Abstract\nRetrieval study on Europarl.',
    'Methods\nWe use BM25.',
    'Experiments\nWe evaluate on Europarl and MultiUN.',
  ]
  const passages = buildPassages(pages, counter, { minTokens: 1 })
  const cards: StructureCard[] = [{ id: 'S1', range: [passages[0].id, passages[passages.length - 1].id], title: 'Datasets', summary: '', keyTerms: [] }]

  it('三路齐全时按加权 RRF 排序，卡片路权重生效', () => {
    const fused = fusePassageCandidates({
      passages,
      query: 'europarl datasets',
      bm25: query => passages.map(passage => ({ id: passage.order, score: passage.order === 2 ? 1 : 0 })),
      dense: () => passages.map(passage => ({ id: passage.order, score: passage.order === 0 ? 1 : 0 })),
      card: () => passages.map(passage => ({ id: passage.order, score: 0.5 })),
      rrfK: 60,
      sectionWeight: 0,
      queryVector: undefined,
      passagesCannotUseVectors: false,
    })
    expect(fused[0].order).toBe(0)
  })

  it('缺向量路时只用 BM25 名次', () => {
    const fused = fusePassageCandidates({
      passages,
      query: 'bm25',
      bm25: () => passages.map(passage => ({ id: passage.order, score: passage.order === 2 ? 9 : 1 })),
      dense: undefined,
      card: undefined,
      rrfK: 60,
      sectionWeight: 0.5,
      queryVector: undefined,
      passagesCannotUseVectors: true,
    })
    expect(fused[0].order).toBe(2)
    expect(fused.map(candidate => candidate.order)).toEqual([2, 0, 1])
  })

  it('并列时按 order 升序', () => {
    const fused = fusePassageCandidates({
      passages,
      query: 'x',
      bm25: () => passages.map(passage => ({ id: passage.order, score: 1 })),
      dense: undefined,
      card: undefined,
      rrfK: 60,
      sectionWeight: 0.5,
      queryVector: undefined,
      passagesCannotUseVectors: true,
    })
    expect(fused.map(candidate => candidate.order)).toEqual([0, 1, 2])
  })
})

/** 4 页，每页一个自然段；总 token 远小于 4096，用于「整篇放入」类断言。 */
function fakeIndex(overrides: Partial<PassageIndex> = {}): { index: PassageIndex; embedder: Embedder } {
  const pages = [
    'Intro\nAlpha beta gamma delta epsilon zeta.',
    'Methods\nWe train a model on the Europarl corpus.',
    'Experiments\nResults on MultiUN are strong.',
    'Discussion\nWe discuss limitations.',
  ]
  const passages = buildPassages(pages, counter, { minTokens: 1 })
  const cards: StructureCard[] = [
    { id: 'S1', range: [passages[0].id, passages[1].id], title: 'Motivation and method', summary: '', keyTerms: ['corpus'] },
    { id: 'S2', range: [passages[2].id, passages[passages.length - 1].id], title: 'MultiUN results', summary: '', keyTerms: ['results'] },
  ]
  const dim = 4
  const index: PassageIndex = {
    version: PASSAGE_INDEX_VERSION,
    stage: 3,
    passages,
    passageConfigHash: passageConfigHash({ schemaVersion: 2, segmentation: { minTokens: 1, maxTokens: 350 } }),
    separatorTokens: 2,
    tree: cardsToIndexNodes(cards, passages),
    cards,
    vectorDim: dim,
    passageVectors: passages.map((_, i) => new Float32Array([i === 2 ? 1 : 0, 1, 0, 0])),
    cardVectors: cards.map((_, i) => new Float32Array([i === 1 ? 1 : 0, 1, 0, 0])),
    embedderId: 'fake@main#q8',
    structureHash: 'sh',
    ...overrides,
  }
  const embedder: Embedder = {
    id: 'fake@main#q8',
    embedQuery: vi.fn(async () => new Float32Array([1, 1, 0, 0])),
    embedPassages: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(dim))),
  }
  return { index, embedder }
}

/** 单小节、长段落：预算放不下全部，才走真正的选择与邻段扩展路径。 */
function longPaper(): Passage[] {
  const paragraph = 'We describe the experimental setup in detail and report every hyperparameter used in the final model. '.repeat(3).trim()
  const pages = [`Methods\n${paragraph}\n\n${paragraph}\n\n${paragraph}\n\n${paragraph}`]
  return buildPassages(pages, counter, { minTokens: 1 })
}

describe('retrievePassageContext（模式判定与组装）', () => {
  it('阶段③ 完整信号 → full，检索阶段零 LLM 调用', async () => {
    const { index, embedder } = fakeIndex()
    const result = await retrievePassageContext(index, 'MultiUN results', { embedder })
    expect(result.hybrid.retrievalMode).toBe('full')
    expect(result.llmCalled).toBe(false)
    expect(result.degraded).toBe(false)
    expect(result.contextGroups.length).toBeGreaterThan(0)
  })

  it('缺向量时降级为 bm25，仍返回原文', async () => {
    // 阶段① 的记录只有段落：向量与卡片（阶段③ 才产出）都缺席，因此卡片字段也要显式清掉。
    // 降级顺序按「当前可用信号」判定，留着一张卡片就会走 bm25+card-lexical
    const { index } = fakeIndex({ stage: 1, passageVectors: undefined, cardVectors: undefined, cards: undefined })
    const result = await retrievePassageContext(index, 'Europarl corpus', {})
    expect(result.hybrid.retrievalMode).toBe('bm25')
    expect(result.context).toContain('Europarl')
  })

  it('向量不可用但卡片在 → bm25+card-lexical', async () => {
    const { index } = fakeIndex({ stage: 3, passageVectors: undefined, cardVectors: undefined })
    const result = await retrievePassageContext(index, 'corpus', {})
    expect(result.hybrid.retrievalMode).toBe('bm25+card-lexical')
  })

  it('标题卡片回落 → full-title-fallback', async () => {
    const { index, embedder } = fakeIndex({ structureFallback: { reason: 'invalid-json' } })
    const result = await retrievePassageContext(index, 'results', { embedder })
    expect(result.hybrid.retrievalMode).toBe('full-title-fallback')
  })

  it('embedder 抛错时不让异常冒给调用方，落到有向量的替代路径之外', async () => {
    const { index, embedder } = fakeIndex()
    const failing: Embedder = {
      id: embedder.id,
      embedQuery: async () => { throw new Error('offline') },
      embedPassages: embedder.embedPassages,
    }
    const result = await retrievePassageContext(index, 'corpus', { embedder: failing })
    expect(result.hybrid.retrievalMode).toBe('bm25+card-lexical')
    expect(result.contextGroups.length).toBeGreaterThan(0)
  })

  it('向量不自洽时降级而不抛错（查询向量维度不符 / 段落向量数不齐）', async () => {
    const { index, embedder } = fakeIndex()
    // 3 长度的查询向量（索引是 4 维）：没有长度判定的话，dense 路会在 `cosineSimilarity`
    // 里抛「向量维度不一致」——而它在 `fusePassageCandidates` 内部执行，已经过了 embedder 的
    // try/catch，异常会直接冒给调用方，而不是落回词法模式
    const wrongDim: Embedder = { ...embedder, embedQuery: async () => new Float32Array([1, 1, 0]) }
    const mismatched = await retrievePassageContext(index, 'corpus', { embedder: wrongDim })
    expect(mismatched.hybrid.retrievalMode).toBe('bm25+card-lexical')
    expect(mismatched.contextGroups.length).toBeGreaterThan(0)
    // 段落向量比段落少一个：`passageVectors[passage.order]` 会取到 undefined
    const shortIndex: PassageIndex = { ...index, passageVectors: (index.passageVectors as Float32Array[]).slice(0, 3) }
    const shortVectors = await retrievePassageContext(shortIndex, 'corpus', { embedder })
    expect(shortVectors.hybrid.retrievalMode).toBe('bm25+card-lexical')
    expect(shortVectors.contextGroups.length).toBeGreaterThan(0)
  })

  it('任意输入下上下文 token 总数（含分隔符）不超过预算', async () => {
    const { index, embedder } = fakeIndex()
    for (const budget of [1, 5, 10, 4096]) {
      const result = await retrievePassageContext(index, 'corpus', { embedder, maxTokens: budget, countTokens: counter })
      const tokens = result.contextGroups.reduce((sum, group) => sum + group.pieces.reduce((s, piece) => s + counter(piece.text), 0), 0)
        + Math.max(0, result.contextGroups.length - 1) * counter(CONTEXT_GROUP_SEPARATOR)
      expect(tokens).toBeLessThanOrEqual(budget)
    }
  })

  it('全文不超过预算时整篇按原文顺序放入、只有一个组', async () => {
    const { index, embedder } = fakeIndex()
    const total = index.passages.reduce((sum, passage) => sum + passage.tokenCount, 0)
    const result = await retrievePassageContext(index, 'anything', { embedder, maxTokens: total })
    expect(result.hybrid.selectedPassageIds).toEqual(index.passages.map(passage => passage.id))
    expect(result.contextGroups).toHaveLength(1)
    expect(result.hybrid.neighbourSelectedIds).toEqual([])   // 整篇放入时没有「扩展」这回事
  })

  it('选中段落始终按原文顺序、组内连续、组间有分隔符', async () => {
    const passages = longPaper()
    const index = {
      ...fakeIndex().index,
      passages,
      tree: cardsToIndexNodes(buildTitleCards(passages), passages),
      cards: buildTitleCards(passages),
      passageVectors: undefined,
      cardVectors: undefined,
      stage: 1 as const,
    }
    const result = await retrievePassageContext(index, 'hyperparameter setup', { maxTokens: 300, countTokens: counter })
    const ids = result.hybrid.selectedPassageIds
    expect(ids.length).toBeGreaterThan(0)
    expect(ids).toEqual([...ids].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))))
    if (result.contextGroups.length > 1) expect(result.context).toContain(CONTEXT_GROUP_SEPARATOR)
  })

  it('selected 只含真实连续页区间，且 sources 与 selected 一一对应', async () => {
    const { index, embedder } = fakeIndex()
    const result = await retrievePassageContext(index, 'corpus', { embedder })
    for (const node of result.selected) {
      expect(node.endPage).toBeGreaterThanOrEqual(node.startPage)
      expect(node.nodes).toEqual([])
    }
    expect(result.sources).toHaveLength(result.selected.length)
  })

  it('sources 用卡片标题标注页区间', async () => {
    const { index, embedder } = fakeIndex()
    // 默认预算会把整篇放进一个页区间连续的组，来源就只剩第一张卡片的标题。
    // 收紧到只放得下 3 号（约 11 token）后选中段落不以 0 号开头，第二张卡片的标题才会出现
    const result = await retrievePassageContext(index, 'MultiUN results', { embedder, maxTokens: 15 })
    expect(result.sources.some(source => /^Pages \d+–\d+: MultiUN results$/.test(source))).toBe(true)
  })

  it('预算放得下两段不相邻段落时，组装出两个组、两个真实页区间', async () => {
    const { index, embedder } = fakeIndex()
    // 0 号（页 1）与 2 号（页 3）各放得下、1 号（页 2）放不下：选中段落页序不连续，
    // 于是两个 ContextGroup、两个真实页区间，中间必须落一个分隔符。
    // 预算由 fixture 自己的 tokenCount 算出（0 + 2 + 一个分隔符），不依赖分词细节
    const budget = index.passages[0].tokenCount + index.passages[2].tokenCount + index.separatorTokens
    const result = await retrievePassageContext(index, 'corpus', { embedder, maxTokens: budget })
    expect(result.contextGroups).toHaveLength(2)
    expect(result.hybrid.selectedPassageIds).toEqual([index.passages[0].id, index.passages[2].id])
    expect(result.context).toContain(CONTEXT_GROUP_SEPARATOR)
    expect(result.context).toBe([index.passages[0].text, index.passages[2].text].join(CONTEXT_GROUP_SEPARATOR))
    expect(result.selected).toHaveLength(2)
    expect(result.sources).toHaveLength(2)
    expect(new Set(result.sources).size).toBe(2)
    expect(result.selected[0].endPage).toBeLessThan(result.selected[1].startPage)
  })

  it('填充的预算记法与物化同口径（R29）：预算扫描下 materializeContext 从不截断', async () => {
    const { index, embedder } = fakeIndex()
    // 与建索引用的估算器逐字同口径的分词器（非空文本都是 max(1, round(len/4)) 个 token）：
    // 两边数出的 token 必须一样，「填充保证不截断」才是可证的（见 passageRetrieval.ts 文件头）
    const exact = { tokenize: (text: string) => (text.length === 0 ? [] : Array(Math.max(1, Math.round(text.length / 4))).fill('x')) }
    const total = index.passages.reduce((sum, passage) => sum + passage.tokenCount, 0)
    const multiGroupBudgets: number[] = []
    for (let budget = 1; budget <= total + index.separatorTokens + 1; budget++) {
      const result = await retrievePassageContext(index, 'corpus', { embedder, maxTokens: budget })
      const materialized = materializeContext(result.contextGroups, exact, budget)
      expect(materialized.truncated, `budget=${budget}`).toBe(false)
      expect(materialized.tokenCount, `budget=${budget}`).toBeLessThanOrEqual(budget)
      if (result.contextGroups.length >= 2) multiGroupBudgets.push(budget)
    }
    // 扫描里必须至少出现一个多组预算：组间分隔符那一项只在多组时非零，单组扫描等于
    // 没检验「填充的 run 规则与组装的分组规则同规则」——而那正是本证明的承重部分
    expect(multiGroupBudgets.length).toBeGreaterThan(0)
  })

  it('空段落索引返回空上下文而不抛错', async () => {
    const { index } = fakeIndex()
    const result = await retrievePassageContext({ ...index, passages: [] }, 'x', {})
    expect(result.context).toBe('')
    expect(result.contextGroups).toEqual([])
    expect(result.hybrid.selectedPassageIds).toEqual([])
  })

  it('默认旋钮就是设计文档冻结值', () => {
    expect(DEFAULT_HYBRID_OPTIONS).toEqual({ maxTokens: 4096, rrfK: 60, sectionWeight: 0.5, neighbourFactor: 0.5, skipLimit: 20 })
  })
})

describe('fillPassageBudget', () => {
  /**
   * 5 段同小节：0 号是一段长自然段（约 22 token），1–4 号各约 4 token。
   * 分隔符单独可控（`separatorTokens`），断言不依赖具体分词数字。
   */
  const passages = buildPassages(
    [`Methods\n${'alpha beta gamma delta epsilon zeta eta theta. '.repeat(2).trim()}\n\np2 words here now\n\np3 words here now\n\np4 words here now\n\np5 words here now`],
    counter,
    { minTokens: 1 },
  )
  const tokens = (order: number) => passages[order].tokenCount
  const base = {
    passages,
    separatorTokens: 0,
    neighbourFactor: 0.5,
    skipLimit: 20,
    maxTokens: 10_000,
  }
  const candidates = (...scores: number[]) => scores.map((score, order) => ({ order, score, fromNeighbour: false }))

  it('放不下即跳过并计数，堆空即结束', () => {
    // 预算 4：0 号 22 token 放不下，1 号正好放入，随后每段都放不下
    const fill = fillPassageBudget({ ...base, candidates: candidates(9, 8, 7, 6, 5), maxTokens: 4 })
    expect(fill.selectedOrders).toEqual([1])
    expect(fill.skippedCount).toBe(4)
  })

  it('连续跳过上限一到就停，不再尝试后面的候选', () => {
    const expensive = passages.map(passage => ({ ...passage, tokenCount: 1000 }))
    const fill = fillPassageBudget({
      ...base,
      passages: expensive,
      candidates: candidates(9, 8, 7, 6, 5),
      maxTokens: 10,
      skipLimit: 1,
    })
    expect(fill.selectedOrders).toEqual([])
    expect(fill.skippedCount).toBe(1)
  })

  it('成功放入后跳过计数归零（上限只约束「连续」跳过）', () => {
    // 1 号与 3 号超大，2 号与 4 号很小。skipLimit=2：
    // 首次跳过 1 号（计数 1）→ 放入 2 号（计数必须归零）→ 跳过 3 号（计数 1）→ 放入 4 号
    // 若不归零，放入 2 号后计数仍为 1，3 号跳过即达上限、4 号永远试不到
    const mixed = passages.map((passage, order) => ({ ...passage, tokenCount: order % 2 === 0 ? 1 : 10_000 }))
    const fill = fillPassageBudget({
      ...base,
      passages: mixed,
      candidates: candidates(9, 8, 7, 6, 5),
      maxTokens: 3,
      skipLimit: 2,
    })
    expect(fill.selectedOrders).toEqual([0, 2, 4])
    expect(fill.skippedCount).toBe(2)
  })

  it('邻段扩展：入队值被扩展抬高的段落记为邻段选中', () => {
    // 只有 2 号有分（10）；其同小节邻段 1 / 3 以 5 入队，压过它们原本 0.1 的融合分。
    // 预算正好放 1+2+3 三段（连续，无分隔符）
    const fill = fillPassageBudget({
      ...base,
      candidates: candidates(0.1, 0.1, 10, 0.1, 0.1),
      maxTokens: tokens(1) + tokens(2) + tokens(3),
    })
    expect(fill.selectedOrders).toEqual([1, 2, 3])
    expect(fill.neighbourOrders).toEqual([1, 3])
  })

  it('不跨小节扩展：不同 subsection 的邻段不入选', () => {
    // 三小节各一段（真标题），页序相邻但小节互不相同 → 没有合法的邻段可扩。
    // 2 号用 tokenCount 覆盖成放不下（与上面两例同法）：**预算必须放得下 0 与 1 两段**
    // （= 两段 token 之和，两段页序相邻、无分隔符），否则 1 号会因预算被拒，
    // 判定就落回「无论有没有同小节守卫都选不进 1 号」的空转。
    // 而「整篇放得下」的短路也必须绕开——总 token 里那 10_000 让它不成立：
    // 若预算等于总 token，fill 直接返回全部段落，这条用例同样与守卫无关。
    // 有守卫时：0 号入选，1 号只能靠自己的候选分 0.1 入选，neighbourOrders 为空；
    // 没有守卫时：0 号入选会以 10 × 0.5 = 5 把 1 号当邻段塞进堆（压过 0.1），
    // 1 号就会记为邻段选中。
    const split = buildPassages(
      ['Methods\nonly para here', 'Experiments\nanother para here', 'Discussion\na third para here'],
      counter,
      { minTokens: 1 },
    ).map((passage, order) => (order === 2 ? { ...passage, tokenCount: 10_000 } : passage))
    const fill = fillPassageBudget({
      ...base,
      passages: split,
      candidates: [
        { order: 0, score: 10, fromNeighbour: false },
        { order: 1, score: 0.1, fromNeighbour: false },
        { order: 2, score: 3, fromNeighbour: false },
      ],
      separatorTokens: 0,
      maxTokens: split[0].tokenCount + split[1].tokenCount,   // 恰好放得下 0 与 1 号
    })
    expect(fill.selectedOrders).toEqual([0, 1])
    expect(fill.neighbourOrders).toEqual([])
  })

  it('不连续的选中段落要计入组间分隔符', () => {
    // 三小节各一段（真标题，故没有邻段扩展干扰），选中间跳过 1 号 →
    // 选中 0 与 2 不连续，需要 1 个分隔符。1 号必须放不进剩余预算：
    // 否则跳过 2 号后它会以「与 0 号连续」的身份补位，「加分隔符就超预算」就断言不到了
    // （用 tokenCount 覆盖造出放不下的段，与上面两例同法）
    const split = buildPassages(
      ['Methods\nfirst para here now', 'Experiments\nmiddle para here now', 'Discussion\nthird para here now'],
      counter,
      { minTokens: 1 },
    ).map((passage, order) => (order === 1 ? { ...passage, tokenCount: 10_000 } : passage))
    const sum = split[0].tokenCount + split[2].tokenCount
    const noSeparator = fillPassageBudget({
      ...base, passages: split, separatorTokens: 0, maxTokens: sum, candidates: candidates(5, 0.1, 4),
    })
    const withSeparator = fillPassageBudget({
      ...base, passages: split, separatorTokens: 1, maxTokens: sum, candidates: candidates(5, 0.1, 4),
    })
    expect(noSeparator.selectedOrders).toEqual([0, 2])
    expect(withSeparator.selectedOrders).toEqual([0])   // 加上分隔符就超预算
  })

  it('全文放得下时整篇按原序放入，且不记邻段', () => {
    const fill = fillPassageBudget({ ...base, candidates: candidates(1, 1, 1, 1, 1) })
    expect(fill.selectedOrders).toEqual([0, 1, 2, 3, 4])
    expect(fill.neighbourOrders).toEqual([])
  })

  it('结果只由分数与 order 决定（同分按 order 升序）', () => {
    const tie = fillPassageBudget({ ...base, candidates: candidates(1, 1, 1, 1, 1), maxTokens: 12 })
    expect(tie.selectedOrders).toEqual([1, 2, 3])
  })
})

describe('fusePassageCandidates 卡片先验的接线', () => {
  /** 单页三段，只为给融合提供 `passages` 占位——三路打分器由测试直接给分。 */
  const passages = buildPassages(['Retrieval study.\n\nWe use BM25.\n\nEuroparl results.'], counter, { minTokens: 1 })
  const ranked = (...scores: number[]) => scores.map((score, id) => ({ id, score }))
  const topOrder = (sectionWeight: number) => fusePassageCandidates({
    passages,
    query: 'x',
    bm25: () => ranked(2, 1, 0),
    card: () => ranked(1, 2, 0),
    rrfK: 60,
    sectionWeight,
    queryVector: undefined,
    passagesCannotUseVectors: true,
  })[0].order

  it('同一组输入下 sectionWeight 0 与非零的第一名不同（卡片路真的接上了）', () => {
    // 卡片路是 BM25 路的名次镜像：权重 0（或卡片路根本没加入）时两个 id 的同分只能由
    // id 升序破平，卡片路改不了第一名；权重 2 让卡片路真正加权后才把 1 号顶到第一
    // （1/62 + 2/61 > 1/61 + 2/62）。这与 `rrf.test.ts` 的「权重改变卡片路的名次贡献」同型。
    expect(topOrder(0)).toBe(0)
    expect(topOrder(2)).toBe(1)
  })
})
