import { describe, it, expect } from 'vitest'
import { tocNodePageSpan, tocSelectionToContextGroups, traverseWithJudge, type TocNode } from '../utils/tocTree'
import type { EvidenceJudge } from '../utils/evidenceJudge'

/** 造一个节点；只给本任务用到的字段，children 默认空 */
const node = (over: Partial<TocNode> & { id: string; title: string }): TocNode => ({
  path: [], depth: 0, pages: [], children: [], ...over,
})

const PAGES = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']

describe('tocNodePageSpan', () => {
  it('首片无前缀、后续每片带 \\n\\n，与 pages.slice().join() 同口径', () => {
    const n = node({ id: 'a', title: 'A', pages: [1, 2, 3] })
    const span = tocNodePageSpan(n, PAGES)
    expect(span).toEqual([
      { page: 1, text: 'p1' },
      { page: 2, text: '\n\np2' },
      { page: 3, text: '\n\np3' },
    ])
    expect(span.map(p => p.text).join('')).toBe(PAGES.slice(1, 4).join('\n\n'))
  })

  it('pages 升序输出，乱序输入被归一', () => {
    const n = node({ id: 'a', title: 'A', pages: [3, 1, 2] })
    expect(tocNodePageSpan(n, PAGES).map(p => p.page)).toEqual([1, 2, 3])
  })

  it('pages 为空产出空片段数组', () => {
    expect(tocNodePageSpan(node({ id: 'a', title: 'A' }), PAGES)).toEqual([])
  })

  it('页号越界直接抛错，不静默产出 undefined 文本', () => {
    const n = node({ id: 'a', title: 'A', pages: [99] })
    expect(() => tocNodePageSpan(n, PAGES)).toThrow('toc-page-out-of-range')
  })

  // 负页号与小数页号正是「下一页起始页 − 1」那套算术推导会产出的值——本设计已删掉推导，
  // 但重建这套逻辑很容易顺手写回 `pages[-1]`。若守卫被简化成只剩上界判断，
  // 这里会静默拿到 `pages[-1] === undefined` 在物化器的 `piece.text.trim()` 上才炸，
  // 错误离现场极远；因此下界与整数性必须各自钉住。
  it('负页号直接抛错', () => {
    const n = node({ id: 'a', title: 'A', pages: [-1] })
    expect(() => tocNodePageSpan(n, PAGES)).toThrow('toc-page-out-of-range')
  })

  it('非整数页号直接抛错', () => {
    const n = node({ id: 'a', title: 'A', pages: [1.5] })
    expect(() => tocNodePageSpan(n, PAGES)).toThrow('toc-page-out-of-range')
  })

  it('末页是合法上界，恰好等于 pages.length - 1 不抛错', () => {
    const n = node({ id: 'a', title: 'A', pages: [7] })
    expect(tocNodePageSpan(n, PAGES)).toEqual([{ page: 7, text: 'p7' }])
  })
})

describe('tocSelectionToContextGroups', () => {
  it('每个选中节点一组，组内按页顺序', () => {
    const groups = tocSelectionToContextGroups([
      node({ id: 'a', title: 'A', pages: [0, 1] }),
      node({ id: 'b', title: 'B', pages: [4, 5] }),
    ], PAGES)
    expect(groups).toHaveLength(2)
    expect(groups[0].pieces.map(p => p.page)).toEqual([0, 1])
    expect(groups[1].pieces.map(p => p.page)).toEqual([4, 5])
  })

  // 无内容节点刻意放在**末尾**：若放在首位，「整体丢掉第一个元素」这种 bug 会产出同样的单组结果，
  // 测试无法区分它到底验证了什么。放末尾才能真正钉住「空节点被跳过」这一行为。
  it('pages 为空的节点被跳过，不产生空组', () => {
    const groups = tocSelectionToContextGroups([
      node({ id: 'a', title: 'A', pages: [1] }),
      node({ id: 'b', title: 'B' }),
    ], PAGES)
    expect(groups).toHaveLength(1)
    expect(groups[0].pieces.map(p => p.page)).toEqual([1])
  })

  it('兄弟节点共用伪页时两组都产出该页——重叠由物化器按首次出现去重', () => {
    const groups = tocSelectionToContextGroups([
      node({ id: 'a', title: 'A', pages: [3] }),
      node({ id: 'b', title: 'B', pages: [3] }),
    ], PAGES)
    expect(groups).toHaveLength(2)
    expect(groups.every(g => g.pieces[0].page === 3)).toBe(true)
  })
})

