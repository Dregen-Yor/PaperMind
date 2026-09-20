import { describe, it, expect, vi } from 'vitest'
import type { IndexNode } from '../utils/pageIndex'
import type { EvidenceBlock } from '../utils/evidenceBlock'
import { validateSemanticTree } from '../utils/semanticTree'

// Node 环境缺 DOMMatrix，pageIndex 顶层会初始化 pdfjs worker
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: {},
  getDocument: vi.fn(),
}))

const { runRagPipeline } = await import('../utils/ragPipeline')
const { materializeContext } = await import('../utils/contextTrace')

/** 与 contextTrace.test.ts 同款分词器：按空白切词并渲染为 ▁word。 */
const tokenizer = {
  tokenize: (text: string) => text.split(/\s+/).filter(Boolean).map(word => `▁${word}`),
}

function leaf(id: string, start: number, end: number): IndexNode {
  return { title: `FLAT-${id}`, nodeId: id, startPage: start, endPage: end, summary: `sum ${id}`, nodes: [] }
}

/** 平面索引：多叶，scoreAndSelect 会实际发出打分请求 */
const flatTree: IndexNode = {
  title: 'Paper', nodeId: 'root', startPage: 0, endPage: 3, summary: '',
  nodes: [leaf('0', 0, 1), leaf('1', 2, 3)],
}
const pages = ['p1', 'p2', 'p3', 'p4']

const block = (order: number): EvidenceBlock => {
  const id = `B${String(order + 1).padStart(3, '0')}`
  return {
    id, rawText: `RAWTEXT-${id}`, normalizedText: `n-${id}`,
    pieces: [{ page: order, text: `RAWTEXT-${id}` }],
    startPage: order, endPage: order, order,
    previousId: null, nextId: null, sourceType: 'body',
  }
}

const BLOCKS = Array.from({ length: 6 }, (_, i) => block(i))

/** root(0) → 机制甲(1)、适用边界(2) */
const semanticTree = validateSemanticTree({
  root: {
    id: 'r', label: '核心主张', description: 'DESC-root', relationToParent: null, evidenceRefs: ['B001'],
    children: [
      { id: 'a1', label: '机制甲', description: 'DESC-a1', relationToParent: 'constitutes', evidenceRefs: ['B002'], children: [] },
      { id: 'a2', label: '适用边界', description: 'DESC-a2', relationToParent: 'limits', evidenceRefs: ['B005'], children: [] },
    ],
  },
}, BLOCKS).tree!

/** 展平顺序：r=0, a1=1, a2=2；平面叶节点接在后面：FLAT-0=3, FLAT-1=4。 */
const CANDIDATES = 5
const scores = (high: Record<number, number> = {}) => JSON.stringify(
  Array.from({ length: CANDIDATES }, (_, i) => ({ id: i, score: high[i] ?? 0 })),
)

