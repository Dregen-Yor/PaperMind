import { describe, it, expect, vi } from 'vitest'
import type { EvidenceBlock } from '../utils/evidenceBlock'
import type { IndexNode } from '../utils/pageIndex'
import { validateSemanticTree, type SemanticTree } from '../utils/semanticTree'
import { routeWithSemanticTree, buildSemanticRoutePrompt } from '../utils/semanticRoute'

const block = (order: number, overrides: Partial<EvidenceBlock> = {}): EvidenceBlock => {
  const id = `B${String(order + 1).padStart(3, '0')}`
  return {
    id,
    rawText: `RAWTEXT-${id}`,
    normalizedText: `normalized ${id}`,
    pieces: [{ page: order, text: `RAWTEXT-${id}` }],
    startPage: order,
    endPage: order,
    order,
    previousId: order > 0 ? `B${String(order).padStart(3, '0')}` : null,
    nextId: `B${String(order + 2).padStart(3, '0')}`,
    sourceType: 'body',
    ...overrides,
  }
}

const BLOCKS = Array.from({ length: 9 }, (_, i) => block(i))

/** root(0) → a1(1) → a1b1(2) / a1b2(3)；a2(4) → a2b1(5)。共 6 个节点。 */
const RAW_TREE = {
  root: {
    id: 'r', label: '核心主张', description: 'DESC-root', relationToParent: null,
    evidenceRefs: ['B001'],
    children: [
      {
        id: 'a1', label: '机制甲', description: 'DESC-a1', relationToParent: 'constitutes',
        evidenceRefs: ['B002', 'B003'],
        children: [
          { id: 'a1b1', label: '证据簇一', description: 'DESC-a1b1', relationToParent: 'supports', evidenceRefs: ['B004'], children: [] },
          { id: 'a1b2', label: '证据簇二', description: 'DESC-a1b2', relationToParent: 'supports', evidenceRefs: ['B005'], children: [] },
        ],
      },
      {
        id: 'a2', label: '适用边界', description: 'DESC-a2', relationToParent: 'limits',
        evidenceRefs: ['B007'],
        children: [
          { id: 'a2b1', label: '边界证据', description: 'DESC-a2b1', relationToParent: 'supports', evidenceRefs: ['B008'], children: [] },
        ],
      },
    ],
  },
}

const TREE: SemanticTree = validateSemanticTree(RAW_TREE, BLOCKS).tree!

/** 展平顺序（先序）：r=0, a1=1, a1b1=2, a1b2=3, a2=4, a2b1=5 */
const NODE_COUNT = 6

/** 覆盖全部节点的打分，只把给定 id 的节点打高分。 */
const scoreAll = (high: Record<number, number> = {}) => JSON.stringify(
  Array.from({ length: NODE_COUNT }, (_, i) => ({ id: i, score: high[i] ?? 0 })),
)

/** 平面索引候选：提供后与语义节点共用同一次打分调用（id 接在节点之后）。 */
const PAGES = Array.from({ length: 9 }, (_, i) => `PAGE-${i + 1}`)
const LEAF_A: IndexNode = { title: '平面章节甲', nodeId: '0', startPage: 0, endPage: 1, summary: 's', nodes: [] }
const LEAF_B: IndexNode = { title: '平面章节乙', nodeId: '1', startPage: 2, endPage: 3, summary: 's', nodes: [] }
const FLAT = { leaves: [LEAF_A, LEAF_B], pages: PAGES }

/** 语义节点 + 平面候选的合并打分：节点 id 0..5，平面候选 id 6,7。 */
const scoreWithFlat = (nodeHigh: Record<number, number> = {}, flatHigh: Record<number, number> = {}) =>
  JSON.stringify([
    ...Array.from({ length: NODE_COUNT }, (_, i) => ({ id: i, score: nodeHigh[i] ?? 0 })),
    ...FLAT.leaves.map((_, i) => ({ id: NODE_COUNT + i, score: flatHigh[i] ?? 0 })),
  ])

/** 两节点树：r→x，x 不引用任何证据。候选空间 r=0, x=1，平面候选接在后面 = 2,3。 */
const SPARSE_TREE: SemanticTree = validateSemanticTree({
  root: {
    id: 'r', label: '根主张', description: 'd', relationToParent: null,
    evidenceRefs: ['B001'],
    children: [{
      id: 'x', label: '无证据节点', description: 'd', relationToParent: 'constitutes',
      evidenceRefs: [], children: [],
    }],
  },
}, BLOCKS).tree!