/** 按标题查表返回概率的假判定器；查不到返回 0 */
const fixedJudge = (table: Record<string, number>): EvidenceJudge => ({
  async judge({ nodes }) { return nodes.map(n => table[n.title] ?? 0) },
})

/** 三个同层叶节点，标题 A/B/C */
const FLAT = (): TocNode[] => [
  node({ id: 'a', title: 'A', pages: [0] }),
  node({ id: 'b', title: 'B', pages: [1] }),
  node({ id: 'c', title: 'C', pages: [2] }),
]

/** 两层树 A[A1, A2] / B[B1]；父节点各自也带一页，确保它们本有资格进 selected */
const NESTED = (): TocNode[] => [
  node({
    id: 'a', title: 'A', pages: [0],
    children: [
      node({ id: 'a1', title: 'A1', path: ['A'], depth: 1, pages: [1] }),
      node({ id: 'a2', title: 'A2', path: ['A'], depth: 1, pages: [2] }),
    ],
  }),
  node({
    id: 'b', title: 'B', pages: [3],
    children: [
      node({ id: 'b1', title: 'B1', path: ['B'], depth: 1, pages: [4] }),
    ],
  }),
]

describe('traverseWithJudge —— 相对阈值', () => {
  it('alpha=0 时阈值退化为 0，全部候选存活（纯 top-N 模式）', async () => {
    const sel = await traverseWithJudge(FLAT(), 'q', fixedJudge({ A: 0.9, B: 0.1, C: 0 }), { alpha: 0, topN: 10 })
    expect(sel.selected.map(n => n.title)).toEqual(['A', 'B', 'C'])
  })

  it('alpha=1 时阈值等于层内最高分，只有并列最高者存活', async () => {
    const sel = await traverseWithJudge(FLAT(), 'q', fixedJudge({ A: 0.9, B: 0.1, C: 0 }), { alpha: 1, topN: 10 })
    expect(sel.selected.map(n => n.title)).toEqual(['A'])
  })

  it('阈值取层内相对值：整体分数偏低时高分区仍能存活', async () => {
    // 实测 Jev 的概率上限只有约 0.393，任何固定绝对阈值（如 0.5）都会把整层滤光
    const sel = await traverseWithJudge(FLAT(), 'q', fixedJudge({ A: 0.39, B: 0.3, C: 0.01 }), { alpha: 0.9, topN: 10 })
    expect(sel.selected.map(n => n.title)).toEqual(['A'])
  })

  it('最高分节点在任意 alpha∈[0,1] 下都存活（阈值滤光在算术上不可达）', async () => {
    // θ = α × max 且 α ≤ 1 时，argmax 恒满足 score ≥ θ。这条回落路径是死代码，
    // 设计里已删掉；本用例把该推论钉死，防止有人日后"补"一个不可能的兜底。
    for (const alpha of [0, 0.25, 0.5, 0.75, 1]) {
      const sel = await traverseWithJudge(FLAT(), 'q', fixedJudge({ A: 0.9, B: 0.1, C: 0 }), { alpha, topN: 10 })
      // 钉的是**打分阶段**：θ ≤ max ⇒ argmax 必过阈值。刻意不看 selected——
      // Task 4 起空 pages 节点会被移出 selected，那时这条断言会因与本事无关的理由失败。
      expect(sel.layers[0].threshold).toBeLessThanOrEqual(sel.layers[0].maxScore)
      expect(sel.layers[0].survivors).toBeGreaterThanOrEqual(1)
    }
  })

  it('全部候选同分时，alpha=1 让它们全部存活', async () => {
    const sel = await traverseWithJudge(FLAT(), 'q', fixedJudge({ A: 0.4, B: 0.4, C: 0.4 }), { alpha: 1, topN: 10 })
    expect(sel.selected.map(n => n.title)).toEqual(['A', 'B', 'C'])
  })

  it('每层存活数超过 topN 时按分数取前 N（同分保持文档顺序）', async () => {
    const sel = await traverseWithJudge(FLAT(), 'q', fixedJudge({ A: 0.9, B: 0.5, C: 0.5 }), { alpha: 0, topN: 2 })
    expect(sel.selected.map(n => n.title)).toEqual(['A', 'B'])
  })

  it('layers 记录每一层的候选数、最高分、阈值与留存数', async () => {
    const sel = await traverseWithJudge(FLAT(), 'q', fixedJudge({ A: 0.9, B: 0.1, C: 0 }), { alpha: 0.5, topN: 10 })
    expect(sel.layers).toHaveLength(1)
    expect(sel.layers[0]).toMatchObject({
      depth: 0, candidates: 3, maxScore: 0.9, threshold: 0.45, survivors: 1, kept: 1,
    })
  })

  it('有子节点的存活者继续下探：父节点不进 selected，子节点进，layers 按先序记录两层', async () => {
    const sel = await traverseWithJudge(
      NESTED(), 'q', fixedJudge({ A: 0.9, B: 0.4, A1: 0.5, A2: 0.2, B1: 0.3 }), { alpha: 0, topN: 9 },
    )
    // 父节点有子层，改收集子层结果，父节点自身**不**进 selected
    expect(sel.selected.map(n => n.title)).toEqual(['A1', 'A2', 'B1'])
    expect(sel.selected.map(n => n.title)).not.toContain('A')
    expect(sel.selected.map(n => n.title)).not.toContain('B')
    // 一次判定一条、DFS 先序：根层 depth 0 之后跟着 A 子层与 B 子层两条 depth 1
    expect(sel.layers.map(l => l.depth)).toEqual([0, 1, 1])
    expect(sel.layers[0]).toMatchObject({ depth: 0, candidates: 2, survivors: 2, kept: 2 })
    expect(sel.layers[1]).toMatchObject({ depth: 1, candidates: 2, survivors: 2, kept: 2 })
    expect(sel.layers[2]).toMatchObject({ depth: 1, candidates: 1, survivors: 1, kept: 1 })
  })

  it('空树不调判定器、不产诊断，两个计数器保持默认', async () => {
    let called = 0
    const judge: EvidenceJudge = { async judge() { called += 1; return [] } }
    const sel = await traverseWithJudge([], 'q', judge, { alpha: 0.5, topN: 10 })
    expect(sel.selected).toEqual([])
    expect(sel.layers).toEqual([])
    expect(sel.emptyContentSkipped).toBe(0)
    expect(sel.emptySelectionFallback).toBe(false)
    // nodes.length === 0 的守卫在**调用判定器之前**返回，因此判定器一次都没被叫到
    expect(called).toBe(0)
  })

  it('判定器返回垃圾时向上抛，不吞掉', async () => {
    const bad: EvidenceJudge = { async judge({ nodes }) { return nodes.map(() => Number.NaN) } }
    await expect(traverseWithJudge(FLAT(), 'q', bad, { alpha: 0.5, topN: 10 })).rejects.toThrow('invalid-score')
  })
})

