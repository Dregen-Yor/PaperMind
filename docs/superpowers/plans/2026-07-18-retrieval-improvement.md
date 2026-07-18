# 检索精准度改进 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用语义分块 + 查询改写 + 评分多选三项改进替换现有固定切块贪心路由 RAG 管线，提升提问时相关内容的检索精准度。

**Architecture:** `pageIndex.ts` 新增 `detectSectionBoundaries`（语义分块）和 `scoreAndSelect`（评分多选），`chat.ts` 新增 `rewriteQuery` 并将 `sendMessage` 改为3-call 管线。不修改数据库 schema，`IndexNode` 接口不变。

**Tech Stack:** TypeScript strict, pdfjs-dist, Pinia, Vitest

## Global Constraints

- 不引入任何新 npm 依赖
- `IndexNode` 接口签名保持不变（`title`, `nodeId`, `startPage`, `endPage`, `summary`, `nodes`）
- `buildPageIndex` 和 `scoreAndSelect` 的函数签名与现有调用方兼容
- 所有 LLM 调用通过现有 `LLMFn = (prompt: string) => Promise<string>` 类型
- TypeScript strict 模式，禁止 `any`（已有代码中的 `any` 保持不动）
- 所有降级均静默处理，不向用户抛出错误

---

## 文件结构

| 文件 | 变更 | 职责 |
|------|------|------|
| `src/utils/pageIndex.ts` | 修改 | 新增 `detectSectionBoundaries`、`mergeSmallSections`（内部）、`scoreAndSelect`；修改 `buildPageIndex`；删除 `retrieve` |
| `src/stores/chat.ts` | 修改 | 新增 `rewriteQuery`（store 内部）；更新 `sendMessage` RAG 段落为3-call 管线；import `scoreAndSelect` 替换 `retrieve` |
| `src/tests/setup.ts` | 修改 | 在 `mockDb` 中补充 `index` mock（`list`/`get`/`set`） |
| `src/tests/pdfUtils.test.ts` | 修改 | 新增 `detectSectionBoundaries` 单元测试 |
| `src/tests/pageIndex.test.ts` | 新增 | `scoreAndSelect` 单元测试 |
| `src/tests/chat.store.test.ts` | 修改 | 新增 `sendMessage` LLM 调用次数校验测试 |

---

### Task 1：修复 setup.ts + 语义分块

**Files:**
- Modify: `src/tests/setup.ts`
- Modify: `src/utils/pageIndex.ts`
- Modify: `src/tests/pdfUtils.test.ts`

**Interfaces:**
- Produces:
  - `export function detectSectionBoundaries(pages: string[]): number[]`
  - `buildPageIndex(pages, llm)` 签名不变，内部使用语义分块

- [ ] **Step 1：在 setup.ts 补充 index mock**

`window.db.index` 在 `pageindex` 提交后被 `chat.ts` `init()` 调用，但 mock 中缺失，导致现有测试报错。

在 `src/tests/setup.ts` 的 `mockDb` 对象中，`data` 字段之前插入：

```typescript
  index: {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
  },
```

完整 `mockDb` 变为：
```typescript
const mockDb = {
  kb: { ... },
  paper: { ... },
  chat: { ... },
  highlight: { ... },
  settings: { ... },
  index: {
    list: vi.fn().mockResolvedValue([]),
    get:  vi.fn().mockResolvedValue(null),
    set:  vi.fn().mockResolvedValue(undefined),
  },
  data: { ... },
}
```

- [ ] **Step 2：运行现有测试，确认全部通过**

```bash
cd /home/Dregen_Yor/code/PaperMind && npm test
```

期望：所有已有测试 PASS（无 `Cannot read properties of undefined` 错误）。

- [ ] **Step 3：为 `detectSectionBoundaries` 写失败测试**

在 `src/tests/pdfUtils.test.ts` 末尾追加（注意：`pageIndex.ts` 同样依赖 `pdfjs-dist`，需要同一个 mock 块）：