/** 稀疏树的合并打分：两个语义节点 + 两个平面候选。 */
const scoreSparseWithFlat = (nodeHigh: Record<number, number> = {}, flatHigh: Record<number, number> = {}) =>
  JSON.stringify([
    { id: 0, score: nodeHigh[0] ?? 0 },
    { id: 1, score: nodeHigh[1] ?? 0 },
    { id: 2, score: flatHigh[0] ?? 0 },
    { id: 3, score: flatHigh[1] ?? 0 },
  ])

describe('buildSemanticRoutePrompt（§9 整棵树一次判断）', () => {
  const prompt = buildSemanticRoutePrompt(TREE, '论文用了什么机制？')

  it('包含用户问题', () => {
    expect(prompt).toContain('论文用了什么机制？')
  })

  it('把整棵树一次性交给检索判断，而不是逐层提问', () => {
    for (const label of ['核心主张', '机制甲', '证据簇一', '证据簇二', '适用边界', '边界证据']) {
      expect(prompt).toContain(label)
    }
  })

  it('保留层级与语义关系，供模型理解归属', () => {
    expect(prompt).toContain('constitutes')
    expect(prompt).toContain('limits')
  })

  it('明确节点描述只用于导航，不是事实依据', () => {
    expect(prompt).toMatch(/导航|路由/)
    expect(prompt).toMatch(/不是事实|不作为事实|不能作为事实|不得作为/)
  })

  it('要求覆盖全部节点并给出 0-10 打分', () => {
    expect(prompt).toContain('0-10')
    expect(prompt).toMatch(/全部|每个|所有/)
  })

  it('提供平面候选时接在语义节点之后列出，共用同一次打分', () => {
    const withFlat = buildSemanticRoutePrompt(TREE, '问题', FLAT.leaves)
    expect(withFlat).toContain('平面章节甲')
    expect(withFlat).toContain('平面章节乙')
    // 语义节点 0..5，平面候选从 6 开始，中间不能留空档
    expect(withFlat).toContain('[6]')
    expect(withFlat).toContain('[7]')
  })
})

describe('routeWithSemanticTree — 单次调用与选择', () => {
  it('每个问题只发一次 LLM 调用（不因两层树增加串行调用）', async () => {
    const llm = vi.fn(async () => scoreAll({ 4: 9, 5: 8 }))
    await routeWithSemanticTree(TREE, BLOCKS, '适用边界是什么？', llm)
    expect(llm).toHaveBeenCalledTimes(1)
  })

  it('按打分为索引选取节点，多分支问题可一次选中多个节点', async () => {
    const llm = async () => scoreAll({ 4: 9, 5: 8 })
    const result = await routeWithSemanticTree(TREE, BLOCKS, '适用边界是什么？', llm)
    expect(result.semantic.selectedNodeIds).toEqual(['a2', 'a2b1'])
    expect(result.semantic.selectedNodeCount).toBe(2)
  })

  it('最高分节点无条件入选，其余需达到 minScore', async () => {
    const llm = async () => scoreAll({ 1: 9, 4: 2 })
    const result = await routeWithSemanticTree(TREE, BLOCKS, '机制？', llm, { minScore: 4 })
    expect(result.semantic.selectedNodeIds).toEqual(['a1'])
  })

  it('topK 限制选中节点数量', async () => {
    const llm = async () => scoreAll({ 1: 9, 4: 9, 5: 9 })
    const result = await routeWithSemanticTree(TREE, BLOCKS, '全部？', llm, { topK: 2 })
    expect(result.semantic.selectedNodeCount).toBe(2)
  })

  it('树域打分不写进 scores——下游按平面叶节点下标映射 id，写进去会让 MRR 取到错误的页区间', async () => {
    const llm = async () => scoreAll({ 4: 9 })
    const result = await routeWithSemanticTree(TREE, BLOCKS, '边界？', llm)
    expect(result.scores).toEqual([])
    expect(result.llmCalled).toBe(true)
    expect(result.degraded).toBe(false)
    expect(result.semantic.usedFlatFallback).toBe(false)
  })
})

