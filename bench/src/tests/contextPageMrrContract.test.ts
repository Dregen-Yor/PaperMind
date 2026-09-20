/**
 * 跨方法横向比较的**互操作契约**。本文件不驱动任何方法的检索决策，
 * 所以它证明的比「跨方法可比较」更窄也更基础，只有两条：
 * 1. 页序是 materializer 的确定性函数（同样输入片段必得同样 pageOrder）；
 * 2. 四个检索指标是「页序 + evidence」的确定性函数。
 * 合起来即：不同方法只要最终物化出同一份页序，指标就必然逐字相同——谁内部怎么选段都不影响。
 * 五个受测方法刻意在组数、重叠、重复页上各异，却收敛到同一份 [2, 5, 7] 页序；
 * 另有一例用同一页多重集的不同次序，单独钉住「名次来自给定次序」这另一半契约。
 */
import { describe, expect, it, vi } from 'vitest'
import { buildTokenStream, chunkTokenStream, tokenRangeToPieces } from '../baselines/tokenStream'
import { reciprocalRankFusion } from '../baselines/rrf'
import { buildEvidenceBlocks } from '../../../src/utils/evidenceBlock'
import { materializeContext, type ContextGroup } from '../../../src/utils/contextTrace'
// 生产侧的逐页分组生产者：PageIndex 适配器直接驱动它，不再自建替身
import { nodeToContextGroup } from '../../../src/utils/pageIndex'
import {
  ZERO_CONTEXT_PAGE_METRICS,
  applyRetrievalMetrics,
  computeContextPageMetrics,
} from '../metrics/retrieval'
import { metricSampleCounts } from '../metrics/aggregate'
// 受控预算直接取自评测契约，不在测试里硬编码第二份——否则契约改了预算，断言仍会用过期的数悄悄通过
import { CONTEXT_BUDGET_TOKENS } from '../evaluationContract'
import type { PerSampleRecord } from '../types'

// Node 环境缺 DOMMatrix，pageIndex 顶层会初始化 pdfjs worker，必须先 mock 掉
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: {},
  getDocument: vi.fn(),
}))

/**
 * 确定性假分词器：与 src/tests/contextTrace.test.ts 同款（空白切词 + ▁ 前缀）。
 * 真实 BGE-M3 分词器需要模型缓存、CI 不可用；本测试的契约是「页序 → 指标」与
 * materializer 的逐页记账，不是分词准确度，故不引入真实分词器。
 */
const tokenizer = { tokenize: (text: string) => text.split(/\s+/).filter(Boolean).map(word => `▁${word}`) }

/** 有效题的 gold 页：只有 5 落在页序里，9 在任何语料中都不存在（制造未命中项）。 */
const EVIDENCE_PAGES = [5, 9]

/**
 * 语料：第 2 页两段、第 5 页一段、第 7 页两段；3/4/6 页留空。
 * 留空是刻意的：页 5、7 在 token 空间因此紧邻页 2，让「连续单段」方法也能只覆盖
 * 2→5→7（否则连续区间必然连带 3/4/6，无法收敛到同一页序）。
 */
const pages = [
  'p0a p0b',
  'p1a p1b',
  'p2a p2b\n\np2c p2d',
  '',
  '',
  'p5a p5b p5c p5d',
  '',
  'p7a p7b\n\np7c p7d',
]

const { tokens } = buildTokenStream(pages, tokenizer)

/** 传统固定分块：4-token、无重叠；只取落在单页上的块 [1,2,3]。 */
const traditionalChunks = chunkTokenStream(tokens, { chunkSize: 4, overlap: 0 })
const traditionalGroups = (ids: number[]): ContextGroup[] =>
  ids.map(id => ({ pieces: traditionalChunks[id].pieces }))

/** hybrid-rerank：2/1 重叠小段经 RRF 融合；融合结果含同页重叠段（证明 pieces 会重叠）。 */
const hybridPassages = chunkTokenStream(tokens, { chunkSize: 2, overlap: 1 })
const hybridRanking = reciprocalRankFusion(
  [
    [4, 5, 8, 12, 13].map((id, index) => ({ id, score: 100 - index })),
    [4, 8, 12].map((id, index) => ({ id, score: 100 - index })),
  ],
  60,
).map(item => item.id)
const hybridGroups = (ids: number[]): ContextGroup[] =>
  ids.map(id => ({ pieces: hybridPassages[id].pieces }))

