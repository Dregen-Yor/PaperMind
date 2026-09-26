# TOC 树 + Jev 判定 · 核心骨架 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现「PDF 目录 → 树 → 本地决策模型逐层判定 → 证据页区间」这条链路的运行时无关骨架，使它在不接 bench、不依赖 Python 的情况下可被完整单测。

**Architecture:** `src/utils/tocTree.ts` 提供建树与遍历两个纯函数（不 import 网络/LLM，只 import pdfjs 用于目录提取）；`src/utils/evidenceJudge.ts` 只定义判定器接口与输出校验；MLX 实现放在 bench 侧，是 `EvidenceJudge` 的一个实现，本计划只交付它的**进程协议**与一个可测的假侧车。

**Tech Stack:** TypeScript strict、Vitest、pdfjs-dist（legacy 构建）、Python 3.13 + laya-mlx（仅真实判定实现，不在单测路径上）。

**分支纪律：** 全部改动只提交到 `feat/jev`，不合入 main。

**上游 spec:** `docs/superpowers/specs/2026-09-26-toc-jev-evidence-routing-design.md`

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/utils/evidenceJudge.ts` | 判定器接口 `EvidenceJudge` + 输出校验 `assertJudgeOutput`。无运行时依赖 |
| `src/utils/tocTree.ts` | 目录提取（pdfjs）、建树与页区间派生、逐层遍历、页区间 → `ContextGroup` |
| `src/tests/evidenceJudge.test.ts` | 接口校验的边界 |
| `src/tests/tocTree.test.ts` | 建树与遍历的全部纯函数行为 |
| `bench/src/jev/protocol.ts` | 侧车 JSON-lines 协议编解码 + 子进程客户端（仅用 Node 内置模块） |
| `bench/src/jev/sidecar.py` | 常驻 Python 进程，持有 `laya_mlx.Agent` |
| `bench/src/jev/mlxJudge.ts` | `EvidenceJudge` 的 MLX 实现（协议客户端 + 批量切分） |
| `bench/src/tests/jevSidecar.test.ts` | 协议往返、崩溃重启、超时——全部用假侧车 |

---

## Task 0: 前置实测——QASPER 目录覆盖率（决策门）

这一步不写产品代码。它的结论决定 Plan 2 是否值得写，因此排在所有实现之前。

**Files:**
- Create: `bench/scripts/outlineCoverage.ts`

- [ ] **Step 1: 确认 QASPER PDF 的取得方式**

Run: `sed -n '1,60p' bench/datasets/qasper/fetch.ts`

把 PDF 的下载 URL 构造方式记下来，后面按同样口径取。注意 `bench/cache/` 与 `bench/datasets/qasper/qasper.jsonl` 已在 `.gitignore` 中，缓存不要入库。

- [ ] **Step 2: 写覆盖率脚本**

Create `bench/scripts/outlineCoverage.ts`：

```ts
/**
 * QASPER 目录覆盖率实测：这是 Plan 2（bench 接入）的决策门。
 * 覆盖率过低则样本量撑不起对照实验，Plan 2 不应开工。
 * 本脚本只读不写，不参与单测。
 */
import { readFileSync } from 'node:fs'
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'

export interface CoverageRow {
  paperId: string
  pages: number
  entries: number
  resolved: number
  depth: number
}

/** 只在给定路径可用时调用；PDF 由调用方预先取到本地。 */
export async function measureOutline(path: string, paperId: string): Promise<CoverageRow> {
  const data = new Uint8Array(readFileSync(path))
  const pdf = await pdfjsLib.getDocument({ data }).promise
  const outline = await pdf.getOutline()
  if (!outline) return { paperId, pages: pdf.numPages, entries: 0, resolved: 0, depth: 0 }

  let entries = 0
  let resolved = 0
  let depth = 0
  const walk = async (items: unknown[], d: number): Promise<void> => {
    depth = Math.max(depth, d)
    for (const it of items as Array<{ title?: string; dest?: unknown; items?: unknown[] }>) {
      entries += 1
      try {
        const dest = typeof it.dest === 'string' ? await pdf.getDestination(it.dest) : it.dest
        if (dest) {
          await pdf.getPageIndex((dest as unknown[])[0] as never)
          resolved += 1
        }
      } catch { /* 解析不出计入未解析，不抛 */ }
      if (it.items?.length) await walk(it.items, d + 1)
    }
  }
  await walk(outline, 1)
  return { paperId, pages: pdf.numPages, entries, resolved, depth }
}
```

- [ ] **Step 3: 补上入口并跑全量**

追加到 `bench/scripts/outlineCoverage.ts` 末尾：

```ts
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** PDF 目录由 Step 1 查明的 fetch 逻辑落盘位置决定，用参数传入以免写死。 */
const PDF_DIR = resolve(process.argv[2] ?? 'bench/cache/qasper/pdfs')
const OUT = resolve('bench/results/outline-coverage.json')

async function main(): Promise<void> {
  const files = readdirSync(PDF_DIR).filter(f => f.toLowerCase().endsWith('.pdf'))
  const rows: CoverageRow[] = []
  for (const file of files) {
    try {
      rows.push(await measureOutline(join(PDF_DIR, file), file.replace(/\.pdf$/i, '')))
    } catch (error) {
      console.error(`跳过 ${file}: ${(error as Error).message}`)
    }
  }
  const withOutline = rows.filter(r => r.entries > 0)
  const fullyResolved = withOutline.filter(r => r.resolved === r.entries)
  const avgDepth = withOutline.reduce((sum, r) => sum + r.depth, 0) / (withOutline.length || 1)
  console.log(`PDF 总数: ${rows.length}`)
  console.log(`有目录: ${withOutline.length}/${rows.length} (${(withOutline.length / (rows.length || 1) * 100).toFixed(1)}%)`)
  console.log(`有目录且页码全解析: ${fullyResolved.length}/${withOutline.length}`)
  console.log(`平均深度: ${avgDepth.toFixed(2)}`)
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(rows, null, 2))
}

