import { describe, expect, it, vi } from 'vitest'
import { startPassagePipeline } from '../utils/passageIndexBuilder'
import { buildPassages, createEstimatingTokenCounter } from '../utils/passages'
import { buildTitleCards, type StructureCard } from '../utils/structureCards'
import { PASSAGE_INDEX_VERSION, passageConfigHash, type PassageIndex } from '../utils/passageIndex'
import type { Embedder } from '../utils/embedder'

const PAGES = [
  'Abstract\nWe study retrieval.\n\nIntroduction\nRetrieval matters.\n\nMethods\nWe use BM25.\n\nExperiments\nEuroparl and MultiUN.',
]
const counter = createEstimatingTokenCounter()

const PASSAGE_HASH = passageConfigHash({ schemaVersion: 2, segmentation: { minTokens: 1, maxTokens: 350 } })
const STRUCTURE_HASH = 'sh-v1'

function fakeEmbedder(): Embedder {
  return {
    id: 'fake@main#q8',
    embedQuery: vi.fn(async () => new Float32Array([1, 0])),
    embedPassages: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array([1, 0]))),
  }
}

function deps(llm: (prompt: string) => Promise<string>, embedder?: Embedder) {
  const persisted: Array<{ stage: number; index: PassageIndex }> = []
  const stages: string[] = []
  return {
    persisted,
    stages,
    deps: {
      llm,
      countTokens: counter,
      ...(embedder ? { embedder } : {}),
      passageConfigHash: PASSAGE_HASH,
      structureHash: STRUCTURE_HASH,
      persist: async (index: PassageIndex, stage: 1 | 2 | 3) => { persisted.push({ stage, index }) },
      onStage: (event: { stage: string }) => { stages.push(event.stage) },
    },
  }
}

// PAGES 切出的是 4 段（P01 Abstract / P02 Introduction / P03 Methods / P04 Experiments）：
// 四个标题行各自开启一个新小节，`mergeSmallParagraphs` 不跨小节合并，所以最小的
// `minTokens` 也得不到第 5 段。三张卡片覆盖这 4 段（连续、恰好一次）才可能通过校验。
const CARDS_JSON = JSON.stringify({
  sections: [
    { id: 'S1', range: ['P01', 'P02'], title: 'Retrieval motivation', summary: 'Why.', keyTerms: ['why'] },
    { id: 'S2', range: ['P03', 'P03'], title: 'BM25 baseline', summary: 'How.', keyTerms: ['bm25'] },
    { id: 'S3', range: ['P04', 'P04'], title: 'Europarl results', summary: 'What.', keyTerms: ['europarl'] },
  ],
})