```typescript
// pageIndex 依赖 pdfjs-dist，在同一文件内 mock 已生效，直接动态导入
const { detectSectionBoundaries } = await import('../utils/pageIndex')

describe('detectSectionBoundaries', () => {
  it('detects English numbered headings', () => {
    const pages = [
      'Some preamble text on page 1.',
      '1. Introduction\nThis paper presents a novel approach...',
      'Continued introduction text across this page.',
      '2. Methods\nWe used the following experimental setup...',
      '3. Results\nOur experiments demonstrate significant improvements...',
    ]
    expect(detectSectionBoundaries(pages)).toEqual([1, 3, 4])
  })

  it('detects all-caps headings', () => {
    const pages = [
      'Abstract content describing the paper.',
      'INTRODUCTION\nIn this work we explore...',
      'More introduction content here.',
      'METHODS\nWe performed the following steps...',
    ]
    expect(detectSectionBoundaries(pages)).toEqual([1, 3])
  })

  it('detects common section name headings (case-insensitive)', () => {
    const pages = [
      'Abstract\nThis paper investigates...',
      'Introduction\nPrior work has shown...',
      'Conclusion\nIn summary...',
    ]
    expect(detectSectionBoundaries(pages)).toEqual([0, 1, 2])
  })

  it('detects Chinese chapter headings', () => {
    const pages = [
      '摘要内容在此处。',
      '第一章 引言\n本文研究了以下问题...',
      '1.1 研究背景\n近年来深度学习取得了巨大进展...',
      '第二章 方法\n本章详细介绍实验方法...',
    ]
    expect(detectSectionBoundaries(pages)).toEqual([1, 2, 3])
  })

  it('returns empty array when no headings found (scanned PDF)', () => {
    const pages = [
      'this is a scanned document without any clear section headings at all',
      'more unstructured text content here without patterns',
      'even more plain text with no recognizable heading format',
    ]
    expect(detectSectionBoundaries(pages)).toEqual([])
  })
})
```

- [ ] **Step 4：运行新测试，确认失败**

```bash
npm test -- --reporter=verbose 2>&1 | grep -E "detectSectionBoundaries|FAIL|PASS"
```

期望：`detectSectionBoundaries` 相关测试报 `ReferenceError` 或 `is not a function`（函数尚未实现）。

- [ ] **Step 5：在 `pageIndex.ts` 实现 `detectSectionBoundaries` 和 `mergeSmallSections`**

在 `src/utils/pageIndex.ts` 文件顶部（`pdfjsLib.GlobalWorkerOptions` 行之后）插入：

```typescript
// ── 语义分块：节标题识别模式（英文 + 中文）───────────────────────────────────
const SECTION_PATTERNS: RegExp[] = [
  // 英文编号节标题："1. Introduction"、"2 Methods"、"1.1 Background"
  /^(\d+\.?\d*\.?\s+)[A-Z][a-zA-Z\s]{2,}$/m,
  // 英文全大写标题："INTRODUCTION"、"RELATED WORK"
  /^[A-Z][A-Z\s]{3,30}$/m,
  // 常见节名称（大小写不敏感）
  /^(Abstract|Introduction|Methods?|Results?|Discussion|Conclusion|References|Acknowledgements?|Appendix)$/im,
  // 中文章节："第一章"、"第3节"
  /^第[一二三四五六七八九十\d]+[章节]/m,
  // 中文编号节："1 引言"、"3.1 实验设置"
  /^\d+[\.\s]+[一-龥]{2,10}$/m,
]

/** 扫描每页文本，返回节标题所在的页码索引列表（0-based）。 */
export function detectSectionBoundaries(pages: string[]): number[] {
  const boundaries: number[] = []
  for (let i = 0; i < pages.length; i++) {
    if (SECTION_PATTERNS.some(pattern => pattern.test(pages[i]))) {
      boundaries.push(i)
    }
  }
  return boundaries
}

/** 将不足 minPages 页的节并入前一节（若无前节则并入后节）。 */
function mergeSmallSections(
  ranges: Array<{ start: number; end: number }>,
  minPages = 2,
): Array<{ start: number; end: number }> {
  const result = [...ranges]
  let i = 0
  while (i < result.length) {
    const size = result[i].end - result[i].start + 1
    if (size < minPages && result.length > 1) {
      if (i > 0) {
        // 并入前一节
        result[i - 1] = { start: result[i - 1].start, end: result[i].end }
        result.splice(i, 1)
      } else {
        // 首节并入后一节
        result[1] = { start: result[0].start, end: result[1].end }
        result.splice(0, 1)
      }
    } else {
      i++
    }
  }
  return result
}
```

- [ ] **Step 6：修改 `buildPageIndex` 使用语义分块**