describe('routeWithSemanticTree — 最终上下文必须来自原文（§4 / §9）', () => {
  it('上下文只包含被选中节点引用的原文证据块', async () => {
    const llm = async () => scoreAll({ 4: 9 })
    const result = await routeWithSemanticTree(TREE, BLOCKS, '边界？', llm)
    expect(result.context).toContain('RAWTEXT-B007')
    expect(result.context).not.toContain('RAWTEXT-B004')
  })

  it('节点描述与标签绝不进入最终上下文', async () => {
    const llm = async () => scoreAll({ 4: 9 })
    const result = await routeWithSemanticTree(TREE, BLOCKS, '边界？', llm)
    expect(result.context).not.toContain('DESC-a2')
    expect(result.context).not.toContain('适用边界')
  })

  it('来源使用原文页码 + 节点名，而不是语义节点 ID', async () => {
    const llm = async () => scoreAll({ 4: 9 })
    const result = await routeWithSemanticTree(TREE, BLOCKS, '边界？', llm, { includeNeighbours: false })
    expect(result.sources).toHaveLength(1)
    expect(result.sources[0]).toBe('Pages 7–7: 适用边界')
  })

  it('selected 携带原文页码区间，供评测按页计算召回', async () => {
    const llm = async () => scoreAll({ 4: 9 })
    const result = await routeWithSemanticTree(TREE, BLOCKS, '边界？', llm, { includeNeighbours: false })
    expect(result.selected).toHaveLength(1)
    expect(result.selected[0]).toMatchObject({ startPage: 6, endPage: 6 })
  })

  it('来源与 selected 覆盖的正是进入上下文的块，相邻块也计入', async () => {
    const llm = async () => scoreAll({ 4: 9 })   // a2 → B007，相邻 B006 / B008
    const result = await routeWithSemanticTree(TREE, BLOCKS, '边界？', llm)
    expect(result.sources).toEqual(['Pages 6–8: 适用边界'])
    expect(result.selected).toEqual([
      { title: '适用边界', nodeId: 'B006', startPage: 5, endPage: 7, summary: 'DESC-a2', nodes: [] },
    ])
  })

  it('相隔很远的多个证据块拆成离散页区间，不并成一个跨越全文的大区间', async () => {
    const spreadTree = validateSemanticTree({
      root: {
        id: 'r', label: '核心主张', description: 'd', relationToParent: null,
        evidenceRefs: ['B001'],
        children: [
          { id: 'far', label: '跨节主张', description: 'd', relationToParent: 'constitutes', evidenceRefs: ['B002', 'B008'], children: [] },
          { id: 'other', label: '另一分支', description: 'd', relationToParent: 'compares', evidenceRefs: ['B005'], children: [] },
        ],
      },
    }, BLOCKS).tree!
    const llm = async () => JSON.stringify([{ id: 0, score: 0 }, { id: 1, score: 9 }, { id: 2, score: 0 }])
    const result = await routeWithSemanticTree(spreadTree, BLOCKS, '跨节？', llm, { includeNeighbours: false })
    // B002 在第 2 页、B008 在第 8 页：中间 6 页并没有进入上下文，不能被报成已选中
    expect(result.selected.map(n => [n.startPage, n.endPage])).toEqual([[1, 1], [7, 7]])
    expect(result.sources).toEqual(['Pages 2–2: 跨节主张', 'Pages 8–8: 跨节主张'])
  })

  it('连续的证据块合并成一个页区间', async () => {
    const llm = async () => scoreAll({ 1: 9 })   // a1 → B002,B003（第 2–3 页）
    const result = await routeWithSemanticTree(TREE, BLOCKS, '机制？', llm, { includeNeighbours: false })
    expect(result.selected.map(n => [n.startPage, n.endPage])).toEqual([[1, 2]])
  })

  it('纳入相邻证据块补齐上下文，并按原文顺序排列', async () => {
    const llm = async () => scoreAll({ 4: 9 })   // a2 → B007 (order 6)
    const result = await routeWithSemanticTree(TREE, BLOCKS, '边界？', llm, { includeNeighbours: true })
    expect(result.semantic.evidenceBlockIds).toEqual(['B007'])
    expect(result.semantic.expandedBlockIds).toEqual(['B006', 'B007', 'B008'])
    expect(result.context.indexOf('RAWTEXT-B006')).toBeLessThan(result.context.indexOf('RAWTEXT-B007'))
    expect(result.context.indexOf('RAWTEXT-B007')).toBeLessThan(result.context.indexOf('RAWTEXT-B008'))
  })

  it('关闭相邻扩展时只取节点直接引用的块', async () => {
    const llm = async () => scoreAll({ 4: 9 })
    const result = await routeWithSemanticTree(TREE, BLOCKS, '边界？', llm, { includeNeighbours: false })
    expect(result.semantic.expandedBlockIds).toEqual(['B007'])
  })

  it('多个节点共引同一块时不重复拼接', async () => {
    const llm = async () => scoreAll({ 1: 9, 4: 9 })   // a1 → B002,B003; a2 → B007
    const result = await routeWithSemanticTree(TREE, BLOCKS, '全部？', llm, { includeNeighbours: false })
    expect(result.semantic.expandedBlockIds).toEqual(['B002', 'B003', 'B007'])
  })

  it('单个证据块跨两页时，contextGroups 保留两页的分片而非压成一页', async () => {
    // B005 换成跨第 3–4 页（0-based 2–3）的块：分片拼接逐字等于 rawText
    const multipage = BLOCKS.map((b, i) => i === 4
      ? {
          ...b,
          rawText: 'SECOND-PAGE\n\nTHIRD-PAGE',
          pieces: [{ page: 2, text: 'SECOND-PAGE' }, { page: 3, text: '\n\nTHIRD-PAGE' }],
          startPage: 2,
          endPage: 3,
        }
      : b)
    const llm = async () => scoreAll({ 3: 9 })   // a1b2 → B005，关闭相邻扩张以隔离该块
    const result = await routeWithSemanticTree(TREE, multipage, '证据？', llm, { includeNeighbours: false })

    expect(result.contextGroups).toEqual([
      { pieces: [{ page: 2, text: 'SECOND-PAGE' }, { page: 3, text: '\n\nTHIRD-PAGE' }] },
    ])
    const group = result.contextGroups[0]
    expect(group.pieces.map(piece => piece.page)).toEqual([2, 3])
    const rebuilt = result.contextGroups
      .map(g => g.pieces.map(piece => piece.text).join(''))
      .join('\n\n---\n\n')
    expect(rebuilt).toBe(result.context)
  })

  it('为实际进入上下文的每个证据块产出逐页分组，拼接后逐字还原 context', async () => {
    const llm = async () => scoreAll({ 4: 9 })   // a2 → B007 + 相邻 B006 / B008
    const result = await routeWithSemanticTree(TREE, BLOCKS, '边界？', llm)

    expect(result.contextGroups).toEqual([
      { pieces: [{ page: 5, text: 'RAWTEXT-B006' }] },
      { pieces: [{ page: 6, text: 'RAWTEXT-B007' }] },
      { pieces: [{ page: 7, text: 'RAWTEXT-B008' }] },
    ])
    const rebuilt = result.contextGroups
      .map(group => group.pieces.map(piece => piece.text).join(''))
      .join('\n\n---\n\n')
    expect(rebuilt).toBe(result.context)
  })

  it('预算丢弃的块不出现在 contextGroups 中', async () => {
    const llm = async () => scoreAll({ 4: 9 })
    const result = await routeWithSemanticTree(TREE, BLOCKS, '边界？', llm, { maxContextChars: 31 })
    expect(result.semantic.expandedBlockIds).toEqual(['B006', 'B007'])
    expect(result.contextGroups).toEqual([
      { pieces: [{ page: 5, text: 'RAWTEXT-B006' }] },
      { pieces: [{ page: 6, text: 'RAWTEXT-B007' }] },
    ])
  })
})