describe('startPassagePipeline', () => {
  it('阶段① 立即完成并落盘（BK25 即可用），②③ 由 rest 承诺完成', async () => {
    const embedder = fakeEmbedder()
    const ctx = deps(async () => CARDS_JSON, embedder)
    const started = await startPassagePipeline(PAGES, ctx.deps, {})
    expect(started.index.stage).toBe(1)
    expect(started.index.passages.length).toBeGreaterThan(0)
    expect(ctx.persisted[0].stage).toBe(1)

    const final = await started.rest
    expect(final.stage).toBe(3)
    expect(final.cards).toHaveLength(3)
    expect(final.passageVectors).toHaveLength(final.passages.length)
    expect(final.cardVectors).toHaveLength(3)
    expect(ctx.persisted.map(item => item.stage)).toEqual([1, 2, 3])
  })

  it('阶段② 与阶段③ 并行：卡片的 LLM 调用不等待向量', async () => {
    const embedder = fakeEmbedder()
    let resolveEmbed: (() => void) | undefined
    // 只卡住**第一次**调用（阶段② 的段落向量）。卡片向量的那一次必须放行：
    // 它排在阶段③ 之后，若也一起卡住，`rest` 永远不会完成，断言并行性就变成断言挂死。
    let blocked = false
    const slowEmbedder: Embedder = {
      id: embedder.id,
      embedQuery: embedder.embedQuery,
      embedPassages: vi.fn(async (texts: string[]) => {
        if (!blocked) {
          blocked = true
          await new Promise<void>(resolve => { resolveEmbed = resolve })
        }
        return texts.map(() => new Float32Array([1, 0]))
      }),
    }
    let llmCalled = false
    const ctx = deps(async () => { llmCalled = true; return CARDS_JSON }, slowEmbedder)
    const started = await startPassagePipeline(PAGES, ctx.deps, {})
    await new Promise(resolve => setTimeout(resolve, 0))
    // 卡住的那次调用必须真的发出去了：否则「向量还卡着」无从谈起，
    // `resolveEmbed` 会是 undefined、`resolveEmbed?.()` 空转，本用例变成空断言
    expect(slowEmbedder.embedPassages).toHaveBeenCalled()
    expect(llmCalled).toBe(true)          // 向量还卡着，卡片调用已经发出
    resolveEmbed?.()
    await started.rest
  })

  it('每篇恰好一次卡片调用', async () => {
    const llm = vi.fn(async () => CARDS_JSON)
    const started = await startPassagePipeline(PAGES, deps(llm, fakeEmbedder()).deps, {})
    await started.rest
    expect(llm).toHaveBeenCalledTimes(1)
  })

  it('卡片校验失败 → 标题卡片回落并记录原因，不重试', async () => {
    const llm = vi.fn(async () => '{oops}')
    const ctx = deps(llm, fakeEmbedder())
    const started = await startPassagePipeline(PAGES, ctx.deps, {})
    const final = await started.rest
    expect(llm).toHaveBeenCalledTimes(1)
    expect(final.structureFallback?.reason).toBe('invalid-json')
    expect(final.cards).toEqual(buildTitleCards(final.passages))
    expect(final.stage).toBe(3)
  })

  it('向量模型不可用 → 停留阶段①，卡片仍然生成（阶段③ 无向量）', async () => {
    const ctx = deps(async () => CARDS_JSON)
    const started = await startPassagePipeline(PAGES, ctx.deps, {})
    const final = await started.rest
    expect(final.passageVectors).toBeUndefined()
    expect(final.cardVectors).toBeUndefined()
    expect(final.cards).toHaveLength(3)
    expect(ctx.persisted.map(item => item.stage)).toEqual([1, 3])

    // 「不可用」的另一种形态：embedder 存在但调用抛错（模型没缓存 / 会话不可用）。
    // 那是阶段② 内部的 catch 路径，与「根本没传 embedder」不是同一段代码；
    // 没有向量是可用性降级，不是构建失败，阶段③ 必须照常完成
    const broken: Embedder = {
      id: 'broken@main#q8',
      embedQuery: vi.fn(async () => { throw new Error('向量模型不可用') }),
      embedPassages: vi.fn(async () => { throw new Error('向量模型不可用') }),
    }
    const brokenCtx = deps(async () => CARDS_JSON, broken)
    const brokenFinal = await (await startPassagePipeline(PAGES, brokenCtx.deps, {})).rest
    expect(brokenFinal.passageVectors).toBeUndefined()
    expect(brokenFinal.cardVectors).toBeUndefined()
    expect(brokenFinal.cards).toHaveLength(3)
    expect(brokenFinal.stage).toBe(3)
    expect(brokenCtx.persisted.map(item => item.stage)).toEqual([1, 3])
  })

  it('切段指纹相同 → 复用段落，不重切', async () => {
    const embedder = fakeEmbedder()
    const first = await (await startPassagePipeline(PAGES, deps(async () => CARDS_JSON, embedder).deps, {})).rest
    const llm = vi.fn(async () => CARDS_JSON)
    const ctx = deps(llm, embedder)
    const second = await startPassagePipeline(PAGES, ctx.deps, { existing: first })
    expect(second.index.passages.map(p => p.id)).toEqual(first.passages.map(p => p.id))
    expect(llm).not.toHaveBeenCalled()   // structureHash 相同 → 卡片也复用
    expect(await second.rest).toMatchObject({ stage: 3 })
  })

  it('structureHash 变化时只重做卡片（段落复用，向量复用）', async () => {
    const embedder = fakeEmbedder()
    const first = await (await startPassagePipeline(PAGES, deps(async () => CARDS_JSON, embedder).deps, {})).rest
    const llm = vi.fn(async () => CARDS_JSON)
    const ctx = deps(llm, embedder)
    const started = await startPassagePipeline(PAGES, { ...ctx.deps, structureHash: 'sh-v2' }, { existing: first })
    expect(started.index.cards).toBeUndefined()
    const final = await started.rest
    expect(llm).toHaveBeenCalledTimes(1)
    expect(final.passageVectors).toHaveLength(final.passages.length)  // 向量仍复用
    // 卡片向量的重算**不许**看 `plan.vectors`：这一例里 plan 明确说「向量不用重算」，
    // 而卡片换了新内容，卡片向量必须跟着重算，否则挂上的是与卡片文本无对应关系的旧向量
    expect(final.cardVectors).toHaveLength(final.cards?.length ?? 0)
  })

  it('切段参数透传到切分器，指纹口径与切段口径一致', async () => {
    const knobs = { minTokens: 1, maxTokens: 4 }
    const expected = buildPassages(PAGES, counter, knobs).map(passage => passage.id)
    // 前提断言：这组 knobs 与默认口径产出的段落确实不同，否则本用例对「透传」是空断言
    expect(expected.length).toBeGreaterThan(buildPassages(PAGES, counter, {}).length)
    const ctx = deps(async () => CARDS_JSON, fakeEmbedder())
    const started = await startPassagePipeline(PAGES, { ...ctx.deps, segmentation: knobs }, {})
    expect(started.index.passages.map(passage => passage.id)).toEqual(expected)
    await started.rest
  })

  it('embedderId 变化 → 只重算向量，不调用 LLM', async () => {
    const embedder = fakeEmbedder()
    const first = await (await startPassagePipeline(PAGES, deps(async () => CARDS_JSON, embedder).deps, {})).rest
    const llm = vi.fn(async () => CARDS_JSON)
    const other: Embedder = { id: 'other@main#q8', embedQuery: embedder.embedQuery, embedPassages: embedder.embedPassages }
    const ctx = deps(llm, other)
    const started = await startPassagePipeline(PAGES, ctx.deps, { existing: first })
    const final = await started.rest
    expect(llm).not.toHaveBeenCalled()
    expect(final.embedderId).toBe('other@main#q8')
  })

  it('无 embedder 时原样带过存量向量（段落未重切）：三元组一起保留', async () => {
    const first = await (await startPassagePipeline(PAGES, deps(async () => CARDS_JSON, fakeEmbedder()).deps, {})).rest
    expect(first.passageVectors).toHaveLength(first.passages.length)

    // 第二次构建没有 embedder（模型没下载完 / 会话暂时拿不到）：段落没重切、向量依然有效，
    // 已经付过费的东西不该因为「模型还没就绪」就作废
    const llm = vi.fn(async () => CARDS_JSON)
    const ctx = deps(llm)
    const final = await (await startPassagePipeline(PAGES, ctx.deps, { existing: first })).rest
    expect(final.passageVectors).toEqual(first.passageVectors)
    expect(final.vectorDim).toBe(first.vectorDim)
    expect(final.embedderId).toBe(first.embedderId)   // 有向量就必须说得出是谁算的，三元组一起写
    expect(final.passageVectors).toHaveLength(final.passages.length)
    expect(final.stage).toBe(3)                       // 卡片照常是阶段③ 的成果
    expect(llm).not.toHaveBeenCalled()                // structureHash 未变 → 卡片也复用
    expect(ctx.persisted.map(item => item.stage)).toEqual([1, 3])
  })

  it('存量向量数与段落数不一致 → 不搬：错位的向量比没有向量更糟', async () => {
    const first = await (await startPassagePipeline(PAGES, deps(async () => CARDS_JSON, fakeEmbedder()).deps, {})).rest
    const vectors = first.passageVectors ?? []
    expect(vectors).toHaveLength(first.passages.length)   // 前提：存量本来是可搬的

    const shortCtx = deps(async () => CARDS_JSON)
    const short = await (await startPassagePipeline(PAGES, shortCtx.deps, { existing: { ...first, passageVectors: vectors.slice(0, -1) } })).rest
    expect(short.passageVectors).toBeUndefined()
    expect(short.vectorDim).toBeUndefined()
    expect(short.embedderId).toBeUndefined()

    // 逐条维度也要对上：`vectorDim: 3` 配着长度 2 的向量是同一类不自洽
    const dimCtx = deps(async () => CARDS_JSON)
    const dim = await (await startPassagePipeline(PAGES, dimCtx.deps, { existing: { ...first, vectorDim: 3 } })).rest
    expect(dim.passageVectors).toBeUndefined()
    expect(dim.vectorDim).toBeUndefined()
  })

  it('段落重切（passageConfigHash 变）→ 绝不带过存量向量：它们属于别的段落', async () => {
    const first = await (await startPassagePipeline(PAGES, deps(async () => CARDS_JSON, fakeEmbedder()).deps, {})).rest
    expect(first.passageVectors).toHaveLength(first.passages.length)

    const llm = vi.fn(async () => CARDS_JSON)
    const ctx = deps(llm)
    const final = await (await startPassagePipeline(PAGES, { ...ctx.deps, passageConfigHash: 'pch-v2' }, { existing: first })).rest
    // 切法没变（段落数与 first 相同），所以唯一拦住搬运的就是 plan.passages
    expect(final.passages).toHaveLength(first.passages.length)
    expect(final.passageVectors).toBeUndefined()
    expect(final.vectorDim).toBeUndefined()
    expect(final.embedderId).toBeUndefined()
    expect(llm).toHaveBeenCalledTimes(1)              // 全量重建：卡片也重做
  })

  it('force 全量重来：调用 LLM、重算向量，不继承任何存量字段', async () => {
    const first = await (await startPassagePipeline(PAGES, deps(async () => CARDS_JSON, fakeEmbedder()).deps, {})).rest
    const storedVectors = first.passageVectors ?? []
    expect(storedVectors).toHaveLength(first.passages.length)   // 前提：存量是完整可复用的稠密索引
    // 给存量打上「只会被继承带出来」的标记：段落文本前缀、向量值、回落原因与 paper
    const stale: PassageIndex = {
      ...first,
      passages: first.passages.map(passage => ({ ...passage, searchText: `STALE ${passage.searchText}` })),
      passageVectors: storedVectors.map(() => new Float32Array([7, 7])),
      vectorDim: 2,
      structureFallback: { reason: 'invalid-json' },
      paper: { title: 'stale-title', summary: 'stale-summary' },
    }

    // 对照组：同一份存量、不带 force → 三个指纹都命中，全部复用（零 LLM 调用，向量原样搬过来）
    const reuseEmbedder = fakeEmbedder()
    const reuseLlm = vi.fn(async () => CARDS_JSON)
    const reused = await (await startPassagePipeline(PAGES, deps(reuseLlm, reuseEmbedder).deps, { existing: stale })).rest
    expect(reuseLlm).not.toHaveBeenCalled()
    expect(reuseEmbedder.embedPassages).toHaveBeenCalledTimes(1)   // 只剩卡片向量那一次（刻意不看 plan.vectors）
    expect(reused.passages[0].searchText.startsWith('STALE')).toBe(true)
    expect(reused.passageVectors?.[0][0]).toBe(7)
    expect(reused.structureFallback?.reason).toBe('invalid-json')
    expect(reused.paper?.title).toBe('stale-title')

    // force：现有索引整份丢弃，三个指纹都不参与复用
    const forceEmbedder = fakeEmbedder()
    const forceLlm = vi.fn(async () => CARDS_JSON)
    const forced = await (await startPassagePipeline(PAGES, deps(forceLlm, forceEmbedder).deps, { existing: stale, force: true })).rest
    expect(forceLlm).toHaveBeenCalledTimes(1)
    expect(forceEmbedder.embedPassages).toHaveBeenCalledTimes(2)   // 段落向量 + 卡片向量都重算
    expect(forced.passages[0].searchText.startsWith('STALE')).toBe(false)   // 重新切出来的段落
    expect(forced.passageVectors?.[0][0]).toBe(1)                  // 模型重算的向量，不是存量那份
    expect(forced.vectorDim).toBe(2)
    expect(forced.embedderId).toBe(forceEmbedder.id)
    expect(forced.structureFallback).toBeUndefined()
    expect(forced.paper).toBeUndefined()
  })

  it('旧版（v1）存量索引视为过期，全量重建', async () => {
    const llm = vi.fn(async () => CARDS_JSON)
    const ctx = deps(llm, fakeEmbedder())
    const started = await startPassagePipeline(PAGES, ctx.deps, { existing: undefined })
    const final = await started.rest
    expect(final.version).toBe(PASSAGE_INDEX_VERSION)
    expect(llm).toHaveBeenCalledTimes(1)
  })

  it('阶段① 落盘失败即抛出，不静默吞掉（没有落盘就没有可用的索引）', async () => {
    const ctx = deps(async () => CARDS_JSON, fakeEmbedder())
    const failing = { ...ctx.deps, persist: async () => { throw new Error('disk full') } }
    await expect(startPassagePipeline(PAGES, failing, {})).rejects.toThrow('disk full')
  })
})