将 `src/utils/pageIndex.ts` 中现有的 `buildPageIndex` 函数替换为：

```typescript
export async function buildPageIndex(pages: string[], llm: LLMFn): Promise<IndexNode> {
  // 语义分块：识别节边界；边界不足2个时降级为固定切块
  const boundaries = detectSectionBoundaries(pages)
  let ranges: Array<{ start: number; end: number }>

  if (boundaries.length >= 2) {
    ranges = boundaries.map((start, i) => ({
      start,
      end: i + 1 < boundaries.length ? boundaries[i + 1] - 1 : pages.length - 1,
    }))
    ranges = mergeSmallSections(ranges)
  } else {
    // 降级：固定5页切块（原有行为）
    ranges = []
    for (let i = 0; i < pages.length; i += CHUNK) {
      ranges.push({ start: i, end: Math.min(i + CHUNK - 1, pages.length - 1) })
    }
  }

  const leaves: IndexNode[] = []
  for (let i = 0; i < ranges.length; i++) {
    const { start, end } = ranges[i]
    leaves.push(await summarizeRange(pages, start, end, String(i), llm))
  }
  if (leaves.length === 1) return leaves[0]

  const sectionList = leaves.map((n, i) => `[${i + 1}] ${n.title}: ${n.summary}`).join('\n')
  const prompt = `Create a top-level index for an academic paper.\n\nSections:\n${sectionList}\n\nReply JSON only: {"title":"...","summary":"2-3 sentences"}`
  let title = 'Paper'
  let summary = ''
  try {
    const raw = (await llm(prompt)).replace(/```json\n?|```/g, '').trim()
    const p = JSON.parse(raw)
    title = p.title || title
    summary = p.summary || ''
  } catch { /* keep defaults */ }

  return { title, nodeId: 'root', startPage: 0, endPage: pages.length - 1, summary, nodes: leaves }
}
```

- [ ] **Step 7：运行测试，确认全部通过**

```bash
npm test
```

期望：所有测试 PASS，包括新增的 `detectSectionBoundaries` 测试。

- [ ] **Step 8：提交**

```bash
git add src/tests/setup.ts src/utils/pageIndex.ts src/tests/pdfUtils.test.ts
git commit -m "feat: semantic chunking with section boundary detection"
```

---

### Task 2：scoreAndSelect（评分多选）

**Files:**
- Modify: `src/utils/pageIndex.ts`
- Create: `src/tests/pageIndex.test.ts`

**Interfaces:**
- Consumes: `IndexNode`（Task 1 中不变的接口），`LLMFn`
- Produces:
  - `export async function scoreAndSelect(root: IndexNode, pages: string[], query: string, llm: LLMFn): Promise<{ context: string; sources: string[] }>`
  - `retrieve` 从导出列表中移除（`chat.ts` 将在 Task 3 更新 import）

- [ ] **Step 1：新建测试文件，写失败测试**

新建 `src/tests/pageIndex.test.ts`：