main().catch(error => { console.error(error); process.exit(1) })
```

Run: `npx tsx bench/scripts/outlineCoverage.ts bench/cache/qasper/pdfs`

Expected: 打印形如

```
PDF 总数: 179
有目录: 118/179 (65.9%)
有目录且页码全解析: 110/118
平均深度: 2.41
```

`bench/results/` 已被 `.gitignore` 忽略，产物不入库。

- [ ] **Step 4: 判定并记录结论**

把三个数字写进 spec 的「风险与未决」表对应行，替换「QASPER 目录覆盖率未知」：

- 有目录论文数 / 总数
- 有目录论文中，条目页码**全部**解析成功的比例（部分解析失败的论文会带 `unresolvedEntries`）
- 目录平均深度

**若覆盖率低于约 40%，停下来向用户报告，不要继续 Task 1。** 此时 Plan 2 的对照实验样本量不足，需要先讨论是否换数据集或扩大样本。

- [ ] **Step 5: Commit**

```bash
git add bench/scripts/outlineCoverage.ts docs/superpowers/specs/2026-09-26-toc-jev-evidence-routing-design.md
git commit -m "chore(bench): measure QASPER outline coverage as the experiment gate"
```

---

## Task 1: 判定器接口与输出校验

**Files:**
- Create: `src/utils/evidenceJudge.ts`
- Test: `src/tests/evidenceJudge.test.ts`

- [ ] **Step 1: 写失败的测试**

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

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/tests/evidenceJudge.test.ts`

Expected: FAIL，报错形如 `Failed to resolve import "../utils/evidenceJudge"`。

- [ ] **Step 3: 写最小实现**

Create `src/utils/evidenceJudge.ts`：

```ts
/**
 * 证据判定器：给一批候选节点打分，回答「这一节对当前问题是不是证据」。
 *
 * 刻意不依赖任何运行时——实现方可以是本地决策模型（MLX / ONNX）、
 * BM25 词法对照，或测试里的假实现。判定逻辑因此可以在不装模型、
 * 不装 Python 的机器上被完整单测。
 */

/** 送去判定的候选节点。只带标题与父路径，不带正文——见 spec §2.2。 */
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

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/tests/evidenceJudge.test.ts`
Expected: PASS，8 个用例全绿。

- [ ] **Step 5: Commit**

```bash
git add src/utils/evidenceJudge.ts src/tests/evidenceJudge.test.ts
git commit -m "feat(jev): add the runtime-agnostic EvidenceJudge interface"
```

---

## Task 2: 建树——基础区间派生

**Files:**
- Create: `src/utils/tocTree.ts`
- Test: `src/tests/tocTree.test.ts`

- [ ] **Step 1: 写失败的测试**

Create `src/tests/tocTree.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { buildTocTree, type RawOutlineEntry } from '../utils/tocTree'

/** 造一个目录条目 */
const e = (title: string, page: number | null, children: RawOutlineEntry[] = []): RawOutlineEntry =>
  ({ title, page, children })

describe('buildTocTree —— 基础区间派生', () => {
  it('平坦目录：每个节点的区间止于下一个兄弟的起始页', () => {
    const tree = buildTocTree([e('A', 0), e('B', 3), e('C', 7)], 10)
    expect(tree.map(n => [n.title, n.startPage, n.endPage])).toEqual([
      ['A', 0, 2],
      ['B', 3, 6],
      ['C', 7, 9],   // 末节点延伸到文末
    ])
  })

  it('父节点带子节点时，子区间正确嵌套', () => {
    const tree = buildTocTree([
      e('A', 0, [e('A1', 1, [e('A1a', 2)]), e('A2', 5)]),
      e('B', 8),
    ], 10)
    const a = tree[0]
    expect([a.startPage, a.endPage]).toEqual([0, 7])
    expect(a.children.map(n => [n.title, n.startPage, n.endPage])).toEqual([
      ['A1', 1, 4],
      ['A2', 5, 7],
    ])
    expect(a.children[0].children.map(n => [n.title, n.startPage, n.endPage])).toEqual([
      ['A1a', 2, 4],
    ])
  })

  it('depth 从根的子节点起算为 0，path 是从根到父节点的标题', () => {
    const tree = buildTocTree([e('A', 0, [e('A1', 1, [e('A1a', 2)])])], 5)
    expect(tree[0].depth).toBe(0)
    expect(tree[0].path).toEqual([])
    expect(tree[0].children[0].depth).toBe(1)
    expect(tree[0].children[0].path).toEqual(['A'])
    expect(tree[0].children[0].children[0].depth).toBe(2)
    expect(tree[0].children[0].children[0].path).toEqual(['A', 'A1'])
  })

  it('nodeId 稳定：同一输入产出同一批 id', () => {
    const outline = [e('A', 0, [e('A1', 1)]), e('B', 2)]
    expect(buildTocTree(outline, 5).map(n => n.id))
      .toEqual(buildTocTree(outline, 5).map(n => n.id))
  })

  it('空目录返回空数组，而不是抛错', () => {
    expect(buildTocTree([], 5)).toEqual([])
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

/** 目录条目：由 pdfjs 提取后的纯数据形态，不含任何 pdfjs 类型。 */
export interface RawOutlineEntry {
  title: string
  /** 0-based 起始页；解析不出为 null */
  page: number | null
  children: RawOutlineEntry[]
}

export interface TocNode {
  id: string
  title: string
  /** 从根到父节点的标题路径；根层为空数组 */
  path: string[]
  /** 根的子节点为 0 */
  depth: number
  /** 0-based inclusive */
  startPage: number
  /**
   * 0-based inclusive。
   * `endPage === startPage - 1` 表示**空区间**（该节点与下一个兄弟同页且自身无内容），
   * 是合法取值，下游不得据此切片。`endPage < startPage - 1` 视为缺陷。
   */
  endPage: number
  children: TocNode[]
}

/** 空区间的规范表示 */
const isEmptyRange = (n: { startPage: number; endPage: number }): boolean => n.endPage === n.startPage - 1

/**
 * 把目录条目转成带页区间的树。
 *
 * 目录只给起始页，区间必须派生：节点的止界是「下一个非自己后代的起始页」。
 * 父节点的区间取 max(自身起始页, 所有子节点的 endPage)——不能用子节点并集，
 * 否则父节点在第一个子节点之前那段引导正文会丢。
 */
export function buildTocTree(outline: RawOutlineEntry[], pageCount: number): TocNode[] {
  if (outline.length === 0 || pageCount <= 0) return []
  let counter = 0
  const nextId = (): string => `T${String(counter++).padStart(3, '0')}`

  const assign = (
    entries: RawOutlineEntry[],
    path: string[],
    depth: number,
    /** 本层最后一个节点的止界（0-based inclusive） */
    boundaryEnd: number,
  ): TocNode[] => {
    const nodes: TocNode[] = []
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      const startPage = Math.min(Math.max(entry.page ?? 0, 0), pageCount - 1)
      // 下一个兄弟的起始页即本节点的止界；无下一个兄弟则用传入的本层止界
      const nextStart = i + 1 < entries.length
        ? Math.min(Math.max(entries[i + 1].page ?? 0, 0), pageCount - 1)
        : boundaryEnd + 1

      const node: TocNode = {
        id: nextId(),
        title: entry.title,
        path,
        depth,
        startPage,
        endPage: nextStart - 1,
        children: [],
      }
      if (entry.children.length > 0) {
        node.children = assign(entry.children, [...path, entry.title], depth + 1, node.endPage)
        const childMax = Math.max(...node.children.map(c => c.endPage))
        node.endPage = Math.max(node.startPage, childMax)
      }
      nodes.push(node)
    }
    return nodes
  }

  return assign(outline, [], 0, pageCount - 1)
}

export { isEmptyRange }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/tests/tocTree.test.ts`
Expected: PASS，5 个用例全绿。