describe('routeWithSemanticTree — 上下文预算（§9 统一预算）', () => {
  it('超出预算的证据块被丢弃，且丢弃的块不写进来源', async () => {
    const llm = async () => scoreAll({ 4: 9 })   // a2 → B007 + 相邻 B006 / B008
    const result = await routeWithSemanticTree(TREE, BLOCKS, '边界？', llm, { maxContextChars: 31 })
    expect(result.context.length).toBeLessThanOrEqual(31)
    expect(result.semantic.expandedBlockIds).toEqual(['B006', 'B007'])
    expect(result.semantic.droppedBlockCount).toBe(1)
    expect(result.sources).toEqual(['Pages 6–7: 适用边界'])
  })

  it('预算再紧也不截断块内原文，块要么完整进入要么整块丢弃', async () => {
    const llm = async () => scoreAll({ 4: 9 })
    const result = await routeWithSemanticTree(TREE, BLOCKS, '边界？', llm, { maxContextChars: 12 })
    // 只装得下一个块：留下的是节点直接引用的 B007，且其原文完整
    expect(result.semantic.expandedBlockIds).toEqual(['B007'])
    expect(result.context).toBe('RAWTEXT-B007')
  })

  it('相邻块优先级低于节点直接引用的块：预算不足时先丢邻居', async () => {
    const llm = async () => scoreAll({ 4: 9 })
    const result = await routeWithSemanticTree(TREE, BLOCKS, '边界？', llm, { maxContextChars: 30 })
    expect(result.semantic.expandedBlockIds).toContain('B007')
  })
})