```typescript
import { describe, it, expect, vi } from 'vitest'
import { scoreAndSelect } from '../utils/pageIndex'
import type { IndexNode } from '../utils/pageIndex'

// pdfjs-dist 在 pageIndex.ts 顶层导入，测试中需要 mock
vi.mock('pdfjs-dist', () => ({
  default: {},
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(),
}))

function makeRoot(): IndexNode {
  return {
    title: 'Paper',
    nodeId: 'root',
    startPage: 0,
    endPage: 5,
    summary: 'A test paper about deep learning.',
    nodes: [
      { title: 'Introduction', nodeId: '0', startPage: 0, endPage: 1, summary: 'Motivates the problem.', nodes: [] },
      { title: 'Methods',      nodeId: '1', startPage: 2, endPage: 3, summary: 'Describes the approach.', nodes: [] },
      { title: 'Results',      nodeId: '2', startPage: 4, endPage: 5, summary: 'Shows experimental results.', nodes: [] },
    ],
  }
}

const pages = ['p0 text', 'p1 text', 'p2 text', 'p3 text', 'p4 text', 'p5 text']

describe('scoreAndSelect', () => {
  it('returns the top-scored node when second score is below threshold (< 4)', async () => {
    const llm = vi.fn().mockResolvedValue('[{"id":1,"score":9},{"id":0,"score":2},{"id":2,"score":1}]')
    const result = await scoreAndSelect(makeRoot(), pages, 'how was the study conducted?', llm)

    expect(result.sources).toHaveLength(1)
    expect(result.sources[0]).toContain('Methods')
    expect(result.context).toBe('p2 text\n\np3 text')
    expect(llm).toHaveBeenCalledTimes(1)
  })

  it('returns top-2 nodes in document order when second score >= 4', async () => {
    const llm = vi.fn().mockResolvedValue('[{"id":2,"score":8},{"id":1,"score":5},{"id":0,"score":1}]')
    const result = await scoreAndSelect(makeRoot(), pages, 'methods and results?', llm)

    expect(result.sources).toHaveLength(2)
    // Document order: Methods (pages 2-3) before Results (pages 4-5)
    expect(result.sources[0]).toContain('Methods')
    expect(result.sources[1]).toContain('Results')
    expect(result.context).toContain('---')
    // Methods context comes first
    expect(result.context.indexOf('p2')).toBeLessThan(result.context.indexOf('p4'))
  })

  it('excludes second node when score is exactly 3 (below threshold)', async () => {
    const llm = vi.fn().mockResolvedValue('[{"id":0,"score":7},{"id":1,"score":3},{"id":2,"score":1}]')
    const result = await scoreAndSelect(makeRoot(), pages, 'introduction overview', llm)

    expect(result.sources).toHaveLength(1)
    expect(result.sources[0]).toContain('Introduction')
  })

  it('falls back to first leaf node on JSON parse failure', async () => {
    const llm = vi.fn().mockResolvedValue('this is not valid json at all')
    const result = await scoreAndSelect(makeRoot(), pages, 'anything', llm)

    expect(result.sources).toHaveLength(1)
    expect(result.sources[0]).toContain('Introduction')
  })

  it('returns single node directly when root has no children', async () => {
    const singleRoot: IndexNode = {
      title: 'Short Paper', nodeId: 'root',
      startPage: 0, endPage: 2,
      summary: 'A very short paper.', nodes: [],
    }
    const llm = vi.fn()
    const result = await scoreAndSelect(singleRoot, ['a', 'b', 'c'], 'anything', llm)

    expect(llm).not.toHaveBeenCalled()
    expect(result.sources).toHaveLength(1)
    expect(result.context).toBe('a\n\nb\n\nc')
  })
})
```

- [ ] **Step 2：运行测试，确认失败**

```bash
npm test -- src/tests/pageIndex.test.ts 2>&1 | grep -E "scoreAndSelect|FAIL|not exported"
```

期望：`scoreAndSelect is not a function` 或 `not exported`。

- [ ] **Step 3：在 `pageIndex.ts` 实现 `scoreAndSelect`，删除 `retrieve`**

在 `src/utils/pageIndex.ts` 中，将现有 `retrieve` 函数整体替换为：