describe('traverseWithJudge —— 父节点规则', () => {
  it('下探的父节点本身不作为证据', async () => {
    const sel = await traverseWithJudge(NESTED(), 'q', fixedJudge({ A: 0.9, A1: 0.8, A2: 0.1, B: 0.2 }), { alpha: 0.5, topN: 5 })
    const titles = sel.selected.map(n => n.title)
    expect(titles).toContain('A1')
    expect(titles).not.toContain('A')   // A 下探了，不该作为证据
  })

  it('下探颗粒无收时父节点兜底成为证据', async () => {
    // A 的子节点都是导航节点（pages 为空），下探拿不到任何内容 → 用 A 的正文兜底
    const tree: TocNode[] = [
      node({ id: 'a', title: 'A', pages: [7], children: [
        node({ id: 'a1', title: 'A1', path: ['A'], depth: 1, pages: [] }),
      ] }),
    ]
    const sel = await traverseWithJudge(tree, 'q', fixedJudge({ A: 0.9, A1: 0.8 }), { alpha: 0, topN: 5 })
    expect(sel.selected.map(n => n.title)).toEqual(['A'])
    expect(sel.emptyContentSkipped).toBe(1)
    // 兜底是「父节点自己顶上」，不是「空选择回落」。少了这一条，把过滤挪到最后统一做
    // 的实现会由空选择回落交出同一个 ['A']，用例照样全绿——它唯一能分辨的观测量就是这个标志。
    expect(sel.emptySelectionFallback).toBe(false)
  })

  it('兜底的父节点不因别的分支有内容而被丢掉', async () => {
    // 「过滤必须发生在递归内部」的**唯一**判据。若把空内容过滤挪到最后统一做：
    // A 的下探会返回 [A1]（非空）→ A 自己永不兜底、被静默丢掉；而 B 仍有内容，
    // 空选择回落不会触发，损失就此无声。上面那条只有 A 一个分支，兜底与回落恰好
    // 给出同一个节点，分辨不出两种实现——必须有第二个有内容的分支才拆得开。
    const tree: TocNode[] = [
      node({ id: 'a', title: 'A', pages: [7], children: [
        node({ id: 'a1', title: 'A1', path: ['A'], depth: 1, pages: [] }),
      ] }),
      node({ id: 'b', title: 'B', pages: [8] }),
    ]
    const sel = await traverseWithJudge(tree, 'q', fixedJudge({ A: 0.9, A1: 0.8, B: 0.7 }), { alpha: 0, topN: 9 })
    expect(sel.selected.map(n => n.title)).toEqual(['A', 'B'])
    expect(sel.emptyContentSkipped).toBe(1)
    expect(sel.emptySelectionFallback).toBe(false)
  })

  it('无内容的叶节点绝不被收为证据', async () => {
    const tree: TocNode[] = [
      node({ id: 'a', title: 'A', pages: [0] }),
      node({ id: 'd', title: 'D', pages: [] }),
    ]
    const sel = await traverseWithJudge(tree, 'q', fixedJudge({ A: 0, D: 0.9 }), { alpha: 0, topN: 5 })
    expect(sel.selected.map(n => n.title)).toEqual(['A'])
    expect(sel.emptyContentSkipped).toBe(1)
    // 跳过了空节点但仍有内容存活 → 不该置位。否则 `emptySelectionFallback = skipped > 0`
    // 这类写反的实现会蒙混过关（它在「全空」用例上恰好也对）。
    expect(sel.emptySelectionFallback).toBe(false)
  })

  it('空父节点的子层也全空时：两者都计数，绝不以空节点收尾', async () => {
    // 钉住 `else if (node.pages.length === 0) emptyContentSkipped += 1` 那一支：
    // 没有这条用例，把它改成 `collected.push(node)` 会让一个 pages 为空的父节点
    // 混进 selected，而其余用例全绿——「无内容节点绝不被收为证据」就此失守。
    const tree: TocNode[] = [
      node({ id: 'p', title: 'P', pages: [], children: [
        node({ id: 'p1', title: 'P1', path: ['P'], depth: 1, pages: [] }),
      ] }),
    ]
    const sel = await traverseWithJudge(tree, 'q', fixedJudge({ P: 0.9, P1: 0.8 }), { alpha: 0, topN: 5 })
    expect(sel.selected).toEqual([])
    expect(sel.emptyContentSkipped).toBe(2)   // 子节点 1 次 + 父节点兜底失败 1 次
    expect(sel.emptySelectionFallback).toBe(false)   // 树里没有任何内容节点，无从回落
  })

  it('存活节点全无内容时，回落到文档首个非空节点并置位', async () => {
    const tree: TocNode[] = [
      node({ id: 'd', title: 'D', pages: [] }),
      node({ id: 'e', title: 'E', pages: [] }),
      node({ id: 'a', title: 'A', pages: [2] }),
    ]
    const sel = await traverseWithJudge(tree, 'q', fixedJudge({ D: 0.9, E: 0.8, A: 0.1 }), { alpha: 1, topN: 5 })
    expect(sel.selected.map(n => n.title)).toEqual(['A'])
    expect(sel.emptySelectionFallback).toBe(true)
    expect(sel.emptyContentSkipped).toBe(1)   // 只有 D 存活且无内容
  })

  it('有非空节点存活时不触发兜底', async () => {
    const sel = await traverseWithJudge(NESTED(), 'q', fixedJudge({ A: 0.9, A1: 0.8, A2: 0.1, B: 0.2 }), { alpha: 0.5, topN: 5 })
    expect(sel.emptySelectionFallback).toBe(false)
  })

  it('selected 按首个页号升序：先序与页序相反时排序真的起作用', async () => {
    // 拿 NESTED 钉不住排序——它的先序本来就升序，且没有任何 topN 重排，把 sort 整个
    // 删掉也照过。这里刻意让先序是 [X(5), Y(1)]，只有真的排过序才会得到 [1, 5]。
    const tree: TocNode[] = [
      node({ id: 'x', title: 'X', pages: [5] }),
      node({ id: 'y', title: 'Y', pages: [1] }),
    ]
    const sel = await traverseWithJudge(tree, 'q', fixedJudge({ X: 0.9, Y: 0.9 }), { alpha: 0, topN: 9 })
    expect(sel.selected.map(n => n.pages[0])).toEqual([1, 5])
  })

  it('父节点下探时 layers 记录两层', async () => {
    const sel = await traverseWithJudge(NESTED(), 'q', fixedJudge({ A: 0.9, A1: 0.4, A2: 0.1, B: 0.2 }), { alpha: 0.5, topN: 5 })
    expect(sel.layers[0]).toMatchObject({ depth: 0, candidates: 2, maxScore: 0.9, threshold: 0.45, kept: 1 })
    expect(sel.layers[1].depth).toBe(1)
  })
})