describe('routeWithSemanticTree — 平面回落（§9 必须能退回现有检索）', () => {
  it('选中节点没有可用证据时，用同一次调用拿到的平面打分就地回落，不追加请求', async () => {
    const llm = vi.fn(async () => scoreSparseWithFlat({ 1: 9 }, { 1: 7 }))
    const result = await routeWithSemanticTree(SPARSE_TREE, BLOCKS, '问题', llm, { flat: FLAT, topK: 1 })

    expect(llm).toHaveBeenCalledTimes(1)
    expect(result.semantic.usedFlatFallback).toBe(true)
    expect(result.semantic.insufficientEvidence).toBe(true)
    expect(result.sources).toEqual(['Pages 3–4: 平面章节乙'])
    expect(result.context).toBe('PAGE-3\n\nPAGE-4')
    // 平面回落沿用平面路径的逐页展开：拼接 pieces 即得该节点的 context
    expect(result.contextGroups).toEqual([
      { pieces: [{ page: 2, text: 'PAGE-3' }, { page: 3, text: '\n\nPAGE-4' }] },
    ])
  })

  it('打分不可用时取第一个平面候选，与 scoreAndSelect 的降级动作一致', async () => {
    const llm = vi.fn(async () => 'not json')
    const result = await routeWithSemanticTree(TREE, BLOCKS, '问题', llm, { flat: FLAT })
    expect(llm).toHaveBeenCalledTimes(1)
    expect(result.degraded).toBe(true)
    expect(result.semantic.usedFlatFallback).toBe(true)
    expect(result.context).toBe('PAGE-1\n\nPAGE-2')
    expect(result.contextGroups).toEqual([
      { pieces: [{ page: 0, text: 'PAGE-1' }, { page: 1, text: '\n\nPAGE-2' }] },
    ])
  })

  it('回落时的打分改用平面叶节点下标，MRR 才能与平面路径同域比较', async () => {
    const llm = async () => scoreSparseWithFlat({ 1: 9 }, { 0: 2, 1: 8 })
    const result = await routeWithSemanticTree(SPARSE_TREE, BLOCKS, '问题', llm, { flat: FLAT })
    expect(result.scores).toEqual([{ id: 0, score: 2 }, { id: 1, score: 8 }])
    expect(result.degraded).toBe(false)
  })

  it('树能用时不回落，平面候选只作为备用打分', async () => {
    const llm = vi.fn(async () => scoreWithFlat({ 4: 9 }, { 1: 7 }))
    const result = await routeWithSemanticTree(TREE, BLOCKS, '边界？', llm, { flat: FLAT })
    expect(result.semantic.usedFlatFallback).toBe(false)
    expect(result.semantic.insufficientEvidence).toBe(false)
    expect(result.context).toContain('RAWTEXT-B007')
    expect(result.context).not.toContain('PAGE-3')
  })

  it('只有根节点的树不再短路：id 空间只剩平面叶节点，退化成与平面路径完全相同的判断', async () => {
    const rootOnly = validateSemanticTree({
      root: {
        id: 'r', label: '唯一主张', description: 'd', relationToParent: null,
        evidenceRefs: ['B001'], children: [],
      },
    }, BLOCKS).tree!
    const llm = vi.fn(async () => JSON.stringify([{ id: 0, score: 0 }, { id: 1, score: 9 }]))
    const result = await routeWithSemanticTree(rootOnly, BLOCKS, '问题', llm, { flat: FLAT, topK: 1 })
    expect(llm).toHaveBeenCalledTimes(1)
    expect(result.semantic.usedFlatFallback).toBe(true)
    expect(result.sources).toEqual(['Pages 3–4: 平面章节乙'])
    expect(result.scores).toEqual([{ id: 0, score: 0 }, { id: 1, score: 9 }])
  })

  it('单候选短路时仍保留平面回落，不丢失唯一叶节点的上下文', async () => {
    // 根节点无证据 + 单叶平面索引：候选总数为 1，短路不发打分请求。
    // 此时没有平面打分可用，回落必须直接用这个唯一的平面叶节点，
    // 否则会同时出现 usedFlatFallback=true 却 context='' 的自相矛盾（§9）。
    const rootOnly = validateSemanticTree({
      root: {
        id: 'r', label: '唯一主张', description: 'd', relationToParent: null,
        evidenceRefs: [], children: [],
      },
    }, BLOCKS).tree!
    const llm = vi.fn(async () => 'unused')
    const result = await routeWithSemanticTree(rootOnly, BLOCKS, '问题', llm, {
      flat: { leaves: [LEAF_A], pages: PAGES },
    })

    expect(llm).not.toHaveBeenCalled()
    expect(result.llmCalled).toBe(false)
    expect(result.semantic.usedFlatFallback).toBe(true)
    // 树/回落路径绝不写平面坐标系的打分：下游 legacy MRR 会把它按叶节点下标误读
    expect(result.scores).toEqual([])
    expect(result.sources).toEqual(['Pages 1–2: 平面章节甲'])
    expect(result.context).toBe('PAGE-1\n\nPAGE-2')
    expect(result.contextGroups).toEqual([
      { pieces: [{ page: 0, text: 'PAGE-1' }, { page: 1, text: '\n\nPAGE-2' }] },
    ])
  })
})