```typescript
/** 对所有叶节点打分，返回 Top-2 合并上下文。JSON 解析失败时降级为第一节点。 */
export async function scoreAndSelect(
  root: IndexNode,
  pages: string[],
  query: string,
  llm: LLMFn,
): Promise<{ context: string; sources: string[] }> {
  // 收集叶节点（无子节点的节点）
  const leaves = root.nodes.length > 0 ? root.nodes : [root]

  // 单节点无需调用 LLM
  if (leaves.length === 1) {
    const leaf = leaves[0]
    return {
      context: pages.slice(leaf.startPage, leaf.endPage + 1).join('\n\n'),
      sources: [`Pages ${leaf.startPage + 1}–${leaf.endPage + 1}: ${leaf.title}`],
    }
  }

  const options = leaves.map((n, i) => `[${i}] ${n.title}: ${n.summary}`).join('\n')
  const prompt = `Query: ${query}\n\nSections:\n${options}\n\nRate each section's relevance to the query (0-10).\nReturn JSON only: [{"id":0,"score":8},{"id":1,"score":2},...]`

  let selected: IndexNode[]
  try {
    const raw = (await llm(prompt)).replace(/```json\n?|```/g, '').trim()
    const scores = JSON.parse(raw) as Array<{ id: number; score: number }>
    const sorted = [...scores].sort((a, b) => b.score - a.score)

    const picked: IndexNode[] = [leaves[sorted[0].id]]
    if (sorted[1] && sorted[1].score >= 4) picked.push(leaves[sorted[1].id])

    // 按文档顺序排列（startPage 升序）
    selected = picked.sort((a, b) => a.startPage - b.startPage)
  } catch {
    selected = [leaves[0]]
  }

  const context = selected
    .map(n => pages.slice(n.startPage, n.endPage + 1).join('\n\n'))
    .join('\n\n---\n\n')

  const sources = selected.map(
    n => `Pages ${n.startPage + 1}–${n.endPage + 1}: ${n.title}`,
  )

  return { context, sources }
}
```

- [ ] **Step 4：运行测试，确认全部通过**

```bash
npm test
```

期望：全部 PASS，包括新增的5个 `scoreAndSelect` 测试。

- [ ] **Step 5：提交**

```bash
git add src/utils/pageIndex.ts src/tests/pageIndex.test.ts
git commit -m "feat: replace retrieve with scored multi-node selection"
```

---

### Task 3：rewriteQuery + sendMessage 3-call 管线

**Files:**
- Modify: `src/stores/chat.ts`
- Modify: `src/tests/chat.store.test.ts`

**Interfaces:**
- Consumes: `scoreAndSelect`（Task 2 产出），`IndexNode`（`pageIndex.ts` 导出）
- Produces: 更新后的 `sendMessage`，RAG 路径调用顺序为：`rewriteQuery` → `scoreAndSelect` → `callLLM`

- [ ] **Step 1：写失败测试**

在 `src/tests/chat.store.test.ts` 末尾，`describe` 块内追加两个测试：

```typescript
  it('sendMessage skips query rewriting on first message (2 LLM calls total)', async () => {
    // 首条消息，无对话历史，应跳过查询改写：共2次 fetch（scoreAndSelect + 回答）
    let callCount = 0
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++
      return Promise.resolve({
        json: () => Promise.resolve({ choices: [{ message: { content: 'Answer' } }] }),
      })
    }) as any

    ;(globalThis as any).mockDb.index.get.mockResolvedValue({
      indexJson: JSON.stringify({
        title: 'Paper', nodeId: 'root', startPage: 0, endPage: 0,
        summary: 'test paper', nodes: [],
      }),
      pagesJson: JSON.stringify(['page one text']),
    })

    const store = useChatStore()
    await store.init()
    await store.updateConfig({ apiKey: 'sk-test' })
    const conv = await store.newConversation('test', ['paper-1'])

    await store.sendMessage(conv.id, 'What is this paper about?')

    // 单节点（root 无子节点）scoreAndSelect 不调用 LLM，加上回答 = 1次
    // 若有多节点才是2次。此处 root 无子节点，共1次回答调用
    expect(callCount).toBe(1)
  })

  it('sendMessage calls query rewriting when conversation has prior history (3 LLM calls total)', async () => {
    // 多节点 index，有历史时应触发改写：改写(1) + 评分(1) + 回答(1) = 3次
    let callCount = 0
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++
      return Promise.resolve({
        json: () => Promise.resolve({
          choices: [{ message: { content: '[{"id":0,"score":9},{"id":1,"score":2}]' } }],
        }),
      })
    }) as any

    ;(globalThis as any).mockDb.index.get.mockResolvedValue({
      indexJson: JSON.stringify({
        title: 'Paper', nodeId: 'root', startPage: 0, endPage: 3,
        summary: 'multi-section paper',
        nodes: [
          { title: 'Intro',    nodeId: '0', startPage: 0, endPage: 1, summary: 'intro', nodes: [] },
          { title: 'Methods',  nodeId: '1', startPage: 2, endPage: 3, summary: 'methods', nodes: [] },
        ],
      }),
      pagesJson: JSON.stringify(['p0', 'p1', 'p2', 'p3']),
    })

    const store = useChatStore()
    await store.init()
    await store.updateConfig({ apiKey: 'sk-test' })
    const conv = await store.newConversation('test', ['paper-1'])

    // 第一条消息（建立历史，不触发改写）
    callCount = 0
    await store.sendMessage(conv.id, 'What is this paper about?')
    const firstRoundCalls = callCount   // scoreAndSelect(1) + answer(1) = 2

    // 第二条消息（有历史，触发改写）
    callCount = 0
    await store.sendMessage(conv.id, 'What about the results?')

    // rewrite(1) + scoreAndSelect(1) + answer(1) = 3
    expect(callCount).toBe(3)
    expect(firstRoundCalls).toBe(2)
  })