- [ ] **Step 5: Commit**

```bash
git add src/utils/tocTree.ts src/tests/tocTree.test.ts
git commit -m "feat(jev): derive page ranges when building a tree from a PDF outline"
```

---

## Task 3: 同页兄弟的空区间

目录里同页多兄弟是常态（实测：attention 论文的 Introduction / Background / Model Architecture 都是 p2）。这条规则不写死就会产出负区间，喂给 `pages.slice` 会**静默返回错页**。

**Files:**
- Modify: `src/utils/tocTree.ts`
- Test: `src/tests/tocTree.test.ts`

- [ ] **Step 1: 写失败的测试**

追加到 `src/tests/tocTree.test.ts`：

```ts
describe('buildTocTree —— 同页兄弟', () => {
  it('同一页上的后继兄弟把前一节点压成空区间，且绝不产出负区间', () => {
    const tree = buildTocTree([e('A', 1), e('B', 1), e('C', 1), e('D', 4)], 8)
    expect(tree.map(n => [n.title, n.startPage, n.endPage])).toEqual([
      ['A', 1, 0],   // 空区间：endPage === startPage - 1
      ['B', 1, 0],
      ['C', 1, 3],
      ['D', 4, 7],
    ])
    for (const n of tree) expect(n.endPage).toBeGreaterThanOrEqual(n.startPage - 1)
  })

  it('父节点区间从自己的起始页开始，包含第一个子节点之前的引导正文', () => {
    const tree = buildTocTree([e('A', 2, [e('A1', 4)]), e('B', 6)], 8)
    expect([tree[0].startPage, tree[0].endPage]).toEqual([2, 5])
    expect(tree[0].children[0].startPage).toBe(4)
  })

  it('父节点自身恒非空：子节点全被同页压成空区间时，父节点仍覆盖该页', () => {
    const tree = buildTocTree([e('A', 2, [e('A1', 2), e('A2', 2)]), e('B', 2)], 5)
    expect([tree[0].startPage, tree[0].endPage]).toEqual([2, 2])
    expect(tree[0].children.every(n => n.endPage === n.startPage - 1)).toBe(true)
  })

  it('边界：startPage - 1 恰为负值时也不越界（首页同页兄弟）', () => {
    const tree = buildTocTree([e('A', 0), e('B', 0)], 4)
    expect(tree[0].endPage).toBe(-1)   // 空区间在首页的规范表示
    expect(tree[1].endPage).toBe(3)
  })
})
```

- [ ] **Step 2: 跑测试确认通过（不该失败）**

Run: `npx vitest run src/tests/tocTree.test.ts -t 同页`

Expected: **PASS**。Task 2 的实现已经覆盖这条规则——本任务的作用是用测试把它钉死，防止将来有人「顺手修正」负区间。若这里 FAIL，说明 Task 2 的 `nextStart - 1` 被改动了，回到 Task 2 修正。

- [ ] **Step 3: 在实现里补一条断言注释**

Modify `src/utils/tocTree.ts`，在 `assign` 函数内 `node.endPage = nextStart - 1` 那行上方补注释：

```ts
        // 同页兄弟的规范表示就是 endPage === startPage - 1（空区间）。
        // 首页上的同页兄弟会得到 -1——这是刻意的，下游按 isEmptyRange 过滤，
        // 绝不「修正」为 0：那会让该节点凭空占用一整页，且与下一个兄弟重叠。
```

- [ ] **Step 4: 跑全量测试**

Run: `npx vitest run src/tests/tocTree.test.ts`
Expected: PASS，9 个用例全绿。

- [ ] **Step 5: Commit**

```bash
git add src/utils/tocTree.ts src/tests/tocTree.test.ts
git commit -m "test(jev): pin same-page siblings to an empty page range"
```

---

## Task 4: 目录合法性校验

非法目录必须**整棵作废**，不修补——沿用 `validateSemanticTree` 的既有口径。

**Files:**
- Modify: `src/utils/tocTree.ts`
- Test: `src/tests/tocTree.test.ts`

- [ ] **Step 1: 写失败的测试**

追加到 `src/tests/tocTree.test.ts`：