/** long-section：单个连续区间，覆盖 token 空间里相邻的 2→5→7 页。 */
const longSectionGroups = (range: { start: number; end: number } | null): ContextGroup[] =>
  range ? [{ pieces: tokenRangeToPieces(tokens, range.start, range.end) }] : []

/** 语义树：buildEvidenceBlocks 的证据块按树路由次序拼装；依次选中第 2、5、2、7 页（第 2 页非连续重复）。 */
const evidenceBlocks = buildEvidenceBlocks(pages, { targetChars: 5, maxChars: 1000, minChars: 0 })
const semanticTreeGroups = (blockIndices: number[]): ContextGroup[] =>
  blockIndices.map(index => ({ pieces: evidenceBlocks[index].pieces }))

/**
 * PageIndex：**直接驱动生产函数** `nodeToContextGroup`，而不是测试内替身——
 * `scoreAndSelect` 正常路径（:365）与单叶短路（:319）都用它把选中的叶节点展开成逐页 group，
 * 它是 PageIndex 真正的逐页 piece 生产者。用替身只能证明 materializer 的记账，
 * 生产函数一旦漂移（如页号算错）这份契约便一无所知。
 * 节点页区间刻意保留 PageIndex 的结构差异：两个 group、第二组仅一页；
 * 第一组区间跨过 3/4 两个空页，空文本会被物化器剔除，故该组只贡献页 2、5。
 */
const pageIndexGroups = (ranges: Array<[number, number]>): ContextGroup[] =>
  ranges.map(([startPage, endPage]) =>
    nodeToContextGroup(
      { title: 'S', nodeId: `${startPage}-${endPage}`, startPage, endPage, summary: '', nodes: [] },
      pages,
    ),
  )

interface Adapter {
  name: string
  /** 命中：五个方法各自的结构差异都在这里 */
  groups: ContextGroup[]
  /** 未命中：该法什么都没选到，物化后页序为空——但仍要留在固定分母里 */
  miss: ContextGroup[]
}

const adapters: Adapter[] = [
  { name: 'traditional-chunk', groups: traditionalGroups([1, 2, 3]), miss: traditionalGroups([]) },
  { name: 'hybrid-rerank', groups: hybridGroups(hybridRanking), miss: hybridGroups([]) },
  {
    name: 'long-section-rag',
    groups: longSectionGroups({ start: 4, end: tokens.length }),
    miss: longSectionGroups(null),
  },
  { name: 'semantic-tree', groups: semanticTreeGroups([2, 4, 3, 5]), miss: semanticTreeGroups([]) },
  // 页区间 [2,5] / [7,7]：经生产 nodeToContextGroup 展开后仍是 2 个 group，物化页序 [2,5,7]
  { name: 'pageindex', groups: pageIndexGroups([[2, 5], [7, 7]]), miss: pageIndexGroups([]) },
]

const outcomes = adapters.map(adapter => ({
  name: adapter.name,
  ...materializeContext(adapter.groups, tokenizer, CONTEXT_BUDGET_TOKENS),
}))