describe('runRagPipeline — 语义树路由', () => {
  it('论文带语义树时按树路由，来源使用树节点而非平面叶节点', async () => {
    const llm = vi.fn().mockResolvedValue(scores({ 2: 9 }))
    const generate = vi.fn().mockResolvedValue('answer')

    const result = await runRagPipeline(
      [{ tree: flatTree, pages, semantic: { tree: semanticTree, blocks: BLOCKS } }],
      '适用边界是什么', [], llm, generate, 'sys',
    )

    // a2 引用的块在第 5 页，相邻块补齐后覆盖第 4–6 页
    expect(result.sources).toEqual(['Pages 4–6: 适用边界'])
    expect(result.treeRouted).toBe(true)
  })

  it('检索阶段仍只发一次 LLM 调用——不因两层树增加串行调用（§10.1）', async () => {
    const llm = vi.fn().mockResolvedValue(scores({ 2: 9 }))
    const generate = vi.fn().mockResolvedValue('answer')

    const result = await runRagPipeline(
      [{ tree: flatTree, pages, semantic: { tree: semanticTree, blocks: BLOCKS } }],
      'q', [], llm, generate, 'sys',
    )

    expect(llm).toHaveBeenCalledTimes(1)
    expect(result.llmCalls).toBe(2)   // 一次树路由 + 一次生成，与平面路径同量级
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('最终上下文来自原文证据块，节点描述不进入上下文（§4）', async () => {
    const llm = vi.fn().mockResolvedValue(scores({ 2: 9 }))
    const generate = vi.fn().mockResolvedValue('answer')

    const result = await runRagPipeline(
      [{ tree: flatTree, pages, semantic: { tree: semanticTree, blocks: BLOCKS } }],
      'q', [], llm, generate, 'sys',
    )

    expect(result.context).toContain('RAWTEXT-B005')
    expect(result.context).not.toContain('DESC-a2')
    expect(generate.mock.calls[0][0][0].content).toContain('RAWTEXT-B005')
  })

  it('检索结果携带树诊断指标，供评测统计（§11.4）', async () => {
    const llm = vi.fn().mockResolvedValue(scores({ 2: 9 }))
    const result = await runRagPipeline(
      [{ tree: flatTree, pages, semantic: { tree: semanticTree, blocks: BLOCKS } }],
      'q', [], llm, vi.fn().mockResolvedValue('answer'), 'sys',
    )

    expect(result.retrievals[0].semantic).toMatchObject({
      selectedNodeIds: ['a2'],
      selectedNodeCount: 1,
      routableNodeCount: 3,
      insufficientEvidence: false,
    })
  })

  it('树路由打分不可用时退回平面候选，且仍只发生一次检索请求（§9 的退路）', async () => {
    const llm = vi.fn().mockResolvedValue('not json')
    const result = await runRagPipeline(
      [{ tree: flatTree, pages, semantic: { tree: semanticTree, blocks: BLOCKS } }],
      'q', [], llm, vi.fn().mockResolvedValue('answer'), 'sys',
    )

    expect(llm).toHaveBeenCalledTimes(1)
    expect(result.retrievals[0].degraded).toBe(true)
    expect(result.retrievals[0].semantic?.usedFlatFallback).toBe(true)
    // 降级动作与平面 scoreAndSelect 一致：取第一个叶节点的原文，而不是空上下文
    expect(result.context).toBe('p1\n\np2')
    expect(result.sources).toEqual(['Pages 1–2: FLAT-0'])
  })

  it('树取证失败时在同一次调用里就地回落平面叶节点，不追加调用', async () => {
    // 只有根节点引用证据，被打到高分的子节点没有任何 evidenceRefs
    const barren = validateSemanticTree({
      root: {
        id: 'r', label: '核心主张', description: 'DESC-root', relationToParent: null, evidenceRefs: ['B001'],
        children: [
          { id: 'a1', label: '无证据分支', description: 'DESC-a1', relationToParent: 'constitutes', evidenceRefs: [], children: [] },
          { id: 'a2', label: '另一分支', description: 'DESC-a2', relationToParent: 'limits', evidenceRefs: [], children: [] },
        ],
      },
    }, BLOCKS).tree!
    const llm = vi.fn().mockResolvedValue(scores({ 1: 9 }))
    const result = await runRagPipeline(
      [{ tree: flatTree, pages, semantic: { tree: barren, blocks: BLOCKS } }],
      'q', [], llm, vi.fn().mockResolvedValue('answer'), 'sys', { topK: 1 },
    )

    expect(llm).toHaveBeenCalledTimes(1)
    expect(result.llmCalls).toBe(2)
    expect(result.retrievals[0].semantic?.usedFlatFallback).toBe(true)
    expect(result.sources).toEqual(['Pages 1–2: FLAT-0'])
    expect(result.context).toBe('p1\n\np2')
  })

  it('平面候选与语义节点在同一次判断里打分（提示词里两类候选都出现）', async () => {
    const llm = vi.fn().mockResolvedValue(scores({ 2: 9 }))
    await runRagPipeline(
      [{ tree: flatTree, pages, semantic: { tree: semanticTree, blocks: BLOCKS } }],
      'q', [], llm, vi.fn().mockResolvedValue('answer'), 'sys',
    )

    const prompt = llm.mock.calls[0][0] as string
    expect(prompt).toContain('适用边界')     // 语义节点
    expect(prompt).toContain('FLAT-0')      // 平面候选
  })

  it('maxContextChars 同时约束树路由的上下文（§9 统一预算）', async () => {
    const llm = vi.fn().mockResolvedValue(scores({ 2: 9 }))
    const result = await runRagPipeline(
      [{ tree: flatTree, pages, semantic: { tree: semanticTree, blocks: BLOCKS } }],
      'q', [], llm, vi.fn().mockResolvedValue('answer'), 'sys',
      { maxContextChars: 12 },
    )

    expect(result.retrievals[0].context).toBe('RAWTEXT-B005')
    expect(result.retrievals[0].semantic?.droppedBlockCount).toBeGreaterThan(0)
  })

  it('未带语义树的论文继续走平面检索（回归）', async () => {
    const llm = vi.fn().mockResolvedValue('[{"id":0,"score":9},{"id":1,"score":2}]')
    const result = await runRagPipeline(
      [{ tree: flatTree, pages }], 'q', [], llm, vi.fn().mockResolvedValue('answer'), 'sys',
    )

    expect(result.treeRouted).toBe(false)
    expect(result.sources).toEqual(['Pages 1–2: FLAT-0'])
    expect(result.context).toContain('p1')
  })

  it('多篇论文混合时，有树的走树、无树的走平面', async () => {
    const llm = vi.fn()
      .mockResolvedValueOnce(scores({ 1: 9 }))                     // 树路由
      .mockResolvedValueOnce('[{"id":0,"score":9},{"id":1,"score":2}]') // 平面打分
    const result = await runRagPipeline(
      [
        { tree: flatTree, pages, semantic: { tree: semanticTree, blocks: BLOCKS } },
        { tree: flatTree, pages },
      ],
      'q', [], llm, vi.fn().mockResolvedValue('answer'), 'sys',
    )

    expect(result.treeRouted).toBe(true)
    expect(result.llmCalls).toBe(3)   // 2 次检索 + 1 次生成
    expect(result.sources).toContain('Pages 1–3: 机制甲')
    expect(result.sources).toContain('Pages 1–2: FLAT-0')
  })

  it('树路由的 topK / minScore 沿用统一的检索参数', async () => {
    const llm = vi.fn().mockResolvedValue(scores({ 1: 9, 2: 5 }))
    const result = await runRagPipeline(
      [{ tree: flatTree, pages, semantic: { tree: semanticTree, blocks: BLOCKS } }],
      'q', [], llm, vi.fn().mockResolvedValue('answer'), 'sys',
      { topK: 2, minScore: 4 },
    )

    expect(result.retrievals[0].semantic?.selectedNodeIds).toEqual(['a1', 'a2'])
  })

  it('注入 materializer 时上下文与页序由同一次物化产出，并逐字进入生成提示词', async () => {
    const llm = vi.fn().mockResolvedValue(scores({ 2: 9 }))   // a2 → B005，邻居 B004/B006
    const generate = vi.fn().mockResolvedValue('answer')
    const result = await runRagPipeline(
      [{ tree: flatTree, pages, semantic: { tree: semanticTree, blocks: BLOCKS } }],
      'q', [], llm, generate, 'sys', {},
      { materialize: groups => materializeContext(groups, tokenizer, 5) },
    )

    // 证据块顺序 B004/B005/B006 对应 0-based 第 3/4/5 页
    expect(result.contextPageOrder).toEqual([3, 4, 5])
    expect(result.contextTokenCount).toBe(5)
    expect(result.context).toBe('RAWTEXT-B004 --- RAWTEXT-B005 --- RAWTEXT-B006')
    expect(generate.mock.calls[0][0][0].content).toContain(`参考内容：\n${result.context}`)
  })
})