```ts
import { validateOutline, MAX_TOC_DEPTH } from '../utils/tocTree'

describe('validateOutline', () => {
  it('接受合法目录', () => {
    expect(validateOutline([e('A', 0, [e('A1', 1)])])).toEqual({ ok: true })
  })

  it('拒绝空标题', () => {
    expect(validateOutline([e('   ', 0)])).toEqual({ ok: false, reason: 'empty-title' })
    expect(validateOutline([e('A', 0, [e('', 1)])])).toEqual({ ok: false, reason: 'empty-title' })
  })

  it('拒绝超过深度上限的目录', () => {
    let nested: RawOutlineEntry = e('L0', 0)
    for (let i = 1; i <= MAX_TOC_DEPTH; i++) nested = e(`L${i}`, i, [nested])
    expect(validateOutline([nested])).toEqual({ ok: false, reason: 'too-deep' })
  })

  it('拒绝在同一路径上重复出现的标题（自嵌套）', () => {
    expect(validateOutline([e('A', 0, [e('A', 1, [e('A', 2)])])]))
      .toEqual({ ok: false, reason: 'cyclic-title' })
  })

  it('兄弟同页不算非法：这是常态，由空区间表达', () => {
    expect(validateOutline([e('A', 1), e('B', 1)])).toEqual({ ok: true })
  })

  it('页码为 null 不算非法：由提取阶段单独计数', () => {
    expect(validateOutline([e('A', null)])).toEqual({ ok: true })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/tests/tocTree.test.ts -t validateOutline`

Expected: FAIL，`validateOutline is not a function`。

- [ ] **Step 3: 写实现**

在 `src/utils/tocTree.ts` 里补：

```ts
/** 目录深度上限。超过即判定为「不是论文目录」，整棵作废。 */
export const MAX_TOC_DEPTH = 6

export type OutlineValidation =
  | { ok: true }
  | { ok: false; reason: 'empty-title' | 'too-deep' | 'cyclic-title' }

/**
 * 目录合法性校验。**整棵作废，不修补**——沿用 `validateSemanticTree` 的口径：
 * 猜一个修复方案比直接回落更容易产出看不出错的坏结果。
 *
 * 刻意不把「兄弟同页」「页码缺失」判为非法：前者是常态（由空区间表达），
 * 后者由提取阶段计数，两者都不该让整棵树作废。
 */
export function validateOutline(outline: RawOutlineEntry[]): OutlineValidation {
  const walk = (entries: RawOutlineEntry[], depth: number, ancestors: string[]): OutlineValidation => {
    if (depth > MAX_TOC_DEPTH) return { ok: false, reason: 'too-deep' }
    for (const entry of entries) {
      if (entry.title.trim() === '') return { ok: false, reason: 'empty-title' }
      // 同一条祖先链上出现重名标题，说明目录自嵌套（pdfjs 在畸形目录上会这样）
      if (ancestors.includes(entry.title)) return { ok: false, reason: 'cyclic-title' }
      const nested = walk(entry.children, depth + 1, [...ancestors, entry.title])
      if (!nested.ok) return nested
    }
    return { ok: true }
  }
  return walk(outline, 1, [])
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/tests/tocTree.test.ts`
Expected: PASS，15 个用例全绿。

- [ ] **Step 5: Commit**

```bash
git add src/utils/tocTree.ts src/tests/tocTree.test.ts
git commit -m "feat(jev): validate the outline and discard the whole tree when invalid"
```

---

## Task 5: 逐层遍历——相对阈值

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
  async judge({ nodes, query }) {
    void query
    return nodes.map(n => table[n.title] ?? 0)
  },
})

const TREE = () => buildTocTree([e('A', 0), e('B', 5), e('C', 9)], 12)