describe('Context Page MRR 跨方法契约', () => {
  it('五个结构不同的方法物化出同一份页序，因而四个检索指标逐字相同', () => {
    // 先钉死收敛前提：任何一法偏离都会让下面的等值断言失去意义
    for (const outcome of outcomes) expect(outcome.pageOrder).toEqual([2, 5, 7])

    const expected = {
      contextPageMrr: 0.5,
      evidenceRecall: 0.5,
      evidenceHit: 1,
      contextPrecision: 1 / 3,
    }
    for (const outcome of outcomes) {
      expect(computeContextPageMetrics(outcome.pageOrder, EVIDENCE_PAGES)).toEqual(expected)
    }
  })

  it('名次来自给定页序而非排序：同一页多重集的非单调次序产出不同的 MRR', () => {
    // 上面五个方法都收敛到单调升序的 [2, 5, 7]，把它排序或反转都得到同一份指标，
    // 因此它们分不清「名次跟随给定次序」与「名次跟随排序」——排序/反转这半条契约是空的。
    // 这里改用同一页多重集（2、5、7）的另一种次序把它钉死：语义树式适配器按 5 → 2 → 7 选块
    // （block 4/2/5 分别是页 5/2/7），物化出的页序即非单调的 [5, 2, 7]。
    const unordered = materializeContext(semanticTreeGroups([4, 2, 5]), tokenizer, CONTEXT_BUDGET_TOKENS)
    expect(unordered.pageOrder).toEqual([5, 2, 7])

    const ascending = computeContextPageMetrics([2, 5, 7], EVIDENCE_PAGES)
    const nonMonotonic = computeContextPageMetrics(unordered.pageOrder, EVIDENCE_PAGES)
    // 逐项核对：首个 gold 页（5）在 [5, 2, 7] 里位于第 1 名（倒数 1），在 [2, 5, 7] 里退居第 2 名
    // （倒数 1/2）；覆盖页数与总页数两种次序相同，故 recall / hit / precision 不变。
    // 若指标按排序或反转计算，两者的 contextPageMrr 会相等，最后一条断言即失败。
    expect(nonMonotonic).toEqual({
      contextPageMrr: 1,
      evidenceRecall: 0.5,
      evidenceHit: 1,
      contextPrecision: 1 / 3,
    })
    expect(nonMonotonic.contextPageMrr).toBe(1)
    expect(ascending.contextPageMrr).toBe(0.5)
  })

  it('结构上确实各异：组数两两不同、有重叠段、有非连续重复页', () => {
    // 组数两两不同——若都相同，说明「结构差异」只是换了个名字
    const groupCounts = adapters.map(adapter => adapter.groups.length)
    expect(new Set(groupCounts).size).toBe(adapters.length)

    // 语义树非连续地重复第 2 页：去重必须取首次出现。取末次不会让名次「变差」——它把第 5 页
    // 提到首位，名次反而更优（同一页多重集的非单调用例正由取末次而来），改的是「哪一页占住
    // 第 1 名」而非好坏方向，所以去重方向本身也是契约的一部分。
    const treePages = adapters.find(adapter => adapter.name === 'semantic-tree')!.groups
      .map(group => group.pieces[0].page)
    expect(treePages).toEqual([2, 5, 2, 7])

    // hybrid 的两段共享同一 token：pieces 在内容上真重叠（若只是首尾相接则不算）
    const hybridText = outcomes.find(outcome => outcome.name === 'hybrid-rerank')!.text
    expect((hybridText.match(/p2b/g) ?? []).length).toBe(2)
    expect((hybridText.match(/p7b/g) ?? []).length).toBe(2)
  })

  it('有效题未命中时四个指标写 0，且仍各留一个观测——不靠缺字段退出固定分母', () => {
    const missRecords: PerSampleRecord[] = adapters.map(adapter => {
      const miss = materializeContext(adapter.miss, tokenizer, CONTEXT_BUDGET_TOKENS)
      expect(miss.pageOrder).toEqual([])
      const metrics: Record<string, number> = {}
      // 走生产的写入路径：有效题必须逐题写出观测，未命中以 0 如实表达
      applyRetrievalMetrics(metrics, {
        eligible: true,
        pageOrder: miss.pageOrder,
        evidencePages: EVIDENCE_PAGES,
        context: miss.text,
      })
      return { id: adapter.name, paperId: 'p', source: 'smoke', metrics, evidencePages: EVIDENCE_PAGES }
    })

    for (const record of missRecords) expect(record.metrics).toMatchObject(ZERO_CONTEXT_PAGE_METRICS)

    // 观测数才是固定分母的度量：四个 0 是有限数，照常被计入，不因未命中而消失
    const counts = metricSampleCounts(missRecords)
    for (const key of ['contextPageMrr', 'evidenceRecall', 'evidenceHit', 'contextPrecision']) {
      expect(counts[key]).toBe(adapters.length)
    }
  })
})