describe('routeWithSemanticTree — 降级（§8.2 / §9）', () => {
  it('打分 JSON 非法时降级到根节点证据，但仍只发一次请求', async () => {
    const llm = vi.fn(async () => 'not json')
    const result = await routeWithSemanticTree(TREE, BLOCKS, '问题', llm)
    expect(llm).toHaveBeenCalledTimes(1)
    expect(result.degraded).toBe(true)
    expect(result.degradedReason).toBe('invalid-json')
    expect(result.semantic.selectedNodeIds).toEqual(['r'])
    expect(result.context).toContain('RAWTEXT-B001')
  })

  it('打分覆盖不全时降级为 incomplete-score-coverage', async () => {
    const llm = async () => JSON.stringify([{ id: 0, score: 5 }])
    const result = await routeWithSemanticTree(TREE, BLOCKS, '问题', llm)
    expect(result.degraded).toBe(true)
    expect(result.degradedReason).toBe('incomplete-score-coverage')
  })

  it('LLM 请求失败时降级为 score-request-failed，不抛出', async () => {
    const llm = vi.fn(async () => { throw new Error('network down') })
    const result = await routeWithSemanticTree(TREE, BLOCKS, '问题', llm)
    expect(result.degraded).toBe(true)
    expect(result.degradedReason).toBe('score-request-failed')
  })

  it('选中节点没有任何有效证据时标记 insufficient-evidence 且不额外发请求', async () => {
    const sparseTree = validateSemanticTree({
      root: {
        id: 'r', label: '根主张', description: 'd', relationToParent: null,
        evidenceRefs: ['B001'],
        children: [{
          id: 'x', label: '无证据节点', description: 'd', relationToParent: 'constitutes',
          evidenceRefs: [], children: [],
        }],
      },
    }, BLOCKS).tree!
    const llm = vi.fn(async () => JSON.stringify([{ id: 0, score: 1 }, { id: 1, score: 9 }]))
    const result = await routeWithSemanticTree(sparseTree, BLOCKS, '问题', llm, { topK: 1 })
    expect(llm).toHaveBeenCalledTimes(1)
    expect(result.degraded).toBe(true)
    expect(result.semantic.insufficientEvidence).toBe(true)
    expect(result.context).toBe('')
    expect(result.contextGroups).toEqual([])
    expect(result.selected).toEqual([])
  })

  it('只有根节点的树不需要发起检索判断（与单叶节点短路一致）', async () => {
    const rootOnly = validateSemanticTree({
      root: {
        id: 'r', label: '唯一主张', description: 'd', relationToParent: null,
        evidenceRefs: ['B001'], children: [],
      },
    }, BLOCKS).tree!
    const llm = vi.fn(async () => 'unused')
    const result = await routeWithSemanticTree(rootOnly, BLOCKS, '问题', llm)
    expect(llm).not.toHaveBeenCalled()
    expect(result.llmCalled).toBe(false)
    expect(result.context).toContain('RAWTEXT-B001')
  })

  it('打分为 0 的节点不被选中，但仍计入完整覆盖', async () => {
    const llm = async () => scoreAll({})
    const result = await routeWithSemanticTree(TREE, BLOCKS, '无关问题', llm)
    expect(result.degraded).toBe(false)
    expect(result.semantic.selectedNodeCount).toBe(1)      // 最高分节点恒入选
    expect(result.semantic.selectedNodeIds).toEqual(['r'])
  })
})