describe('traverseWithJudge —— 相对阈值', () => {
  it('alpha=0 时阈值退化为 0，全部候选存活（纯 top-N 模式）', async () => {
    const sel = await traverseWithJudge(TREE(), 'q', fixedJudge({ A: 0.9, B: 0.1, C: 0 }), { alpha: 0, topN: 10 })
    expect(sel.selected.map(n => n.title)).toEqual(['A', 'B', 'C'])
  })

  it('alpha=1 时阈值等于层内最高分，只有并列最高者存活', async () => {
    const sel = await traverseWithJudge(TREE(), 'q', fixedJudge({ A: 0.9, B: 0.1, C: 0 }), { alpha: 1, topN: 10 })
    expect(sel.selected.map(n => n.title)).toEqual(['A'])
  })

  it('阈值取层内相对值：整体分数偏低时高分区仍能存活', async () => {
    // 实测 Jev 的概率上限只有约 0.393，任何固定绝对阈值（如 0.5）都会把整层滤光
    const sel = await traverseWithJudge(TREE(), 'q', fixedJudge({ A: 0.39, B: 0.3, C: 0.01 }), { alpha: 0.9, topN: 10 })
    expect(sel.selected.map(n => n.title)).toEqual(['A'])
  })

  it('最高分节点在任意 alpha∈[0,1] 下都存活（阈值滤光在算术上不可达）', async () => {
    for (const alpha of [0, 0.25, 0.5, 0.75, 1]) {
      const sel = await traverseWithJudge(TREE(), 'q', fixedJudge({ A: 0.9, B: 0.1, C: 0 }), { alpha, topN: 10 })
      expect(sel.selected.map(n => n.title)).toContain('A')
    }
  })

  it('全部候选同分时，alpha=1 让它们全部存活', async () => {
    const sel = await traverseWithJudge(TREE(), 'q', fixedJudge({ A: 0.4, B: 0.4, C: 0.4 }), { alpha: 1, topN: 10 })
    expect(sel.selected.map(n => n.title)).toEqual(['A', 'B', 'C'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/tests/tocTree.test.ts -t 相对阈值`
Expected: FAIL，`traverseWithJudge is not a function`。

- [ ] **Step 3: 写实现**

在 `src/utils/tocTree.ts` 里补：

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
  /** 收为证据的节点，按 startPage 升序 */
  selected: TocNode[]
  layers: LayerDiagnostic[]
  /** 因空区间被排除出 selected 的节点数 */
  emptyRangeSkipped: number
  /** 存活节点全部是空区间、于是回落到文档首个非空节点时置位 */
  emptySelectionFallback: boolean
}

const toJudgeNode = (n: TocNode): JudgeNode => ({ id: n.id, title: n.title, path: n.path })

/** 稳定排序取前 topN：同分保持原有文档顺序。 */
function topNSurvivors(
  nodes: TocNode[], scores: number[], threshold: number, topN: number,
): TocNode[] {
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
 * 逐层判定并收集证据。
 *
 * **阈值是层内相对的**（θ = α × 本层最高分），不是绝对值：实测本地决策模型的
 * 概率整体压在 0.03–0.39，任何固定绝对阈值都会把整层滤光。相对阈值同时对
 * 未校准的概率免疫——这正好对症该 checkpoint 的温度被 clamp 那条警告。
 *
 * 注意本步**尚未**处理空区间（同页兄弟）与空选择兜底：那两条由 Task 6 补上，
 * 两个诊断字段在此先返回零值占位。
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

  const selected = (await descend(tree, 0)).sort((a, b) => a.startPage - b.startPage)
  return { selected, layers, emptyRangeSkipped: 0, emptySelectionFallback: false }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/tests/tocTree.test.ts`
Expected: PASS，20 个用例全绿。

- [ ] **Step 5: Commit**

```bash
git add src/utils/tocTree.ts src/tests/tocTree.test.ts
git commit -m "feat(jev): traverse the TOC tree with a layer-relative threshold"
```

---

## Task 6: 逐层遍历——top-N 与父节点规则

**Files:**
- Modify: `src/utils/tocTree.ts`
- Modify: `src/tests/tocTree.test.ts`

- [ ] **Step 1: 写失败的测试**

追加到 `src/tests/tocTree.test.ts`：

```ts
describe('traverseWithJudge —— top-N 与父节点规则', () => {
  const NESTED = () => buildTocTree([
    e('A', 0, [e('A1', 0), e('A2', 3)]),
    e('B', 6, [e('B1', 6)]),
  ], 10)

  it('每层存活数超过 topN 时按分数取前 N（同分保持文档顺序）', async () => {
    const tree = buildTocTree([e('A', 0), e('B', 2), e('C', 4)], 8)
    const sel = await traverseWithJudge(tree, 'q', fixedJudge({ A: 0.9, B: 0.5, C: 0.5 }), { alpha: 0, topN: 2 })
    expect(sel.selected.map(n => n.title)).toEqual(['A', 'B'])
  })

  it('下探的父节点本身不作为证据', async () => {
    const sel = await traverseWithJudge(NESTED(), 'q', fixedJudge({ A: 0.9, A1: 0.8, A2: 0.1, B: 0.2 }), { alpha: 0.5, topN: 5 })
    const titles = sel.selected.map(n => n.title)
    expect(titles).toContain('A1')
    expect(titles).not.toContain('A')   // A 下探了，不该作为证据
  })

  it('子节点全被同页压成空区间时，父节点兜底成为证据', async () => {
    // 注意：触发条件不是「阈值滤光」——α ≤ 1 时层内 argmax 恒存活，滤光是不可达的。
    // 唯一能让下探颗粒无收的是空区间。这里 A 的两个子节点都与 B 同页而被压空。
    const tree = buildTocTree([e('A', 2, [e('A1', 2), e('A2', 2)]), e('B', 2)], 5)
    const sel = await traverseWithJudge(tree, 'q', fixedJudge({ A: 0.9, A1: 0.8, A2: 0.7, B: 0.1 }), { alpha: 0.5, topN: 5 })
    expect(sel.selected.map(n => n.title)).toEqual(['A'])
    expect(sel.emptyRangeSkipped).toBe(2)
  })

  it('存活节点全是空区间时，回落到文档首个非空节点并置位', async () => {
    const tree = buildTocTree([e('A', 1), e('B', 1)], 4)   // A 是空区间，B 覆盖 1–3
    const sel = await traverseWithJudge(tree, 'q', fixedJudge({ A: 0.9, B: 0.1 }), { alpha: 1, topN: 5 })
    expect(sel.selected.map(n => n.title)).toEqual(['B'])
    expect(sel.emptySelectionFallback).toBe(true)
    expect(sel.emptyRangeSkipped).toBe(1)
  })

  it('有非空节点存活时不触发兜底', async () => {
    const sel = await traverseWithJudge(NESTED(), 'q', fixedJudge({ A: 0.9, A1: 0.8, A2: 0.1, B: 0.2 }), { alpha: 0.5, topN: 5 })
    expect(sel.emptySelectionFallback).toBe(false)
  })

  it('selected 按 startPage 升序，与文档顺序一致', async () => {
    const sel = await traverseWithJudge(NESTED(), 'q', fixedJudge({ A: 0.9, A1: 0.9, A2: 0.9, B: 0.9, B1: 0.9 }), { alpha: 0, topN: 9 })
    const pages = sel.selected.map(n => n.startPage)
    expect(pages).toEqual([...pages].sort((a, b) => a - b))
  })

  it('空区间的节点被排除出 selected，并计数', async () => {
    const tree = buildTocTree([e('A', 1), e('B', 1)], 4)
    const sel = await traverseWithJudge(tree, 'q', fixedJudge({ A: 0.9, B: 0.9 }), { alpha: 0, topN: 9 })
    expect(sel.selected.map(n => n.title)).toEqual(['B'])   // A 是空区间
    expect(sel.emptyRangeSkipped).toBe(1)
  })

  it('layers 记录每一层的候选数、最高分、阈值与下探数', async () => {
    const sel = await traverseWithJudge(NESTED(), 'q', fixedJudge({ A: 0.9, A1: 0.4, A2: 0.1, B: 0.2 }), { alpha: 0.5, topN: 5 })
    expect(sel.layers[0]).toMatchObject({ depth: 0, candidates: 2, maxScore: 0.9, threshold: 0.45 })
    expect(sel.layers[0].descended).toBe(1)
    expect(sel.layers[1].depth).toBe(1)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/tests/tocTree.test.ts -t "top-N"`

Expected: **3 个失败、5 个通过**。通过的是 top-N 截断、父节点不下探、selected 升序、layers 记录、以及「有非空节点存活时不触发兜底」（第 5 个恰好用 Task 5 的行为就成立）。失败的是三条空区间用例，报错形如：

```
AssertionError: expected [ 'A1', 'A2' ] to deeply equal [ 'A' ]
```

即 Task 5 把空区间的子节点原样收了进来。

- [ ] **Step 3: 写实现**

把 Task 5 放在 `traverseWithJudge` 上方的新增 `firstNonEmptyNode` 与改造后的 `descend` 替换进去：

```ts
/**
 * 按文档顺序（先序）找第一个非空区间节点。段末顶层节点恒非空，
 * 因此只要树非空就必有结果。
 */
function firstNonEmptyNode(nodes: TocNode[]): TocNode | undefined {
  for (const node of nodes) {
    if (!isEmptyRange(node)) return node
    const found = firstNonEmptyNode(node.children)
    if (found) return found
  }
  return undefined
}
```

然后替换 `traverseWithJudge` 的函数体（签名与 `layers` 的计算不变）：

```ts
  const layers: LayerDiagnostic[] = []
  let emptyRangeSkipped = 0

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
        if (isEmptyRange(node)) emptyRangeSkipped += 1
        else collected.push(node)
        continue
      }
      const fromChildren = await descend(node.children, depth + 1)
      // 父节点自身恒非空（endPage = max(startPage, 子节点最大 endPage) ≥ startPage），
      // 所以下探颗粒无收时一定能拿它兜底，否则这条分支的证据会整体消失。
      collected.push(...(fromChildren.length > 0 ? fromChildren : [node]))
    }
    return collected
  }

  let selected = (await descend(tree, 0)).sort((a, b) => a.startPage - b.startPage)
  let emptySelectionFallback = false
  if (selected.length === 0) {
    const first = firstNonEmptyNode(tree)
    if (first) {
      selected = [first]
      emptySelectionFallback = true
    }
  }

  return { selected, layers, emptyRangeSkipped, emptySelectionFallback }
```

并在 `traverseWithJudge` 的文档注释末尾补上这段推论：

```ts
 * 空区间过滤必须发生在**递归内部**，不能放到最后统一过滤：存活节点恰好都是
 * 同页兄弟（`endPage === startPage − 1`）时不携带任何页内容，若在递归外过滤，
 * 下探会「看起来有收获」而父节点兜底永不触发，最终产出空上下文。
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/tests/tocTree.test.ts`
Expected: PASS，28 个用例全绿。

- [ ] **Step 5: 检查覆盖**

Run: `npx vitest run src/tests/tocTree.test.ts --coverage.enabled --coverage.include='src/utils/tocTree.ts'`
Expected: PASS，`tocTree.ts` 行覆盖 ≥ 90%。

- [ ] **Step 6: Commit**

```bash
git add src/utils/tocTree.ts src/tests/tocTree.test.ts
git commit -m "feat(jev): exclude empty page ranges and fall back when nothing is selectable"
```

---

## Task 7: 页区间 → ContextGroup（与物化器同源）

产出必须是 `ContextPiece` 的逐页无损分区，否则 bench 的四个检索指标与现有基线不同源，跑出来的数字不可比。

**Files:**
- Modify: `src/utils/tocTree.ts`
- Test: `src/tests/tocTree.test.ts`

- [ ] **Step 1: 写失败的测试**

追加到 `src/tests/tocTree.test.ts`：

```ts
import { tocSelectionToContextGroups, tocNodePageSpan } from '../utils/tocTree'

describe('tocNodePageSpan 与 tocSelectionToContextGroups', () => {
  const PAGES = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']

  it('页片段逐字等于 pages 对应项的拼接（含首片无前缀约定）', () => {
    const tree = buildTocTree([e('A', 1), e('B', 4)], 6)   // A 覆盖 1–3
    const span = tocNodePageSpan(tree[0], PAGES)
    expect(span).toEqual([
      { page: 1, text: 'p1' },
      { page: 2, text: '\n\np2' },
      { page: 3, text: '\n\np3' },
    ])
    expect(span.map(p => p.text).join('')).toBe(PAGES.slice(1, 4).join('\n\n'))
  })

  it('空区间产出空片段数组，绝不切片', () => {
    const tree = buildTocTree([e('A', 1), e('B', 1)], 4)
    expect(tocNodePageSpan(tree[0], PAGES)).toEqual([])
  })

  it('每个选中节点一组，组内按页顺序', () => {
    const tree = buildTocTree([e('A', 0), e('C', 4)], 8)
    const groups = tocSelectionToContextGroups(tree, PAGES)
    expect(groups).toHaveLength(2)
    expect(groups[0].pieces.map(p => p.page)).toEqual([0, 1, 2, 3])
    expect(groups[1].pieces.map(p => p.page)).toEqual([4, 5, 6, 7])
  })

  it('空区间节点被跳过，不产生空组', () => {
    const tree = buildTocTree([e('A', 1), e('B', 1)], 4)
    const groups = tocSelectionToContextGroups(tree, PAGES)
    expect(groups).toHaveLength(1)
    expect(groups[0].pieces.map(p => p.page)).toEqual([1, 2, 3])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/tests/tocTree.test.ts -t tocNodePageSpan`
Expected: FAIL，`tocNodePageSpan is not a function`。

- [ ] **Step 3: 写实现**

在 `src/utils/tocTree.ts` 里补：

```ts
/**
 * 把一个节点的页区间展开成带页码的片段。首片是节点首页原文，后续每页带 `\n\n` 前缀
 * ——与 `pages.slice(start, end + 1).join('\n\n')` 逐字一致，也与
 * `pageIndex.ts` 的 `nodeToContextGroup` 同一口径，因此物化器从上下文反推出的
 * pageOrder 在两条路径上语义相同，指标可横向比较。
 *
 * 空区间返回空数组：绝不能交给 `pages.slice`——负 endPage 会静默返回错页。
 */
export function tocNodePageSpan(node: TocNode, pages: string[]): ContextPiece[] {
  if (isEmptyRange(node)) return []
  return pages
    .slice(node.startPage, node.endPage + 1)
    .map((text, offset) => ({ page: node.startPage + offset, text: offset === 0 ? text : `\n\n${text}` }))
}

/** 选中节点 → 上下文分组，每个节点一组。空区间节点被跳过，不产生空组。 */
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
Expected: PASS，32 个用例全绿。

- [ ] **Step 5: 与既有口径交叉验证**

Run: `npx vitest run src/tests/contextTrace.test.ts src/tests/tocTree.test.ts`
Expected: PASS。`contextTrace.test.ts` 钉住物化器的分组不变量；两边同时绿说明本模块产出的组满足同一契约。

- [ ] **Step 6: Commit**

```bash
git add src/utils/tocTree.ts src/tests/tocTree.test.ts
git commit -m "feat(jev): emit context groups that share the materializer's page-order semantics"
```

---

## Task 8: 目录提取（pdfjs）

**Files:**
- Modify: `src/utils/tocTree.ts`
- Test: `src/tests/tocTree.test.ts`

- [ ] **Step 1: 写测试（mock pdfjs）**

把 `src/tests/tocTree.test.ts` 顶部原有的 import 行改成带 `vi`，并在其下加 mock（依赖 `pageIndex.ts` 的测试文件都要这一句，否则 jsdom 外缺 `DOMMatrix`）：

```ts
import { describe, it, expect, vi } from 'vitest'

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  default: {},
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(),
}))
```

追加测试：

```ts
import { extractOutline } from '../utils/tocTree'
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'

const mockPdf = (outline: unknown, numPages = 10) => {
  const pdf = {
    numPages,
    getOutline: vi.fn().mockResolvedValue(outline),
    getDestination: vi.fn(async (name: string) => [{ num: name === 'd1' ? 3 : 7 }, 'XYZ', 0, 0, 0]),
    getPageIndex: vi.fn(async (ref: { num: number }) => ref.num),
  }
  vi.mocked(pdfjsLib.getDocument).mockReturnValue({ promise: Promise.resolve(pdf) } as never)
  return pdf
}

describe('extractOutline', () => {
  it('把目录转成纯数据，解析出 0-based 页码', async () => {
    mockPdf([{ title: 'A', dest: 'd1', items: [{ title: 'A1', dest: 'd2', items: [] }] }])
    expect(await extractOutline('AAAA')).toEqual([
      { title: 'A', page: 3, children: [{ title: 'A1', page: 7, children: [] }] },
    ])
  })

  it('无目录返回空数组', async () => {
    mockPdf(null)
    expect(await extractOutline('AAAA')).toEqual([])
  })

  it('单个条目解析失败不拖垮整份目录，该条目页码记 null', async () => {
    const pdf = mockPdf([{ title: 'A', dest: 'd1', items: [] }, { title: 'B', dest: 'bad', items: [] }])
    pdf.getDestination = vi.fn(async (name: string) => {
      if (name === 'bad') throw new Error('broken dest')
      return [{ num: 3 }, 'XYZ', 0, 0, 0]
    })
    expect(await extractOutline('AAAA')).toEqual([
      { title: 'A', page: 3, children: [] },
      { title: 'B', page: null, children: [] },
    ])
  })

  it('标题两端空白被 trim', async () => {
    mockPdf([{ title: '  A  ', dest: 'd1', items: [] }])
    expect((await extractOutline('AAAA'))[0].title).toBe('A')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/tests/tocTree.test.ts -t extractOutline`
Expected: FAIL，`extractOutline is not a function`。

- [ ] **Step 3: 写实现**

在 `src/utils/tocTree.ts` 顶部补 import，并追加实现：

```ts
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'

pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.min.mjs'
```

```ts
interface PdfOutlineItem {
  title?: string
  dest?: unknown
  items?: PdfOutlineItem[]
}

/**
 * 提取 PDF 内置目录。无目录返回空数组——**不返回 null**，
 * 让调用方用 `length === 0` 一个条件覆盖「没目录」与「目录为空」两种情形。
 *
 * 单个条目的 dest 解析失败只把该条目页码记 null，不拖垮整份目录：
 * 实测有的 PDF 只有个别条目指向命名目的地，为它放弃整棵树不划算。
 */
export async function extractOutline(base64: string): Promise<RawOutlineEntry[]> {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const pdf = await pdfjsLib.getDocument({ data: bytes.buffer }).promise
  const outline = await pdf.getOutline()
  if (!outline) return []

  const walk = async (items: PdfOutlineItem[]): Promise<RawOutlineEntry[]> => {
    const out: RawOutlineEntry[] = []
    for (const item of items) {
      let page: number | null = null
      try {
        const dest = typeof item.dest === 'string' ? await pdf.getDestination(item.dest) : item.dest
        if (Array.isArray(dest) && dest.length > 0) page = await pdf.getPageIndex(dest[0] as never)
      } catch { page = null }
      out.push({
        title: (item.title ?? '').trim(),
        page,
        children: item.items?.length ? await walk(item.items) : [],
      })
    }
    return out
  }
  return walk(outline as PdfOutlineItem[])
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/tests/tocTree.test.ts`
Expected: PASS，36 个用例全绿。

- [ ] **Step 5: 类型检查**

Run: `npm run typecheck`
Expected: 无输出（通过）。

- [ ] **Step 6: Commit**

```bash
git add src/utils/tocTree.ts src/tests/tocTree.test.ts
git commit -m "feat(jev): extract the PDF outline into plain data"
```

---

## Task 9: 侧车协议与子进程客户端

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

/** 假侧车：逐行读请求，按 request 里的 title 长度回一个确定概率。 */
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
const spawnFake: SidecarSpawn = () => ({
  command: process.execPath,
  args: ['-e', FAKE],
})

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

## Task 10: 真实侧车与 MLX 判定实现

本任务不在单测路径上。它的验收是**手工跑通**，因为真实推理依赖 `models/laya/.venv`。

**Files:**
- Create: `bench/src/jev/sidecar.py`
- Create: `bench/src/jev/mlxJudge.ts`

- [ ] **Step 1: 写侧车**

Create `bench/src/jev/sidecar.py`：

```python
"""Laya 侧车：常驻进程，逐行读 JSON 请求、逐行写 JSON 响应。

权重从本地目录加载（不联网）。判定只喂「章节标题 + 父路径 + 问题」，
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
        try:
            req = json.loads(line)
            out = {"id": req["id"], "scores": score(req)}
        except Exception as exc:  # noqa: BLE001 — 单条失败必须让请求方拿到明确错误
            out = {"id": json.loads(line).get("id") if line else None, "error": f"{type(exc).__name__}: {exc}"}
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

Expected: 一行 JSON，`scores` 两项且第一项**明显高于**第二项（spec 实测同一节点 0.3930 vs 0.0283 量级）。若两项都接近，检查 `INSTRUCTION` 是否用了反引号引用 `section` / `question`——探针确认过，不引用时模型看不到输入。

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
  const inner = new SidecarJudge({ spawn: defaultSpawn(opts), ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) })
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

- [ ] **Step 4: 手工验证 MLX 判定端到端**

Create `bench/scripts/jevSmoke.ts`（临时脚本，验证后保留作为冒烟工具）：

```ts
/**
 * Jev 判定冒烟：确认本地权重可用、概率有区分度。不属于单测。
 *
 * 全部逻辑包在 main() 里：tsx 对仓库内脚本按 CJS 转译，顶层 await 会直接报
 * "Top-level await is currently not supported with the cjs output format"。
 */
import { readFileSync } from 'node:fs'
import { createMlxJudge } from '../src/jev/mlxJudge'
import { extractOutline, buildTocTree, traverseWithJudge } from '../../src/utils/tocTree'

async function main(): Promise<void> {
  const PDF = process.argv[2] ?? 'bench/minibatch/01-method-attention-is-all-you-need.pdf'
  const QUERY = process.argv[3] ?? 'What optimizer and learning rate schedule were used for training?'

  const outline = await extractOutline(readFileSync(PDF).toString('base64'))
  const tree = buildTocTree(outline, 20)
  console.log(`目录条目 ${outline.length}，顶层 ${tree.length}`)

  const judge = createMlxJudge()
  const t0 = Date.now()
  const sel = await traverseWithJudge(tree, QUERY, judge, { alpha: 0.5, topN: 2 })
  console.log(`遍历耗时 ${Date.now() - t0}ms`)
  console.log('逐层诊断:', JSON.stringify(sel.layers, null, 2))
  console.log('选中:', sel.selected.map(n => `${n.title} p${n.startPage + 1}-${n.endPage + 1}`))
}

main().catch(error => { console.error(error); process.exit(1) })
```

Run: `npx tsx bench/scripts/jevSmoke.ts`

Expected: 打印目录条目数、遍历耗时（量级应为数百毫秒）、逐层诊断，且**选中的节点与问题相关**（对该问题应为 `Optimizer` 一类）。若选中明显无关，先确认 Step 2 的区分度，再回来查 `toJudgeNode` 的 `path` 是否传对。

- [ ] **Step 5: 跑全量测试与类型检查**

Run: `npm test && npm run typecheck`
Expected: 全绿。注意 `sidecar.py` 与 `mlxJudge.ts` 都不在单测路径上——若此处失败，说明有测试误引入了它们。

- [ ] **Step 6: Commit**

```bash
git add bench/src/jev/sidecar.py bench/src/jev/mlxJudge.ts bench/scripts/jevSmoke.ts
git commit -m "feat(jev): run the local decision model through a Python sidecar"
```

---

## 与 spec 的偏离（实施前须回填 spec）

写这份计划时逐步推演发现两处 spec 需要修正，代码按修正后的语义实现：

1. **`traverseWithJudge` 多一个 `query` 参数。** spec §1 写作 `traverseWithJudge(tree, judge, opts)`，但 `judge` 需要 query 才能判定，query 必须由遍历方传入。签名改为 `traverseWithJudge(tree, query, judge, opts)`。

2. **spec §2.3 与 §4 的两条回落规则在算术上不可达，触发条件须改为「空区间」。** 由 `θ_层 = α × max` 且 `α ≤ 1`、所有分数 `≥ 0` 可证：取得层内最高分的节点恒满足 `score ≥ θ`，因此「所有节点被阈值滤掉」不可能发生——除非把 `α` 设成 > 1。真正能让选择变空的只有**空区间**：存活节点恰好都是同页兄弟（`endPage === startPage − 1`）时不携带任何页内容。

   连带结论：spec §4 的 `emptySelectionFallback` 仍然保留，但触发条件从「阈值滤光」改为「存活节点全是空区间」；§2.3 的「子节点全被滤光 → 父节点兜底」也同样改为由空区间触发。**父节点自身恒非空**（`endPage = max(startPage, 子节点最大 endPage) ≥ startPage`），所以兜底一定拿得到东西。

   附带一个实现约束，已写进 Task 6：空区间过滤必须发生在**递归内部**，放到最后统一过滤会让下探「看起来有收获」而父节点兜底永不触发。

## 完成标准

全部任务结束后应满足：

- `npm test` 与 `npm run typecheck` 全绿
- `src/utils/tocTree.ts` 与 `src/utils/evidenceJudge.ts` 的纯函数部分**无 Python、无模型、无网络依赖**，可在任意机器单测
- `npx tsx bench/scripts/jevSmoke.ts` 能对真实 PDF 跑通并选出与问题相关的节点
- QASPER 目录覆盖率已实测并记入 spec

**未覆盖（属 Plan 2）：** 接入 bench 的 runner 与配置、四条对照臂、α/N 网格扫描、对照组报告；以及 spec §2.4 要求的 **`RetrievalResult` 字面组装**（`selected` / `sources` / `degraded` / `llmCalled` 那几个字段）与 `ragPipeline.ts:245` 的第四路分派。本计划只交付它依赖的硬约束——`ContextGroup` 的逐页无损分区，那才是四个检索指标同源的前提。产品侧分派按 spec 的「非目标」本就不做，等实验结论为正再补。

Plan 2 待 Task 0 的覆盖率实测结论出来后再写。