```

- [ ] **Step 2：运行测试，确认新测试失败**

```bash
npm test -- src/tests/chat.store.test.ts 2>&1 | tail -20
```

期望：两个新测试 FAIL（`retrieve is not a function` 或调用次数不符）。

- [ ] **Step 3：更新 `chat.ts` 的 import**

在 `src/stores/chat.ts` 顶部，将：

```typescript
import { extractPages, buildPageIndex, retrieve } from '../utils/pageIndex'
```

替换为（只改 `retrieve` → `scoreAndSelect`，`Message` 已在同文件内定义，不需新增 import）：

```typescript
import { extractPages, buildPageIndex, scoreAndSelect } from '../utils/pageIndex'
```

- [ ] **Step 4：在 `useChatStore` 的 setup 函数内添加 `rewriteQuery`**

在 `src/stores/chat.ts` 中，`callLLM` 函数定义之后，`indexPaper` 之前，插入：

```typescript
  /** 利用对话历史将追问改写为独立检索查询。失败时返回原始 query。 */
  async function rewriteQuery(
    query: string,
    history: Message[],
    llmFn: (prompt: string) => Promise<string>,
  ): Promise<string> {
    const historyText = history.map(m => `${m.role}: ${m.content}`).join('\n')
    const prompt = `Based on the following conversation, rewrite the user's latest question as a self-contained retrieval query. Resolve pronouns, expand abbreviations, preserve technical terms. Return ONLY the rewritten query, no explanation.

Conversation:
${historyText}

Latest question: ${query}`
    try {
      const result = await llmFn(prompt)
      return result.trim() || query
    } catch {
      return query
    }
  }
```

- [ ] **Step 5：更新 `sendMessage` 中的 RAG 段落**

在 `src/stores/chat.ts` 的 `sendMessage` 函数中，将现有 RAG 块：

```typescript
    // RAG: retrieve context from indexed papers when no manual context provided
    let ragSources: string[] = []
    if (!context && conv.paperIds.length > 0) {
      const parts: string[] = []
      const llmFn = (prompt: string) => callLLM([{ role: 'user', content: prompt }])
      for (const paperId of conv.paperIds) {
        const stored = await window.db.index.get(paperId)
        if (!stored) continue
        const tree = JSON.parse(stored.indexJson)
        const pages = JSON.parse(stored.pagesJson)
        const { context: ctx, sources } = await retrieve(tree, pages, userMessage, llmFn)
        parts.push(ctx)
        ragSources.push(...sources)
      }
      if (parts.length > 0) context = parts.join('\n\n---\n\n')
    }
```

替换为：

```typescript
    // RAG: 3-call 管线 — 查询改写（有历史时）→ 评分多选 → 注入上下文
    let ragSources: string[] = []
    if (!context && conv.paperIds.length > 0) {
      const parts: string[] = []
      const llmFn = (prompt: string) => callLLM([{ role: 'user', content: prompt }])

      // Call 1（条件）：查询改写 — 取当前消息之前的最近3条历史
      // conv.messages 此时已包含刚加入的 userMessage（最后一条），故取 slice(-4, -1)
      const historyBeforeCurrent = conv.messages.slice(-4, -1)
      const retrievalQuery = historyBeforeCurrent.length >= 2
        ? await rewriteQuery(userMessage, historyBeforeCurrent, llmFn)
        : userMessage

      for (const paperId of conv.paperIds) {
        const stored = await window.db.index.get(paperId)
        if (!stored) continue
        const tree = JSON.parse(stored.indexJson)
        const pages = JSON.parse(stored.pagesJson)
        // Call 2：评分多选
        const { context: ctx, sources } = await scoreAndSelect(tree, pages, retrievalQuery, llmFn)
        parts.push(ctx)
        ragSources.push(...sources)
      }
      if (parts.length > 0) context = parts.join('\n\n---\n\n')
    }
```

- [ ] **Step 6：运行全部测试，确认全部通过**

```bash
npm test
```

期望：全部 PASS。若出现类型错误，运行 `npm run typecheck` 确认无 TypeScript 报错。

- [ ] **Step 7：提交**

```bash
git add src/stores/chat.ts src/tests/chat.store.test.ts
git commit -m "feat: add query rewriting and 3-call RAG pipeline"
```
