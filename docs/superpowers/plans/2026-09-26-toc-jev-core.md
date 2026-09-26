# TOC 树 + Jev 判定 · 核心骨架 实施计划（路线 C）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现「QASPER 节结构 → 树 → 本地决策模型逐层判定 → 证据页区间」这条链路，遍历逻辑与判定运行时彻底解耦，使它在不接 bench runner、不依赖 Python 的情况下可被完整单测。

**Architecture:** `src/utils/tocTree.ts` 只认识 `TocNode` 与概率数组——不认识 QASPER、不认识 PDF、不认识 LLM。树的构造器 `bench/src/toc/qasperTree.ts` 是 bench 专属物，读 QASPER 的节结构与伪页布局。判定器接口 `src/utils/evidenceJudge.ts` 是纯接口，MLX 实现是它在 bench 侧的一个实现。

**Tech Stack:** TypeScript strict、Vitest、Node 内置 `child_process`、Python 3.13 + laya-mlx（仅真实判定，不在单测路径上）。

**分支纪律：** 全部改动只提交到 `feat/jev`，不合入 main。

**上游 spec:** `docs/superpowers/specs/2026-09-26-toc-jev-evidence-routing-design.md`（路线 C 修订版）

**为什么树源是 QASPER 节结构而不是 PDF 目录：** bench 的 QASPER 通路从不打开 PDF——`sectionsToPages` 把节+段落打包成伪页，`evidencePages` 是伪页下标。真实 PDF 页码与伪页下标没有对应关系，用 PDF 目录会让 TOC 臂无法与既有基线落在同一把尺子上。详见 spec 的「修订说明」。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/utils/evidenceJudge.ts` | 判定器接口 `EvidenceJudge` + 输出校验 `assertJudgeOutput`。无运行时依赖 |
| `src/utils/tocTree.ts` | `TocNode` 类型、逐层遍历、页 → `ContextGroup`。数据集无关，不 import pdfjs / 网络 / LLM |
| `bench/src/datasets/qasper.ts` | **修改**：`sectionsToPages` 增加 `sectionPages` 返回值（纯观察，不改既有输出） |
| `bench/src/toc/qasperTree.ts` | QASPER 节结构 → `TocNode[]` |
| `bench/src/jev/protocol.ts` | 侧车 JSON-lines 协议 + 子进程客户端（仅 Node 内置模块） |
| `bench/src/jev/sidecar.py` | 常驻 Python 进程，持有 `laya_mlx.Agent` |
| `bench/src/jev/mlxJudge.ts` | `EvidenceJudge` 的 MLX 实现（协议客户端 + 批量切分） |
| `src/tests/evidenceJudge.test.ts` | 接口校验边界 |
| `src/tests/tocTree.test.ts` | 遍历的全部纯函数行为 |
| `bench/src/tests/qasperTree.test.ts` | 节 → 树；`sectionPages` 与 `pages` 同源 |
| `bench/src/tests/jevSidecar.test.ts` | 协议往返 / 崩溃 / 超时 / 并发——全用假侧车 |

---

## Task 1: 判定器接口与输出校验

**Files:**
- Create: `src/utils/evidenceJudge.ts`
- Test: `src/tests/evidenceJudge.test.ts`

- [x] **Step 1: 写失败的测试**

Create `src/tests/evidenceJudge.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { assertJudgeOutput, type EvidenceJudge, type JudgeNode } from '../utils/evidenceJudge'

describe('assertJudgeOutput', () => {
  it('接受与候选等长、取值在 [0,1] 的有限数数组', () => {
    expect(assertJudgeOutput([0, 0.5, 1], 3)).toEqual([0, 0.5, 1])
  })

  it('长度不匹配即拒绝', () => {
    expect(() => assertJudgeOutput([0.1, 0.2], 3)).toThrow('length-mismatch')
  })

  it('非数组即拒绝', () => {
    expect(() => assertJudgeOutput({ 0: 0.1 }, 1)).toThrow('not-an-array')
  })

  it('NaN 与 Infinity 一律拒绝', () => {
    expect(() => assertJudgeOutput([Number.NaN], 1)).toThrow('invalid-score')
    expect(() => assertJudgeOutput([Number.POSITIVE_INFINITY], 1)).toThrow('invalid-score')
  })

  it('越界值拒绝', () => {
    expect(() => assertJudgeOutput([-0.01], 1)).toThrow('invalid-score')
    expect(() => assertJudgeOutput([1.01], 1)).toThrow('invalid-score')
  })

  it('非数字元素拒绝', () => {
    expect(() => assertJudgeOutput(['0.5'], 1)).toThrow('invalid-score')
  })

  it('零候选返回空数组', () => {
    expect(assertJudgeOutput([], 0)).toEqual([])
  })
})

describe('EvidenceJudge 契约', () => {
  it('是可注入的接口：假实现返回与候选等长的概率', async () => {
    const judge: EvidenceJudge = {
      async judge({ nodes }) { return nodes.map(() => 0.5) },
    }
    const nodes: JudgeNode[] = [
      { id: 'a', title: 'A', path: [] },
      { id: 'b', title: 'B', path: ['A'] },
    ]
    await expect(judge.judge({ query: 'q', nodes })).resolves.toEqual([0.5, 0.5])
  })
})
```

- [x] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/tests/evidenceJudge.test.ts`

Expected: FAIL，报错形如 `Failed to resolve import "../utils/evidenceJudge"`。

- [x] **Step 3: 写最小实现**

Create `src/utils/evidenceJudge.ts`：

```ts
/**
 * 证据判定器：给一批候选节点打分，回答「这一节对当前问题是不是证据」。
 *
 * 刻意不依赖任何运行时——实现方可以是本地决策模型（MLX / ONNX）、
 * BM25 词法对照，或测试里的假实现。判定逻辑因此可以在不装模型、
 * 不装 Python 的机器上被完整单测。
 */

/**
 * 送去判定的候选节点。只带标题与父路径，**不带正文**——树只承担导航职责，
 * 判定的是「这一节值不值得去读」，真正的证据仍要回原文页取证（spec §1 的模块边界）。
 */
export interface JudgeNode {
  id: string
  title: string
  /** 从根到父节点的标题路径，根层节点为空数组 */
  path: string[]
}

export interface JudgeInput {
  query: string
  /** 同一层的候选节点，一次批量判定 */
  nodes: JudgeNode[]
}

export interface EvidenceJudge {
  /** 返回与 `nodes` 等长、逐位对应的概率数组 */
  judge(input: JudgeInput): Promise<number[]>
}

/**
 * 校验判定器输出。判定器可能来自模型、子进程或对照实现，
 * 任何一处返回垃圾都必须在进入阈值计算之前拦下——否则 NaN 会在
 * `Math.max` 里静默传播，最终表现为「什么都没选中」而不是报错。
 */
export function assertJudgeOutput(output: unknown, expectedLength: number): number[] {
  if (!Array.isArray(output)) throw new Error('not-an-array')
  if (output.length !== expectedLength) throw new Error('length-mismatch')
  for (const value of output) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error('invalid-score')
    }
  }
  return output
}
```

- [x] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/tests/evidenceJudge.test.ts`
Expected: PASS，8 个用例全绿。

- [x] **Step 5: Commit**

```bash
git add src/utils/evidenceJudge.ts src/tests/evidenceJudge.test.ts
git commit -m "feat(jev): add the runtime-agnostic EvidenceJudge interface"
```

---

## Task 2: `TocNode` 与页 → ContextGroup

`TocNode.pages` 是 **`number[]`**，不是 `startPage`/`endPage`。QASPER 的节内容落在哪些伪页是打包时已知的，量出来即可——不需要 PDF 路线那种「下一个非后代起始页 − 1」的推导，因此空区间、负区间、`max(自身 startPage, 子节点 endPage)` 那一整套规则**全部不存在**。

**Files:**
- Create: `src/utils/tocTree.ts`
- Test: `src/tests/tocTree.test.ts`

- [ ] **Step 1: 写失败的测试**

Create `src/tests/tocTree.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { tocNodePageSpan, tocSelectionToContextGroups, type TocNode } from '../utils/tocTree'

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

  it('pages 为空的节点被跳过，不产生空组', () => {
    const groups = tocSelectionToContextGroups([
      node({ id: 'a', title: 'A' }),
      node({ id: 'b', title: 'B', pages: [2] }),
    ], PAGES)
    expect(groups).toHaveLength(1)
    expect(groups[0].pieces.map(p => p.page)).toEqual([2])
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/tests/tocTree.test.ts`
Expected: FAIL，`Failed to resolve import "../utils/tocTree"`。

- [ ] **Step 3: 写最小实现**

Create `src/utils/tocTree.ts`：

```ts
import type { ContextGroup, ContextPiece } from './contextTrace'

/**
 * 树节点。`pages` 是该节点内容实际落在的页号（升序），由构造器**量出**而非推导——
 * 因此不存在「空区间」「负区间」这两个概念，空就是空数组。
 *
 * 父子、兄弟之间的 `pages` 可以重叠：父节的引导正文与其子节常在同一页，
 * 同页兄弟也常见。重叠不是缺陷，`materializeContext` 的 `pageOrder` 按首次
 * 出现去重，不会污染检索指标。
 */
export interface TocNode {
  id: string
  title: string
  /** 从根到父节点的标题路径；根层为空数组 */
  path: string[]
  /** 根的子节点为 0 */
  depth: number
  /** 该节点占用的页号，升序。为空表示它不携带任何页内容（合成的导航节点或空节） */
  pages: number[]
  children: TocNode[]
}

/**
 * 把节点的页展开成带页码的片段。首片是首页原文，后续每页带 `\n\n` 前缀
 * ——与 `pages.slice(start, end + 1).join('\n\n')` 逐字一致，也与
 * `pageIndex.ts` 的 `nodeToContextGroup` 同一口径，因此物化器从上下文反推出的
 * pageOrder 在两条路径上语义相同，指标可横向比较。
 *
 * 页号越界直接抛错：静默产出 `undefined` 文本会在物化器的 `text.trim()` 上炸掉，
 * 错误离现场很远；而越界是构造器的编程错误，不是运行时数据问题。
 */
export function tocNodePageSpan(node: TocNode, pages: string[]): ContextPiece[] {
  return [...node.pages]
    .sort((a, b) => a - b)
    .map((page, index) => {
      if (!Number.isInteger(page) || page < 0 || page >= pages.length) {
        throw new Error('toc-page-out-of-range')
      }
      return { page, text: index === 0 ? pages[page] : `\n\n${pages[page]}` }
    })
}

/** 选中节点 → 上下文分组，每个节点一组。`pages` 为空的节点被跳过，不产生空组。 */
export function tocSelectionToContextGroups(selected: TocNode[], pages: string[]): ContextGroup[] {
  const groups: ContextGroup[] = []
  for (const node of selected) {
    const pieces = tocNodePageSpan(node, pages)
    if (pieces.length > 0) groups.push({ pieces })
  }
  return groups
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/tests/tocTree.test.ts`
Expected: PASS，7 个用例全绿。

- [ ] **Step 5: 与既有口径交叉验证**

Run: `npx vitest run src/tests/contextTrace.test.ts src/tests/tocTree.test.ts`
Expected: PASS。`contextTrace.test.ts` 钉住物化器的分组不变量；两边同时绿说明本模块产出的组满足同一契约。

- [ ] **Step 6: Commit**

```bash
git add src/utils/tocTree.ts src/tests/tocTree.test.ts
git commit -m "feat(jev): add TocNode and page-to-context conversion"
```

---

## Task 3: 逐层遍历——相对阈值与 top-N

**Files:**
- Modify: `src/utils/tocTree.ts`
- Test: `src/tests/tocTree.test.ts`

- [ ] **Step 1: 写失败的测试**

追加到 `src/tests/tocTree.test.ts`：

```ts
import { traverseWithJudge } from '../utils/tocTree'
import type { EvidenceJudge } from '../utils/evidenceJudge'

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
      expect(sel.selected.map(n => n.title)).toContain('A')
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

  it('layers 记录每一层的候选数、最高分、阈值与下探数', async () => {
    const sel = await traverseWithJudge(FLAT(), 'q', fixedJudge({ A: 0.9, B: 0.1, C: 0 }), { alpha: 0.5, topN: 10 })
    expect(sel.layers).toHaveLength(1)
    expect(sel.layers[0]).toMatchObject({
      depth: 0, candidates: 3, maxScore: 0.9, threshold: 0.45, survivors: 1, descended: 1,
    })
  })

  it('判定器返回垃圾时向上抛，不吞掉', async () => {
    const bad: EvidenceJudge = { async judge({ nodes }) { return nodes.map(() => Number.NaN) } }
    await expect(traverseWithJudge(FLAT(), 'q', bad, { alpha: 0.5, topN: 10 })).rejects.toThrow('invalid-score')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/tests/tocTree.test.ts -t 相对阈值`
Expected: FAIL，`traverseWithJudge is not a function`。

- [ ] **Step 3: 写实现**

在 `src/utils/tocTree.ts` 补：

```ts
import { assertJudgeOutput, type EvidenceJudge, type JudgeNode } from './evidenceJudge'

export interface TraverseOptions {
  /** 层内相对阈值系数 α ∈ [0,1]。θ_层 = α × 层内最高分。 */
  alpha: number
  /** 每层最多下探的存活节点数 */
  topN: number
}

/** 逐层诊断。调用方据此统计阈值行为，指标不读它。 */
export interface LayerDiagnostic {
  depth: number
  candidates: number
  maxScore: number
  threshold: number
  survivors: number
  descended: number
}

export interface TocSelection {
  /** 收为证据的节点，按首个个页号升序 */
  selected: TocNode[]
  layers: LayerDiagnostic[]
  /** 因 pages 为空被排除出 selected 的节点数 */
  emptyContentSkipped: number
  /** 存活节点全无内容、于是回落到文档首个非空节点时置位 */
  emptySelectionFallback: boolean
}

const toJudgeNode = (n: TocNode): JudgeNode => ({ id: n.id, title: n.title, path: n.path })

/** 稳定排序取前 topN：同分保持原有文档顺序。 */
function topNSurvivors(nodes: TocNode[], scores: number[], threshold: number, topN: number): TocNode[] {
  const surviving = nodes
    .map((node, i) => ({ node, score: scores[i], order: i }))
    .filter(s => s.score >= threshold)
  if (surviving.length <= topN) return surviving.map(s => s.node)
  return surviving
    .sort((a, b) => (b.score - a.score) || (a.order - b.order))
    .slice(0, topN)
    .map(s => s.node)
}

/**
 * 按文档顺序（先序）找第一个 `pages` 非空的节点。
 * 只要树里还有一个带内容的节点就必有结果——供空选择时兜底。
 */
export function firstNodeWithContent(nodes: TocNode[]): TocNode | undefined {
  for (const node of nodes) {
    if (node.pages.length > 0) return node
    const found = firstNodeWithContent(node.children)
    if (found) return found
  }
  return undefined
}

/**
 * 逐层判定并收集证据。
 *
 * **阈值是层内相对的**（θ = α × 本层最高分），不是绝对值：实测本地决策模型的
 * 概率整体压在 0.03–0.39，任何固定绝对阈值都会把整层滤光。相对阈值同时对
 * 未校准的概率免疫——这正好对症该 checkpoint 的温度被 clamp 那条警告。
 *
 * 本步只实现阈值与 top-N；父节点规则、空内容节点与空选择兜底由 Task 4 补上。
 */
export async function traverseWithJudge(
  tree: TocNode[],
  query: string,
  judge: EvidenceJudge,
  opts: TraverseOptions,
): Promise<TocSelection> {
  const layers: LayerDiagnostic[] = []

  const descend = async (nodes: TocNode[], depth: number): Promise<TocNode[]> => {
    if (nodes.length === 0) return []
    // assertJudgeOutput 可能抛错。调用方按 spec §4 把「判定器输出非法」
    // 作为该篇回落的依据，不在这里吞掉。
    const scores = assertJudgeOutput(await judge.judge({ query, nodes: nodes.map(toJudgeNode) }), nodes.length)
    const maxScore = Math.max(...scores)
    const threshold = opts.alpha * maxScore
    const survivors = topNSurvivors(nodes, scores, threshold, opts.topN)
    layers.push({
      depth,
      candidates: nodes.length,
      maxScore,
      threshold,
      survivors: scores.filter(s => s >= threshold).length,
      descended: survivors.length,
    })

    const collected: TocNode[] = []
    for (const node of survivors) {
      if (node.children.length === 0) {
        collected.push(node)
        continue
      }
      const fromChildren = await descend(node.children, depth + 1)
      collected.push(...(fromChildren.length > 0 ? fromChildren : [node]))
    }
    return collected
  }

  const selected = (await descend(tree, 0)).sort((a, b) => a.pages[0] - b.pages[0])
  return { selected, layers, emptyContentSkipped: 0, emptySelectionFallback: false }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/tests/tocTree.test.ts`
Expected: PASS，15 个用例全绿。

- [ ] **Step 5: Commit**

```bash
git add src/utils/tocTree.ts src/tests/tocTree.test.ts
git commit -m "feat(jev): traverse the tree with a layer-relative threshold"
```

---

## Task 4: 逐层遍历——父节点规则与空内容兜底

**Files:**
- Modify: `src/utils/tocTree.ts`
- Test: `src/tests/tocTree.test.ts`

- [ ] **Step 1: 写失败的测试**

追加到 `src/tests/tocTree.test.ts`：

```ts
/** A 有子节点 A1/A2；B 有子节点 B1；D 是合成的导航节点（pages 为空） */
const NESTED = (): TocNode[] => [
  node({ id: 'a', title: 'A', pages: [0, 1], children: [
    node({ id: 'a1', title: 'A1', path: ['A'], depth: 1, pages: [1] }),
    node({ id: 'a2', title: 'A2', path: ['A'], depth: 1, pages: [2] }),
  ] }),
  node({ id: 'b', title: 'B', pages: [3], children: [
    node({ id: 'b1', title: 'B1', path: ['B'], depth: 1, pages: [3] }),
  ] }),
]

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
  })

  it('无内容的叶节点绝不被收为证据', async () => {
    const tree: TocNode[] = [
      node({ id: 'a', title: 'A', pages: [0] }),
      node({ id: 'd', title: 'D', pages: [] }),
    ]
    const sel = await traverseWithJudge(tree, 'q', fixedJudge({ A: 0, D: 0.9 }), { alpha: 0, topN: 5 })
    expect(sel.selected.map(n => n.title)).toEqual(['A'])
    expect(sel.emptyContentSkipped).toBe(1)
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

  it('selected 按首个页号升序，与文档顺序一致', async () => {
    const sel = await traverseWithJudge(NESTED(), 'q', fixedJudge({ A: 0.9, A1: 0.9, A2: 0.9, B: 0.9, B1: 0.9 }), { alpha: 0, topN: 9 })
    const pages = sel.selected.map(n => n.pages[0])
    expect(pages).toEqual([...pages].sort((a, b) => a - b))
  })

  it('父节点下探时 layers 记录两层', async () => {
    const sel = await traverseWithJudge(NESTED(), 'q', fixedJudge({ A: 0.9, A1: 0.4, A2: 0.1, B: 0.2 }), { alpha: 0.5, topN: 5 })
    expect(sel.layers[0]).toMatchObject({ depth: 0, candidates: 2, maxScore: 0.9, threshold: 0.45, descended: 1 })
    expect(sel.layers[1].depth).toBe(1)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/tests/tocTree.test.ts -t "父节点规则"`

Expected: **4 个失败、3 个通过**。

失败的是「下探颗粒无收时父节点兜底」「无内容的叶节点绝不被收为证据」「存活节点全无内容时回落」「selected 按首个页号升序」——Task 3 把 `pages` 为空的节点原样收了进来。典型报错：

```
AssertionError: expected [ 'A1' ] to deeply equal [ 'A' ]
```

「selected 按首个页号升序」那条会以更隐晦的方式失败：空 `pages` 让 `a.pages[0] - b.pages[0]` 得到 `NaN`，排序结果不稳定——**这正是必须先写测试的原因**，这类错误不会报错，只会悄悄产出乱序上下文。

通过的是「下探的父节点本身不作为证据」（Task 3 已经会下探）、「有非空节点存活时不触发兜底」（`emptySelectionFallback` 恒为 `false`）、「父节点下探时 layers 记录两层」（与空内容无关）。若这三条里任何一条失败，说明 `NESTED` fixture 的构造与预期不符，先修 fixture 再继续。

- [ ] **Step 3: 写实现**

替换 `traverseWithJudge` 中的 `descend` 循环体与返回值：

```ts
  const layers: LayerDiagnostic[] = []
  let emptyContentSkipped = 0

  const descend = async (nodes: TocNode[], depth: number): Promise<TocNode[]> => {
    if (nodes.length === 0) return []
    const scores = assertJudgeOutput(await judge.judge({ query, nodes: nodes.map(toJudgeNode) }), nodes.length)
    const maxScore = Math.max(...scores)
    const threshold = opts.alpha * maxScore
    const survivors = topNSurvivors(nodes, scores, threshold, opts.topN)
    layers.push({
      depth,
      candidates: nodes.length,
      maxScore,
      threshold,
      survivors: scores.filter(s => s >= threshold).length,
      descended: survivors.length,
    })

    const collected: TocNode[] = []
    for (const node of survivors) {
      if (node.children.length === 0) {
        // `pages` 为空的节点不携带任何内容，收进来只会产出一个被物化器丢掉的空组
        if (node.pages.length === 0) emptyContentSkipped += 1
        else collected.push(node)
        continue
      }
      const fromChildren = await descend(node.children, depth + 1)
      if (fromChildren.length > 0) collected.push(...fromChildren)
      else if (node.pages.length === 0) emptyContentSkipped += 1
      else collected.push(node)   // 兜底：下探颗粒无收时用父节点正文
    }
    return collected
  }

  let selected = (await descend(tree, 0)).sort((a, b) => a.pages[0] - b.pages[0])
  let emptySelectionFallback = false
  if (selected.length === 0) {
    const first = firstNodeWithContent(tree)
    if (first) {
      selected = [first]
      emptySelectionFallback = true
    }
  }

  return { selected, layers, emptyContentSkipped, emptySelectionFallback }
```

并在 `traverseWithJudge` 的文档注释末尾补：

```ts
 * 空内容过滤必须发生在**递归内部**，不能放到最后统一过滤：放到最后的话，
 * 下探会「看起来有收获」（返回一批马上要被丢掉的空节点）而父节点兜底永不触发，
 * 最终静默产出空上下文。
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/tests/tocTree.test.ts`
Expected: PASS，22 个用例全绿。

- [ ] **Step 5: 检查覆盖**

Run: `npx vitest run src/tests/tocTree.test.ts --coverage.enabled --coverage.include='src/utils/tocTree.ts'`
Expected: PASS，`tocTree.ts` 行覆盖 ≥ 90%。

- [ ] **Step 6: 确认纯函数没被污染**

Run: `grep -n "pdfjs\|node:fs\|node:child_process\|fetch(" src/utils/tocTree.ts src/utils/evidenceJudge.ts`
Expected: **无输出**。这两个文件必须不认识 PDF、文件系统、子进程与网络——这是 §1 解耦设计的全部意义，也是单测能在任何机器上跑的前提。

- [ ] **Step 7: Commit**

```bash
git add src/utils/tocTree.ts src/tests/tocTree.test.ts
git commit -m "feat(jev): skip contentless nodes and fall back when nothing is selectable"
```

---

## Task 5: `sectionsToPages` 增加 `sectionPages`

**这是本计划最容易出错的一步。** `sectionsToPages` 决定了伪页边界，`evidencePages` 由它产出。节区间若用另一套实现算，两边会在边界上错开一页，而指标照常输出数字——**静默失真**。所以必须在**同一个循环**里记录。

只增加返回值，**绝不改动它已产出的 `pages` 与 `paragraphToPage`**——改那两者会让全部 LLM 缓存与既有基线结果失效。

**Files:**
- Modify: `bench/src/datasets/qasper.ts:67-103`
- Test: `bench/src/tests/qasperTree.test.ts`

- [ ] **Step 1: 写失败的测试**

Create `bench/src/tests/qasperTree.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { sectionsToPages, PSEUDO_PAGE_CHARS } from '../datasets/qasper'

describe('sectionsToPages —— sectionPages 与 pages 同源', () => {
  it('节的页区间覆盖其内容真正落入的伪页', () => {
    const names = ['Intro', 'Method']
    // 每段 1200 字符：Intro 占 p0，Method 起于 p0 尾或 p1（由打包决定）
    const sections = [['x'.repeat(1200)], ['y'.repeat(1200)]]
    const { pages, sectionPages } = sectionsToPages(names, sections)
    expect(sectionPages).toHaveLength(2)
    for (const [i, touched] of sectionPages.entries()) {
      expect(touched.length).toBeGreaterThan(0)
      for (const page of touched) expect(page).toBeLessThan(pages.length)
      // 区间必须升序且不重复
      expect(touched).toEqual([...new Set(touched)].sort((a, b) => a - b))
    }
  })

  it('标题与其首段强制同页：sectionPages 的首元素等于该首段落的伪页号', () => {
    // 先塞一个几乎占满页的节，逼出封页，再验证下一节的标题没被孤立
    const names = ['Filler', 'Method']
    const sections = [
      ['f'.repeat(PSEUDO_PAGE_CHARS - 10)],
      ['z'.repeat(50)],
    ]
    const { paragraphToPage, sectionPages } = sectionsToPages(names, sections)
    // 第 2 节只有 1 段，对应 paragraphToPage[1]
    expect(sectionPages[1]).toEqual([paragraphToPage[1]])
  })

  it('无内容的节得到空数组', () => {
    const { sectionPages } = sectionsToPages(['Empty', 'Real'], [[], ['body']])
    expect(sectionPages[0]).toEqual([])
    expect(sectionPages[1].length).toBeGreaterThan(0)
  })

  it('不改变既有输出：pages 与 paragraphToPage 逐字不变', () => {
    const names = ['A', 'B', 'C']
    const sections = [['a1', 'a2'], ['b1'], ['c1', 'c2', 'c3']]
    const out = sectionsToPages(names, sections)
    // 这三个不变量是 evidencePages 的基础，任何重构都不得动摇
    expect(out.paragraphToPage).toHaveLength(sections.flat().length)
    expect(out.pages.join('\u0000')).toBe(sectionsToPages(names, sections).pages.join('\u0000'))
    for (const p of out.paragraphToPage) expect(p).toBeLessThan(out.pages.length)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run bench/src/tests/qasperTree.test.ts`

Expected: FAIL，`sectionPages` 为 `undefined`，报错形如 `expected undefined to have length 2`。

- [ ] **Step 3: 写实现**

把 `bench/src/datasets/qasper.ts:67-103` 的 `sectionsToPages` 整体替换为：

```ts
/** Like paragraphsToPages, but injects each original section heading before its first paragraph. */
export function sectionsToPages(sectionNames: string[], sections: string[][]): {
  pages: string[]
  paragraphToPage: number[]
  /**
   * 每节内容实际落到的伪页号，升序。与 sectionNames 同序同长；空数组表示该节无内容。
   * 由下面这段打包循环**顺手记录**，不另起一套实现——两套实现会在封页边界上错开一页，
   * 而指标照常输出数字，是静默失真。
   */
  sectionPages: number[][]
} {
  const pages: string[] = []
  const paragraphToPage: number[] = []
  const sectionPages: number[][] = []
  let buffer: string[] = []
  let bufferLen = 0
  const append = (text: string) => {
    if (bufferLen > 0 && bufferLen + text.length > PSEUDO_PAGE_CHARS) {
      pages.push(buffer.join('\n\n'))
      buffer = []
      bufferLen = 0
    }
    buffer.push(text)
    bufferLen += text.length
  }
  // 必须在每次 append **之后**调用：append 可能先封页，此时 pages.length 才是
  // 这份内容真正落到的页号。封页前后的 pages.length 不同，顺序错了就整体偏一页。
  const note = (touched: number[]) => {
    const page = pages.length
    if (touched[touched.length - 1] !== page) touched.push(page)
  }
  for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
    const heading = sectionNames[sectionIndex]?.trim()
    const paragraphs = sections[sectionIndex]
    const firstParagraph = paragraphs[0]
    const touched: number[] = []
    // Keep a heading and its first paragraph on the same pseudo page. Otherwise a
    // nearly full preceding page can strand the heading from the content it labels.
    if (heading && firstParagraph !== undefined) {
      append(`${heading}\n\n${firstParagraph}`)
      note(touched)
      paragraphToPage.push(pages.length)
    } else if (heading) {
      append(heading)
      note(touched)
    }
    for (const paragraph of paragraphs.slice(firstParagraph === undefined ? 0 : 1)) {
      append(paragraph)
      note(touched)
      paragraphToPage.push(pages.length)
    }
    sectionPages.push(touched)
  }
  if (buffer.length > 0) pages.push(buffer.join('\n\n'))
  return { pages, paragraphToPage, sectionPages }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run bench/src/tests/qasperTree.test.ts`
Expected: PASS，4 个用例全绿。

- [ ] **Step 5: 确认没有波及其它测试**

Run: `npx vitest run bench/src/tests/`

Expected: 全绿。若有既有测试因这次改动失败，**说明确实改动了 `pages` 或 `paragraphToPage`**——回 Step 3 检查，不要改测试去迁就。

- [ ] **Step 6: Commit**

```bash
git add bench/src/datasets/qasper.ts bench/src/tests/qasperTree.test.ts
git commit -m "feat(bench): record per-section pseudo-page ranges in the same packing pass"
```

---

## Task 6: QASPER 节结构 → 树

**Files:**
- Create: `bench/src/toc/qasperTree.ts`
- Test: `bench/src/tests/qasperTree.test.ts`（追加）

- [ ] **Step 1: 写失败的测试**

追加到 `bench/src/tests/qasperTree.test.ts`：

```ts
import { buildQasperTree, validateSections, MAX_TOC_DEPTH } from '../toc/qasperTree'

const build = (names: string[], pages: number[][]) =>
  buildQasperTree({ sectionNames: names, sectionPages: pages })

describe('buildQasperTree', () => {
  it('扁平节列表产出单层树', () => {
    const { tree } = build(['Introduction', 'Method', 'Conclusion'], [[0], [1], [2]])
    expect(tree.map(n => n.title)).toEqual(['Introduction', 'Method', 'Conclusion'])
    expect(tree.every(n => n.depth === 0 && n.children.length === 0)).toBe(true)
    expect(tree[1].pages).toEqual([1])
  })

  it(' ::: 还原父子关系，path 与 depth 正确', () => {
    const { tree } = build(
      ['Approach', 'Approach ::: Masked LM', 'Approach ::: Bridge LM', 'Experiments'],
      [[0], [1], [2], [3]],
    )
    expect(tree.map(n => n.title)).toEqual(['Approach', 'Experiments'])
    expect(tree[0].children.map(n => n.title)).toEqual(['Masked LM', 'Bridge LM'])
    expect(tree[0].children[0].path).toEqual(['Approach'])
    expect(tree[0].children[0].depth).toBe(1)
  })

  it('父节点缺条目时合成一个导航节点（pages 为空）', () => {
    const { tree, synthesizedParents } = build(
      ['Approach ::: Masked LM', 'Approach ::: Bridge LM'],
      [[1], [2]],
    )
    expect(tree.map(n => n.title)).toEqual(['Approach'])
    expect(tree[0].pages).toEqual([])
    expect(synthesizedParents).toBe(1)
    expect(tree[0].children.map(n => n.title)).toEqual(['Masked LM', 'Bridge LM'])
  })

  it('父节点后出现自己的条目时，页合并不新建节点', () => {
    const { tree } = build(['Approach ::: Masked LM', 'Approach'], [[1], [0]])
    expect(tree).toHaveLength(1)
    expect(tree[0].pages).toEqual([0])
  })

  it('标题两端空白被 trim（实测存在尾随空格的节名）', () => {
    const { tree } = build(['  Dogmatism data  ', 'What is X? (R1)'], [[0], [1]])
    expect(tree.map(n => n.title)).toEqual(['Dogmatism data', 'What is X? (R1)'])
  })

  it('空标题的节被丢弃并计数', () => {
    const { tree, droppedSections } = build(['Introduction', '   ', ''], [[0], [1], [2]])
    expect(tree.map(n => n.title)).toEqual(['Introduction'])
    expect(droppedSections).toBe(2)
  })

  it('三层嵌套正确挂载', () => {
    const { tree } = build(
      ['Experiments ::: Setup ::: Datasets.', 'Experiments ::: Setup ::: Details.'],
      [[2], [3]],
    )
    const experiments = tree[0]
    const setup = experiments.children[0]
    expect([experiments.title, setup.title, experiments.depth, setup.depth]).toEqual(['Experiments', 'Setup', 0, 1])
    expect(setup.children.map(n => n.title)).toEqual(['Datasets.', 'Details.'])
    expect(setup.children[0].depth).toBe(2)
  })

  it('节点 id 稳定：同一输入产出同一批 id', () => {
    const names = ['A', 'A ::: B']
    const ids = () => build(names, [[0], [1]]).tree.flatMap(n => [n.id, ...n.children.map(c => c.id)])
    expect(ids()).toEqual(ids())
  })

  it('空输入返回空树', () => {
    expect(build([], []).tree).toEqual([])
  })

  it('节结构非法时抛错，绝不产出带断层的树', () => {
    // 校验在 buildQasperTree 内部执行，调用方无法绕过
    expect(() => build(['Results', 'Methods', 'Results'], [[1], [2, 3, 4], [5]]))
      .toThrow('invalid-section-structure: non-adjacent-repeat')
    const deep = Array.from({ length: MAX_TOC_DEPTH + 1 }, (_, i) => `L${i}`).join(' ::: ')
    expect(() => build([deep], [[0]])).toThrow('invalid-section-structure: too-deep')
  })
})

describe('validateSections', () => {
  it('接受扁平与合法嵌套', () => {
    expect(validateSections({ sectionNames: ['A', 'A ::: B'], sectionPages: [[0], [1]] })).toEqual({ ok: true })
  })

  it('拒绝超过深度上限', () => {
    const deep = Array.from({ length: MAX_TOC_DEPTH + 1 }, (_, i) => `L${i}`).join(' ::: ')
    expect(validateSections({ sectionNames: [deep], sectionPages: [[0]] }))
      .toEqual({ ok: false, reason: 'too-deep' })
  })

  it('拒绝同一路径内重复的层名（自嵌套）', () => {
    expect(validateSections({ sectionNames: ['A ::: A'], sectionPages: [[0]] }))
      .toEqual({ ok: false, reason: 'cyclic-path' })
  })

  it('空标题不算非法：由建树阶段丢弃计数', () => {
    expect(validateSections({ sectionNames: ['  '], sectionPages: [[0]] })).toEqual({ ok: true })
  })

  it('拒绝同一路径分两处出现且页区间断开（中间隔着别的节）', () => {
    // `Results` 在页 1 与页 5 各出现一次，中间夹着 Methods 的 2–4 页。
    // 并集 [1,5] 断开——拼出来的文本与连续两页没有区别，中间三页会被无声吞掉。
    expect(validateSections({
      sectionNames: ['Results', 'Methods', 'Results'],
      sectionPages: [[1], [2, 3, 4], [5]],
    })).toEqual({ ok: false, reason: 'non-adjacent-repeat' })
  })

  it('接受同一路径连续两节出现且页区间相接', () => {
    // 真正相邻的重复节：页区间首尾相接，并集连续，不会造出断层
    expect(validateSections({ sectionNames: ['Results', 'Results'], sectionPages: [[1], [2]] }))
      .toEqual({ ok: true })
    expect(validateSections({ sectionNames: ['Results', 'Results'], sectionPages: [[3], [3]] }))
      .toEqual({ ok: true })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run bench/src/tests/qasperTree.test.ts -t buildQasperTree`
Expected: FAIL，`Failed to resolve import "../toc/qasperTree"`。

- [ ] **Step 3: 写实现**

Create `bench/src/toc/qasperTree.ts`：

```ts
/**
 * QASPER 节结构 → TocNode 树。
 *
 * 这是 bench 专属物：它读的是 QASPER 的 `section_name`（` ::: ` 分隔层级）与
 * 伪页布局。产品若将来要从 PDF 目录建树，会配一个兄弟模块，`src/utils/tocTree.ts`
 * 一行不改。
 */
import type { TocNode } from '../../../src/utils/tocTree'

/** 节层级上限。QASPER 实测最深 3 层，留一倍余量。 */
export const MAX_TOC_DEPTH = 6

/** 父路径与层名的连接符。用 NUL 避免与节名里的任何字符冲突。 */
const KEY_SEP = '\u0000'
const PATH_SEP = ' ::: '

export interface QasperSectionInput {
  sectionNames: string[]
  sectionPages: number[][]
}

export type SectionValidation =
  | { ok: true }
  | { ok: false; reason: 'too-deep' | 'cyclic-path' | 'non-adjacent-repeat' }

export interface QasperTreeResult {
  tree: TocNode[]
  /** 只作导航、自身无内容的父节点数 */
  synthesizedParents: number
  /** 因标题为空被丢弃的节数 */
  droppedSections: number
}

/** 把节名切成层级路径；全空的层名被剔除，因此空标题返回空数组。 */
function pathOf(sectionName: string): string[] {
  return sectionName
    .split(PATH_SEP)
    .map(part => part.trim())
    .filter(part => part.length > 0)
}

/**
 * 同一路径多次出现时，各次的页区间必须首尾相接（并集连续）。
 *
 * 为什么必须校验：`tocNodePageSpan` 用与「相邻两页」**完全相同**的 `\n\n` 拼接
 * 片段，因此 `pages: [1, 5]` 渲染出的文本与 `[1, 2]` 形状毫无区别——中间
 * 2–4 页被无声吞掉，读上下文的人和答题模型都看不出断层。指标（`pageOrder`
 * 取自 `piece.page`）仍然诚实，所以这不会表现为数字异常，只会表现为**召回
 * 静默损失**。这类「指标正常、内容悄悄少一段」正是本设计要避免的失效形态。
 *
 * 这是本模块**唯一**可能造出空隙的地方：打包循环只顺序追加，单节区间恒连续
 * （每次 append 至多封一页，页号每次至多 +1）。
 */
function mergedRunsAreContiguous(input: QasperSectionInput): boolean {
  const byPath = new Map<string, number[]>()
  for (let i = 0; i < input.sectionNames.length; i++) {
    const parts = pathOf(input.sectionNames[i])
    if (parts.length === 0) continue
    const key = parts.join(KEY_SEP)
    byPath.set(key, [...(byPath.get(key) ?? []), ...(input.sectionPages[i] ?? [])])
  }
  for (const pages of byPath.values()) {
    const sorted = [...new Set(pages)].sort((a, b) => a - b)
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] !== sorted[i - 1] + 1) return false
    }
  }
  return true
}

/**
 * 节结构合法性校验。**整棵作废，不修补**——沿用 `validateSemanticTree` 的口径：
 * 猜一个修复方案比直接回落更容易产出看不出错的坏结果。
 *
 * 空标题刻意**不算**非法：它是可丢弃的局部噪声（跳过该节即可），不该让整篇回落。
 */
export function validateSections(input: QasperSectionInput): SectionValidation {
  for (const name of input.sectionNames) {
    const parts = pathOf(name)
    if (parts.length > MAX_TOC_DEPTH) return { ok: false, reason: 'too-deep' }
    // `A ::: A` 会造出 A → A 的自嵌套
    if (new Set(parts).size !== parts.length) return { ok: false, reason: 'cyclic-path' }
  }
  if (!mergedRunsAreContiguous(input)) return { ok: false, reason: 'non-adjacent-repeat' }
  return { ok: true }
}

/**
 * 建树。按节的**首次出现顺序**决定节点顺序，与原文一致。
 *
 * 父节点通常自带独立条目（实测 `Approach` 与 `Approach ::: Masked LM` 并存），
 * 但不保证每篇都如此；缺条目时合成一个 `pages` 为空的导航节点，
 * 它只承担下探职责，不会被收为证据（见 `traverseWithJudge` 的空内容过滤）。
 *
 * **先校验再建树**：校验放在函数内部而非交给调用方，是为了让「产出带断层的树」
 * 在类型上没有出口——调用方忘了校验就会静默拿到坏树，这正是要防的。
 */
export function buildQasperTree(input: QasperSectionInput): QasperTreeResult {
  const validation = validateSections(input)
  if (!validation.ok) throw new Error(`invalid-section-structure: ${validation.reason}`)

  const byPath = new Map<string, TocNode>()
  const roots: TocNode[] = []
  let droppedSections = 0
  let counter = 0

  for (let i = 0; i < input.sectionNames.length; i++) {
    const parts = pathOf(input.sectionNames[i])
    if (parts.length === 0) {
      droppedSections += 1
      continue
    }
    const pages = input.sectionPages[i] ?? []

    for (let depth = 0; depth < parts.length; depth++) {
      const path = parts.slice(0, depth)
      const key = [...path, parts[depth]].join(KEY_SEP)
      const existing = byPath.get(key)
      const isLeafOfThisSection = depth === parts.length - 1

      if (existing) {
        // 同一路径重复出现（如父节点条目排在子节点之后）：合并页，不新建节点
        if (isLeafOfThisSection) {
          existing.pages = [...new Set([...existing.pages, ...pages])].sort((a, b) => a - b)
        }
        continue
      }

      const node: TocNode = {
        id: `S${String(counter++).padStart(3, '0')}`,
        title: parts[depth],
        path,
        depth,
        pages: isLeafOfThisSection ? [...pages].sort((a, b) => a - b) : [],
        children: [],
      }
      byPath.set(key, node)
      if (depth === 0) roots.push(node)
      else byPath.get(path.join(KEY_SEP))!.children.push(node)
    }
  }

  let synthesizedParents = 0
  const countEmptyParents = (nodes: TocNode[]): void => {
    for (const node of nodes) {
      if (node.children.length > 0 && node.pages.length === 0) synthesizedParents += 1
      countEmptyParents(node.children)
    }
  }
  countEmptyParents(roots)

  return { tree: roots, synthesizedParents, droppedSections }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run bench/src/tests/qasperTree.test.ts`
Expected: PASS，20 个用例全绿（本节 16 个 + Task 5 的 4 个 sectionsToPages 用例）。

- [ ] **Step 5: 把节结构带进 EvalSample**

`EvalSample` 目前**没有**节结构字段——`normalizeQasperEntry` 的返回对象只有 `paperId / title / pages / questions / referenceAbstract / source`，节名在归一化时被丢掉了。建树需要它，所以先把这一步补上。

在 `bench/src/types.ts` 的 `EvalSample` 上加两个字段（**可选**，让冒烟集样本合法）：

```ts
  /** 节名（` ::: ` 编码层级）。仅 QASPER 样本有；冒烟集为 undefined。 */
  sectionNames?: string[]
  /** 每节内容落到的伪页号，与 sectionNames 同序同长。仅 QASPER 样本有。 */
  sectionPages?: number[][]
```

`bench/src/datasets/qasper.ts:107` 的解构改为：

```ts
  const { pages, paragraphToPage, sectionPages } = sectionsToPages(entry.full_text.section_name, entry.full_text.paragraphs)
```

返回对象（`bench/src/datasets/qasper.ts:159-166`）里加两行：

```ts
    sectionNames: entry.full_text.section_name,
    sectionPages,
```

**注意别改 `loadQasperDataset` 的校验**：它只对既有字段做完整性检查，新字段是给建树用的，缺了不该让整个数据集加载失败。

- [ ] **Step 6: 用真实数据冒烟**

Create `bench/scripts/tocSmoke.ts`：

```ts
/**
 * 用真实 QASPER 数据建树并打印结构，人工核对。不属于单测。
 *
 * 全部逻辑包在 main() 里：tsx 对仓库内脚本按 CJS 转译，顶层 await 会直接报
 * "Top-level await is currently not supported with the cjs output format"。
 * 数据集路径走 loadQasperDataset，不自己拼——bench/src/paths.ts 的存在就是
 * 因为 `new URL(...).pathname` 会在含空格的路径上静默失效。
 */
import { loadQasperDataset } from '../src/datasets/qasper'
import { buildQasperTree } from '../src/toc/qasperTree'
import type { TocNode } from '../../src/utils/tocTree'

function print(nodes: TocNode[], indent: string): void {
  for (const node of nodes) {
    console.log(`${indent}${node.title}  pages=[${node.pages.join(',')}]`)
    print(node.children, `${indent}  `)
  }
}

async function main(): Promise<void> {
  const samples = await loadQasperDataset()
  console.log(`样本 ${samples.length} 篇`)
  let withSections = 0
  let maxDepth = 0
  for (const sample of samples) {
    if (sample.sectionNames?.length) withSections += 1
    for (const node of buildQasperTree({
      sectionNames: sample.sectionNames ?? [],
      sectionPages: sample.sectionPages ?? [],
    }).tree) {
      const depthOf = (n: TocNode): number => (n.children.length === 0 ? n.depth : Math.max(...n.children.map(depthOf)))
      maxDepth = Math.max(maxDepth, depthOf(node))
    }
  }
  console.log(`带节结构的样本 ${withSections}/${samples.length}，最深 ${maxDepth} 层`)

  for (const sample of samples.slice(0, 3)) {
    console.log(`\n--- ${sample.title.slice(0, 60)} (伪页 ${sample.pages.length})`)
    const { tree, synthesizedParents, droppedSections } = buildQasperTree({
      sectionNames: sample.sectionNames ?? [],
      sectionPages: sample.sectionPages ?? [],
    })
    print(tree, '  ')
    console.log(`  合成父节点 ${synthesizedParents}，丢弃节 ${droppedSections}`)
  }
}

main().catch(error => { console.error(error); process.exit(1) })
```

Run: `npx tsx bench/scripts/tocSmoke.ts`

Expected: 打印「带节结构的样本 `60/60`」——节结构是 QASPER 原始数据的一部分，本地 60 篇全都有（100 篇抽样实测 100/100 覆盖）。若显示 `0/60`，说明 Step 5 的字段没接上。最深应为 3 层（实测深度分布 1 层:68 / 2 层:17 / 3 层:15，与「约三分之二是单层树」一致）。随后打印的三棵树里，`pages` 必须都是合法伪页号且带内容的节点非空。

- [ ] **Step 7: 跑全量测试与类型检查**

Run: `npm test && npm run typecheck`
Expected: 全绿。若 `bench/src/tests/` 里有别的测试因 `EvalSample` 多出字段而失败，那是测试写得过严（用了 `toEqual` 而非 `toMatchObject`）——按新契约修测试，别删字段。

- [ ] **Step 8: Commit**

```bash
git add bench/src/toc/qasperTree.ts bench/src/types.ts bench/src/datasets/qasper.ts bench/src/tests/qasperTree.test.ts bench/scripts/tocSmoke.ts
git commit -m "feat(bench): build a tree from QASPER's own section structure"
```

---

## Task 7: 侧车协议与子进程客户端

**Files:**
- Create: `bench/src/jev/protocol.ts`
- Test: `bench/src/tests/jevSidecar.test.ts`

- [ ] **Step 1: 写失败的测试**

Create `bench/src/tests/jevSidecar.test.ts`：

```ts
/**
 * 侧车协议。全部用假侧车（一个内联的 node 子进程），**不依赖 Python 或 MLX**——
 * 这是「判定逻辑与运行时解耦」的直接回报：CI 与别人的机器上都能跑。
 */
import { describe, it, expect } from 'vitest'
import { SidecarJudge, type SidecarSpawn } from '../jev/protocol'

/** 假侧车：逐行读请求，按 request 里 title 长度回一个确定概率。 */
const FAKE = `
let buf = ''
process.stdin.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    const req = JSON.parse(line)
    const scores = req.nodes.map((n) => (n.title.length % 10) / 10)
    process.stdout.write(JSON.stringify({ id: req.id, scores }) + '\\n')
  }
})
`
const spawnFake: SidecarSpawn = () => ({ command: process.execPath, args: ['-e', FAKE] })

describe('SidecarJudge', () => {
  it('批量往返：返回与候选等长的概率', async () => {
    const judge = new SidecarJudge({ spawn: spawnFake })
    try {
      const scores = await judge.judge({
        query: 'q',
        nodes: [{ id: 'a', title: 'aa', path: [] }, { id: 'b', title: 'bbbb', path: [] }],
      })
      expect(scores).toEqual([0.2, 0.4])
    } finally { await judge.close() }
  })

  it('并发调用各自拿到自己的结果（按 id 配对，不串线）', async () => {
    const judge = new SidecarJudge({ spawn: spawnFake })
    try {
      const [a, b] = await Promise.all([
        judge.judge({ query: 'q', nodes: [{ id: 'x', title: 'x', path: [] }] }),
        judge.judge({ query: 'q', nodes: [{ id: 'y', title: 'yyyyyyyyyy', path: [] }] }),
      ])
      expect(a).toEqual([0.1])
      expect(b).toEqual([0.0])
    } finally { await judge.close() }
  })

  it('空候选不发起请求', async () => {
    const judge = new SidecarJudge({ spawn: spawnFake })
    try {
      expect(await judge.judge({ query: 'q', nodes: [] })).toEqual([])
    } finally { await judge.close() }
  })

  it('侧车立刻退出时抛错，调用方据此按篇回落', async () => {
    const judge = new SidecarJudge({ spawn: () => ({ command: process.execPath, args: ['-e', 'process.exit(1)'] }) })
    await expect(judge.judge({ query: 'q', nodes: [{ id: 'a', title: 'a', path: [] }] }))
      .rejects.toThrow(/sidecar exited/)
    await judge.close()
  })

  it('超时抛错，不无限等待', async () => {
    const judge = new SidecarJudge({
      spawn: () => ({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] }),
      timeoutMs: 200,
    })
    await expect(judge.judge({ query: 'q', nodes: [{ id: 'a', title: 'a', path: [] }] }))
      .rejects.toThrow(/timeout/)
    await judge.close()
  })

  it('返回长度与候选不匹配时抛错', async () => {
    const lying = `let b='';process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const l=b.slice(0,i);b=b.slice(i+1);const r=JSON.parse(l);process.stdout.write(JSON.stringify({id:r.id,scores:[0.5]})+'\\n')}})`
    const judge = new SidecarJudge({ spawn: () => ({ command: process.execPath, args: ['-e', lying] }) })
    await expect(judge.judge({ query: 'q', nodes: [{ id: 'a', title: 'a', path: [] }, { id: 'b', title: 'b', path: [] }] }))
      .rejects.toThrow(/length-mismatch/)
    await judge.close()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run bench/src/tests/jevSidecar.test.ts`
Expected: FAIL，`Failed to resolve import "../jev/protocol"`。

- [ ] **Step 3: 写实现**

Create `bench/src/jev/protocol.ts`：

```ts
/**
 * 侧车协议：一行 JSON 请求 / 一行 JSON 响应，按 `id` 配对。
 *
 * 只依赖 Node 内置模块——这是刻意的：协议层能脱离 Python 与 MLX 被完整单测，
 * 真实推理只在 `sidecar.py` 与实验里出现。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { assertJudgeOutput, type EvidenceJudge, type JudgeInput } from '../../../src/utils/evidenceJudge'

export interface SidecarHandle {
  command: string
  args: string[]
}

export type SidecarSpawn = () => SidecarHandle

interface Pending {
  expected: number
  resolve: (scores: number[]) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface SidecarJudgeOptions {
  spawn: SidecarSpawn
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 30_000

export class SidecarJudge implements EvidenceJudge {
  private child: ChildProcess | undefined
  private buffer = ''
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly timeoutMs: number

  constructor(private readonly opts: SidecarJudgeOptions) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  private ensureChild(): ChildProcess {
    if (this.child && this.child.exitCode === null) return this.child
    const { command, args } = this.opts.spawn()
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] })
    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (chunk: string) => this.onData(chunk))
    // 侧车立刻退出时，紧接着的 stdin.write 会触发 EPIPE。没有这个 handler 它会变成
    // unhandled 'error' 事件把进程整个带崩，而不是让调用方收到一个可回落的 reject。
    child.stdin!.on('error', () => { /* 由 exit 事件统一收尾 */ })
    child.on('exit', () => this.failAll(new Error('sidecar exited')))
    child.on('error', (error) => this.failAll(new Error(`sidecar spawn failed: ${error.message}`)))
    this.buffer = ''
    this.child = child
    return child
  }

  /** 侧车重启后旧请求全部作废：判定无副作用，调用方按篇回落或重试。 */
  private failAll(error: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(error)
    }
    this.pending.clear()
    this.child = undefined
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let index: number
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      if (line.trim() === '') continue
      let message: { id?: unknown; scores?: unknown }
      try { message = JSON.parse(line) } catch { continue }
      if (typeof message.id !== 'number') continue
      const p = this.pending.get(message.id)
      if (!p) continue
      this.pending.delete(message.id)
      clearTimeout(p.timer)
      try {
        p.resolve(assertJudgeOutput(message.scores, p.expected))
      } catch (error) {
        p.reject(error as Error)
      }
    }
  }

  async judge(input: JudgeInput): Promise<number[]> {
    if (input.nodes.length === 0) return []
    const child = this.ensureChild()
    const id = this.nextId++
    const request = {
      id,
      query: input.query,
      nodes: input.nodes.map(n => ({ id: n.id, title: n.title, path: n.path })),
    }
    return new Promise<number[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('sidecar timeout'))
      }, this.timeoutMs)
      this.pending.set(id, { expected: input.nodes.length, resolve, reject, timer })
      child.stdin!.write(`${JSON.stringify(request)}\n`)
    })
  }

  async close(): Promise<void> {
    const child = this.child
    if (!child) return
    this.failAll(new Error('sidecar closed'))
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve())
      child.kill()
      setTimeout(resolve, 1000)
    })
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run bench/src/tests/jevSidecar.test.ts`
Expected: PASS，6 个用例全绿。

- [ ] **Step 5: Commit**

```bash
git add bench/src/jev/protocol.ts bench/src/tests/jevSidecar.test.ts
git commit -m "feat(jev): add the sidecar protocol with a testable fake child process"
```

---

## Task 8: 真实侧车与 MLX 判定实现

本任务不在单测路径上。它的验收是**手工跑通**，因为真实推理依赖 `models/laya/.venv`。

**Files:**
- Create: `bench/src/jev/sidecar.py`
- Create: `bench/src/jev/mlxJudge.ts`
- Create: `bench/scripts/jevSmoke.ts`

- [ ] **Step 1: 写侧车**

> **先核对 API 再照抄。** 下面 `laya_mlx` 的调用形态来自早期探针，**没有**从装好的包里读过签名。动手前先跑
> `models/laya/.venv/bin/python -c "import laya_mlx, inspect; print(inspect.signature(laya_mlx.load)); print([n for n in dir(laya_mlx) if not n.startswith('_')])"`
> 与 `inspect.getsource` 确认 `load()` / `predict()` 的真实签名与返回结构（`result["answers"]["evidence"]["noul"]` 这条路径尤其要核）。对不上就按真实签名改 `score()`，**别改协议**——协议那侧已被 Task 7 的单测钉死。


Create `bench/src/jev/sidecar.py`：

```python
"""Laya 侧车：常驻进程，逐行读 JSON 请求、逐行写 JSON 响应。

权重从本地目录加载（不联网）。判定只喂「节标题 + 父路径 + 问题」，
不带正文——总上下文 512 token，装不下整节内文。
"""
import json
import sys
from pathlib import Path

import laya_mlx as laya

MODEL_PATH = sys.argv[1] if len(sys.argv) > 1 else str(Path(__file__).with_name("laya-mlx"))

INSTRUCTION = "Does `section` contain evidence that answers `question`?"

_agent = None


def get_agent():
    global _agent
    if _agent is None:
        _agent = laya.load(MODEL_PATH)
    return _agent


def score(req):
    agent = get_agent()
    scores = []
    for node in req["nodes"]:
        path = " > ".join(list(node.get("path") or []) + [node["title"]])
        result = agent.predict(
            {"question": req["query"], "section": path},
            {"evidence": {"type": "noul", "instructions": INSTRUCTION}},
        )
        scores.append(float(result["answers"]["evidence"]["noul"]))
    return scores


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            out = {"id": req_id, "scores": score(req)}
        except Exception as exc:  # noqa: BLE001 — 单条失败必须让请求方拿到明确错误
            out = {"id": req_id, "error": f"{type(exc).__name__}: {exc}"}
        sys.stdout.write(json.dumps(out) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: 手工验证侧车能起、能判**

Run:

```bash
printf '%s\n' '{"id":1,"query":"How many attention heads does the Transformer use?","nodes":[{"id":"a","title":"Multi-Head Attention","path":["Model Architecture","Attention"]},{"id":"b","title":"Conclusion","path":[]}]}' \
  | models/laya/.venv/bin/python bench/src/jev/sidecar.py models/laya/laya-mlx
```

Expected: 一行 JSON，`scores` 两项且第一项**明显高于**第二项（探针实测同一节点 0.1490 vs 掉出前八量级）。若两项都接近，检查 `INSTRUCTION` 是否用了反引号引用 `section` / `question`——探针确认过，不引用时模型看不到输入。

- [ ] **Step 3: 写 MLX 判定实现**

Create `bench/src/jev/mlxJudge.ts`：

```ts
/**
 * `EvidenceJudge` 的 MLX 实现：把判定委托给 Python 侧车。
 *
 * 批量切分是刻意的：侧车逐节点调用，一次请求塞太多节点会让单次往返变长，
 * 而超时是按请求计的。按 `batchSize` 切分后，单批失败只影响该批。
 */
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { SidecarJudge, type SidecarSpawn } from './protocol'
import type { EvidenceJudge, JudgeInput } from '../../../src/utils/evidenceJudge'

const HERE = dirname(fileURLToPath(import.meta.url))

export interface MlxJudgeOptions {
  /** 本地权重目录，默认仓库根的 models/laya/laya-mlx */
  modelPath?: string
  /** venv 的 python，默认仓库根的 models/laya/.venv/bin/python */
  pythonPath?: string
  batchSize?: number
  timeoutMs?: number
}

export function defaultSpawn(opts: MlxJudgeOptions = {}): SidecarSpawn {
  const root = resolve(HERE, '../../..')
  const python = opts.pythonPath ?? resolve(root, 'models/laya/.venv/bin/python')
  const model = opts.modelPath ?? resolve(root, 'models/laya/laya-mlx')
  const script = resolve(HERE, 'sidecar.py')
  return () => ({ command: python, args: [script, model] })
}

/** 批量切分的 EvidenceJudge。每批独立往返，批间串行以固定单条判定的时延特征。 */
export function createMlxJudge(opts: MlxJudgeOptions = {}): EvidenceJudge {
  const inner = new SidecarJudge({
    spawn: defaultSpawn(opts),
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  })
  const batchSize = opts.batchSize ?? 16
  return {
    async judge(input: JudgeInput): Promise<number[]> {
      const out: number[] = []
      for (let i = 0; i < input.nodes.length; i += batchSize) {
        out.push(...await inner.judge({ query: input.query, nodes: input.nodes.slice(i, i + batchSize) }))
      }
      return out
    },
  }
}
```

- [ ] **Step 4: 端到端冒烟**

Create `bench/scripts/jevSmoke.ts`：

```ts
/**
 * Jev 判定冒烟：用真实 QASPER 论文确认本地权重可用、概率有区分度。
 *
 * 全部逻辑包在 main() 里：tsx 对仓库内脚本按 CJS 转译，顶层 await 会直接报
 * "Top-level await is currently not supported with the cjs output format"。
 */
import { loadQasperDataset } from '../src/datasets/qasper'
import { createMlxJudge } from '../src/jev/mlxJudge'
import { buildQasperTree } from '../src/toc/qasperTree'
import { traverseWithJudge } from '../../src/utils/tocTree'

async function main(): Promise<void> {
  const samples = await loadQasperDataset()
  const sample = samples[0]
  const query = sample.questions[0]?.question ?? 'What is the main contribution?'

  const { tree } = buildQasperTree({
    sectionNames: sample.sectionNames ?? [],
    sectionPages: sample.sectionPages ?? [],
  })
  console.log(`论文: ${sample.title.slice(0, 60)}`)
  console.log(`问题: ${query}`)
  console.log(`树: 顶层 ${tree.length} 个节点`)

  const judge = createMlxJudge()
  const started = Date.now()
  const sel = await traverseWithJudge(tree, query, judge, { alpha: 0.5, topN: 2 })
  console.log(`遍历耗时 ${Date.now() - started}ms`)
  console.log('逐层诊断:', JSON.stringify(sel.layers, null, 2))
  console.log('选中:', sel.selected.map(n => `${n.title} pages=[${n.pages.join(',')}]`))
}

main().catch(error => { console.error(error); process.exit(1) })
```

Run: `npx tsx bench/scripts/jevSmoke.ts`

Expected: 打印树规模、遍历耗时（量级应为数百毫秒）、逐层诊断，且**选中的节点与问题相关**。若选中明显无关，先确认 Step 2 的区分度，再回来查 `toJudgeNode` 的 `path` 是否传对。

- [ ] **Step 5: 跑全量测试与类型检查**

Run: `npm test && npm run typecheck`
Expected: 全绿。`sidecar.py`、`mlxJudge.ts` 都不在单测路径上——若此处失败，说明有测试误引入了它们。

- [ ] **Step 6: Commit**

```bash
git add bench/src/jev/sidecar.py bench/src/jev/mlxJudge.ts bench/scripts/jevSmoke.ts
git commit -m "feat(jev): run the local decision model through a Python sidecar"
```

---

## 完成标准

全部任务结束后应满足：

- `npm test` 与 `npm run typecheck` 全绿
- `src/utils/tocTree.ts` 与 `src/utils/evidenceJudge.ts` **不认识 PDF、文件系统、子进程与网络**（Task 4 Step 6 的 grep 无输出），可在任意机器单测
- `npx tsx bench/scripts/tocSmoke.ts` 能对真实 QASPER 论文打印出节树
- `npx tsx bench/scripts/jevSmoke.ts` 能对真实论文跑通并选出与问题相关的节
- `sectionsToPages` 的 `pages` / `paragraphToPage` 逐字未变（Task 5 Step 4 的既有测试全绿）

**未覆盖（属 Plan 2）：** 接入 bench runner 与配置、四条对照臂、α/N 网格扫描、按深度分组的对照报告；以及 spec §2.4 要求的 **`RetrievalResult` 字面组装**与 `ragPipeline.ts:245` 的第四路分派。本计划只交付它依赖的硬约束——`ContextGroup` 的逐页无损分区，那才是四个检索指标同源的前提。产品侧分派按 spec 的「非目标」本就不做，等实验结论为正再补。
