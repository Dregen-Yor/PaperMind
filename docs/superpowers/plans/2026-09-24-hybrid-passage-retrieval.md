# 段落级混合检索 + 结构卡片先验 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 v1 的整章粒度 RAG 换成段落级混合检索（段落 BM25 + 段落向量 + 卡片向量，加权 RRF 融合，冻结 4096 token 预算），冷启动每篇论文只花一次 LLM 调用生成结构卡片，查询热路径回答前零 LLM 调用。

**Architecture:** 检索原语全部落在 `src/utils`，产品（Electron 渲染层）与 bench（Node）import 同一份代码。索引是同一张 `paper_indexes` 表里的版本化 `index_json`（`version: 2`），分三阶段构建：① 本地切段落（<1 秒，BM25 即可用）② 段落向量 ③ 结构卡片 LLM 调用 + 卡片向量（② 与 ③ 并行）；每阶段完成即落盘，提问读当时最高阶段并按可用信号降级。卡片只做融合打分的第三路先验与提问用词的补充，**不进上下文、不作事实依据**，回答仍来自原文段落。

**Tech Stack:** TypeScript（strict）、Vue 3 + Pinia、Electron、`@huggingface/transformers` v3（产品 WASM / bench onnxruntime-node，同一权重 `Xenova/bge-small-en-v1.5` int8 384 维）、Vitest（jsdom）、Node CLI（bench，`tsx`）。

**Spec:** [`docs/superpowers/specs/2026-09-23-hybrid-passage-retrieval-design.md`](../specs/2026-09-23-hybrid-passage-retrieval-design.md)

---

## Global Constraints

以下约束贯穿每个 Task，违反任一即视为实现错误：

1. **上下文预算 4096 token 冻结**，与现有基线同口径；物化由共享 `materializeContext` 施加，段落路径**必须在填充阶段就保证放得下**，绝不依赖 materialize 截断。
2. **回答前零 LLM 调用**：段落检索路径 `llmCalled: false`、`retrieval.llmCalls === 0`。产品多轮对话的 `rewriteQuery` 触发条件不变（有历史时才改写）。
3. **冷启动每篇论文恰好一次卡片 LLM 调用**；卡片失败**不重试、不修补**，直接标题卡片回落。
4. **原文不可改**：进入上下文的永远是 `pieces` 拼接出的原文 `text`；页眉页脚清洗只作用于 `searchText` 与向量输入。
5. **不新增数据表与 IPC 通道**：沿用 `paper_indexes` + `window.db.index.*`。
6. **回答提示词不改**（`buildAnswerMessages` 与 `src/utils/answerMessages.ts` 不动，framing 指纹必须一致）。
7. **切片与历史口径不改**：`bench/configs/default.json`、QASPER 60 篇 / 179 题切片、`CONTEXT_BUDGET_TOKENS` 均不改动。
8. **API key 不进入索引、缓存、日志或提交**；不提交 PDF、模型缓存、`public/ort/` 与生成的实验数据。
9. **交付前必须通过** `npm test` 与 `npm run typecheck`（纯文档变更除外）。
10. **确定性**：所有排序都要有稳定的破平（同分按 `order` 升序），禁止依赖 `Array.prototype.sort` 之外的隐式顺序。

## Review Focus

- 段落 `pieces` 拼接与 `text` 的**逐字相等**（不变量），以及 `tokenCount` 与 `materializeContext` 的**同口径**计数（按 piece 累加、组间分隔符计入）。
- 4096 预算填充的**放得下判定**与物化器一致：`已用 + 新组分隔符 + 段落 token ≤ 预算`，保证 `contextTruncated === false`。
- 「跳过 20 个后停止」的计数器只在**成功放入**时归零。
- 降级模式的判定顺序（`full` → `full-title-fallback` → `bm25+dense` → `bm25+card-lexical` → `bm25`）与 `retrievalMode` 记录一致。
- 代次（generation token）+ 配置快照保护：构建期间切了索引 profile，过期结果**整体丢弃**。
- bench：`bm25*` 结果被排除在正式对照外（`comparisonEligible: false`），old-index 报错而非静默回落。
- 三个失效键各自只触发对应范围的重建（`passageConfigHash` 全量 / `structureHash` 仅卡片 / `embedderId` 仅向量）。

---

## 开工前的代码地图与决策

**已读到的现成件（直接复用，不要重写）：**

| 位置 | 复用什么 |
|---|---|
| `src/utils/contextTrace.ts` | `CONTEXT_GROUP_SEPARATOR`、`ContextPiece`、`ContextGroup`、`materializeContext`（最终页序的唯一来源） |
| `src/utils/evidenceBlock.ts` | `detectRunningLines`、`normalizeEvidenceText`（清洗规则）、`hasExactPagePartition` 的写法（照抄成 `hasPassagePartition`） |
| `src/utils/semanticTree.ts` | `estimateTokens`、`isGenericSectionLabel`、`DEFAULT_MAX_INPUT_CHARS = 120_000`、`hashTreeSource` + `semanticTreeConfigHash` 的指纹写法、`SemanticTreeBuildError` 的「失败即带成本」形态 |
| `src/utils/pageIndex.ts` | `IndexNode`、`RetrievalResult`、`ScoreOptions`、`collectLeafNodes` |
| `src/utils/semanticRoute.ts` | `toPageSpans`（页区间合并规则：`start <= prev.end + 1`）、`formatSource` 的文案 |
| `bench/src/traditionalRag/bm25.ts`、`lexicalTokenizer.ts`、`bench/src/baselines/rrf.ts` | 整体移入 `src/utils`，bench 侧改为薄再导出 |
| `bench/src/baselines/sections.ts` | `isHeadingLine` 移入 `src/utils/sectionHeadings.ts`，bench 侧再导出 |
| `bench/src/runner/semanticTreeQa.ts` | 建索引 hook 的形态（`createXxxHook` → runner 注入） |
| `bench/src/metrics/treeDiagnostics.ts` | `xxxRecordFields` / `summarizeXxx` 的聚合形态 |
| `bench/src/runner/support.ts` | `FinalizeQaArgs.extraMetrics` / `extraTimingValues` / `extraMeta`、`withPercentiles` |
| `bench/src/cli.ts` | `config.kind === ...` 分派链、`createBgeM3Tokenizer`、`materialize` 注入 |

**关键决策（都已经过推演，实现时不要再改）：**

1. **段落 token 计数**：索引里存每个段落的 `tokenCount`（按 piece 累加）与 `separatorTokens`。bench 与产品**都**用注入的计数器；bench 注入冻结的 BGE-M3 分词器，产品注入 `createEstimatingTokenCounter()`（4 字符 ≈ 1 token，与 `semanticTree.estimateTokens` 同口径）。因此 bench 的 4096 约束是**精确**的，产品的约束是**估算的**但偏保守（估算值 ≥ BGE-M3 实际值时要靠 24000 字符上限兜底，见 `ragPipeline` 现有 `maxContextChars`）。
2. **「放得下」判定的语义**：`已用 + (新增一组时分隔符 token) + 段落 token ≤ 预算`。数学上保证 `materializeContext` 的 `used + prefix >= maxTokens` 守卫永不触发，`contextTruncated === false`。
3. **`kind: 'papermind'` 如何区分混合配置**：不看 `kind`，看配置里有没有 `passage` 块。段落检索的**可调参数放在配置顶层**（`rrfK` / `sectionWeight` / `neighbourFactor` / `skipLimit` / `minTokens` / `maxTokens` / `maxInputChars`），这样它们能被现有 `matrix` 机制直接消融（`matrix` 只接受 number|boolean）；`passage` 块只放不可消融的 embedder 身份（模型 / revision / 量化 / 维度）。
4. **embedder 不可用时仍然建卡片**：卡片能生成就生成（`stage: 3`），检索退化为 `bm25+card-lexical`；`passageVectors` / `cardVectors` 都是可选字段，模式判定只看它们是否存在。
5. **ORt wasm 资源随包发布**：`public/ort/`（由 `vite.config.ts` 在启动时从 `node_modules/onnxruntime-web/dist/` 拷贝，与 `pdf.worker.min.mjs` 同一套做法），`wasmPaths = './ort/'`，`numThreads = 1`（打包后是 `file://` 页面，没有 `crossOriginIsolated`，多线程 wasm 拿不到 `SharedArrayBuffer`）。
6. **模型文件缓存自管**：`env.useCustomCache = true` + 一个 IndexedDB 后端（`modelCache.ts`）。默认的浏览器 Cache API 在 `file://` 页面不保证可用，而「首次下载后离线可用」是阶段②③ 的前提。
7. **落盘只写一个 key**：`window.db.index.set(paperId, JSON.stringify(serializePassageIndex(index)), JSON.stringify(pages))`，`pagesJson` 与 v1 完全一致（语义树建树路径仍读它，不受影响）。
8. **新增的回落原因 `no-passages`**：设计文档列的四种原因覆盖不了「论文无文本」，这里补第五种（`no-passages`），行为与其它回落一致（空上下文照常回答）。

**文件结构（本计划要新建 / 修改的全部文件）：**

```
新建（产品）
  src/utils/sectionHeadings.ts        标题行识别（从 bench 移入，公开单一实现）
  src/utils/passages.ts               段落切分 + Passage 类型 + token 计数器
  src/utils/lexicalTokenizer.ts       词法分词（从 bench 移入）
  src/utils/bm25.ts                   BM25 打分器（从 bench 移入）
  src/utils/rrf.ts                    加权 RRF（从 bench 移入 + 加权重参数）
  src/utils/embedder.ts               Embedder 接口 + 向量工具（cos / 文本拼接 / base64 编解码）
  src/utils/modelCache.ts             IndexedDB 模型文件缓存
  src/utils/transformersEmbedder.ts   真实向量模型（动态 import，jsdom 不加载）
  src/utils/structureCards.ts         卡片提示词 / 解析 / 校验 / 标题卡片回落 / 卡片→IndexNode
  src/utils/passageIndex.ts           版本化索引结构、三个指纹、序列化与失效规划
  src/utils/priorityQueue.ts          确定性最大堆
  src/utils/passageRetrieval.ts       三路融合 + 预算填充 + 组装 + 降级模式
  src/utils/passageIndexBuilder.ts    分阶段构建管线（②③ 并行、逐阶段落盘、阶段观测回调）
  src/utils/buildGeneration.ts        构建代次保护（快照 + 代次令牌，索引 profile 变更时作废在途构建）

新建（测试）
  src/tests/sectionHeadings.test.ts
  src/tests/passages.test.ts
  src/tests/bm25.test.ts     src/tests/rrf.test.ts
  src/tests/embedder.test.ts src/tests/modelCache.test.ts
  src/tests/structureCards.test.ts
  src/tests/passageIndex.test.ts
  src/tests/passageRetrieval.test.ts
  src/tests/passageIndexBuilder.test.ts
  src/tests/buildGeneration.test.ts
  src/tests/chatPassageIndex.test.ts
  bench/src/tests/passageConfig.test.ts
  bench/src/tests/passageDiagnostics.test.ts

修改（产品）
  src/utils/ragPipeline.ts            IndexedPaper.passageIndex + RagPipelineDeps.passage + 分派
  src/stores/chat.ts                  分阶段后台构建、向量模型生命周期、treeEnabled 默认关闭
  src/types/db.d.ts                   （不改：index.set 签名不变）
  package.json                        把 @huggingface/transformers 挪进 dependencies
  vite.config.ts                      拷贝 onnxruntime-web wasm 到 public/ort/
  .gitignore                          忽略 public/ort/
  src/tests/semanticTreeStore.test.ts 语义树默认值断言（关闭）
  src/tests/settingsViewTree.test.ts  同样断言 treeEnabled 默认关闭（设置页开关仍在）
  src/tests/chat.store.test.ts        init 时不再拉扯语义树默认开启

修改（bench）
  bench/src/baselines/sections.ts     isHeadingLine 改再导出
  bench/src/baselines/rrf.ts          reciprocalRankFusion 改再导出
  bench/src/traditionalRag/bm25.ts    改再导出 src/utils/bm25
  bench/src/traditionalRag/lexicalTokenizer.ts 改再导出
  bench/src/types.ts                  新配置字段 + PaperTimingRecord 冷启动字段 + retrievalMode
  bench/src/config.ts                 passage 校验 + 顶层旋钮校验 + matrix 键集合 + carried
  bench/src/configs/papermind-hybrid.json      新建
  bench/src/configs/papermind-hybrid-m3.json   新建（embedder 消融）
  bench/src/metrics/passageDiagnostics.ts      新建
  bench/src/runner/passageIndexHook.ts         新建
  bench/src/runner/qa.ts              接入 passage hook、逐题 retrievalMode、冷启动聚合
  bench/src/cli.ts                    passage 分派 + embedder 构造
  bench/src/report.ts                 新增「冷启动成本」表
  bench/src/treeInspect.ts            新增卡片视图
  bench/src/treeInspectCli.ts         卡片视图接线
```

**实现顺序**：阶段 A（1–5，纯原语，每步都能独立合并且测试通过）→ 阶段 B（6–8，融合与构建）→ 阶段 C（9–11，产品接入）→ 阶段 D（12–15，bench 接入）。**每一步做完都要跑 `npm test`，每个 Task 结束都提交。**

---

## 阶段 A：检索原语

### Task 1: 标题行识别 + 段落切分

**Files:**
- Create: `src/utils/sectionHeadings.ts`
- Create: `src/utils/passages.ts`
- Modify: `bench/src/baselines/sections.ts`
- Test: `src/tests/sectionHeadings.test.ts`, `src/tests/passages.test.ts`

- [ ] **Step 1: 写失败测试——标题识别**

`src/tests/sectionHeadings.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { isHeadingLine } from '../utils/sectionHeadings'

describe('isHeadingLine', () => {
  it('识别 Markdown 标题并去掉井号', () => {
    expect(isHeadingLine('## 3.2 Model Architecture')).toBe('3.2 Model Architecture')
  })

  it('识别中文「第N章/节」与中文序号标题', () => {
    expect(isHeadingLine('第二章 相关工作')).toBe('第二章 相关工作')
    expect(isHeadingLine('一、研究背景')).toBe('一、研究背景')
  })

  it('识别常见英文章节名', () => {
    expect(isHeadingLine('Introduction')).toBe('Introduction')
    expect(isHeadingLine('Experiments')).toBe('Experiments')
  })

  it('长句子带编号时按正文处理，避免假阳性', () => {
    expect(isHeadingLine('1. 我们发现模型在 Europarl 上的表现显著优于此前所有基线，尤其是在低资源语言对上。')).toBeNull()
  })

  it('普通正文行返回 null', () => {
    expect(isHeadingLine('We evaluate on Europarl and MultiUN.')).toBeNull()
    expect(isHeadingLine('')).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/tests/sectionHeadings.test.ts`
Expected: FAIL — `Failed to resolve import "../utils/sectionHeadings"`

- [ ] **Step 3: 实现 `src/utils/sectionHeadings.ts`**

```ts
/**
 * 标题行识别（自 `bench/src/baselines/sections.ts` 移入）。
 *
 * 段落切分（`passages.ts`）与长章节基线（`bench/src/baselines/sections.ts`）必须共用
 * 这一份规则：各写一份的话同一条标题会在两处得到不同判定，而两处的下游
 * （段落边界 / 章节区域）都是按它切的。
 */

const MARKDOWN_HEADING = /^#{1,6}\s+(.+)$/
const NUMBERED_HEADING = /^(\d+(?:\.\d+)*)\.?\s+(.+)$/
const KNOWN_ENGLISH_HEADING = /^(abstract|introduction|background|related work|preliminaries|motivation|methods?|methodology|approach|model|experiments?|experimental setup|evaluation|results?( and discussion)?|discussion|analysis|conclusions?|limitations?|references|acknowledg(e)?ments?|appendix|appendices)$/i
const CN_CHAPTER = /^第[一二三四五六七八九十百\d]+[章节部分]\s*\S{0,60}$/
const CN_ENUMERATED = /^[一二三四五六七八九十]+、\s*\S{1,60}$/

/** 编号标题内容部分的上限：超过就按正文处理，这是假阳性的唯一防线。 */
const MAX_HEADING_CHARS = 100
const MAX_HEADING_WORDS = 20

/**
 * 命中即返回去掉编号后的标题文本，未命中返回 null。
 * 标题只用于切段与「通用章节名」判定，不进入上下文。
 */
export function isHeadingLine(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  const markdown = MARKDOWN_HEADING.exec(trimmed)
  if (markdown) return markdown[1].trim()

  if (CN_CHAPTER.test(trimmed) || CN_ENUMERATED.test(trimmed)) return trimmed
  if (KNOWN_ENGLISH_HEADING.test(trimmed)) return trimmed

  const numbered = NUMBERED_HEADING.exec(trimmed)
  if (numbered) {
    const rest = numbered[2].trim()
    const words = rest.split(/\s+/).length
    const endsLikeSentence = /[。;；]$/.test(rest)
    if (rest.length > 0 && rest.length <= MAX_HEADING_CHARS && words <= MAX_HEADING_WORDS && !endsLikeSentence) {
      return rest
    }
  }
  return null
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/tests/sectionHeadings.test.ts`
Expected: PASS（5 个用例）

- [ ] **Step 5: 让 bench 复用同一实现**

`bench/src/baselines/sections.ts` 顶部把原来的 `isHeadingLine` 与它用到的正则/常量整段删掉，改为：

```ts
/**
 * 标题行识别已移入 `src/utils/sectionHeadings.ts`：段落切分与本章节边界必须
 * 共用同一份规则，否则同一条标题在两处会有不同判定。这里只做再导出，
 * 保持 bench 内部既有的 import 路径不变。
 */
export { isHeadingLine } from '../../../src/utils/sectionHeadings'
```

Run: `npx vitest run bench/src/tests`（若无该目录则 `npx vitest run src/tests`）与 `npm run typecheck`
Expected: PASS，无 TS 报错

- [ ] **Step 6: 写失败测试——段落切分**

`src/tests/passages.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { buildPassages, createEstimatingTokenCounter, hasPassagePartition } from '../utils/passages'

const counter = createEstimatingTokenCounter()
const LONG = `这在论文里是一段很长的正文。${'filler words here '.repeat(40)}`

function joined(passages: { text: string; pieces: { page: number; text: string }[] }[]): string {
  return passages.map(p => p.pieces.map(piece => piece.text).join('')).join('|')
}

describe('buildPassages', () => {
  it('pieces 拼接逐字等于 text', () => {
    const passages = buildPassages(['Intro\nFirst paragraph.\n\nSecond paragraph.', 'Third paragraph.'], counter)
    for (const passage of passages) {
      expect(passage.pieces.map(piece => piece.text).join('')).toBe(passage.text)
      expect(hasPassagePartition(passage)).toBe(true)
    }
  })

  it('标题行并入其后一段的段首，该段落的小节为标题', () => {
    const passages = buildPassages(['Introduction\nWe study X.'], counter, { minTokens: 1 })
    expect(passages).toHaveLength(1)
    expect(passages[0].text.startsWith('Introduction')).toBe(true)
    expect(passages[0].subsection).toBe('Introduction')
  })

  it('不足 minTokens 的段落在小节内向后合并', () => {
    const pages = ['Abstract\nShort one.\n\nShort two.\n\nShort three.']
    const passages = buildPassages(pages, counter, { minTokens: 20 })
    expect(passages).toHaveLength(1)
    expect(passages[0].text).toContain('Short one.')
    expect(passages[0].text).toContain('Short three.')
  })

  it('小节末尾的小段保留，不跨标题合并', () => {
    const pages = ['Introduction\nTiny intro.', 'Related Work\nTiny related work.']
    const passages = buildPassages(pages, counter, { minTokens: 50 })
    expect(passages).toHaveLength(2)
    expect(passages[0].subsection).toBe('Introduction')
    expect(passages[1].subsection).toBe('Related Work')
    expect(passages[0].text).not.toContain('Tiny related work')
  })

  it('超过 maxTokens 的段落在句子边界切开', () => {
    const pages = [`Methods\n${LONG}`]
    const passages = buildPassages(pages, counter, { minTokens: 10, maxTokens: 60 })
    expect(passages.length).toBeGreaterThan(1)
    for (const passage of passages) expect(passage.tokenCount).toBeLessThanOrEqual(120)
  })

  it('跨页自然段按页分片，pieces 页号递增且连续', () => {
    const pages = ['Abstract\nA sentence that continues', 'onto the next page.']
    const passages = buildPassages(pages, counter, { minTokens: 1 })
    expect(passages).toHaveLength(1)
    expect(passages[0].pieces.map(piece => piece.page)).toEqual([0, 1])
    expect(passages[0].pieces[0].text.endsWith('continues')).toBe(true)
  })

  it('searchText 去掉页眉页码，text 保持原文', () => {
    const pages = ['PaperMind Journal Vol 3\nReal content here.\n12', 'PaperMind Journal Vol 3\nMore content.\n13']
    const passages = buildPassages(pages, counter, { minTokens: 1 })
    const all = passages.map(p => p.searchText).join('\n')
    expect(all).not.toContain('PaperMind Journal Vol 3')
    expect(passages.map(p => p.text).join('')).toContain('PaperMind Journal Vol 3')
  })

  it('prevId / nextId 串成有序链', () => {
    const pages = ['A\npara one.\n\npara two.\n\npara three.']
    const passages = buildPassages(pages, counter, { minTokens: 1 })
    expect(passages[0].prevId).toBeNull()
    expect(passages[passages.length - 1].nextId).toBeNull()
    for (let i = 0; i + 1 < passages.length; i++) expect(passages[i].nextId).toBe(passages[i + 1].id)
  })

  it('空输入返回空数组', () => {
    expect(buildPassages([], counter)).toEqual([])
    expect(joined(buildPassages([], counter))).toBe('')
  })
})
```

- [ ] **Step 7: 跑测试确认失败**

Run: `npx vitest run src/tests/passages.test.ts`
Expected: FAIL — `Failed to resolve import "../utils/passages"`

- [ ] **Step 8: 实现 `src/utils/passages.ts`**

```ts
/**
 * 段落切分（方案 §1）——混合检索的最小检索单位。
 *
 * 与证据块（`evidenceBlock.ts`）的分工：证据块服务语义树取证，按字符目标封块；
 * 段落按论文自然段切分，是段落级 BM25 / 向量 / 卡片先验三路打分的坐标。
 * 同一份原文两套切法，互不影响。
 *
 * 不可动摇的不变量：每个段落的 `text` 逐字等于其 `pieces` 的拼接，
 * 且进入上下文的永远是 `text`（原文）；清洗只作用于 `searchText`。
 */
import type { ContextPiece } from './contextTrace'
import { detectRunningLines, normalizeEvidenceText } from './evidenceBlock'
import { isHeadingLine } from './sectionHeadings'

export interface Passage {
  /** 论文内稳定且唯一的段落 ID，形如 `P01` */
  id: string
  order: number
  /** `text` 的逐页精确分区：按序拼接所有 piece 得到 `text` */
  pieces: ContextPiece[]
  /** 原文；进入上下文的唯一来源 */
  text: string
  /** 仅供打分与向量使用的轻度清洗文本（去页眉页脚/页码、复原断词） */
  searchText: string
  /** 由注入的 token 计数器给出，按 piece 累加（与 materializeContext 的计法一致） */
  tokenCount: number
  prevId: string | null
  nextId: string | null
  /** 所属小节标题（标题行文本）；首个标题之前的正文为空串 */
  subsection: string
}

export type TokenCounter = (text: string) => number

export interface PassageOptions {
  /** 自然段低于此 token 数即向后合并，直到达标或遇到小节边界。默认 120 */
  minTokens?: number
  /** 自然段超过此 token 数即在句子边界切开。默认 350 */
  maxTokens?: number
}

export const DEFAULT_PASSAGE_OPTIONS: Required<PassageOptions> = { minTokens: 120, maxTokens: 350 }

/** 4 字符 ≈ 1 token：与 `semanticTree.estimateTokens` 同口径，产品侧不引入真分词器。 */
export function createEstimatingTokenCounter(): TokenCounter {
  return (text: string) => (text.length === 0 ? 0 : Math.max(1, Math.round(text.length / 4)))
}

/** 分片无损校验（形态照抄 `evidenceBlock.hasExactPagePartition`，字段名换成 `text`）。 */
export function hasPassagePartition(passage: unknown): boolean {
  if (!passage || typeof passage !== 'object') return false
  const { pieces, text } = passage as { pieces?: unknown; text?: unknown }
  if (typeof text !== 'string' || !Array.isArray(pieces) || pieces.length === 0) return false
  const typed: ContextPiece[] = []
  for (const piece of pieces) {
    if (!piece || typeof piece !== 'object') return false
    const { page, text: pieceText } = piece as { page?: unknown; text?: unknown }
    if (typeof page !== 'number' || !Number.isInteger(page) || page < 0) return false
    if (typeof pieceText !== 'string') return false
    typed.push({ page, text: pieceText })
  }
  return typed.map(piece => piece.text).join('') === text
}

/** 同一页内的一个连续行块；`breakBefore` 表示它开启一个新自然段（换行符宽度不同）。 */
interface Atom {
  page: number
  text: string
  breakBefore: boolean
}

interface Paragraph {
  atoms: Atom[]
  subsection: string
}

const SENTENCE_END = /[.!?:;。！？：；]["')\]]?$/
const PARAGRAPH_START = /^[A-Z0-9(“"(\[]/

/** 无空行页面里的行级启发式：上一行以句末标点收尾且本行以大写/数字开头即视作新段。 */
function startsNewParagraph(previousLine: string, line: string): boolean {
  if (!previousLine) return true
  if (!SENTENCE_END.test(previousLine)) return false
  return PARAGRAPH_START.test(line)
}

/** 逐页、逐行扫描，产出自然段；标题行并入其后一段的段首并强制开新段。 */
function collectParagraphs(pages: string[]): Paragraph[] {
  const paragraphs: Paragraph[] = []
  let atoms: Atom[] = []
  let subsection = ''
  let paragraphSubsection = ''
  let previousLine = ''

  const flush = () => {
    if (atoms.length > 0) paragraphs.push({ atoms, subsection: paragraphSubsection })
    atoms = []
  }
  const append = (page: number, text: string, breakBefore: boolean) => {
    const last = atoms.at(-1)
    if (last && last.page === page && !breakBefore) last.text += `\n${text}`
    else atoms.push({ page, text, breakBefore })
  }
  const startParagraph = (page: number, text: string) => {
    flush()
    paragraphSubsection = subsection
    append(page, text, true)
  }

  for (let page = 0; page < pages.length; page++) {
    for (const raw of pages[page].split(/\r?\n/)) {
      const text = raw.trim()
      if (!text) {
        flush()
        previousLine = ''
        continue
      }
      const heading = isHeadingLine(text)
      if (heading) {
        // 标题行开启新小节，并并入其后一段的段首（不单独成段）：先关掉当前段
        flush()
        subsection = heading
        paragraphSubsection = heading
        append(page, text, true)
        previousLine = text
        continue
      }
      if (atoms.length === 0 || startsNewParagraph(previousLine, text)) startParagraph(page, text)
      else append(page, text, false)
      previousLine = text
    }
  }
  flush()
  return paragraphs
}

function countParagraphTokens(paragraph: Paragraph, countTokens: TokenCounter): number {
  return paragraph.atoms.reduce((sum, atom) => sum + countTokens(atom.text), 0)
}

/** 不足 minTokens 的段落在同一小节内向后合并；小节边界、标题边界都不跨。 */
function mergeSmallParagraphs(paragraphs: Paragraph[], minTokens: number, countTokens: TokenCounter): Paragraph[] {
  const merged: Paragraph[] = []
  let buffer: Paragraph | undefined
  for (const paragraph of paragraphs) {
    if (buffer && buffer.subsection === paragraph.subsection && countParagraphTokens(buffer, countTokens) < minTokens) {
      buffer = { atoms: [...buffer.atoms, ...paragraph.atoms], subsection: buffer.subsection }
      continue
    }
    if (buffer) merged.push(buffer)
    buffer = paragraph
  }
  if (buffer) merged.push(buffer)
  return merged
}

/** 在句子边界处把超长文本切成长度接近 maxTokens 的片段。 */
function splitLongText(text: string, maxTokens: number, countTokens: TokenCounter): string[] {
  const sentences = text.split(/(?<=[.!?。！？])\s+/).filter(sentence => sentence.length > 0)
  const pieces: string[] = []
  let current = ''
  for (const sentence of sentences) {
    const candidate = current ? `${current} ${sentence}` : sentence
    if (current && countTokens(candidate) > maxTokens) {
      pieces.push(current)
      current = sentence
    } else {
      current = candidate
    }
  }
  if (current) pieces.push(current)
  return pieces
}

/** 超过 maxTokens 的段落按原子边界或句子边界切开。 */
function splitOversizedParagraph(paragraph: Paragraph, maxTokens: number, countTokens: TokenCounter): Paragraph[] {
  const out: Paragraph[] = []
  let current: Atom[] = []
  let currentTokens = 0
  const flush = () => {
    if (current.length > 0) out.push({ atoms: current, subsection: paragraph.subsection })
    current = []
    currentTokens = 0
  }

  for (const atom of paragraph.atoms) {
    const atomTokens = countTokens(atom.text)
    if (atomTokens > maxTokens) {
      flush()
      for (const piece of splitLongText(atom.text, maxTokens, countTokens)) {
        out.push({ atoms: [{ page: atom.page, text: piece, breakBefore: true }], subsection: paragraph.subsection })
      }
      continue
    }
    if (current.length > 0 && currentTokens + atomTokens > maxTokens) flush()
    current.push(atom)
    currentTokens += atomTokens
  }
  flush()
  return out
}

/** 原子序列 → 逐页精确分片：新段落前缀 `\n\n`，同段落跨页前缀 `\n`。 */
function atomsToPieces(atoms: Atom[]): ContextPiece[] {
  const pieces: ContextPiece[] = []
  atoms.forEach((atom, index) => {
    const prefix = index === 0 ? '' : atom.breakBefore ? '\n\n' : '\n'
    const fragment = `${prefix}${atom.text}`
    const last = pieces.at(-1)
    if (last && last.page === atom.page) last.text += fragment
    else pieces.push({ page: atom.page, text: fragment })
  })
  return pieces
}

export function buildPassages(
  pages: string[],
  countTokens: TokenCounter,
  opts: PassageOptions = {},
): Passage[] {
  const minTokens = opts.minTokens ?? DEFAULT_PASSAGE_OPTIONS.minTokens
  const maxTokens = opts.maxTokens ?? DEFAULT_PASSAGE_OPTIONS.maxTokens
  if (!Number.isInteger(minTokens) || minTokens <= 0) throw new Error('minTokens 必须是正整数')
  if (!Number.isInteger(maxTokens) || maxTokens < minTokens) throw new Error('maxTokens 必须是不小于 minTokens 的整数')
  if (pages.length === 0) return []

  const runningLines = detectRunningLines(pages)
  const merged = mergeSmallParagraphs(collectParagraphs(pages), minTokens, countTokens)
  const groups = merged.flatMap(paragraph => splitOversizedParagraph(paragraph, maxTokens, countTokens))

  const passages: Passage[] = groups.map((group, index) => {
    const pieces = atomsToPieces(group.atoms)
    const text = pieces.map(piece => piece.text).join('')
    const id = `P${String(index + 1).padStart(2, '0')}`
    if (!hasPassagePartition({ pieces, text })) throw new Error(`段落 ${id} 的分片与原文不一致`)
    return {
      id,
      order: index,
      pieces,
      text,
      searchText: normalizeEvidenceText(text, runningLines),
      tokenCount: pieces.reduce((sum, piece) => sum + countTokens(piece.text), 0),
      prevId: null,
      nextId: null,
      subsection: group.subsection,
    }
  })

  for (let i = 0; i < passages.length; i++) {
    passages[i].prevId = i > 0 ? passages[i - 1].id : null
    passages[i].nextId = i + 1 < passages.length ? passages[i + 1].id : null
  }
  return passages
}
```

- [ ] **Step 9: 跑测试确认通过**

Run: `npx vitest run src/tests/passages.test.ts && npm run typecheck`
Expected: PASS（9 个用例），typecheck 干净

- [ ] **Step 10: 提交**

```bash
git add src/utils/sectionHeadings.ts src/utils/passages.ts src/tests/sectionHeadings.test.ts src/tests/passages.test.ts bench/src/baselines/sections.ts
git commit -m "feat(retrieval): add passage segmentation with shared heading detection"
```

---

### Task 2: 词法检索与 RRF 原语移入 `src/utils`

**Files:**
- Create: `src/utils/lexicalTokenizer.ts`, `src/utils/bm25.ts`, `src/utils/rrf.ts`
- Modify: `bench/src/traditionalRag/lexicalTokenizer.ts`, `bench/src/traditionalRag/bm25.ts`, `bench/src/baselines/rrf.ts`
- Test: `src/tests/bm25.test.ts`, `src/tests/rrf.test.ts`

- [ ] **Step 1: 写失败测试**

`src/tests/bm25.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { buildBm25Scorer } from '../utils/bm25'

describe('buildBm25Scorer', () => {
  const texts = [
    'We evaluate on Europarl and MultiUN datasets.',
    'The model uses a transformer encoder with attention.',
    'Attention is all you need for sequence transduction.',
  ]

  it('给含查询词的文档更高分，并返回全部文档的分数', () => {
    const scores = buildBm25Scorer(texts)('Europarl datasets')
    expect(scores).toHaveLength(texts.length)
    expect(scores[0].score).toBeGreaterThan(scores[1].score)
  })

  it('id 即输入下标，便于回填候选', () => {
    const scores = buildBm25Scorer(texts)('attention')
    expect(scores.map(item => item.id)).toEqual([0, 1, 2])
    expect(scores[2].score).toBeGreaterThan(scores[0].score)
  })

  it('空文档集合返回全零而不抛错', () => {
    expect(buildBm25Scorer([])('anything')).toEqual([])
  })

  it('查询词完全不在文档中时全零', () => {
    expect(buildBm25Scorer(texts)('zzzqqq').every(item => item.score === 0)).toBe(true)
  })
})
```

`src/tests/rrf.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { reciprocalRankFusion } from '../utils/rrf'

const list = (...scores: number[]) => scores.map((score, id) => ({ id, score }))

describe('reciprocalRankFusion', () => {
  it('同一名次在多路出现者得分更高', () => {
    const fused = reciprocalRankFusion([list(3, 2, 1), list(3, 1, 2)], 60)
    expect(fused.map(item => item.id)).toEqual([0, 1, 2])
  })

  it('并列按 id 升序，保证确定性', () => {
    const fused = reciprocalRankFusion([list(1, 1), list(1, 1)], 60)
    expect(fused.map(item => item.id)).toEqual([0, 1])
  })

  it('权重 0 等价于该路不参与', () => {
    const two = reciprocalRankFusion([list(5, 1), list(1, 5)], 60)
    const three = reciprocalRankFusion([list(5, 1), list(1, 5), list(9, 9)], 60, [1, 1, 0])
    expect(three).toEqual(two)
  })

  it('权重改变卡片路的名次贡献', () => {
    const noPrior = reciprocalRankFusion([list(2, 1)], 60, [1])
    const withPrior = reciprocalRankFusion([list(2, 1), list(1, 2)], 60, [1, 1])
    expect(noPrior[0].id).toBe(0)
    expect(withPrior[0].id).toBe(1)
  })

  it('非法 k 与权重直接抛错', () => {
    expect(() => reciprocalRankFusion([list(1)], 0)).toThrow()
    expect(() => reciprocalRankFusion([list(1), list(1)], 60, [1])).toThrow()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/tests/bm25.test.ts src/tests/rrf.test.ts`
Expected: FAIL — 无法解析 `../utils/bm25` / `../utils/rrf`

- [ ] **Step 3: 实现三个模块**

`src/utils/lexicalTokenizer.ts`：把 `bench/src/traditionalRag/lexicalTokenizer.ts` 的内容**整体搬运**过来（`Intl.Segmenter` 分词 + 小写化 + 标点过滤），只把错误文案改成与运行环境无关的写法：

```ts
/**
 * 词法分词（自 `bench/src/traditionalRag/lexicalTokenizer.ts` 移入）：产品与
 * 传统 RAG 基线必须用同一份分词口径，否则 BM25 的分数不可比。
 */
const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl
  ? new Intl.Segmenter('en', { granularity: 'word' })
  : undefined

/** 词法 token 化：小写化 + 只保留含字母/数字的词元。 */
export function lexicalTokenize(text: string): string[] {
  if (!segmenter) throw new Error('当前环境不支持 Intl.Segmenter，词法检索无法运行')
  const tokens: string[] = []
  for (const segment of segmenter.segment(text)) {
    if (!segment.isWordLike) continue
    const token = segment.segment.toLowerCase()
    if (/[a-z0-9]/.test(token)) tokens.push(token)
  }
  return tokens
}
```

> 搬运时**逐字保留**原文件已有的分词细节（若原实现有额外的大小写/数字处理，以原文件为准——这里不重新发明口径）。

`src/utils/bm25.ts`：

```ts
/**
 * BM25 打分（自 `bench/src/traditionalRag/bm25.ts` 移入）。参数固定 k1=1.2 / b=0.75
 * （方案 §4.2），因此不暴露到配置之外。
 */
import { lexicalTokenize } from './lexicalTokenizer'

export interface ScoredDoc {
  /** 传入文本数组时的下标，调用方据此回填候选 */
  id: number
  score: number
}

export interface Bm25Options {
  k1?: number
  b?: number
}

/**
 * 返回一个查询函数：对给定 query 给**全部文档**打分（不做截断，
 * 名次由融合层决定）。统计量现算不落盘（方案 §4.2）。
 */
export function buildBm25Scorer(texts: string[], options: Bm25Options = {}): (query: string) => ScoredDoc[] {
  const k1 = options.k1 ?? 1.2
  const b = options.b ?? 0.75
  const docs = texts.map(text => lexicalTokenize(text))
  const lengths = docs.map(doc => doc.length)
  const docCount = docs.length
  const avgdl = docCount > 0 ? lengths.reduce((sum, length) => sum + length, 0) / docCount : 0
  const termFreqs = docs.map(doc => {
    const frequencies = new Map<string, number>()
    for (const token of doc) frequencies.set(token, (frequencies.get(token) ?? 0) + 1)
    return frequencies
  })
  const docFreqs = new Map<string, number>()
  for (const frequencies of termFreqs) {
    for (const token of frequencies.keys()) docFreqs.set(token, (docFreqs.get(token) ?? 0) + 1)
  }

  return (query: string): ScoredDoc[] => {
    const terms = lexicalTokenize(query)
    return texts.map((_, index) => {
      let score = 0
      for (const term of terms) {
        const tf = termFreqs[index].get(term) ?? 0
        if (tf === 0 || avgdl === 0) continue
        const n = docFreqs.get(term) ?? 0
        const idf = Math.log(1 + (docCount - n + 0.5) / (n + 0.5))
        score += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * lengths[index]) / avgdl))
      }
      return { id: index, score: Number.isFinite(score) ? score : 0 }
    })
  }
}
```

`src/utils/rrf.ts`：

```ts
/**
 * 加权倒数名次融合（自 `bench/src/baselines/rrf.ts` 移入并加权重）。
 * 名次 1-based：`score = Σ w_i / (k + rank_i)`。
 */
export interface RankedItem {
  id: number
  score: number
}

export function reciprocalRankFusion(lists: RankedItem[][], k: number, weights?: number[]): RankedItem[] {
  if (!Number.isFinite(k) || k <= 0) throw new Error('RRF k 必须为正数')
  if (weights && (weights.length !== lists.length || weights.some(w => !Number.isFinite(w)))) {
    throw new Error('RRF 权重必须与排名路数一致且为有限数')
  }
  const scores = new Map<number, number>()
  lists.forEach((list, listIndex) => {
    const weight = weights?.[listIndex] ?? 1
    const ranked = [...list].sort((a, b) => b.score - a.score || a.id - b.id)
    ranked.forEach((item, rank) => {
      scores.set(item.id, (scores.get(item.id) ?? 0) + weight / (k + rank + 1))
    })
  })
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || a.id - b.id)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/tests/bm25.test.ts src/tests/rrf.test.ts`
Expected: PASS（9 个用例）

- [ ] **Step 5: bench 侧改成再导出**

三个文件都改成薄再导出，原实现整段删除：

```ts
// bench/src/traditionalRag/lexicalTokenizer.ts
/** 已移入 `src/utils/lexicalTokenizer.ts`：产品 BM25 与传统 RAG 基线必须共用分词口径。 */
export { lexicalTokenize } from '../../../src/utils/lexicalTokenizer'

// bench/src/traditionalRag/bm25.ts
/** BM25 原语已移入 `src/utils/bm25.ts`（生产段落检索与基线共用）。 */
export { buildBm25Scorer, type Bm25Options, type ScoredDoc } from '../../../src/utils/bm25'
// 保留 bench 自己的 buildBm25Retriever 包装（若原文件有）：它把下标映射回 chunk id
import { buildBm25Scorer } from '../../../src/utils/bm25'
// …原 buildBm25Retriever 函数体不变，内部改调 buildBm25Scorer(chunks.map(c => c.text), options)

// bench/src/baselines/rrf.ts
/** RRF 原语已移入 `src/utils/rrf.ts`（加了可选权重参数，签名向后兼容）。 */
export { reciprocalRankFusion } from '../../../src/utils/rrf'
```

- [ ] **Step 6: 跑 bench 测试 + 类型检查**

Run: `npx vitest run bench/src/tests && npm run typecheck`
Expected: PASS（`hybrid-rerank` 与传统 RAG 的既有测试全绿）

- [ ] **Step 7: 提交**

```bash
git add src/utils/lexicalTokenizer.ts src/utils/bm25.ts src/utils/rrf.ts src/tests/bm25.test.ts src/tests/rrf.test.ts bench/src/traditionalRag bench/src/baselines/rrf.ts
git commit -m "refactor(retrieval): move bm25 and rrf primitives into src/utils"
```

---

### Task 3: 向量接口与编码

**Files:**
- Create: `src/utils/embedder.ts`, `src/utils/modelCache.ts`, `src/utils/transformersEmbedder.ts`
- Modify: `package.json`, `vite.config.ts`, `.gitignore`
- Test: `src/tests/embedder.test.ts`, `src/tests/modelCache.test.ts`

- [ ] **Step 1: 写失败测试**

`src/tests/embedder.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest'
import {
  QUERY_INSTRUCTION, cosineSimilarity, createEmbedder, decodeVectors, embedderId, encodeVectors,
} from '../utils/embedder'
import { cardEmbedText } from '../utils/embedder'

describe('createEmbedder', () => {
  it('查询侧加 bge 指令前缀，段落侧不加', async () => {
    const embed = vi.fn(async (texts: string[]) => texts.map(() => new Float32Array([1, 0])))
    const embedder = createEmbedder({ id: 'fake', embed })
    await embedder.embedQuery('what datasets?')
    expect(embed).toHaveBeenCalledWith([`${QUERY_INSTRUCTION}what datasets?`])
    await embedder.embedPassages(['raw passage'])
    expect(embed).toHaveBeenLastCalledWith(['raw passage'])
  })

  it('空段落数组不发请求', async () => {
    const embed = vi.fn(async (texts: string[]) => texts.map(() => new Float32Array([1])))
    const embedder = createEmbedder({ id: 'fake', embed })
    expect(await embedder.embedPassages([])).toEqual([])
    expect(embed).not.toHaveBeenCalled()
  })

  it('模型返回空结果时查询向量视为缺失', async () => {
    const embedder = createEmbedder({ id: 'fake', embed: async () => [] })
    await expect(embedder.embedQuery('x')).rejects.toThrow()
  })
})

describe('embedderId', () => {
  it('包含模型 / revision / 量化，任一变化即换身份', () => {
    expect(embedderId('Xenova/bge-small-en-v1.5', 'main', 'q8')).toBe('Xenova/bge-small-en-v1.5@main#q8')
    expect(embedderId('Xenova/bge-small-en-v1.5', 'main', 'fp32')).not.toBe(embedderId('Xenova/bge-small-en-v1.5', 'main', 'q8'))
  })
})

describe('cosineSimilarity', () => {
  it('同向为 1、正交为 0、反向为 -1', () => {
    expect(cosineSimilarity(new Float32Array([1, 1]), new Float32Array([2, 2]))).toBeCloseTo(1)
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBeCloseTo(0)
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([-1, 0]))).toBeCloseTo(-1)
  })

  it('零向量得 0 而不 NaN', () => {
    expect(cosineSimilarity(new Float32Array([0, 0]), new Float32Array([1, 1]))).toBe(0)
  })

  it('维度不一致直接抛错', () => {
    expect(() => cosineSimilarity(new Float32Array([1]), new Float32Array([1, 2]))).toThrow()
  })
})

describe('向量编解码', () => {
  it('encode → decode 逐值还原', () => {
    const vectors = [new Float32Array([1, -0.5, 0.25]), new Float32Array([0, 0, 0])]
    const decoded = decodeVectors(encodeVectors(vectors), 3)
    expect(decoded).toHaveLength(2)
    expect([...decoded![1]]).toEqual([0, 0, 0])
    expect(decoded![0][1]).toBeCloseTo(-0.5)
  })

  it('长度与维度不符时解析失败', () => {
    expect(decodeVectors(encodeVectors([new Float32Array([1, 2])]), 3)).toBeUndefined()
  })
})

describe('cardEmbedText', () => {
  it('拼接标题、摘要与 keyTerms', () => {
    expect(cardEmbedText({ id: 'S1', range: ['P01', 'P02'], title: 'Datasets', summary: 'Europarl.', keyTerms: ['data', 'corpora'] }))
      .toBe('Datasets. Europarl. Key terms: data, corpora')
  })
})
```

`src/tests/modelCache.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { createModelFileCache, type KeyValueStore } from '../utils/modelCache'

function memoryStore(): KeyValueStore & { size(): number } {
  const map = new Map<string, ArrayBuffer>()
  return {
    async get(key) { return map.get(key) },
    async put(key, value) { map.set(key, value) },
    size: () => map.size,
  }
}

describe('createModelFileCache', () => {
  it('未命中返回 undefined，命中返回可读的 Response', async () => {
    const cache = createModelFileCache(memoryStore())
    expect(await cache.match('https://example.com/model.onnx')).toBeUndefined()
    await cache.put('https://example.com/model.onnx', new Response(new Uint8Array([1, 2, 3])))
    const hit = await cache.match('https://example.com/model.onnx')
    expect(new Uint8Array(await hit!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('同一个 key 覆写后读回新内容', async () => {
    const cache = createModelFileCache(memoryStore())
    await cache.put('k', new Response(new Uint8Array([1])))
    await cache.put('k', new Response(new Uint8Array([2])))
    expect(new Uint8Array(await (await cache.match('k'))!.arrayBuffer())).toEqual(new Uint8Array([2]))
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/tests/embedder.test.ts src/tests/modelCache.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 `src/utils/embedder.ts`**

```ts
/**
 * 向量模型接口（方案 §3）。真实实现（`transformersEmbedder.ts`）动态 import
 * `@huggingface/transformers`，因此 jsdom 单测永远不加载它；测试注入假实现。
 */
import type { Passage } from './passages'

/** 卡片只用标题建向量时的输入构造（回落卡片没有 summary / keyTerms）。 */
export interface EmbeddableCard {
  title: string
  summary: string
  keyTerms: string[]
}

export interface Embedder {
  /** 模型 + revision + 量化方式；进入索引缓存身份（`passageIndex.embedderId`） */
  readonly id: string
  embedQuery(text: string): Promise<Float32Array>
  embedPassages(texts: string[]): Promise<Float32Array[]>
}

export const BGE_SMALL_MODEL = 'Xenova/bge-small-en-v1.5'
export const BGE_SMALL_REVISION = 'main'
export const BGE_SMALL_DTYPE = 'q8'
export const BGE_SMALL_DIM = 384

/** bge 系列检索是非对称的：查询侧必须带指令前缀，段落 / 卡片侧不加。 */
export const QUERY_INSTRUCTION = 'Represent this sentence for searching relevant passages: '

export function embedderId(model: string, revision: string, dtype: string): string {
  return `${model}@${revision}#${dtype}`
}

/** 段落向量输入：清洗后的段落文本，不加前缀。 */
export function passageEmbedText(passage: Passage): string {
  return passage.searchText
}

/** 卡片向量输入：title + ". " + summary + " Key terms: " + keyTerms。 */
export function cardEmbedText(card: EmbeddableCard): string {
  const terms = card.keyTerms.length > 0 ? ` Key terms: ${card.keyTerms.join(', ')}` : ''
  const summary = card.summary ? `${card.summary}` : ''
  return `${card.title}. ${summary}${terms}`.trim().replace(/\s+/g, ' ')
}

export function createEmbedder(deps: {
  id: string
  embed: (texts: string[]) => Promise<Float32Array[]>
}): Embedder {
  return {
    id: deps.id,
    async embedQuery(text: string): Promise<Float32Array> {
      const [vector] = await deps.embed([QUERY_INSTRUCTION + text])
      if (!vector) throw new Error('向量模型未返回查询向量')
      return vector
    },
    embedPassages: (texts: string[]): Promise<Float32Array[]> =>
      texts.length === 0 ? Promise.resolve([]) : deps.embed(texts),
  }
}

/** 余弦相似度；零向量返回 0（不产生 NaN 污染排序）。 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error('向量维度不一致')
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB)
  return denominator === 0 ? 0 : dot / denominator
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** 一组等长向量 → base64（Float32Array 原始字节，小端）。落盘前统一走这里。 */
export function encodeVectors(vectors: Float32Array[]): string {
  const dim = vectors[0]?.length ?? 0
  const flat = new Float32Array(vectors.length * dim)
  vectors.forEach((vector, index) => flat.set(vector, index * dim))
  return toBase64(new Uint8Array(flat.buffer, flat.byteOffset, flat.byteLength))
}

/** base64 → 等长向量；长度不是 dim 的整数倍时返回 undefined（视为索引损坏）。 */
export function decodeVectors(value: string, dim: number): Float32Array[] | undefined {
  if (dim <= 0) return undefined
  let bytes: Uint8Array
  try {
    bytes = fromBase64(value)
  } catch {
    return undefined
  }
  if (bytes.byteLength % (dim * 4) !== 0) return undefined
  const count = bytes.byteLength / (dim * 4)
  const flat = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  const vectors: Float32Array[] = []
  for (let i = 0; i < count; i++) vectors.push(flat.slice(i * dim, (i + 1) * dim))
  return vectors
}
```

> `decodeVectors` 用 `bytes.buffer.slice(...)` 保证拷贝后的 `Float32Array` 与原始 buffer 对齐（base64 解码结果的 `byteOffset` 恒为 0，但显式 slice 避免后续改动踩坑）。

- [ ] **Step 4: 实现 `src/utils/modelCache.ts`**

```ts
/**
 * 提供给 transformers.js 的自定义文件缓存（`env.useCustomCache`）。
 * 默认的浏览器 Cache API 在打包后的 `file://` 页面不保证可用，而「首次下载后离线可用」
 * 是阶段②③ 的前提；IndexedDB 在 Electron 的 file:// 页面下可用。
 */
export interface KeyValueStore {
  get(key: string): Promise<ArrayBuffer | undefined>
  put(key: string, value: ArrayBuffer): Promise<void>
}

export interface ModelFileCache {
  match(request: string): Promise<Response | undefined>
  put(request: string, response: Response): Promise<void>
}

/** transformers.js 的 `env.customCache` 形态（match / put 语义同 Web Cache API）。 */
export function createModelFileCache(store: KeyValueStore): ModelFileCache {
  return {
    async match(request: string): Promise<Response | undefined> {
      const buffer = await store.get(request)
      if (!buffer) return undefined
      return new Response(buffer)
    },
    async put(request: string, response: Response): Promise<void> {
      await store.put(request, await response.arrayBuffer())
    },
  }
}

/** IndexedDB 后端；库/表不存在时自动创建。 */
export function createIdbStore(dbName = 'papermind-model-cache', storeName = 'files'): KeyValueStore {
  let dbPromise: Promise<IDBDatabase> | undefined
  const open = (): Promise<IDBDatabase> => {
    dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(dbName, 1)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName)
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('打开模型缓存失败'))
    })
    return dbPromise
  }
  const run = <T>(mode: IDBTransactionMode, request: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
    open().then(db => new Promise<T>((resolve, reject) => {
      const tx = db.transaction(storeName, mode)
      const pending = request(tx.objectStore(storeName))
      pending.onsuccess = () => resolve(pending.result)
      pending.onerror = () => reject(pending.error ?? new Error('模型缓存读写失败'))
    }))

  return {
    get: key => run<ArrayBuffer | undefined>('readonly', store => store.get(key) as IDBRequest<ArrayBuffer | undefined>),
    put: (key, value) => run<IDBValidKey>('readwrite', store => store.put(value, key)).then(() => undefined),
  }
}
```

- [ ] **Step 5: 实现 `src/utils/transformersEmbedder.ts`**

```ts
/**
 * 真实向量模型：`Xenova/bge-small-en-v1.5`（int8 量化，384 维）。
 *
 * 与 bench 共用同一份权重与接口：渲染层由 Vite 解析到 web 构建（WASM），
 * bench 在 Node 下解析到 node 构建（onnxruntime-node）。
 * 动态 import 让 jsdom 单测永远不加载这个模块。
 */
import {
  BGE_SMALL_DIM, BGE_SMALL_DTYPE, BGE_SMALL_MODEL, BGE_SMALL_REVISION,
  createEmbedder, embedderId, type Embedder,
} from './embedder'
import { createIdbStore, createModelFileCache, type ModelFileCache } from './modelCache'

/** 单批前向传播的文本数：WASM 下单批过大会陡增内存占用。 */
export const EMBED_BATCH_SIZE = 16

export interface TransformersEmbedderOptions {
  model?: string
  revision?: string
  dtype?: string
  /** onnxruntime-web 的 wasm 资源目录；产品传 './ort/'，bench 走 node 后端时不传 */
  wasmPaths?: string
  /** 模型文件缓存；缺省用 IndexedDB */
  cache?: ModelFileCache
}

export async function createTransformersEmbedder(options: TransformersEmbedderOptions = {}): Promise<Embedder> {
  const model = options.model ?? BGE_SMALL_MODEL
  const revision = options.revision ?? BGE_SMALL_REVISION
  const dtype = options.dtype ?? BGE_SMALL_DTYPE

  const transformers = await import('@huggingface/transformers')
  const env = transformers.env as unknown as Record<string, unknown>
  env.useCustomCache = true
  env.customCache = options.cache ?? createModelFileCache(createIdbStore())

  const wasm = (env.backends as { onnx?: { wasm?: { wasmPaths?: string; numThreads?: number; proxy?: boolean } } } | undefined)?.onnx?.wasm
  if (wasm && options.wasmPaths) {
    // 资源随包发布在 ./ort/（vite.config.ts 启动时拷贝）：打包后是 file:// 页面，不能走 CDN
    wasm.wasmPaths = options.wasmPaths
    // 多线程 wasm 需要 SharedArrayBuffer，而页面没有 crossOriginIsolated；强制单线程
    wasm.numThreads = 1
  }

  const extractor = await transformers.pipeline('feature-extraction', model, { revision, dtype })
  const embed = async (texts: string[]): Promise<Float32Array[]> => {
    const vectors: Float32Array[] = []
    for (let start = 0; start < texts.length; start += EMBED_BATCH_SIZE) {
      const batch = texts.slice(start, start + EMBED_BATCH_SIZE)
      const output = await extractor(batch, { pooling: 'cls', normalize: true }) as unknown as {
        data: Float32Array
        dims: number[]
      }
      const width = output.dims.at(-1) ?? 0
      if (width <= 0 || output.data.length !== batch.length * width) throw new Error('向量输出维度异常')
      if (width !== BGE_SMALL_DIM) throw new Error(`向量维度 ${width} 与约定 ${BGE_SMALL_DIM} 不一致`)
      for (let i = 0; i < batch.length; i++) vectors.push(output.data.slice(i * width, (i + 1) * width))
    }
    return vectors
  }
  return createEmbedder({ id: embedderId(model, revision, dtype), embed })
}
```

- [ ] **Step 6: 依赖与构建资源接线**

`package.json`：把 `@huggingface/transformers` 从 `devDependencies` 挪到 `dependencies`（它是运行期依赖，打包必须带上）。版本保持 `^3.8.1` 不变。

`vite.config.ts`：仿照现成的 `pdf.worker.min.mjs` 拷贝逻辑，在同一个启动钩子里追加 ORT 资源拷贝：

```ts
// onnxruntime-web 的 wasm 运行时资源：随包发布到 public/ort/，
// 供 src/utils/transformersEmbedder.ts 以 wasmPaths='./ort/' 加载。
// 打包后是 file:// 页面，不能从 CDN 取，而向量模型离线可用是阶段②③ 的前提。
const ORT_ASSETS = [
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.jsep.mjs',
]
try {
  mkdirSync(resolve(__dirname, 'public/ort'), { recursive: true })
  for (const asset of ORT_ASSETS) {
    copyFileSync(
      resolve(__dirname, 'node_modules/onnxruntime-web/dist', asset),
      resolve(__dirname, 'public/ort', asset),
    )
  }
} catch {
  // 依赖缺失时不阻断 dev / build：向量模型不可用时检索退化为阶段①
}
```

`.gitignore`：在 `public/pdf.worker.min.mjs` 旁追加 `public/ort/`（与 pdf worker 同样是构建产物拷贝）。

- [ ] **Step 7: 跑测试 + 类型检查**

Run: `npx vitest run src/tests/embedder.test.ts src/tests/modelCache.test.ts && npm run typecheck`
Expected: PASS（10 + 2 个用例）

- [ ] **Step 8: 提交**

```bash
git add src/utils/embedder.ts src/utils/modelCache.ts src/utils/transformersEmbedder.ts src/tests/embedder.test.ts src/tests/modelCache.test.ts package.json vite.config.ts .gitignore
git commit -m "feat(retrieval): add local embedding interface with offline model cache"
```

---

### Task 4: 结构卡片

**Files:**
- Create: `src/utils/structureCards.ts`
- Test: `src/tests/structureCards.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it, vi } from 'vitest'
import { buildPassages, createEstimatingTokenCounter } from '../utils/passages'
import {
  MAX_KEY_TERMS, MIN_STRUCTURE_CARDS, StructureCardError,
  buildStructureCardPrompt, buildStructureCards, buildTitleCards, cardsToIndexNodes,
  parseStructureCards, validateStructureCards,
} from '../utils/structureCards'

const counter = createEstimatingTokenCounter()
const PAGES = [
  'Abstract\nWe study retrieval.\n\nIntroduction\nRetrieval matters a lot.\n\nMethods\nWe use BM25 and a dense encoder.\n\nExperiments\nWe evaluate on Europarl and MultiUN.',
]
const passages = buildPassages(PAGES, counter, { minTokens: 1 })

const valid = {
  paper: { title: 'Retrieval Study', summary: 'A study of retrieval.' },
  sections: [
    { id: 'S1', range: ['P01', 'P02'], title: 'Motivation for retrieval', summary: 'Retrieval matters.', keyTerms: ['retrieval', 'motivation'] },
    { id: 'S2', range: ['P03', 'P04'], title: 'BM25 and dense encoders', summary: 'We use BM25.', keyTerms: ['bm25', 'encoder'] },
    { id: 'S3', range: ['P05', 'P06'], title: 'Europarl evaluation setup', summary: 'Europarl and MultiUN.', keyTerms: ['datasets', 'evaluation data'] },
  ],
}

describe('buildStructureCardPrompt', () => {
  it('包含每一个段落 ID 与段落原文', () => {
    const prompt = buildStructureCardPrompt(passages)
    for (const passage of passages) {
      expect(prompt).toContain(`[${passage.id}]`)
      expect(prompt).toContain(passage.text.slice(0, 20))
    }
  })
})

describe('validateStructureCards', () => {
  it('合法输出通过并保留 paper', () => {
    const result = validateStructureCards(valid, passages)
    expect(result.ok).toBe(true)
    expect(result.cards).toHaveLength(3)
    expect(result.paper?.title).toBe('Retrieval Study')
  })

  it('卡片数低于下限判非法', () => {
    const few = { sections: valid.sections.slice(0, MIN_STRUCTURE_CARDS - 1).map((s, i) => ({ ...s, range: i === 0 ? ['P01', 'P06'] : s.range })) }
    expect(validateStructureCards(few, passages).failure).toBe('invalid-structure')
  })

  it('范围有遗漏或重叠判非法', () => {
    const overlap = { sections: [valid.sections[0], { ...valid.sections[1], range: ['P02', 'P04'] }, valid.sections[2]] }
    expect(validateStructureCards(overlap, passages).ok).toBe(false)
  })

  it('范围乱序判非法', () => {
    const shuffled = { sections: [valid.sections[1], valid.sections[0], valid.sections[2]] }
    expect(validateStructureCards(shuffled, passages).ok).toBe(false)
  })

  it('引用不存在的段落判非法', () => {
    const bogus = { sections: [valid.sections[0], { ...valid.sections[1], range: ['P99', 'P04'] }, valid.sections[2]] }
    expect(validateStructureCards(bogus, passages).ok).toBe(false)
  })

  it('通用章节名判非法', () => {
    const generic = { sections: [{ ...valid.sections[0], title: 'Introduction' }, valid.sections[1], valid.sections[2]] }
    expect(validateStructureCards(generic, passages).failure).toBe('invalid-structure')
  })

  it('keyTerms 越界或含空串判非法', () => {
    const tooMany = { sections: [{ ...valid.sections[0], keyTerms: Array.from({ length: MAX_KEY_TERMS + 1 }, (_, i) => `t${i}`) }, valid.sections[1], valid.sections[2]] }
    expect(validateStructureCards(tooMany, passages).ok).toBe(false)
    const blank = { sections: [{ ...valid.sections[0], keyTerms: ['ok', '  '] }, valid.sections[1], valid.sections[2]] }
    expect(validateStructureCards(blank, passages).ok).toBe(false)
  })

  it('缺 sections 数组判非法', () => {
    expect(validateStructureCards({ paper: {} }, passages).failure).toBe('invalid-structure')
  })
})

describe('parseStructureCards', () => {
  it('剥离代码围栏与前后解释文字', () => {
    expect(parseStructureCards('```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(parseStructureCards('好的：{"a":1} 以上。')).toEqual({ a: 1 })
  })

  it('无 JSON 或 JSON 非法时抛 invalid-json', () => {
    expect(() => parseStructureCards('没有 JSON')).toThrow(StructureCardError)
    expect(() => parseStructureCards('{oops}')).toThrow(StructureCardError)
  })
})

describe('buildStructureCards', () => {
  const llm = vi.fn(async () => JSON.stringify(valid))

  it('恰好一次调用并返回卡片与元信息', async () => {
    const result = await buildStructureCards(passages, llm)
    expect(llm).toHaveBeenCalledTimes(1)
    expect(result.cards).toHaveLength(3)
    expect(result.meta.llmCalls).toBe(1)
    expect(result.meta.inputChars).toBeGreaterThan(0)
  })

  it('输入超上限直接 input-too-large 且零成本', async () => {
    const sparse = vi.fn(async () => '')
    await expect(buildStructureCards(passages, sparse, { maxInputChars: 10 })).rejects.toMatchObject({
      reason: 'input-too-large',
      cost: undefined,
    })
    expect(sparse).not.toHaveBeenCalled()
  })

  it('调用失败带 request-failed 与已发生成本', async () => {
    const failing = vi.fn(async () => { throw new Error('boom') })
    await expect(buildStructureCards(passages, failing)).rejects.toMatchObject({
      reason: 'request-failed',
      cost: { llmCalls: 1 },
    })
  })

  it('校验不通过带 invalid-structure 与已发生成本', async () => {
    const bad = vi.fn(async () => JSON.stringify({ sections: [] }))
    await expect(buildStructureCards(passages, bad)).rejects.toMatchObject({
      reason: 'invalid-structure',
      cost: { llmCalls: 1 },
    })
  })

  it('没有段落时按 no-passages 回落', async () => {
    await expect(buildStructureCards([], llm)).rejects.toMatchObject({ reason: 'no-passages' })
  })
})

describe('buildTitleCards', () => {
  it('按标题行分小节，每小节一张只有标题的卡片，覆盖全部段落', () => {
    const cards = buildTitleCards(passages)
    expect(cards.length).toBeGreaterThan(0)
    expect(cards[0].range[0]).toBe(passages[0].id)
    expect(cards[cards.length - 1].range[1]).toBe(passages[passages.length - 1].id)
    for (const card of cards) {
      expect(card.summary).toBe('')
      expect(card.keyTerms).toEqual([])
    }
  })
})

describe('cardsToIndexNodes', () => {
  it('由卡片推导叶节点，页区间来自覆盖段落', () => {
    const tree = cardsToIndexNodes(buildTitleCards(passages), passages)
    expect(tree.nodes.length).toBeGreaterThan(0)
    for (const node of tree.nodes) {
      expect(node.startPage).toBeGreaterThanOrEqual(0)
      expect(node.endPage).toBeGreaterThanOrEqual(node.startPage)
      expect(node.nodes).toEqual([])
    }
    expect(tree.startPage).toBe(0)
    expect(tree.nodes[tree.nodes.length - 1].endPage).toBe(tree.endPage)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/tests/structureCards.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 `src/utils/structureCards.ts`**

```ts
/**
 * 结构卡片（方案 §2）：冷启动每篇论文**唯一一次** LLM 调用。
 *
 * 卡片不进上下文、不作为事实依据，只做两件事：把段落按主题归组（使「整片相关」
 * 成为段落的加分项），以及用模型写出的 summary / keyTerms 补上段落原文里没有的提问用词。
 * 校验不通过即整份作废，**不重试、不修补**，直接标题卡片回落（方案 §2.3 / §2.4）。
 */
import type { IndexNode } from './pageIndex'
import type { LLMFn } from './llm'
import type { Passage } from './passages'
import { DEFAULT_MAX_INPUT_CHARS, isGenericSectionLabel } from './semanticTree'

export const STRUCTURE_CARD_PROMPT_VERSION = 'v1'
export const MIN_STRUCTURE_CARDS = 3
export const MAX_STRUCTURE_CARDS = 10
export const MIN_KEY_TERMS = 1
export const MAX_KEY_TERMS = 12

/** 卡片作废的原因；`no-passages` 是设计文档四种原因之外的补充（论文无文本）。 */
export type StructureFallbackReason =
  | 'request-failed'
  | 'invalid-json'
  | 'invalid-structure'
  | 'input-too-large'
  | 'no-passages'

export interface StructureCard {
  id: string
  /** `[起始段落 ID, 结束段落 ID]`，闭区间且连续 */
  range: [string, string]
  title: string
  summary: string
  keyTerms: string[]
}

export interface StructureCallCost {
  llmCalls: number
  latencyMs: number
}

/**
 * 卡片失败**必须带成本**：模型已返回、只是输出不可用（非法 JSON、结构不过）时
 * 那次调用与 token 是真实成本，bench 要照记；只有调用前就被拒才是零成本
 * （沿用语义树 `SemanticTreeBuildError` 的口径）。
 */
export class StructureCardError extends Error {
  constructor(
    readonly reason: StructureFallbackReason,
    message: string,
    readonly cost?: StructureCallCost,
  ) {
    super(message)
    this.name = 'StructureCardError'
  }
}

export interface StructureCardMeta {
  latencyMs: number
  inputChars: number
  llmCalls: number
}

export interface StructureCardResult {
  cards: StructureCard[]
  paper?: { title: string; summary: string }
  meta: StructureCardMeta
}

export function buildStructureCardPrompt(passages: Passage[]): string {
  const body = passages.map(passage => `[${passage.id}]\n${passage.text}`).join('\n\n')
  const first = passages[0]?.id ?? 'P01'
  return `你在为一篇学术论文建立**主题卡片**。
下面按论文原始顺序给出全文的段落，每段带有稳定 ID：

${body}

请通读全文后，按**主题**把段落划分为 ${MIN_STRUCTURE_CARDS}–${MAX_STRUCTURE_CARDS} 片**连续**范围，并为每片写一张卡片。硬性约束：

1. 每片的 range 是从起点段落 ID 到终点段落 ID 的**连续**区间，全部段落被覆盖**恰好一次**（不重叠、不遗漏），并按段落顺序排列。
2. 卡片 title 必须是该主题**特有的具体名称**，**禁止**使用 Abstract / Introduction / Method / Experiments / 结论 这类通用章节名。
3. summary 用 2–3 句写清该主题的具体内容，**必须**包含原文出现的具体名称、数据集、指标与数字。
4. keyTerms 给 5–12 个读者可能的提问用词，**必须**包含原文没有出现但语义等价的说法（例如原文写 "We evaluate on Europarl and MultiUN"，keyTerms 应含 "datasets" / "evaluation data"）。
5. 按主题划分即可合并（如 Abstract 与 Introduction 合成一片）也可拆分（如把实验章拆为「设置」与「结果」两片）；不要照抄论文的章节标题。

只输出 JSON，不要任何解释文字，格式如下：

{"paper":{"title":"...","summary":"2-3 sentences"},"sections":[{"id":"S1","range":["${first}","P05"],"title":"...","summary":"...","keyTerms":["...","..."]}]}`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 提取并解析 JSON；围栏与前后解释文字都容忍，找不到 JSON 一律 invalid-json。 */
export function parseStructureCards(raw: string): unknown {
  const cleaned = raw.replace(/```(?:json)?/gi, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new StructureCardError('invalid-json', '模型输出中找不到 JSON 对象')
  try {
    return JSON.parse(cleaned.slice(start, end + 1))
  } catch {
    throw new StructureCardError('invalid-json', '模型输出的 JSON 无法解析')
  }
}

class StructureCardValidationFailure extends Error {
  constructor(readonly reason: StructureFallbackReason, message: string) {
    super(message)
  }
}

export interface StructureCardValidation {
  ok: boolean
  cards?: StructureCard[]
  paper?: { title: string; summary: string }
  failure?: StructureFallbackReason
  message?: string
}

/**
 * 逐项校验（方案 §2.3）。「连续 + 覆盖恰好一次 + 有序」用一个游标 `expected` 表达：
 * 每张卡片的起点必须正好接上一张的终点 + 1，最后再要求覆盖到末尾。
 */
export function validateStructureCards(value: unknown, passages: Passage[]): StructureCardValidation {
  const fail = (reason: StructureFallbackReason, message: string): never => {
    throw new StructureCardValidationFailure(reason, message)
  }
  try {
    if (!isPlainObject(value)) fail('invalid-structure', '输出不是 JSON 对象')
    const raw = value as Record<string, unknown>
    const rawSections = raw.sections
    if (!Array.isArray(rawSections)) fail('invalid-structure', '输出缺少 sections 数组')
    if (rawSections.length < MIN_STRUCTURE_CARDS || rawSections.length > MAX_STRUCTURE_CARDS) {
      fail('invalid-structure', `卡片数 ${rawSections.length} 不在 ${MIN_STRUCTURE_CARDS}–${MAX_STRUCTURE_CARDS} 之间`)
    }

    const orderById = new Map(passages.map(passage => [passage.id, passage.order]))
    const cards: StructureCard[] = []
    let expected = 0
    for (const section of rawSections as unknown[]) {
      if (!isPlainObject(section)) fail('invalid-structure', '卡片不是 JSON 对象')
      const { id, range, title, summary, keyTerms } = section as Record<string, unknown>
      if (typeof id !== 'string' || !id.trim()) fail('invalid-structure', '卡片 id 缺失')
      if (!Array.isArray(range) || range.length !== 2 || range.some(item => typeof item !== 'string')) {
        fail('invalid-structure', `卡片 ${id} 的 range 必须是两个段落 ID`)
      }
      const [startId, endId] = range as [string, string]
      const start = orderById.get(startId)
      const end = orderById.get(endId)
      if (start === undefined || end === undefined) fail('invalid-structure', `卡片 ${id} 引用了不存在的段落`)
      if (start !== expected) fail('invalid-structure', `卡片 ${id} 的 range 不连续或与上一张重叠/遗漏`)
      if (end < start) fail('invalid-structure', `卡片 ${id} 的 range 起止颠倒`)
      expected = end + 1
      if (typeof title !== 'string' || !title.trim()) fail('invalid-structure', `卡片 ${id} 缺少标题`)
      const trimmedTitle = title.trim()
      if (isGenericSectionLabel(trimmedTitle)) fail('invalid-structure', `卡片标题「${trimmedTitle}」是通用章节名`)
      if (typeof summary !== 'string') fail('invalid-structure', `卡片 ${id} 缺少 summary`)
      if (!Array.isArray(keyTerms) || keyTerms.length < MIN_KEY_TERMS || keyTerms.length > MAX_KEY_TERMS) {
        fail('invalid-structure', `卡片 ${id} 的 keyTerms 数量越界`)
      }
      if (keyTerms.some(term => typeof term !== 'string' || !term.trim())) {
        fail('invalid-structure', `卡片 ${id} 的 keyTerms 含空项`)
      }
      cards.push({
        id: id.trim(),
        range: [startId, endId],
        title: trimmedTitle,
        summary: summary.trim(),
        keyTerms: (keyTerms as string[]).map(term => term.trim()),
      })
    }
    if (expected !== passages.length) fail('invalid-structure', `段落覆盖不全：只覆盖到第 ${expected} 段，共 ${passages.length} 段`)

    let paper: { title: string; summary: string } | undefined
    if (isPlainObject(raw.paper)) {
      const { title, summary } = raw.paper as Record<string, unknown>
      if (typeof title === 'string' && typeof summary === 'string' && title.trim()) {
        paper = { title: title.trim(), summary: summary.trim() }
      }
    }
    return { ok: true, cards, ...(paper ? { paper } : {}) }
  } catch (error) {
    if (!(error instanceof StructureCardValidationFailure)) throw error
    return { ok: false, failure: error.reason, message: error.message }
  }
}

/** 回落卡片：按标题行划分小节，每小节一张只有标题的卡片（无 summary / keyTerms）。 */
export function buildTitleCards(passages: Passage[]): StructureCard[] {
  const cards: StructureCard[] = []
  let start = 0
  for (let i = 1; i <= passages.length; i++) {
    const atEnd = i === passages.length
    if (!atEnd && passages[i].subsection === passages[start].subsection) continue
    cards.push({
      id: `S${cards.length + 1}`,
      range: [passages[start].id, passages[i - 1].id],
      title: passages[start].subsection || '正文',
      summary: '',
      keyTerms: [],
    })
    start = i
  }
  return cards
}

/** 卡片 → `IndexNode` 树：根来自 paper，每张卡片一个叶节点（UI 与旧代码零改动）。 */
export function cardsToIndexNodes(
  cards: StructureCard[],
  passages: Passage[],
  opts: { title?: string; summary?: string } = {},
): IndexNode {
  const byId = new Map(passages.map(passage => [passage.id, passage]))
  const nodes: IndexNode[] = []
  for (const card of cards) {
    const first = byId.get(card.range[0])
    const last = byId.get(card.range[1])
    if (!first || !last) continue
    nodes.push({
      title: card.title,
      nodeId: card.id,
      startPage: first.pieces[0].page,
      endPage: last.pieces[last.pieces.length - 1].page,
      summary: card.summary,
      nodes: [],
    })
  }
  const endPage = nodes.length > 0 ? nodes[nodes.length - 1].endPage : 0
  return {
    title: opts.title || 'Paper',
    nodeId: 'root',
    startPage: nodes.length > 0 ? nodes[0].startPage : 0,
    endPage,
    summary: opts.summary ?? '',
    nodes,
  }
}

export interface StructureCardBuildOptions {
  maxInputChars?: number
  now?: () => number
  timeoutMs?: number
}

/** 建卡片：恰好一次调用；失败抛 `StructureCardError`（带已发生成本），不重试不修补。 */
export async function buildStructureCards(
  passages: Passage[],
  llm: LLMFn,
  opts: StructureCardBuildOptions = {},
): Promise<StructureCardResult> {
  const now = opts.now ?? Date.now
  const maxInputChars = opts.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS
  if (passages.length === 0) throw new StructureCardError('no-passages', '论文没有可用段落')

  const prompt = buildStructureCardPrompt(passages)
  if (prompt.length > maxInputChars) {
    throw new StructureCardError('input-too-large', `卡片输入 ${prompt.length} 字符，超过上限 ${maxInputChars}；不截断补救`)
  }

  const startedAt = now()
  let raw: string
  try {
    raw = await llm(prompt)
  } catch (error) {
    throw new StructureCardError(
      'request-failed',
      error instanceof Error ? error.message : String(error),
      { llmCalls: 1, latencyMs: Math.max(0, now() - startedAt) },
    )
  }
  const latencyMs = Math.max(0, now() - startedAt)
  const cost: StructureCallCost = { llmCalls: 1, latencyMs }

  let parsed: unknown
  try {
    parsed = parseStructureCards(raw)
  } catch (error) {
    if (error instanceof StructureCardError) throw new StructureCardError(error.reason, error.message, cost)
    throw error
  }

  const validation = validateStructureCards(parsed, passages)
  if (!validation.ok || !validation.cards) {
    throw new StructureCardError(validation.failure ?? 'invalid-structure', validation.message ?? '结构卡片校验失败', cost)
  }
  return {
    cards: validation.cards,
    ...(validation.paper ? { paper: validation.paper } : {}),
    meta: { latencyMs, inputChars: prompt.length, llmCalls: 1 },
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/tests/structureCards.test.ts && npm run typecheck`
Expected: PASS（16 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/utils/structureCards.ts src/tests/structureCards.test.ts
git commit -m "feat(retrieval): add structure cards with validation and title fallback"
```

---

### Task 5: 版本化索引结构与失效规则

**Files:**
- Create: `src/utils/passageIndex.ts`
- Test: `src/tests/passageIndex.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest'
import { buildPassages, createEstimatingTokenCounter, hasPassagePartition } from '../utils/passages'
import { buildTitleCards, cardsToIndexNodes } from '../utils/structureCards'
import { encodeVectors } from '../utils/embedder'
import {
  PASSAGE_INDEX_SCHEMA_VERSION, PASSAGE_INDEX_VERSION, planPassageIndexRebuild,
  parsePassageIndex, passageConfigHash, serializePassageIndex, structureHash,
} from '../utils/passageIndex'

const counter = createEstimatingTokenCounter()
const passages = buildPassages(['Abstract\nA short abstract.\n\nMethods\nWe use BM25.'], counter, { minTokens: 1 })
const tree = cardsToIndexNodes(buildTitleCards(passages), passages)

const baseIndex = {
  version: PASSAGE_INDEX_VERSION,
  stage: 1 as const,
  passages,
  tree,
  separatorTokens: 2,
  passageConfigHash: 'pcfg',
}

describe('serialize / parse', () => {
  it('第 1 阶段索引往返无损', () => {
    const parsed = parsePassageIndex(JSON.parse(JSON.stringify(serializePassageIndex(baseIndex))))
    expect(parsed?.passages).toHaveLength(passages.length)
    expect(parsed?.tree.nodes.length).toBe(tree.nodes.length)
    expect(parsed?.stage).toBe(1)
  })

  it('向量按 base64 往返，维度与段落数一致', () => {
    const vectors = passages.map((_, i) => new Float32Array([i, 1, 0]))
    const index = { ...baseIndex, stage: 3 as const, vectorDim: 3, passageVectors: vectors, cards: [{ id: 'S1', range: [passages[0].id, passages[1].id] as [string, string], title: 'Datasets', summary: '', keyTerms: [] }], cardVectors: [new Float32Array([1, 0, 0])], embedderId: 'fake@main#q8' }
    const parsed = parsePassageIndex(JSON.parse(JSON.stringify(serializePassageIndex(index))))
    expect(parsed?.passageVectors?.[1][0]).toBe(1)
    expect(parsed?.cardVectors?.[0][0]).toBe(1)
  })

  it('版本不符即视为过期（返回 undefined）', () => {
    expect(parsePassageIndex({ ...JSON.parse(JSON.stringify(serializePassageIndex(baseIndex))), version: 1 })).toBeUndefined()
    expect(parsePassageIndex({ version: 2, stage: 1 })).toBeUndefined()
    expect(parsePassageIndex('nope')).toBeUndefined()
  })

  it('分片与原文不一致的索引视为损坏', () => {
    const broken = JSON.parse(JSON.stringify(serializePassageIndex(baseIndex)))
    broken.passages[0].pieces[0].text = 'tampered'
    expect(hasPassagePartition(broken.passages[0])).toBe(false)
    expect(parsePassageIndex(broken)).toBeUndefined()
  })

  it('向量长度与段落数不符时丢弃向量但不丢索引', () => {
    const broken = JSON.parse(JSON.stringify(serializePassageIndex(baseIndex)))
    broken.stage = 2
    broken.embedderId = 'fake@main#q8'
    broken.vectorDim = 3
    broken.passageVectors = encodeVectors([new Float32Array([1, 0, 0])])  // 只有 1 个，段落数 > 1
    const parsed = parsePassageIndex(broken)
    expect(parsed).toBeDefined()
    expect(parsed?.passageVectors).toBeUndefined()
  })
})

describe('三个指纹', () => {
  it('切段参数变化 → passageConfigHash 变化', () => {
    const a = passageConfigHash({ schemaVersion: PASSAGE_INDEX_SCHEMA_VERSION, segmentation: { minTokens: 120, maxTokens: 350 } })
    const b = passageConfigHash({ schemaVersion: PASSAGE_INDEX_SCHEMA_VERSION, segmentation: { minTokens: 100, maxTokens: 350 } })
    expect(a).not.toBe(b)
  })

  it('模型端点或提示词版本变化 → structureHash 变化，切段参数不变则 passageConfigHash 不变', () => {
    const cfg = { schemaVersion: PASSAGE_INDEX_SCHEMA_VERSION, segmentation: { minTokens: 120, maxTokens: 350 } }
    const base = { schemaVersion: PASSAGE_INDEX_SCHEMA_VERSION, passageConfigHash: passageConfigHash(cfg), promptVersion: 'v1', maxInputChars: 120000, model: 'openai/gpt-4o' }
    expect(structureHash(base)).toBe(structureHash({ ...base }))
    expect(structureHash(base)).not.toBe(structureHash({ ...base, model: 'openai/gpt-4o-mini' }))
    expect(structureHash(base)).not.toBe(structureHash({ ...base, promptVersion: 'v2' }))
  })
})

describe('planPassageIndexRebuild', () => {
  const config = { schemaVersion: PASSAGE_INDEX_SCHEMA_VERSION, segmentation: { minTokens: 120, maxTokens: 350 } }
  const passageConfig = passageConfigHash(config)
  const structure = structureHash({ schemaVersion: PASSAGE_INDEX_SCHEMA_VERSION, passageConfigHash: passageConfig, promptVersion: 'v1', maxInputChars: 120000, model: 'm' })
  const stored = { version: PASSAGE_INDEX_VERSION, stage: 3 as const, passages, tree, separatorTokens: 2, passageConfigHash: passageConfig, structureHash: structure, embedderId: 'e1', vectorDim: 3 }

  it('完全匹配且已到阶段③时全部复用', () => {
    expect(planPassageIndexRebuild({ stored, passageConfigHash: passageConfig, structureHash: structure, embedderId: 'e1' }))
      .toEqual({ passages: false, vectors: false, structure: false })
  })

  it('embedderId 变化只重算向量', () => {
    expect(planPassageIndexRebuild({ stored, passageConfigHash: passageConfig, structureHash: structure, embedderId: 'e2' }))
      .toEqual({ passages: false, vectors: true, structure: false })
  })

  it('structureHash 变化只重做卡片', () => {
    expect(planPassageIndexRebuild({ stored, passageConfigHash: passageConfig, structureHash: 'other', embedderId: 'e1' }))
      .toEqual({ passages: false, vectors: false, structure: true })
  })

  it('passageConfigHash 变化触发全部重建', () => {
    expect(planPassageIndexRebuild({ stored, passageConfigHash: 'other', structureHash: structure, embedderId: 'e1' }))
      .toEqual({ passages: true, vectors: true, structure: true })
  })

  it('没有存量索引时全部重建', () => {
    expect(planPassageIndexRebuild({ stored: undefined, passageConfigHash: passageConfig, structureHash: structure, embedderId: 'e1' }))
      .toEqual({ passages: true, vectors: true, structure: true })
  })

  it('阶段未到③时卡片要重做', () => {
    const partial = { ...stored, stage: 2 as const }
    expect(planPassageIndexRebuild({ stored: partial, passageConfigHash: passageConfig, structureHash: structure, embedderId: 'e1' }).structure).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/tests/passageIndex.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 `src/utils/passageIndex.ts`**

```ts
/**
 * 段落索引的版本化结构、指纹与失效规则（方案 §6.2）。
 *
 * `index_json` 升级为 v2：同一个 JSON 里既装索引（passages / 向量 / 卡片），
 * 也装由卡片推导的 `IndexNode` 树（UI 与依赖树的旧代码零改动）。
 * 表与 IPC 通道都不变，`pagesJson` 与 v1 逐字一致。
 */
import {
  decodeVectors, encodeVectors,
} from './embedder'
import type { IndexNode } from './pageIndex'
import { hasPassagePartition, type Passage } from './passages'
import { hashTreeSource } from './semanticTree'
import type { StructureCard, StructureFallbackReason } from './structureCards'

/**
 * 落盘记录格式版本（`index_json.version`）。方案 §6 规定：无 `version` 的旧记录在加载时
 * 一律视为过期，由后台重建。
 */
export const PASSAGE_INDEX_VERSION = 2

/**
 * 切段配置 schema 的版本，**只作为 `passageConfigHash` 的输入之一**（见 `PassageConfigInput`）。
 * 与 `PASSAGE_INDEX_VERSION` 当前同为 2 是巧合——两者独立演进：
 * 改了存储字段改前者，改了切段参数语义改后者。**不要合并成一个常量**，
 * 否则改存储格式会把所有论文的切段指纹一起推倒重建。
 */
export const PASSAGE_INDEX_SCHEMA_VERSION = 2

export interface PassageIndex {
  version: typeof PASSAGE_INDEX_VERSION
  /** 已完成的最高构建阶段；③ 落盘即代表卡片可用（向量可能因模型不可用而缺席） */
  stage: 1 | 2 | 3
  passages: Passage[]
  passageVectors?: Float32Array[]
  cards?: StructureCard[]
  paper?: { title: string; summary: string }
  cardVectors?: Float32Array[]
  structureFallback?: { reason: StructureFallbackReason }
  tree: IndexNode
  embedderId?: string
  structureHash?: string
  passageConfigHash: string
  /** 向量维度；判定向量可用性时与 passages.length 一起用 */
  vectorDim?: number
  /** 组间分隔符的 token 数，用于填充阶段的预算判定 */
  separatorTokens: number
}

export interface PassageConfigInput {
  schemaVersion: number
  segmentation: { minTokens: number; maxTokens: number }
}

export interface StructureConfigInput {
  schemaVersion: number
  passageConfigHash: string
  promptVersion: string
  maxInputChars: number
  /** 索引 profile 的端点 + 模型名（模型换了语义就换了，卡片必须重做） */
  model: string
}

/** 切段参数变了 → 段落 ID 与边界全变 → 全量重建。 */
export function passageConfigHash(config: PassageConfigInput): string {
  return hashTreeSource(JSON.stringify({
    schemaVersion: config.schemaVersion,
    minTokens: config.segmentation.minTokens,
    maxTokens: config.segmentation.maxTokens,
  }))
}

/** 切段参数 + 提示词版本 + 输入上限 + 索引模型 → 卡片重建范围。 */
export function structureHash(config: StructureConfigInput): string {
  return hashTreeSource(JSON.stringify({
    schemaVersion: config.schemaVersion,
    passageConfigHash: config.passageConfigHash,
    promptVersion: config.promptVersion,
    maxInputChars: config.maxInputChars,
    model: config.model,
  }))
}

export interface PassageIndexRecord {
  indexJson: string
  pagesJson: string
}

export interface PassageIndexBuildPlan {
  passages: boolean
  vectors: boolean
  structure: boolean
}

/**
 * 失效规则（方案 §6.2）：`passageConfigHash` 变 → 全部重建；`structureHash` 变 →
 * 只重做阶段③；`embedderId` 变 → 只重算向量。三者独立，任何一项都不能越界。
 */
export function planPassageIndexRebuild(args: {
  stored?: PassageIndex
  passageConfigHash: string
  structureHash: string
  embedderId?: string
}): PassageIndexBuildPlan {
  const { stored } = args
  if (!stored) return { passages: true, vectors: true, structure: true }
  if (stored.passageConfigHash !== args.passageConfigHash) return { passages: true, vectors: true, structure: true }
  const vectors = stored.embedderId !== args.embedderId || stored.passageVectors === undefined || stored.stage < 2
  const structure = stored.structureHash !== args.structureHash || stored.stage < 3 || stored.cards === undefined
  return { passages: false, vectors, structure }
}

interface SerializedPassageIndex extends Omit<PassageIndex, 'passageVectors' | 'cardVectors'> {
  passageVectors?: string
  cardVectors?: string
}

/** 落盘：向量转 base64，其余原样。 */
export function serializePassageIndex(index: PassageIndex): SerializedPassageIndex {
  const { passageVectors, cardVectors, ...rest } = index
  return {
    ...rest,
    ...(passageVectors ? { passageVectors: encodeVectors(passageVectors) } : {}),
    ...(cardVectors ? { cardVectors: encodeVectors(cardVectors) } : {}),
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 解析并校验一份存量索引。**任何不自洽都返回 undefined**（调用方视为无索引、后台重建）：
 * 静默接受一份损坏的索引会让检索用错的分片与页号，比报错更难查。
 * 向量不自洽时只丢向量（降到阶段①/③ 检索），不丢整个索引。
 */
export function parsePassageIndex(raw: unknown): PassageIndex | undefined {
  let value: unknown = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      return undefined
    }
  }
  if (!isPlainObject(value)) return undefined
  if (value.version !== PASSAGE_INDEX_VERSION) return undefined
  const stage = value.stage
  if (stage !== 1 && stage !== 2 && stage !== 3) return undefined
  const passages = value.passages
  if (!Array.isArray(passages) || passages.length === 0) return undefined
  if (!passages.every(passage => hasPassagePartition(passage))) return undefined
  if (!isPlainObject(value.tree)) return undefined
  if (typeof value.passageConfigHash !== 'string' || !value.passageConfigHash) return undefined
  const separatorTokens = typeof value.separatorTokens === 'number' && Number.isInteger(value.separatorTokens) && value.separatorTokens >= 0
    ? value.separatorTokens
    : undefined
  if (separatorTokens === undefined) return undefined

  const typedPassages = passages as Passage[]
  const index: PassageIndex = {
    version: PASSAGE_INDEX_VERSION,
    stage,
    passages: typedPassages,
    tree: value.tree as unknown as IndexNode,
    passageConfigHash: value.passageConfigHash,
    separatorTokens,
  }
  if (typeof value.embedderId === 'string') index.embedderId = value.embedderId
  if (typeof value.structureHash === 'string') index.structureHash = value.structureHash

  if (isPlainObject(value.structureFallback) && typeof (value.structureFallback as Record<string, unknown>).reason === 'string') {
    index.structureFallback = { reason: (value.structureFallback as { reason: StructureFallbackReason }).reason }
  }
  if (isPlainObject(value.paper) && typeof (value.paper as Record<string, unknown>).title === 'string') {
    index.paper = value.paper as unknown as { title: string; summary: string }
  }
  if (Array.isArray(value.cards) && value.cards.length > 0) index.cards = value.cards as StructureCard[]

  const dim = typeof value.vectorDim === 'number' && Number.isInteger(value.vectorDim) && value.vectorDim > 0 ? value.vectorDim : undefined
  if (dim !== undefined) {
    index.vectorDim = dim
    if (typeof value.passageVectors === 'string') {
      const vectors = decodeVectors(value.passageVectors, dim)
      if (vectors && vectors.length === typedPassages.length) index.passageVectors = vectors
    }
    if (typeof value.cardVectors === 'string' && index.cards) {
      const vectors = decodeVectors(value.cardVectors, dim)
      if (vectors && vectors.length === index.cards.length) index.cardVectors = vectors
    }
  }
  return index
}

/** 便捷包装：直接吃 `window.db.index.get` 返回的记录。 */
export function passageIndexOf(record: { indexJson: string } | undefined): PassageIndex | undefined {
  return record ? parsePassageIndex(record.indexJson) : undefined
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/tests/passageIndex.test.ts && npm run typecheck`
Expected: PASS（12 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/utils/passageIndex.ts src/tests/passageIndex.test.ts
git commit -m "feat(retrieval): add versioned passage index with scoped invalidation"
```

---

## 阶段 B：融合、组装与构建

### Task 6: 确定性优先队列与三路融合

**Files:**
- Create: `src/utils/priorityQueue.ts`
- Test: `src/tests/passageRetrieval.test.ts`（前半：融合与队列）

- [ ] **Step 1: 写失败测试**

`src/tests/passageRetrieval.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest'
import { createMaxHeap } from '../utils/priorityQueue'
import { buildPassages, createEstimatingTokenCounter } from '../utils/passages'
import { buildTitleCards, cardsToIndexNodes, type StructureCard } from '../utils/structureCards'
import { PASSAGE_INDEX_VERSION, passageConfigHash, type PassageIndex } from '../utils/passageIndex'
import { fusePassageCandidates } from '../utils/passageRetrieval'
import type { Embedder } from '../utils/embedder'

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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/tests/passageRetrieval.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 `src/utils/priorityQueue.ts`**

```ts
/**
 * 确定性最大堆：并列时按 `order` 升序出队（方案 §4.4 要求同分按段落 order 升序）。
 * 预算填充需要「取最大分 → 追加邻段 → 再取最大分」，用堆避免每轮重排。
 */
export interface HeapEntry {
  score: number
  order: number
}

export interface MaxHeap<T extends HeapEntry> {
  readonly size: number
  push(entry: T): void
  pop(): T | undefined
}

export function createMaxHeap<T extends HeapEntry>(): MaxHeap<T> {
  const items: T[] = []
  const better = (a: T, b: T): boolean => a.score > b.score || (a.score === b.score && a.order < b.order)
  const swap = (i: number, j: number) => {
    const temp = items[i]
    items[i] = items[j]
    items[j] = temp
  }
  const bubbleUp = (from: number) => {
    let i = from
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (!better(items[i], items[parent])) break
      swap(i, parent)
      i = parent
    }
  }
  const sinkDown = (from: number) => {
    let i = from
    for (;;) {
      const left = i * 2 + 1
      const right = left + 1
      let best = i
      if (left < items.length && better(items[left], items[best])) best = left
      if (right < items.length && better(items[right], items[best])) best = right
      if (best === i) break
      swap(i, best)
      i = best
    }
  }
  return {
    get size() {
      return items.length
    },
    push(entry: T) {
      items.push(entry)
      bubbleUp(items.length - 1)
    },
    pop(): T | undefined {
      const top = items[0]
      if (top === undefined) return undefined
      const last = items.pop() as T
      if (items.length > 0) {
        items[0] = last
        sinkDown(0)
      }
      return top
    },
  }
}
```

- [ ] **Step 4: 实现 `src/utils/passageRetrieval.ts` 的融合部分**

```ts
/**
 * 段落级混合检索（方案 §4）：三路加权 RRF 融合 → 4096 预算填充 + 同小节邻段扩展
 * → 原文顺序组装。查询阶段零 LLM 调用（`llmCalled: false`）。
 *
 * 关键口径：预算判定必须与 `materializeContext` 的计法一致——「已用 + 新组分隔符 +
 * 段落 token ≤ 预算」，这样最终物化永不截断（`contextTruncated === false`）。
 */
import { cosineSimilarity, type Embedder } from './embedder'
import { CONTEXT_GROUP_SEPARATOR, type ContextGroup } from './contextTrace'
import type { IndexNode, RetrievalResult } from './pageIndex'
import type { Passage } from './passages'
import type { PassageIndex } from './passageIndex'
import { createMaxHeap } from './priorityQueue'
import { reciprocalRankFusion, type RankedItem } from './rrf'

export type RetrievalMode = 'bm25' | 'bm25+dense' | 'full' | 'full-title-fallback' | 'bm25+card-lexical'

export interface PassageCandidate {
  order: number
  score: number
  /** 由邻段扩展进入（方案 §4.4 的邻段系数路径） */
  fromNeighbour: boolean
}

export interface FusePassageCandidatesArgs {
  passages: Passage[]
  query: string
  /** 段落 BM25 打分器；返回全部段落的分数 */
  bm25: (query: string) => RankedItem[]
  /** 段落向量路；向量不可用时为 undefined */
  dense?: ((query: string) => RankedItem[]) | undefined
  /** 卡片先验路（向量或词法）；卡片不可用时为 undefined */
  card?: ((query: string) => RankedItem[]) | undefined
  rrfK: number
  sectionWeight: number
  /** 占位参数：调用方已决定各路的可用性，这里只做融合 */
  queryVector?: Float32Array
  passagesCannotUseVectors: boolean
}

/** 三路（可少路）加权 RRF，返回按分数降序、同分按 order 升序的候选。 */
export function fusePassageCandidates(args: FusePassageCandidatesArgs): PassageCandidate[] {
  const lists: RankedItem[][] = [args.bm25(args.query)]
  const weights: number[] = [1]
  if (args.dense) {
    lists.push(args.dense(args.query))
    weights.push(1)
  }
  if (args.card) {
    lists.push(args.card(args.query))
    weights.push(args.sectionWeight)
  }
  const fused = reciprocalRankFusion(lists, args.rrfK, weights)
  const fromNeighbour = new Map<number, boolean>()
  const candidates = fused.map(item => ({
    order: item.id,
    score: item.score,
    fromNeighbour: fromNeighbour.get(item.id) ?? false,
  }))
  return candidates
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/tests/passageRetrieval.test.ts`
Expected: PASS（6 个用例）

- [ ] **Step 6: 提交**

```bash
git add src/utils/priorityQueue.ts src/utils/passageRetrieval.ts src/tests/passageRetrieval.test.ts
git commit -m "feat(retrieval): add deterministic heap and weighted passage fusion"
```

---

### Task 7: 预算填充、邻段扩展与结果组装

**Files:**
- Modify: `src/utils/passageRetrieval.ts`
- Test: `src/tests/passageRetrieval.test.ts`（追加）

- [ ] **Step 1: 写失败测试（追加到同一文件）**

预算填充用**手写的候选分数**直接测（见 `fillPassageBudget`）——用真实融合结果测邻段扩展是测不稳的：RRF 给每篇文档都在每一路里排了名次，所以「邻段分 × 0.5」几乎从不高于邻段自己的融合分，断言会随分词细节飘。

```ts
// 追加 import
import {
  DEFAULT_HYBRID_OPTIONS, fillPassageBudget, retrievePassageContext,
} from '../utils/passageRetrieval'
import { encodeVectors } from '../utils/embedder'

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
    const { index } = fakeIndex({ stage: 1, passageVectors: undefined, cardVectors: undefined })
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
    const result = await retrievePassageContext(index, 'MultiUN results', { embedder })
    expect(result.sources.some(source => /^Pages \d+–\d+: MultiUN results$/.test(source))).toBe(true)
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
    expect(fill.skippedCount).toBe(3)
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
    const split = buildPassages(['Methods\nonly para here', 'Experiments\nanother para here'], counter, { minTokens: 1 })
    const fill = fillPassageBudget({
      ...base,
      passages: split,
      candidates: [{ order: 0, score: 10, fromNeighbour: false }, { order: 1, score: 0.1, fromNeighbour: false }],
      separatorTokens: 0,
      maxTokens: split[0].tokenCount,   // 只放得下 0 号
    })
    expect(fill.selectedOrders).toEqual([0])
    expect(fill.neighbourOrders).toEqual([])
  })

  it('不连续的选中段落要计入组间分隔符', () => {
    // 三小节各一段，选中间跳过 1 号 → 选中 0 与 2 不连续，需要 1 个分隔符。
    // 小节互不相同也顺带保证没有邻段扩展干扰
    const split = buildPassages(['A\nfirst para here now', 'B\nmiddle para here now', 'C\nthird para here now'], counter, { minTokens: 1 })
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/tests/passageRetrieval.test.ts`
Expected: FAIL — `retrievePassageContext is not a function`

- [ ] **Step 3: 实现检索主体（追加到 `src/utils/passageRetrieval.ts`）**

```ts
export interface HybridPassageDiagnostics {
  retrievalMode: RetrievalMode
  selectedPassageIds: string[]
  /** 入队值来自邻段扩展（「该段分 × neighbourFactor」压过了它自己的融合分）的段落 */
  neighbourSelectedIds: string[]
  candidateCount: number
  skippedCount: number
}

export type PassageRetrievalResult = RetrievalResult & { hybrid: HybridPassageDiagnostics }

export interface PassageRetrievalOptions {
  embedder?: Embedder
  /** 段落 token 计数器；bench 注入冻结的 BGE-M3 分词器，产品用估算器 */
  countTokens?: TokenCounter
  maxTokens?: number
  rrfK?: number
  sectionWeight?: number
  neighbourFactor?: number
  skipLimit?: number
}

export const DEFAULT_HYBRID_OPTIONS: Required<Pick<PassageRetrievalOptions, 'maxTokens' | 'rrfK' | 'sectionWeight' | 'neighbourFactor' | 'skipLimit'>> = {
  maxTokens: 4096,
  rrfK: 60,
  sectionWeight: 0.5,
  neighbourFactor: 0.5,
  skipLimit: 20,
}

export interface FillPassageBudgetArgs {
  passages: Passage[]
  candidates: PassageCandidate[]
  /** 组间分隔符的 token 数；与 materializeContext 同口径 */
  separatorTokens: number
  maxTokens: number
  neighbourFactor: number
  skipLimit: number
}

export interface FillPassageBudgetResult {
  /** 按原文 order 升序 */
  selectedOrders: number[]
  neighbourOrders: number[]
  skippedCount: number
}

/**
 * 预算填充（方案 §4.4）。**「放得下」的判定必须与 materializeContext 同口径**：
 * 已用 + 新开一组的组间分隔符 + 本段 token ≤ 预算。这样物化时
 * `used + prefix >= maxTokens` 的截断守卫永远不会触发，`contextTruncated === false`。
 *
 * 连续跳过上限只约束「连续」：一旦有一段成功放入，计数归零——
 * 否则一段小段落就能把后续所有候选挡在门外。
 */
export function fillPassageBudget(args: FillPassageBudgetArgs): FillPassageBudgetResult {
  const { passages, candidates, separatorTokens, maxTokens, neighbourFactor, skipLimit } = args
  const totalTokens = passages.reduce((sum, passage) => sum + passage.tokenCount, 0)
  if (totalTokens <= maxTokens) {
    return { selectedOrders: passages.map(passage => passage.order), neighbourOrders: [], skippedCount: 0 }
  }

  const heap = createMaxHeap<{ score: number; order: number }>()
  const queued = new Map<number, number>()
  const offered = new Map<number, boolean>()
  const selected = new Set<number>()
  const neighbourSelected = new Set<number>()

  const offer = (order: number, score: number, fromNeighbour: boolean) => {
    if (order < 0 || order >= passages.length || selected.has(order)) return
    if ((queued.get(order) ?? Number.NEGATIVE_INFINITY) >= score) return
    queued.set(order, score)
    offered.set(order, fromNeighbour)
    heap.push({ score, order })
  }

  for (const candidate of candidates) offer(candidate.order, candidate.score, candidate.fromNeighbour)

  const runCount = (chosen: number[]): number => {
    const sorted = [...chosen].sort((a, b) => a - b)
    let runs = 0
    for (let i = 0; i < sorted.length; i++) if (i === 0 || sorted[i] !== sorted[i - 1] + 1) runs++
    return runs
  }
  const usedTokens = (chosen: number[]): number =>
    chosen.reduce((sum, order) => sum + passages[order].tokenCount, 0) + Math.max(0, runCount(chosen) - 1) * separatorTokens

  let consecutiveSkips = 0
  let skippedCount = 0
  while (heap.size > 0 && consecutiveSkips < skipLimit) {
    const entry = heap.pop() as { score: number; order: number }
    if (selected.has(entry.order)) continue
    // 惰性删除：堆里可能留着同一段落的旧（较低）分数
    if ((queued.get(entry.order) ?? Number.NEGATIVE_INFINITY) > entry.score) continue
    if (usedTokens([...selected, entry.order]) > maxTokens) {
      consecutiveSkips++
      skippedCount++
      continue
    }
    selected.add(entry.order)
    consecutiveSkips = 0
    if (offered.get(entry.order)) neighbourSelected.add(entry.order)
    // 邻段扩展：同一小节内的前后邻段以「本段分 × neighbourFactor」入队，取较大值
    const current = passages[entry.order]
    for (const neighbour of [passages[entry.order - 1], passages[entry.order + 1]]) {
      if (neighbour && neighbour.subsection === current.subsection) {
        offer(neighbour.order, entry.score * neighbourFactor, true)
      }
    }
  }

  return {
    selectedOrders: [...selected].sort((a, b) => a - b),
    neighbourOrders: [...neighbourSelected].sort((a, b) => a - b),
    skippedCount,
  }
}

/** 卡片标题查询表：段落 order → 卡片标题。卡片覆盖连续区间，线性扫一遍即可。 */
function cardTitlesByOrder(index: PassageIndex): Map<number, string> {
  const titles = new Map<number, string>()
  if (!index.cards) return titles
  const orderById = new Map(index.passages.map(passage => [passage.id, passage.order]))
  for (const card of index.cards) {
    const start = orderById.get(card.range[0])
    const end = orderById.get(card.range[1])
    if (start === undefined || end === undefined) continue
    for (let order = start; order <= end; order++) titles.set(order, card.title)
  }
  return titles
}

function emptyResult(mode: RetrievalMode): PassageRetrievalResult {
  return {
    context: '',
    contextGroups: [],
    sources: [],
    selected: [],
    scores: [],
    degraded: false,
    llmCalled: false,
    hybrid: { retrievalMode: mode, selectedPassageIds: [], neighbourSelectedIds: [], candidateCount: 0, skippedCount: 0 },
  }
}

/**
 * 段落级混合检索。降级顺序严格按方案 §4 的表：
 * `full` → `full-title-fallback` → `bm25+dense` → `bm25+card-lexical` → `bm25`。
 */
export async function retrievePassageContext(
  index: PassageIndex,
  query: string,
  opts: PassageRetrievalOptions = {},
): Promise<PassageRetrievalResult> {
  const maxTokens = opts.maxTokens ?? DEFAULT_HYBRID_OPTIONS.maxTokens
  const rrfK = opts.rrfK ?? DEFAULT_HYBRID_OPTIONS.rrfK
  const sectionWeight = opts.sectionWeight ?? DEFAULT_HYBRID_OPTIONS.sectionWeight
  const neighbourFactor = opts.neighbourFactor ?? DEFAULT_HYBRID_OPTIONS.neighbourFactor
  const skipLimit = opts.skipLimit ?? DEFAULT_HYBRID_OPTIONS.skipLimit
  const countTokens = opts.countTokens ?? createEstimatingTokenCounter()
  const passages = index.passages
  if (passages.length === 0) return emptyResult('bm25')

  const cards = index.cards
  const cardByPassage = cards ? mapCardsToPassageIndexes(index) : undefined

  // 查询向量是唯一需要 await 的一步。模型不可用**不发异常给调用方**：
  // 这一次提问按可用信号降级即可，下一次模型就绪后自然恢复（方案 §8）
  const passagesUsable = index.passageVectors !== undefined && (index.vectorDim ?? 0) > 0
  let queryVector: Float32Array | undefined
  if (opts.embedder && passagesUsable) {
    try {
      queryVector = await opts.embedder.embedQuery(query)
    } catch {
      queryVector = undefined
    }
  }
  const denseAvailable = queryVector !== undefined && passagesUsable

  const bm25 = buildBm25Scorer(passages.map(passage => passage.searchText))

  let dense: ((query: string) => RankedItem[]) | undefined
  let card: ((query: string) => RankedItem[]) | undefined
  let mode: RetrievalMode

  if (denseAvailable) {
    const vector = queryVector as Float32Array
    const passageVectors = index.passageVectors as Float32Array[]
    dense = () => passages.map(passage => ({
      id: passage.order,
      score: cosineSimilarity(vector, passageVectors[passage.order]),
    }))
    let cardScores: number[] | undefined
    if (cards && index.cardVectors) {
      const cardVectors = index.cardVectors
      cardScores = cards.map((_, cardIndex) => vector.length === cardVectors[cardIndex].length
        ? cosineSimilarity(vector, cardVectors[cardIndex])
        : Number.NEGATIVE_INFINITY)
    }
    if (cardScores && cardByPassage) {
      const scores = cardScores
      card = () => passages.map(passage => ({ id: passage.order, score: scores[cardByPassage.get(passage.order) ?? -1] ?? 0 }))
      mode = index.structureFallback ? 'full-title-fallback' : 'full'
    } else {
      mode = 'bm25+dense'
    }
  } else if (cards && cards.length > 0) {
    // 向量不可用但卡片已生成：卡片先验退化为卡片文本的词法匹配（方案 §4 的表）
    const scoreCards = buildBm25Scorer(cards.map(card => cardEmbedText(card)))
    card = text => {
      const scores = scoreCards(text)
      return passages.map(passage => ({ id: passage.order, score: scores[cardByPassage!.get(passage.order) ?? -1]?.score ?? 0 }))
    }
    mode = 'bm25+card-lexical'
  } else {
    mode = 'bm25'
  }

  const candidates = fusePassageCandidates({
    passages,
    query,
    bm25: text => bm25(text),
    ...(dense ? { dense } : {}),
    ...(card ? { card } : {}),
    rrfK,
    sectionWeight,
    passagesCannotUseVectors: !denseAvailable,
  })

  const fill = fillPassageBudget({
    passages,
    candidates,
    separatorTokens: index.separatorTokens,
    maxTokens,
    neighbourFactor,
    skipLimit,
  })

  return assembleResult(index, fill, candidates, mode)
}
```

> `mapCardsToPassageIndexes(index)` 与上文 Step 3 定稿里的 `cardTitlesByOrder(index)` 是两张不同的表（前者 order→卡片下标，后者 order→卡片标题），实现时各自保留一份：查询时用前者，组装时用后者。

- [ ] **Step 4: 实现组装（同文件追加）**

```ts
/** 选中段落 → 原文顺序组装。组与组的页序即 materializeContext 的输入。 */
function assembleResult(
  index: PassageIndex,
  fill: FillPassageBudgetResult,
  candidates: PassageCandidate[],
  mode: RetrievalMode,
): PassageRetrievalResult {
  const passages = index.passages
  if (fill.selectedOrders.length === 0) {
    return {
      ...emptyResult(mode),
      hybrid: {
        retrievalMode: mode,
        selectedPassageIds: [],
        neighbourSelectedIds: [],
        candidateCount: candidates.length,
        skippedCount: fill.skippedCount,
      },
    }
  }

  // 原文连续的段落合为一个 ContextGroup；pieces 直接拼接，页号天然正确
  const runs: Passage[][] = []
  for (const order of fill.selectedOrders) {
    const last = runs.at(-1)
    if (last && last[last.length - 1].order + 1 === order) last.push(passages[order])
    else runs.push([passages[order]])
  }
  const contextGroups: ContextGroup[] = runs.map(run => ({ pieces: run.flatMap(passage => passage.pieces) }))
  const context = runs.map(run => run.map(passage => passage.text).join('')).join(CONTEXT_GROUP_SEPARATOR)

  // selected：按真实连续页区间拆分。相邻但不连续（中间缺页）必须分成两段，
  // 否则 sources 会声称读了一页其实没读的原文
  const titles = cardTitlesByOrder(index)
  interface Span { startPage: number; endPage: number; startOrder: number }
  const spans: Span[] = []
  for (const order of fill.selectedOrders) {
    const passage = passages[order]
    const startPage = passage.pieces[0].page
    const endPage = passage.pieces[passage.pieces.length - 1].page
    const last = spans.at(-1)
    if (last && startPage <= last.endPage + 1) last.endPage = Math.max(last.endPage, endPage)
    else spans.push({ startPage, endPage, startOrder: order })
  }

  const selectedNodes: IndexNode[] = spans.map(span => ({
    title: titles.get(span.startOrder) ?? `段落 ${passages[span.startOrder].id}`,
    nodeId: `R${span.startOrder}`,
    startPage: span.startPage,
    endPage: span.endPage,
    summary: '',
    nodes: [],
  }))

  return {
    context,
    contextGroups,
    sources: selectedNodes.map(node => `Pages ${node.startPage + 1}–${node.endPage + 1}: ${node.title}`),
    selected: selectedNodes,
    scores: candidates.map(candidate => ({ id: candidate.order, score: candidate.score })),
    degraded: false,
    llmCalled: false,
    hybrid: {
      retrievalMode: mode,
      selectedPassageIds: fill.selectedOrders.map(order => passages[order].id),
      neighbourSelectedIds: fill.neighbourOrders.map(order => passages[order].id),
      candidateCount: candidates.length,
      skippedCount: fill.skippedCount,
    },
  }
}

/** 段落 order → 卡片下标（查询卡片向量时用） */
function mapCardsToPassageIndexes(index: PassageIndex): Map<number, number> {
  const map = new Map<number, number>()
  if (!index.cards) return map
  const orderById = new Map(index.passages.map(passage => [passage.id, passage.order]))
  index.cards.forEach((card, cardIndex) => {
    const start = orderById.get(card.range[0])
    const end = orderById.get(card.range[1])
    if (start === undefined || end === undefined) return
    for (let order = start; order <= end; order++) map.set(order, cardIndex)
  })
  return map
}
```

还要在文件顶部补 import：`buildBm25Scorer`（`./bm25`）、`cardEmbedText`（`./embedder`）、`createEstimatingTokenCounter` 与 `TokenCounter`（`./passages`）、`buildTitleCards`/`cardsToIndexNodes` 只测试用（测试文件里 import，不在实现里）。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/tests/passageRetrieval.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/utils/passageRetrieval.ts src/tests/passageRetrieval.test.ts
git commit -m "feat(retrieval): budget-aware passage assembly with neighbour expansion"
```

---

### Task 8: 分阶段构建管线

**Files:**
- Create: `src/utils/passageIndexBuilder.ts`
- Test: `src/tests/passageIndexBuilder.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it, vi } from 'vitest'
import { startPassagePipeline } from '../utils/passageIndexBuilder'
import { createEstimatingTokenCounter } from '../utils/passages'
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

const CARDS_JSON = JSON.stringify({
  sections: [
    { id: 'S1', range: ['P01', 'P02'], title: 'Retrieval motivation', summary: 'Why.', keyTerms: ['why'] },
    { id: 'S2', range: ['P03', 'P04'], title: 'BM25 baseline', summary: 'How.', keyTerms: ['bm25'] },
    { id: 'S3', range: ['P05', 'P05'], title: 'Europarl results', summary: 'What.', keyTerms: ['europarl'] },
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
    const slowEmbedder: Embedder = {
      id: embedder.id,
      embedQuery: embedder.embedQuery,
      embedPassages: vi.fn(async (texts: string[]) => {
        await new Promise<void>(resolve => { resolveEmbed = resolve })
        return texts.map(() => new Float32Array([1, 0]))
      }),
    }
    let llmCalled = false
    const ctx = deps(async () => { llmCalled = true; return CARDS_JSON }, slowEmbedder)
    const started = await startPassagePipeline(PAGES, ctx.deps, {})
    await new Promise(resolve => setTimeout(resolve, 0))
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/tests/passageIndexBuilder.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 `src/utils/passageIndexBuilder.ts`**

```ts
/**
 * 分阶段构建管线（方案 §6.1）：① 段落（本地，<1 秒）→ ② 段落向量 → ③ 卡片 + 卡片向量。
 *
 * 「阶段① 完成即返回」是本模块的核心契约：调用方（`indexPaper`）拿到能用的索引之后，
 * 可以决定是 `await rest` 还是继续在后台跑。② 与 ③ 的 LLM 调用并行启动，
 * 卡片向量在两者都完成后计算。
 *
 * 代次保护不在这里：`persist` 回调由调用方提供，它负责「写盘前比对代次」。
 * 这样构建器不需要知道 store 的任何状态，单测可以只注入一个记账数组。
 */
import { cardEmbedText, type Embedder } from './embedder'
import { CONTEXT_GROUP_SEPARATOR } from './contextTrace'
import type { LLMFn } from './llm'
import { buildPassages, createEstimatingTokenCounter, type Passage, type TokenCounter } from './passages'
import {
  PASSAGE_INDEX_VERSION, planPassageIndexRebuild,
  type PassageIndex, type PassageIndexBuildPlan,
} from './passageIndex'
import { DEFAULT_MAX_INPUT_CHARS } from './semanticTree'
import {
  buildStructureCards, buildTitleCards, cardsToIndexNodes, StructureCardError,
  type StructureCard, type StructureFallbackReason,
} from './structureCards'

export type PassageStageEvent =
  | { stage: 'passages'; latencyMs: number; passageCount: number }
  | { stage: 'passage-vectors'; latencyMs: number }
  | { stage: 'structure'; latencyMs: number; cardCount: number; fallback?: StructureFallbackReason; cacheHit?: boolean }
  | { stage: 'card-vectors'; latencyMs: number }

export interface PassagePipelineDeps {
  /** 索引 profile 的卡片调用入口；恰好调用一次（复用时不调用） */
  llm: LLMFn
  countTokens?: TokenCounter
  embedder?: Embedder
  /** 逐阶段落盘；实现方负责代次校验，过期结果直接返回而不写盘 */
  persist: (index: PassageIndex, stage: 1 | 2 | 3) => Promise<void> | void
  passageConfigHash: string
  structureHash: string
  maxInputChars?: number
  now?: () => number
  /** 阶段耗时观测（bench 冷启动成本）；产品不传 */
  onStage?: (event: PassageStageEvent) => void
}

export interface PassagePipelineStart {
  /** 阶段① 的索引（返回时已产出并落盘） */
  index: PassageIndex
  /** 阶段②③ 的完成信号；调用方决定 await 还是后台继续 */
  rest: Promise<PassageIndex>
}

function buildInitialIndex(pages: string[], countTokens: TokenCounter, passageConfigHash: string, now: () => number, onStage?: (event: PassageStageEvent) => void): PassageIndex {
  const startedAt = now()
  const passages = buildPassages(pages, countTokens, {})
  const cards = buildTitleCards(passages)
  const tree = cardsToIndexNodes(cards, passages)
  onStage?.({ stage: 'passages', latencyMs: Math.max(0, now() - startedAt), passageCount: passages.length })
  return {
    version: PASSAGE_INDEX_VERSION,
    stage: 1,
    passages,
    tree,
    passageConfigHash,
    separatorTokens: countTokens(CONTEXT_GROUP_SEPARATOR),
  }
}

/** 复用存量索引的阶段① 成果；不满足复用条件时返回 undefined。 */
function reuseStage1(existing: PassageIndex | undefined, plan: PassageIndexBuildPlan): { passages: Passage[]; tree: PassageIndex['tree']; separatorTokens: number } | undefined {
  if (!existing || plan.passages) return undefined
  return { passages: existing.passages, tree: existing.tree, separatorTokens: existing.separatorTokens }
}

export async function startPassagePipeline(
  pages: string[],
  deps: PassagePipelineDeps,
  opts: { existing?: PassageIndex; force?: boolean } = {},
): Promise<PassagePipelineStart> {
  const now = deps.now ?? Date.now
  const countTokens = deps.countTokens ?? createEstimatingTokenCounter()
  const embedder = deps.embedder
  // force 的语义是「重来一遍」：直接给出全量重建计划，与三个指纹各自的失效范围无关。
  // 同时丢弃存量索引，避免任何字段被误复用
  const plan: PassageIndexBuildPlan = opts.force
    ? { passages: true, vectors: true, structure: true }
    : planPassageIndexRebuild({
        ...(opts.existing ? { stored: opts.existing } : {}),
        passageConfigHash: deps.passageConfigHash,
        structureHash: deps.structureHash,
        ...(embedder ? { embedderId: embedder.id } : {}),
      })
  const existing = opts.force ? undefined : opts.existing

  const reused = reuseStage1(existing, plan)
  let index: PassageIndex
  if (reused) {
    // 只搬阶段① 的成果，其余字段一概不继承：向量与卡片由阶段②③ 按 plan 重新填
    index = {
      version: PASSAGE_INDEX_VERSION,
      stage: 1,
      passages: reused.passages,
      tree: reused.tree,
      separatorTokens: reused.separatorTokens,
      passageConfigHash: deps.passageConfigHash,
      structureHash: deps.structureHash,
    }
  } else {
    index = buildInitialIndex(pages, countTokens, deps.passageConfigHash, now, deps.onStage)
  }

  // 阶段① 立即落盘：此后提问即可用 BM25，不等待任何模型
  await deps.persist(index, 1)

  const rest = runRemainingStages(
    { ...deps, countTokens },
    { existing, plan, stage1: index, now },
  )
  return { index, rest }
}

async function runRemainingStages(
  deps: PassagePipelineDeps,
  ctx: { existing?: PassageIndex; plan: PassageIndexBuildPlan; stage1: PassageIndex; now: () => number },
): Promise<PassageIndex> {
  const { plan, stage1, now } = ctx
  const embedder = deps.embedder
  // 阶段② 与 ③ 各写一份自己的产物，最后由下面的 merge 合成，避免两条并行分支互相覆盖
  let passageVectors: Float32Array[] | undefined
  let vectorDim: number | undefined
  let cards: StructureCard[] | undefined
  let paper: { title: string; summary: string } | undefined
  let structureFallback: { reason: StructureFallbackReason } | undefined
  let cardVectors: Float32Array[] | undefined

  const canReusePassageVectors = !plan.vectors
    && ctx.existing?.passageVectors !== undefined
    && (ctx.existing.vectorDim ?? 0) > 0
    && ctx.existing.embedderId === embedder?.id

  // 阶段②：段落向量。与阶段③ 并行启动
  const stage2 = (async (): Promise<void> => {
    if (!embedder) return
    if (canReusePassageVectors && ctx.existing?.passageVectors) {
      passageVectors = ctx.existing.passageVectors
      vectorDim = ctx.existing.vectorDim
      return
    }
    const startedAt = now()
    try {
      const vectors = await embedder.embedPassages(stage1.passages.map(passage => passage.searchText))
      if (vectors.length !== stage1.passages.length) throw new Error('段落向量数量与段落数不一致')
      passageVectors = vectors
      vectorDim = vectors[0]?.length
      deps.onStage?.({ stage: 'passage-vectors', latencyMs: Math.max(0, now() - startedAt) })
      await deps.persist({ ...stage1, stage: 2, passageVectors, vectorDim, embedderId: embedder.id }, 2)
    } catch {
      // 向量模型不可用：停留阶段①，卡片仍然生成（检索退化为 bm25+card-lexical）。
      // 不 rethrow：没有向量是可用性降级，不是构建失败
      deps.onStage?.({ stage: 'passage-vectors', latencyMs: Math.max(0, now() - startedAt) })
    }
  })()

  // 阶段③：卡片（唯一一次 LLM 调用）
  const stage3 = (async (): Promise<void> => {
    if (!plan.structure && ctx.existing?.cards) {
      cards = ctx.existing.cards
      paper = ctx.existing.paper
      structureFallback = ctx.existing.structureFallback
      deps.onStage?.({ stage: 'structure', latencyMs: 0, cardCount: cards.length, cacheHit: true })
      return
    }
    const startedAt = now()
    try {
      const result = await buildStructureCards(stage1.passages, deps.llm, {
        maxInputChars: deps.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS,
        now,
      })
      cards = result.cards
      paper = result.paper
      deps.onStage?.({ stage: 'structure', latencyMs: result.meta.latencyMs, cardCount: result.cards.length })
    } catch (error) {
      if (!(error instanceof StructureCardError)) throw error
      // 失败即标题卡片回落，不重试不修补（方案 §2.4）
      cards = buildTitleCards(stage1.passages)
      structureFallback = { reason: error.reason }
      // 失败也要记成本：模型已返回、只是输出不可用时那次调用与 token 是真实成本；
      // 只有调用前就被拒（无段落 / input-too-large）才是零成本，此时 cost 为 undefined
      deps.onStage?.({
        stage: 'structure',
        latencyMs: error.cost?.latencyMs ?? Math.max(0, now() - startedAt),
        cardCount: cards.length,
        fallback: error.reason,
      })
    }
  })()

  await Promise.all([stage2, stage3])

  // 卡片向量：必须在 ②③ 都完成之后（方案 §6.1）——两个输入一个来自阶段②（维度），
  // 一个来自阶段③（卡片文本）
  if (embedder && passageVectors && cards && cards.length > 0 && (vectorDim ?? 0) > 0) {
    const startedAt = now()
    try {
      const vectors = await embedder.embedPassages(cards.map(card => cardEmbedText(card)))
      if (vectors.length === cards.length) {
        cardVectors = vectors
        deps.onStage?.({ stage: 'card-vectors', latencyMs: Math.max(0, now() - startedAt) })
      }
    } catch {
      deps.onStage?.({ stage: 'card-vectors', latencyMs: Math.max(0, now() - startedAt) })
    }
  }

  // stage 是「已完成的最高阶段」：卡片落盘即 3（哪怕向量因模型不可用而缺席，
  // 那种情况由检索时的 retrievalMode 报告，不靠 stage 表达）
  const stage: 1 | 2 | 3 = cards && cards.length > 0 ? 3 : passageVectors ? 2 : 1
  const final: PassageIndex = {
    version: PASSAGE_INDEX_VERSION,
    stage,
    passages: stage1.passages,
    tree: cards && cards.length > 0
      ? cardsToIndexNodes(cards, stage1.passages, {
          ...(paper ? { title: paper.title, summary: paper.summary } : {}),
        })
      : stage1.tree,
    passageConfigHash: deps.passageConfigHash,
    structureHash: deps.structureHash,
    separatorTokens: stage1.separatorTokens,
    ...(passageVectors ? { passageVectors } : {}),
    ...(vectorDim ? { vectorDim } : {}),
    ...(embedder ? { embedderId: embedder.id } : {}),
    ...(cards ? { cards } : {}),
    ...(cardVectors ? { cardVectors } : {}),
    ...(paper ? { paper } : {}),
    ...(structureFallback ? { structureFallback } : {}),
  }
  await deps.persist(final, stage)
  return final
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/tests/passageIndexBuilder.test.ts && npm run typecheck`
Expected: PASS（10 个用例）

- [ ] **Step 5: 全量测试 + 提交**

Run: `npm test`
Expected: 全绿

```bash
git add src/utils/passageIndexBuilder.ts src/tests/passageIndexBuilder.test.ts
git commit -m "feat(retrieval): add staged passage index pipeline with parallel stage 2/3"
```

---

## 阶段 C：产品接入

### Task 9: `ragPipeline` 接入段落索引

**Files:**
- Modify: `src/utils/ragPipeline.ts`
- Test: `src/tests/ragPipeline.test.ts`（若不存在则新建）

- [ ] **Step 1: 写失败测试**

新建/追加 `src/tests/ragPipeline.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest'
import { buildPassages, createEstimatingTokenCounter } from '../utils/passages'
import { buildTitleCards, cardsToIndexNodes } from '../utils/structureCards'
import { PASSAGE_INDEX_VERSION, passageConfigHash, type PassageIndex } from '../utils/passageIndex'
import { retrieveRagContext } from '../utils/ragPipeline'

const counter = createEstimatingTokenCounter()
const pages = ['Abstract\nWe study retrieval on Europarl.', 'Methods\nWe use BM25 and dense encoders.']
const passages = buildPassages(pages, counter, { minTokens: 1 })
const cards = buildTitleCards(passages)
const passageIndex: PassageIndex = {
  version: PASSAGE_INDEX_VERSION,
  stage: 1,
  passages,
  tree: cardsToIndexNodes(cards, passages),
  passageConfigHash: passageConfigHash({ schemaVersion: 2, segmentation: { minTokens: 1, maxTokens: 350 } }),
  separatorTokens: 2,
}

describe('retrieveRagContext 的段落路径', () => {
  it('有 passageIndex 时走段落检索且检索阶段零 LLM 调用', async () => {
    const llm = vi.fn(async () => 'should not be called')
    const retrieval = await retrieveRagContext(
      [{ tree: passageIndex.tree, pages, passageIndex }],
      'Europarl datasets',
      [],
      llm,
      {},
      {},
    )
    expect(retrieval.llmCalls).toBe(0)
    expect(retrieval.retrievals[0].hybrid?.retrievalMode).toBe('bm25')
    expect(retrieval.retrievals[0].context).toContain('Europarl')
  })

  it('没有 passageIndex 时仍走旧路径（scoreAndSelect）', async () => {
    const llm = vi.fn(async () => JSON.stringify({ scores: [{ nodeId: 'root', score: 9 }] }))
    const retrieval = await retrieveRagContext(
      [{ tree: cardsToIndexNodes(cards, passages), pages }],
      'Europarl',
      [],
      llm,
      {},
      {},
    )
    expect(retrieval.llmCalls).toBeGreaterThan(0)
    expect(retrieval.retrievals[0].hybrid).toBeUndefined()
  })

  it('多轮历史仍触发查询改写（段落路径不例外）', async () => {
    const llm = vi.fn(async (messages: { content: string }[]) => {
      const content = messages[0]?.content ?? ''
      return content.includes('改写') ? 'rewritten query' : 'answer'
    })
    const retrieval = await retrieveRagContext(
      [{ tree: passageIndex.tree, pages, passageIndex }],
      'and the datasets?',
      [
        { role: 'user', content: 'What is this paper about?' },
        { role: 'assistant', content: 'It studies retrieval.' },
        { role: 'user', content: 'Which datasets?' },
        { role: 'assistant', content: 'Europarl.' },
      ],
      llm,
      {},
      {},
    )
    expect(retrieval.retrievalQuery).not.toBe('and the datasets?')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/tests/ragPipeline.test.ts`
Expected: FAIL — `hybrid` 为 undefined / `passageIndex` 类型不存在

- [ ] **Step 3: 修改 `src/utils/ragPipeline.ts`**

三处改动：

```ts
// 1) 顶部补 import
import { retrievePassageContext, type HybridPassageDiagnostics } from './passageRetrieval'
import type { PassageIndex } from './passageIndex'
import type { Embedder } from './embedder'

// 2) PipelineRetrieval 带上 hybrid 诊断
export type PipelineRetrieval = RetrievalResult & {
  semantic?: SemanticRouteDiagnostics
  /** 走段落混合检索时的诊断（retrievalMode / 选中段落） */
  hybrid?: HybridPassageDiagnostics
}

// 3) IndexedPaper 新增可选字段
export interface IndexedPaper {
  tree: IndexNode
  pages: string[]
  semantic?: SemanticPaperIndex
  /**
   * 段落级混合索引。提供时检索走段落混合路径（回答前零 LLM 调用），
   * 否则回落语义树路由或平面 scoreAndSelect。
   */
  passageIndex?: PassageIndex
}

// 4) RagPipelineDeps 注入项
export interface RagPipelineDeps {
  now?: () => number
  materialize?: (groups: ContextGroup[]) => MaterializedContext
  /** 段落混合检索的注入：查询向量模型与 token 计数器（bench 注入冻结分词器） */
  passage?: {
    embedder?: Embedder
    countTokens?: (text: string) => number
    maxTokens?: number
  }
}
```

分派处（现 `paper.semantic ? routeWithSemanticTree(...) : scoreAndSelect(...)` 那个三元表达式）：

```ts
        const result = paper.passageIndex
          ? await retrievePassageContext(paper.passageIndex, retrievalQuery, {
              ...(deps.passage?.embedder ? { embedder: deps.passage.embedder } : {}),
              ...(deps.passage?.countTokens ? { countTokens: deps.passage.countTokens } : {}),
              ...(deps.passage?.maxTokens !== undefined ? { maxTokens: deps.passage.maxTokens } : {}),
            })
          : paper.semantic
            ? await routeWithSemanticTree(paper.semantic, retrievalQuery, llm, { now, materialize: deps.materialize })
            : await scoreAndSelect(paper.tree, retrievalQuery, llm, scoreOptions, { now })
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/tests/ragPipeline.test.ts && npm run typecheck`
Expected: PASS（3 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/utils/ragPipeline.ts src/tests/ragPipeline.test.ts
git commit -m "feat(rag): route indexed papers through passage retrieval when available"
```

---

### Task 10: store 分阶段后台构建

**Files:**
- Create: `src/utils/buildGeneration.ts`
- Modify: `src/stores/chat.ts`（`indexPaper`、`collectIndexedPapers`、`loadSemanticIndex` 调用处）
- Test: `src/tests/buildGeneration.test.ts`, `src/tests/chat.store.test.ts`（追加）

- [ ] **Step 1: 写失败测试——代次保护**

代次保护解决的是**跨多次构建**的问题：`indexingPapers` 只挡住同一篇论文的并发重复触发，挡不住「构建进行到一半，用户切了索引 profile」——那条路径必须让在途构建的写盘作废（方案 §8）。抽成一个独立小模块是为了能直接单测，不必绕 store 的异步编排。

`src/tests/buildGeneration.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { createBuildGeneration } from '../utils/buildGeneration'

describe('createBuildGeneration', () => {
  it('begin 返回的代次在无失效时一直有效', () => {
    const generation = createBuildGeneration()
    const token = generation.begin('p1')
    expect(generation.isCurrent('p1', token)).toBe(true)
  })

  it('invalidate 之后旧代次作废，新代次有效', () => {
    const generation = createBuildGeneration()
    const stale = generation.begin('p1')
    generation.invalidate('p1')
    const fresh = generation.begin('p1')
    expect(generation.isCurrent('p1', stale)).toBe(false)
    expect(generation.isCurrent('p1', fresh)).toBe(true)
  })

  it('不同论文互不影响', () => {
    const generation = createBuildGeneration()
    const p1 = generation.begin('p1')
    const p2 = generation.begin('p2')
    generation.invalidate('p1')
    expect(generation.isCurrent('p1', p1)).toBe(false)
    expect(generation.isCurrent('p2', p2)).toBe(true)
  })

  it('invalidateAll 让所有在途构建作废（切换索引 profile 时用）', () => {
    const generation = createBuildGeneration()
    const p1 = generation.begin('p1')
    const p2 = generation.begin('p2')
    generation.invalidateAll()
    expect(generation.isCurrent('p1', p1)).toBe(false)
    expect(generation.isCurrent('p2', p2)).toBe(false)
    expect(generation.isCurrent('p1', generation.begin('p1'))).toBe(true)
  })

  it('从未 begin 过的论文对任意代号都不有效（避免默认 0 蒙对）', () => {
    const generation = createBuildGeneration()
    expect(generation.isCurrent('unknown', 1)).toBe(false)
    expect(generation.isCurrent('unknown', 0)).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/tests/buildGeneration.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 `src/utils/buildGeneration.ts`**

```ts
/**
 * 长异步构建的代次（generation）保护。
 *
 * `indexingPapers` 这类「进行中」去重只能挡住同一篇论文的并发重复触发；
 * 挡不住「构建进行到一半，索引配置被改了」——那条路径下在途构建的结果已经
 * 按旧配置算出来了，写盘就会让索引与它自称的配置指纹对不上。
 * 约定：每次开始构建 `begin()` 取一个代次，写盘前用 `isCurrent()` 复核。
 */
export interface BuildGeneration {
  /** 开始一次构建，返回本次构建的代次 */
  begin(key: string): number
  /** 该代次是否仍然有效（没有被 invalidate / invalidateAll 作废） */
  isCurrent(key: string, token: number): boolean
  /** 让某个 key 的在途构建作废（如该篇被重新触发构建） */
  invalidate(key: string): void
  /** 让全部在途构建作废（如索引 profile 被切换） */
  invalidateAll(): void
}

export function createBuildGeneration(): BuildGeneration {
  /** key → 当前有效代次；不存在的 key 表示「没有在途构建」 */
  const current = new Map<string, number>()
  /** 每个 key 的代次计数器只增不减，避免复用旧数值被在途构建蒙对 */
  const counters = new Map<string, number>()

  const next = (key: string): number => {
    const value = (counters.get(key) ?? 0) + 1
    counters.set(key, value)
    return value
  }

  return {
    begin(key: string): number {
      const token = next(key)
      current.set(key, token)
      return token
    },
    isCurrent(key: string, token: number): boolean {
      const active = current.get(key)
      return active !== undefined && active === token
    },
    invalidate(key: string): void {
      if (!counters.has(key)) return // 从未构建过：不需要无谓地推高计数器
      current.delete(key)
      next(key)
    },
    invalidateAll(): void {
      for (const key of current.keys()) {
        current.delete(key)
        next(key)
      }
    },
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/tests/buildGeneration.test.ts`
Expected: PASS（5 个用例）

- [ ] **Step 5: 写失败测试（追加到 `src/tests/chat.store.test.ts`）**

```ts
describe('段落索引的分阶段构建', () => {
  it('indexPaper 落盘阶段① 后即可用，不等卡片调用', async () => {
    const store = useChatStore()
    // window.db.paper.readFile 返回极小的 base64；extractPages 由测试替身给出两页
    vi.mocked(window.db.paper.readFile).mockResolvedValue('BASE64')
    vi.mock('../utils/pageIndex', async importOriginal => ({
      ...(await importOriginal<typeof import('../utils/pageIndex')>()),
      extractPages: async () => ['Abstract\nA short abstract.', 'Methods\nWe use BM25.'],
    }))
    await store.indexPaper('paper-1')
    const saved = vi.mocked(window.db.index.set).mock.calls.at(-1)
    const index = JSON.parse(saved![1] as string)
    expect(index.version).toBe(2)
    expect(index.passages.length).toBeGreaterThan(0)
  })

  it('旧版（v1）索引不被解析为段落索引，且触发后台重建', async () => {
    vi.mocked(window.db.index.get).mockResolvedValue({
      paperId: 'paper-1',
      indexJson: JSON.stringify({ title: 'Paper', nodeId: 'root', startPage: 0, endPage: 1, summary: '', nodes: [] }),
      pagesJson: JSON.stringify(['page one']),
      createdAt: '',
    })
    const store = useChatStore()
    const papers = await store.collectIndexedPapers({ id: 'c1', paperIds: ['paper-1'] } as never)
    expect(papers.papers[0].passageIndex).toBeUndefined()
    expect(papers.papers[0].tree.nodeId).toBe('root')
  })
})
```

> 若 `chat.store.test.ts` 现有结构不便追加（例如 mock 在文件顶层用 `vi.mock` 静态声明），把这两个用例放进新文件 `src/tests/chatPassageIndex.test.ts`，复用 `src/tests/setup.ts` 的 `window.db` 注入即可。

- [ ] **Step 6: 写失败测试——store 层的代次保护**

这一对用例是**成对**的：只有「无失效时确实写盘」这个正对照成立，后面「失效后不写盘」才证明得了守卫在起作用（否则「从未写盘」也会让断言通过）。

放进新文件 `src/tests/chatPassageIndex.test.ts`（需要模块级 `vi.mock`，与 `chat.store.test.ts` 的既有 mock 结构隔开）：

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PassagePipelineDeps } from '../utils/passageIndexBuilder'
import type { PassageIndex } from '../utils/passageIndex'
import { useChatStore } from '../stores/chat'

/** 捕获 store 交给管线的 persist，由测试决定何时、以哪一代调用它。 */
let capturedPersist: PassagePipelineDeps['persist'] | undefined
let capturedRest: Promise<PassageIndex>

vi.mock('../utils/passageIndexBuilder', () => ({
  startPassagePipeline: vi.fn(async (_pages: string[], deps: PassagePipelineDeps) => {
    capturedPersist = deps.persist
    const stage1 = {
      version: 2, stage: 1, passages: [], tree: {}, passageConfigHash: deps.passageConfigHash, separatorTokens: 0,
    } as unknown as PassageIndex
    capturedRest = Promise.resolve(stage1)
    return { index: stage1, rest: capturedRest }
  }),
}))

vi.mock('../utils/pageIndex', async importOriginal => ({
  ...(await importOriginal<typeof import('../utils/pageIndex')>()),
  extractPages: async () => ['Abstract\nA short abstract.', 'Methods\nWe use BM25.'],
}))

const finalIndex = {
  version: 2, stage: 3, passages: [], tree: {}, passageConfigHash: 'h', separatorTokens: 0,
} as unknown as PassageIndex

describe('indexPaper 的代次保护', () => {
  beforeEach(() => {
    capturedPersist = undefined
    vi.mocked(window.db.index.set).mockClear()
    vi.mocked(window.db.paper.readFile).mockResolvedValue('BASE64')
    vi.mocked(window.db.index.get).mockResolvedValue(undefined)
  })

  it('正对照：没有失效时 persist 确实写盘', async () => {
    const store = useChatStore()
    await store.indexPaper('paper-1')
    await capturedPersist!(finalIndex, 3)
    expect(window.db.index.set).toHaveBeenCalledTimes(1)
  })

  it('同一篇被重新触发构建后，旧代次的写入被丢弃', async () => {
    const store = useChatStore()
    await store.indexPaper('paper-1')
    const stalePersist = capturedPersist!
    await store.indexPaper('paper-1')          // 新一代，旧代次随即作废
    await stalePersist(finalIndex, 3)
    expect(window.db.index.set).not.toHaveBeenCalled()
  })

  it('切换索引 profile 后，在途代次的写入被丢弃', async () => {
    const store = useChatStore()
    await store.indexPaper('paper-1')
    const stalePersist = capturedPersist!
    await store.updateProfile(store.indexProfileId, { model: 'another-model' } as never)
    await stalePersist(finalIndex, 3)
    expect(window.db.index.set).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 7: 跑测试确认失败**

Run: `npx vitest run src/tests/chat.store.test.ts src/tests/chatPassageIndex.test.ts`
Expected: FAIL — `passageIndex` 字段不存在 / `buildGeneration` 未接线 / `index.set` 未按阶段调用

- [ ] **Step 8: 改 `src/stores/chat.ts`**

顶部补 import：

```ts
import { createBuildGeneration } from '../utils/buildGeneration'
import { createEstimatingTokenCounter } from '../utils/passages'
import {
  PASSAGE_INDEX_SCHEMA_VERSION, parsePassageIndex, serializePassageIndex,
  passageConfigHash, structureHash, type PassageIndex,
} from '../utils/passageIndex'
import { startPassagePipeline } from '../utils/passageIndexBuilder'
import { STRUCTURE_CARD_PROMPT_VERSION } from '../utils/structureCards'
import { DEFAULT_MAX_INPUT_CHARS } from '../utils/semanticTree'
import { DEFAULT_PASSAGE_OPTIONS } from '../utils/passages'
import { createTransformersEmbedder } from '../utils/transformersEmbedder'
import type { Embedder } from '../utils/embedder'
```

> `extractPages` 不用补 import——`chat.ts:3` 已经 `import { extractPages, buildPageIndex } from '../utils/pageIndex'`，下面片段的用法与 `chat.ts:522` 的既有调用完全一致。

模块级常量与工具（放在 store 定义外或 store 内部均可，保持一处定义）：

```ts
/** 段落 token 计数用估算器：产品不引入真分词器（bench 才注入冻结的 BGE-M3） */
const COUNT_TOKENS = createEstimatingTokenCounter()

/** 索引模型身份：端点 + 模型名（模型换了语义就换了，卡片必须重做） */
function indexModelIdentity(profile: LLMProfile): string {
  return `${profile.baseUrl ?? ''}|${profile.model ?? ''}`
}

function currentPassageConfigHash(): string {
  return passageConfigHash({ schemaVersion: PASSAGE_INDEX_SCHEMA_VERSION, segmentation: DEFAULT_PASSAGE_OPTIONS })
}

function currentStructureHash(profile: LLMProfile): string {
  return structureHash({
    schemaVersion: PASSAGE_INDEX_SCHEMA_VERSION,
    passageConfigHash: currentPassageConfigHash(),
    promptVersion: STRUCTURE_CARD_PROMPT_VERSION,
    maxInputChars: DEFAULT_MAX_INPUT_CHARS,
    model: indexModelIdentity(profile),
  })
}
```

> `LLMProfile` 已定义在 `src/stores/chat.ts:24-35`，字段就是 `id` / `name` / `provider` / `model` / `apiKey` / `baseUrl` / `temperature` / `maxTokens` / `topK` / `systemPrompt`——上面用到的 `profile.baseUrl` 与 `profile.model` 都存在。**`indexModelIdentity` 只覆盖端点与模型名两项，绝不把 `apiKey` 拼进去**：这个指纹会落进 `paper_indexes.index_json` 并随 bench 结果 JSON 落盘（全局约束第 6 条）。

`indexPaper` 整体替换：

```ts
  /** 构建代次保护（方案 §8）：写盘前复核，过期的一代整体丢弃。 */
  const buildGeneration = createBuildGeneration()

  async function indexPaper(paperId: string, opts: IndexPaperOptions = {}): Promise<void> {
    if (indexingPapers.value.has(paperId)) return
    indexingPapers.value.add(paperId)
    const token = buildGeneration.begin(paperId)
    void ensureEmbedder()
    try {
      const base64 = await window.db.paper.readFile(paperId)
      if (!base64) throw new Error('论文文件缺失')
      const pages = await extractPages(base64)
      // 配置快照：整轮构建（含阶段③ 的卡片调用）都用开始这一刻的 profile，
      // 中途切 profile 只会让这一代作废（见 persist 里的代次复核）
      const buildProfile: LLMProfile = { ...indexProfile.value }
      const stored = await window.db.index.get(paperId)
      const existing = stored ? parsePassageIndex(stored.indexJson) : undefined
      const embedder = await currentEmbedder()

      const { rest } = await startPassagePipeline(
        pages,
        {
          llm: prompt => callLLM([{ role: 'user', content: prompt }], buildProfile),
          countTokens: COUNT_TOKENS,
          ...(embedder ? { embedder } : {}),
          passageConfigHash: currentPassageConfigHash(),
          structureHash: currentStructureHash(buildProfile),
          maxInputChars: DEFAULT_MAX_INPUT_CHARS,
          persist: (next: PassageIndex) => {
            // 期间切了索引 profile 或这一篇被重新触发构建：这一代结果整体丢弃，不写盘。
            // 注意是「整体」——不能只丢卡片而把段落写进去，混合代数会让索引
            // 与它自称的 structureHash 对不上
            if (!buildGeneration.isCurrent(paperId, token)) return
            return window.db.index.set(paperId, JSON.stringify(serializePassageIndex(next)), JSON.stringify(pages))
          },
        },
        { existing },
      )
      indexedPapers.value = new Set([...indexedPapers.value, paperId])
      // 阶段① 已落盘，②③ 在后台继续；syncStage1Only 与默认都只等阶段①，
      // 因为提问不等待卡片调用（方案 §6.1）
      void rest.catch(() => {})
      if (!opts.syncStage1Only) await rest.catch(() => {})
    } finally {
      indexingPapers.value.delete(paperId)
    }
  }
```

同时把索引 profile 变更处接上作废。`updateProfile` 在 `src/stores/chat.ts:368-375`，已经有一处「改的是索引配置」分支（`if (id === indexProfileId.value) await refreshTreeReadyPapers()`），把作废追加进**同一个分支**里：

```ts
  async function updateProfile(id: string, patch: Partial<Omit<LLMProfile, 'id'>>) {
    const idx = profiles.value.findIndex(p => p.id === id)
    if (idx === -1) return
    profiles.value[idx] = { ...profiles.value[idx], ...patch }
    await persistProfiles()
    // 改的若是当前索引配置（模型/端点），已建好的树随即失效，就绪集合要重算
    if (id === indexProfileId.value) {
      // 段落索引同理：在途构建按旧端点算出的结构卡片与 structureHash 已经不对了，
      // 作废让它们停止写盘（方案 §8），再把受影响的论文重新入队
      buildGeneration.invalidateAll()
      await refreshTreeReadyPapers()
      void reindexStalePapers()
    }
  }
```

`reindexStalePapers` 放在 `indexPaper` 之后（同一 setup 函数内，函数声明提升，调用顺序不受影响）：

```ts
  /**
   * 索引 profile 变了（端点 / 模型）→ 每篇论文的 structureHash 随之改变 → 卡片与卡片向量全部过期。
   * 逐个重新入队，**串行**（`await` 每一篇）而不是并发铺开：阶段③ 是要计费的 LLM 调用，
   * 一次导入几十篇论文时并发会把服务商打爆。调用方用 `void` 脱离，不阻塞设置页。
   * `indexPaper` 内部已有 `indexingPapers` 去重，对正在构建的论文重复调用是安全的；
   * 具体重建到哪一阶段交给 `planPassageIndexRebuild` 判断（结构没变时只重算向量）。
   */
  async function reindexStalePapers(): Promise<void> {
    const papers = (await window.db.paper.list()) as Array<{ id: string }>
    for (const paper of papers) {
      try {
        await indexPaper(paper.id)
      } catch {
        // 单篇失败不影响其余论文：与 collectIndexedPapers 的容错口径一致
      }
    }
  }
```

> `IndexPaperOptions` 增加 `syncStage1Only?: boolean`。上面这段刻意没有用 `usePaperStore`——`window.db.paper.list()` 已是现成接口，`chat.ts` 目前也不依赖 paper store，不要为了一处遍历引入新的 store 依赖。

`collectIndexedPapers` 的每篇分支替换为：

```ts
      let stored = await window.db.index.get(paperId)
      if (!stored) {
        // 导入时后台预处理未完成（LLM 未配置等）：同步只做阶段①（本地切段，<1 秒），
        // ②③ 继续在后台跑——提问不等待卡片调用（方案 §6.1）
        try {
          await indexPaper(paperId, { syncStage1Only: true })
          stored = await window.db.index.get(paperId)
        } catch {
          // 该篇没有可用索引
        }
      }
      if (!stored) continue

      const pages: string[] = JSON.parse(stored.pagesJson)
      const passageIndex = parsePassageIndex(stored.indexJson)
      if (passageIndex) {
        papers.push({ tree: passageIndex.tree, pages, passageIndex })
        paperIds.push(paperId)
        continue
      }

      // 旧版（v1 平面）索引：它自己还能用，先按旧路径服务，同时后台重建；
      // 重建完成前绝不静默切换路径（方案 §6.2 的失效规则）
      void indexPaper(paperId, { syncStage1Only: true }).catch(() => {})
      const semantic = await loadSemanticIndex(paperId)
      papers.push({ tree: JSON.parse(stored.indexJson), pages, ...(semantic ? { semantic } : {}) })
      paperIds.push(paperId)
```

- [ ] **Step 9: 跑测试确认通过**

Run: `npx vitest run src/tests/chat.store.test.ts src/tests/chatPassageIndex.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 10: 提交**

```bash
git add src/utils/buildGeneration.ts src/stores/chat.ts src/tests/buildGeneration.test.ts src/tests/chat.store.test.ts src/tests/chatPassageIndex.test.ts
git commit -m "feat(store): build passage index in stages with generation guard"
```

---

### Task 11: 向量模型生命周期 + 语义树默认关闭

**Files:**
- Modify: `src/stores/chat.ts`
- Modify: `src/tests/semanticTreeStore.test.ts`, `src/tests/settingsViewTree.test.ts`

- [ ] **Step 1: 更新已有断言（语义树默认关闭）**

`src/tests/semanticTreeStore.test.ts:123` 与 `src/tests/settingsViewTree.test.ts:84` 把「默认开启」的断言改为「默认关闭」，并把用例名同步改掉（例如 `it('treeEnabled 默认关闭（方案 §6.3）')` / `expect(store.treeEnabled).toBe(false)`）。

- [ ] **Step 2: 写失败测试**

追加到 `src/tests/chat.store.test.ts`：

```ts
describe('语义树默认值', () => {
  it('未存过偏好时 treeEnabled 默认 false', async () => {
    vi.mocked(window.db.settings.get).mockResolvedValue(undefined)
    const store = useChatStore()
    await store.init()
    expect(store.treeEnabled).toBe(false)
  })

  it('存过 true 时不被强制覆盖', async () => {
    vi.mocked(window.db.settings.get).mockImplementation(async (key: string) =>
      key === 'tree_enabled' ? 'true' : undefined)
    const store = useChatStore()
    await store.init()
    expect(store.treeEnabled).toBe(true)
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run src/tests/chat.store.test.ts src/tests/semanticTreeStore.test.ts src/tests/settingsViewTree.test.ts`
Expected: FAIL — 默认值仍为 `true`

- [ ] **Step 4: 改 `src/stores/chat.ts`**

```ts
  // 语义树退出默认路径（方案 §6.3）：默认关闭，但已存偏好不强制覆盖；
  // 代码与设置页开关保留，是否删除另议。
  const treeEnabled = ref(false)
```

加载处（原 `treeEnabled.value = stored !== false`）改为只认显式的 `'true'`：

```ts
    const treeSetting = await window.db.settings.get('tree_enabled')
    if (treeSetting !== undefined) treeEnabled.value = treeSetting === 'true'
```

向量模型生命周期（新增到 store 内）：

```ts
  /** 向量模型状态：设置页与诊断可读；失败只是没有向量，不影响阶段① */
  const vectorModelState = ref<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  let embedderInstance: Embedder | undefined
  let embedderPromise: Promise<Embedder | undefined> | undefined

  /**
   * 取向量模型。问答热路径**不 await** 它（提问不等待模型加载）：
   * 已就绪就用，没就绪这次问题就按可用信号降级。
   */
  async function currentEmbedder(): Promise<Embedder | undefined> {
    if (embedderInstance) return embedderInstance
    embedderPromise ??= loadEmbedder()
    return embedderPromise
  }

  async function loadEmbedder(): Promise<Embedder | undefined> {
    vectorModelState.value = 'loading'
    try {
      embedderInstance = await createTransformersEmbedder({ wasmPaths: './ort/' })
      vectorModelState.value = 'ready'
      return embedderInstance
    } catch {
      // 下载失败 / 离线无缓存：停留阶段①，下次导入或切换索引配置时重试
      vectorModelState.value = 'failed'
      embedderPromise = undefined
      return undefined
    }
  }

  /** 触发下载但不阻塞调用方（init / indexPaper / 切换索引 profile 时各调一次）。 */
  function ensureEmbedder(): Promise<Embedder | undefined> {
    return currentEmbedder()
  }
```

`init()` 里在 `loaded.value = true` 之后追加：

```ts
    void ensureEmbedder()
```

`generateReply` / `continueMessage` 构造 pipeline 依赖时把向量模型传进去（**不 await**）：

```ts
    const passageDeps = embedderInstance ? { passage: { embedder: embedderInstance, countTokens: COUNT_TOKENS } } : { passage: { countTokens: COUNT_TOKENS } }
```

并把 `passageDeps` 并入传给 `runRagPipeline` / `retrieveRagContext` 的 deps 对象（与既有 `now` / `materialize` 同级）。

- [ ] **Step 5: 跑测试 + 类型检查**

Run: `npm test && npm run typecheck`
Expected: 全绿

- [ ] **Step 6: 提交**

```bash
git add src/stores/chat.ts src/tests/chat.store.test.ts src/tests/semanticTreeStore.test.ts src/tests/settingsViewTree.test.ts
git commit -m "feat(store): stage passage pipeline, lazy embedder, tree disabled by default"
```

---

## 阶段 D：bench 接入

### Task 12: bench 配置与校验

**Files:**
- Modify: `bench/src/types.ts`, `bench/src/config.ts`
- Create: `bench/configs/papermind-hybrid.json`, `bench/configs/papermind-hybrid-m3.json`
- Test: `bench/src/tests/passageConfig.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest'
import { expandMatrix, validatePaperMind } from '../config'

const baseConfig = {
  name: 'papermind-hybrid',
  kind: 'papermind',
  passage: { embedder: { model: 'Xenova/bge-small-en-v1.5', revision: 'main', dtype: 'q8', dim: 384 } },
  matrix: {
    topK: [4], minScore: [6], maxContextChars: [24000],
    minTokens: [120], maxTokens: [350], maxInputChars: [120000],
    rrfK: [60], sectionWeight: [0, 0.5, 1], neighbourFactor: [0.5], skipLimit: [20],
  },
}

describe('validatePaperMind（段落混合配置）', () => {
  it('合法配置通过，matrix 展开为 sectionWeight 的三个取值', () => {
    const configs = expandMatrix(validatePaperMind(baseConfig, 'test'))
    expect(configs).toHaveLength(3)
    expect(configs.map(c => (c as { sectionWeight?: number }).sectionWeight)).toEqual([0, 0.5, 1])
    for (const config of configs) expect(config.passage?.embedder.model).toBe('Xenova/bge-small-en-v1.5')
  })

  it('缺任一旋钮直接报错（配置即口径，不能默默用产品默认值）', () => {
    const { rrfK, ...matrix } = baseConfig.matrix
    expect(() => validatePaperMind({ ...baseConfig, matrix }, 'test')).toThrow(/rrfK/)
  })

  it('旋钮取值越界报错', () => {
    expect(() => validatePaperMind({ ...baseConfig, matrix: { ...baseConfig.matrix, sectionWeight: [-1] } }, 'test')).toThrow(/sectionWeight/)
    expect(() => validatePaperMind({ ...baseConfig, matrix: { ...baseConfig.matrix, rrfK: [0] } }, 'test')).toThrow(/rrfK/)
    expect(() => validatePaperMind({ ...baseConfig, matrix: { ...baseConfig.matrix, minTokens: [400], maxTokens: [350] } }, 'test')).toThrow(/minTokens/)
  })

  it('embedder 必须显式 pin 模型 / revision / 量化 / 维度', () => {
    const passage = { embedder: { model: 'm', revision: 'main', dtype: 'q8' } }
    expect(() => validatePaperMind({ ...baseConfig, passage }, 'test')).toThrow(/dim/)
  })

  it('无 passage 块的配置照旧（default.json 不受影响）', () => {
    const configs = expandMatrix(validatePaperMind({ name: 'default', matrix: { topK: [4] } }, 'test'))
    expect(configs).toHaveLength(1)
    expect(configs[0].passage).toBeUndefined()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run bench/src/tests/passageConfig.test.ts`
Expected: FAIL — `validatePaperMind` 不认识 `passage` / 新旋钮

- [ ] **Step 3: 改 `bench/src/types.ts`**

```ts
/** 段落混合检索的 embedder 身份：必须显式 pin，禁止环境默认（与强基线同一原则）。 */
export interface PassageEmbedderParams {
  model: string
  revision: string
  dtype: string
  dim: number
}

export interface PassageRuntimeParams {
  embedder: PassageEmbedderParams
}

export interface PaperMindConfig extends IndexOptions, Omit<RagOptions, 'externalContext'> {
  name: string
  kind?: 'papermind' | 'semantic-tree'
  semanticTree?: SemanticTreeParams
  /**
   * 段落级混合检索（方案 §7）：提供即走该路径。
   * 只放不可消融的 embedder 身份；可调旋钮在顶层，好让 matrix 直接消融。
   */
  passage?: PassageRuntimeParams
  /** 切段：不足 minTokens 向后合并 */
  minTokens?: number
  /** 切段：超过 maxTokens 在句子边界切开 */
  maxTokens?: number
  /** 卡片输入字符上限 */
  maxInputChars?: number
  rrfK?: number
  sectionWeight?: number
  neighbourFactor?: number
  skipLimit?: number
}
```

`ConfigFile`：

```ts
export interface ConfigFile {
  name: string
  kind?: 'papermind' | 'semantic-tree'
  semanticTree?: SemanticTreeParams
  /** 段落混合检索块（不可消融），由 expandMatrix 原样带到每个展开点 */
  passage?: PassageRuntimeParams
  matrix: Partial<Record<Exclude<keyof PaperMindConfig, 'name' | 'kind' | 'semanticTree' | 'passage'>, Array<number | boolean>>>
}
```

`PaperTimingRecord` 追加冷启动字段：

```ts
  /** —— 段落混合检索冷启动（方案 §7）；仅 passage 配置的论文写入 —— */
  coldStartPassageMs?: number
  coldStartEmbedPassagesMs?: number
  coldStartStructureCallMs?: number
  /** 1 = 卡片调用命中缓存，不计入 structureCall 耗时统计 */
  coldStartStructureCacheHit?: number
  coldStartStructureInputTokens?: number
  coldStartStructureOutputTokens?: number
  /** 1 = token 数为估算值（服务商 usage 未透传） */
  coldStartStructureTokensEstimated?: number
  coldStartEmbedCardsMs?: number
  coldStartTotalMs?: number
  /** 卡片回落原因；未回落时不写 */
  coldStartStructureFallback?: string
  coldStartCardCount?: number
  coldStartPassageCount?: number
  /** 1 = 本篇建索引失败 */
  coldStartFailed?: number
```

`PerSampleRecord` 追加：

```ts
  /** 段落混合检索实际使用的模式（bm25 / bm25+dense / full / full-title-fallback / bm25+card-lexical） */
  retrievalMode?: string
```

`BenchResult.meta.retrievalAlgorithm` 联合类型追加 `'hybrid-passage'`。

- [ ] **Step 4: 改 `bench/src/config.ts`**

三处改动。

**(a) `validatePaperMind` 加 `export`**（现为模块私有，纯函数，导出后可被单测直接调用——`expandMatrix` 已经是导出的）：

```ts
export function validatePaperMind(raw: Record<string, unknown>, path: string): ConfigFile {
```

**(b) `allowed` 键集合追加七个旋钮**（现有 8 个键：`topK` / `minScore` / `chunkPages` / `minSectionPages` / `maxSectionPages` / `maxContextChars` / `forceFixedChunk` / `enableRewrite`）：

```ts
  const allowed = new Set([
    'topK', 'minScore', 'chunkPages', 'minSectionPages', 'maxSectionPages', 'maxContextChars', 'forceFixedChunk', 'enableRewrite',
    // 段落混合检索旋钮（方案 §7）：与其它参数一样显式列出，拼错的键不能静默失效
    'minTokens', 'maxTokens', 'maxInputChars', 'rrfK', 'sectionWeight', 'neighbourFactor', 'skipLimit',
  ])
```

`passage` 键本身不进 `matrix`（它是不可消融的身份块，由 `carried` 携带），因此在 `validatePaperMind` 里对它单独校验并原样返回。新增两段校验：

```ts
/** 段落混合检索的旋钮必须齐全且在合理范围：缺一个就会静默用产品默认值，配置就不等于口径了。 */
function validateHybridKnobs(config: PaperMindConfig, path: string): void {
  if (!config.passage) return
  const require = (name: keyof PaperMindConfig, predicate: (v: unknown) => boolean, hint: string) => {
    const value = config[name]
    if (!predicate(value)) fail(path, `passage`, `${String(name)} ${hint}`)
  }
  require('minTokens', v => typeof v === 'number' && Number.isInteger(v) && v > 0, '必须存在且为正整数')
  require('maxTokens', v => typeof v === 'number' && Number.isInteger(v) && v > 0, '必须存在且为正整数')
  if (typeof config.maxTokens === 'number' && typeof config.minTokens === 'number' && config.maxTokens < config.minTokens) {
    fail(path, 'passage', 'maxTokens 必须不小于 minTokens')
  }
  require('maxInputChars', v => typeof v === 'number' && Number.isInteger(v) && v > 0, '必须存在且为正整数')
  require('rrfK', v => typeof v === 'number' && Number.isInteger(v) && v > 0, '必须存在且为正整数')
  require('sectionWeight', v => typeof v === 'number' && v >= 0 && v <= 1, '必须在 [0, 1]')
  require('neighbourFactor', v => typeof v === 'number' && v >= 0 && v <= 1, '必须在 [0, 1]')
  require('skipLimit', v => typeof v === 'number' && Number.isInteger(v) && v > 0, '必须存在且为正整数')
}

function validatePassageParams(value: unknown, path: string): PassageRuntimeParams {
  if (!isPlainObject(value)) fail(path, 'passage', '必须是对象')
  const embedder = (value as Record<string, unknown>).embedder
  if (!isPlainObject(embedder)) fail(path, 'passage.embedder', '缺失或不是对象')
  const e = embedder as Record<string, unknown>
  for (const key of ['model', 'revision', 'dtype'] as const) {
    if (typeof e[key] !== 'string' || !(e[key] as string).trim()) {
      fail(path, `passage.embedder.${key}`, '必须为非空字符串（显式 pin，禁止环境默认）')
    }
  }
  if (typeof e.dim !== 'number' || !Number.isInteger(e.dim) || e.dim <= 0) fail(path, 'passage.embedder.dim', '必须为正整数')
  return { embedder: { model: e.model as string, revision: e.revision as string, dtype: e.dtype as string, dim: e.dim as number } }
}
```

`loadConfigs` 的返回改为「展开后再逐点校验旋钮」：

```ts
    const configs = expandMatrix(validatePaperMind(record, path)).map(config => {
      validateHybridKnobs(config, path)
      return config
    })
    return configs
```

**(c) `carried` 块追加 `passage`**（`expandMatrix` 约 `bench/src/config.ts:20-30`）。校验只做一次：在 `validatePaperMind` 里校验并归一化后写回 `ConfigFile`，`expandMatrix` 只透传：

```ts
  const carried = {
    ...(file.kind ? { kind: file.kind } : {}),
    ...(file.semanticTree ? { semanticTree: file.semanticTree } : {}),
    // passage 的身份由 validatePaperMind 校验并归一化，这里不再重复校验
    ...(file.passage ? { passage: file.passage } : {}),
  }
```

`validatePaperMind` 内部的接线（在既有的 `semanticTree` 校验旁并列）：

```ts
  // 段落混合检索块：不可消融，校验后写回 ConfigFile，由 expandMatrix 原样带到每个展开点
  if (raw.passage !== undefined) file.passage = validatePassageParams(raw.passage, path)
```

- [ ] **Step 5: 写两个配置文件**

`bench/configs/papermind-hybrid.json`（矩阵逐项显式，与 `default.json` 的其它字段口径一致）：

```json
{
  "name": "papermind-hybrid",
  "kind": "papermind",
  "passage": {
    "embedder": { "model": "Xenova/bge-small-en-v1.5", "revision": "main", "dtype": "q8", "dim": 384 }
  },
  "matrix": {
    "topK": [4],
    "minScore": [6],
    "maxContextChars": [24000],
    "enableRewrite": [false],
    "minTokens": [120],
    "maxTokens": [350],
    "maxInputChars": [120000],
    "rrfK": [60],
    "sectionWeight": [0, 0.5, 1],
    "neighbourFactor": [0.5],
    "skipLimit": [20]
  }
}
```

`bench/configs/papermind-hybrid-m3.json`：只有 embedder 不同（消融用），`sectionWeight` 固定 `[0.5]`：

```json
{
  "name": "papermind-hybrid-m3",
  "kind": "papermind",
  "passage": {
    "embedder": { "model": "BAAI/bge-m3", "revision": "main", "dtype": "q8", "dim": 1024 }
  },
  "matrix": {
    "topK": [4],
    "minScore": [6],
    "maxContextChars": [24000],
    "enableRewrite": [false],
    "minTokens": [120],
    "maxTokens": [350],
    "maxInputChars": [120000],
    "rrfK": [60],
    "sectionWeight": [0.5],
    "neighbourFactor": [0.5],
    "skipLimit": [20]
  }
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run bench/src/tests && npm run typecheck`
Expected: PASS（5 个用例）

- [ ] **Step 7: 提交**

```bash
git add bench/src/types.ts bench/src/config.ts bench/src/tests/passageConfig.test.ts bench/configs/papermind-hybrid.json bench/configs/papermind-hybrid-m3.json
git commit -m "feat(bench): add hybrid passage config with explicit knob validation"
```

---

### Task 13: 冷启动记录与聚合

**Files:**
- Create: `bench/src/metrics/passageDiagnostics.ts`
- Test: `bench/src/tests/passageDiagnostics.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest'
import { introspectPassageStageEvent, summarizeColdStart, type PassageStageEventLike } from '../metrics/passageDiagnostics'

describe('summarizeColdStart', () => {
  const records = [
    { paperId: 'p1', source: 'qasper' as const, pageCount: 5, questionCount: 3, coldStartPassageMs: 100, coldStartEmbedPassagesMs: 200, coldStartStructureCallMs: 4000, coldStartStructureCacheHit: 0, coldStartStructureInputTokens: 8000, coldStartStructureOutputTokens: 400, coldStartEmbedCardsMs: 20, coldStartTotalMs: 4300, coldStartCardCount: 5, coldStartPassageCount: 40 },
    { paperId: 'p2', source: 'qasper' as const, pageCount: 5, questionCount: 2, coldStartPassageMs: 120, coldStartEmbedPassagesMs: 220, coldStartStructureCallMs: 100, coldStartStructureCacheHit: 1, coldStartStructureInputTokens: 8100, coldStartStructureOutputTokens: 410, coldStartEmbedCardsMs: 22, coldStartTotalMs: 400, coldStartPassageCount: 44 },
    { paperId: 'p3', source: 'qasper' as const, pageCount: 5, questionCount: 2, coldStartFailed: 1, coldStartStructureFallback: 'invalid-json', coldStartCardCount: 3, coldStartPassageCount: 30 },
  ]

  it('缓存命中的卡片调用不计入 structureCall 耗时统计', () => {
    const metrics = summarizeColdStart(records)
    expect(metrics.structureCallP50Ms).toBe(4000)
    expect(metrics.structureCallP95Ms).toBe(4000)
  })

  it('聚合出总耗时 P50/P95 与每篇 token 均值', () => {
    const metrics = summarizeColdStart(records)
    expect(metrics.coldStartTotalP50Ms).toBe(4300)
    expect(metrics.coldStartTotalP95Ms).toBe(4300)
    expect(metrics.structureTokensPerPaper).toBe(8455)
  })

  it('回落率按尝试过的论文归一', () => {
    const metrics = summarizeColdStart(records)
    expect(metrics.structureFallbackRate).toBeCloseTo(1 / 3)
  })

  it('阶段耗时取各自分母的均值', () => {
    const metrics = summarizeColdStart(records)
    expect(metrics.avgColdStartPassageMs).toBeCloseTo(110)
    expect(metrics.avgColdStartEmbedPassagesMs).toBeCloseTo(210)
    expect(metrics.avgColdStartEmbedCardsMs).toBeCloseTo(21)
  })

  it('空输入产出空对象（报表据此跳过整块）', () => {
    expect(summarizeColdStart([])).toEqual({})
  })
})

describe('introspectPassageStageEvent', () => {
  it('把卡片事件映射为 token 估算与缓存命中标记', () => {
    const event: PassageStageEventLike = { stage: 'structure', latencyMs: 12, cardCount: 3 }
    expect(introspectPassageStageEvent(event, { inputChars: 100, outputChars: 40 })).toEqual({
      coldStartStructureCallMs: 12,
      coldStartCardCount: 3,
      coldStartStructureInputTokens: 25,
      coldStartStructureOutputTokens: 10,
      coldStartStructureTokensEstimated: 1,
    })
  })

  it('回落事件额外记原因', () => {
    const event: PassageStageEventLike = { stage: 'structure', latencyMs: 9, cardCount: 2, fallback: 'input-too-large' }
    expect(introspectPassageStageEvent(event, { inputChars: 0, outputChars: 0 }).coldStartStructureFallback).toBe('input-too-large')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run bench/src/tests/passageDiagnostics.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 `bench/src/metrics/passageDiagnostics.ts`**

```ts
/**
 * 冷启动成本的记录与聚合（方案 §7）：**不进入 Q**，与 Q 并列报告。
 *
 * 口径要点：
 * - `structureCall` 的 P50/P95 **只统计未命中缓存的调用**——缓存命中时耗时接近 0，
 *   混进去会把卡片调用成本稀释成假象；命中的论文仍照记 token（估算）与卡片数。
 * - 回落率的分母是**所有尝试过的论文**（回落是结果的一部分），
 *   阶段耗时均值只在真的做了那一步的论文上平均。
 */
import { withPercentiles } from './aggregate'
import type { PaperTimingRecord } from '../types'

/**
 * 取均值，空数组返回 `undefined` 而非 0（与 `treeDiagnostics.ts` 的私有 `mean` 同口径，
 * 不能直接用 `aggregate.mean`——它对空数组返回 0，会把「没有数据」写成「成本为零」）。
 */
const meanOf = (values: number[]): number | undefined =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : undefined

export interface PassageStageEventLike {
  stage: 'passages' | 'passage-vectors' | 'structure' | 'card-vectors'
  latencyMs: number
  passageCount?: number
  cardCount?: number
  fallback?: string
  cacheHit?: boolean
}

/** 卡片事件的 token 估算：`LlmClient.complete` 不透传服务商 usage，故一律标 estimated=1。 */
export function introspectPassageStageEvent(
  event: PassageStageEventLike,
  input: { inputChars: number; outputChars: number; cacheHit?: boolean },
): Partial<PaperTimingRecord> {
  if (event.stage !== 'structure') return {}
  return {
    coldStartStructureCallMs: event.latencyMs,
    ...(event.cardCount !== undefined ? { coldStartCardCount: event.cardCount } : {}),
    coldStartStructureTokensEstimated: 1,
    coldStartStructureInputTokens: Math.max(1, Math.round(input.inputChars / 4)),
    coldStartStructureOutputTokens: Math.max(1, Math.round(input.outputChars / 4)),
    coldStartStructureCacheHit: (input.cacheHit ?? event.cacheHit) ? 1 : 0,
    ...(event.fallback ? { coldStartStructureFallback: event.fallback } : {}),
  }
}

function valuesOf(records: PaperTimingRecord[], pick: (record: PaperTimingRecord) => number | undefined): number[] {
  return records.map(pick).filter((value): value is number => value !== undefined && Number.isFinite(value))
}

/** 结果 JSON 的 `metrics` 增量；报表据此渲染「冷启动成本」表。 */
export function summarizeColdStart(records: PaperTimingRecord[]): Record<string, number> {
  if (records.length === 0) return {}
  const metrics: Record<string, number> = {}
  const store = (key: string, value: number | undefined) => {
    if (value !== undefined && Number.isFinite(value)) metrics[key] = value
  }

  const passageMs = valuesOf(records, record => record.coldStartPassageMs)
  const embedPassagesMs = valuesOf(records, record => record.coldStartEmbedPassagesMs)
  const embedCardsMs = valuesOf(records, record => record.coldStartEmbedCardsMs)
  const totalMs = valuesOf(records, record => record.coldStartTotalMs)
  store('avgColdStartPassageMs', meanOf(passageMs))
  store('avgColdStartEmbedPassagesMs', meanOf(embedPassagesMs))
  store('avgColdStartEmbedCardsMs', meanOf(embedCardsMs))

  // 卡片调用只统计未命中缓存的调用
  const uncachedCallMs = records
    .filter(record => record.coldStartStructureCacheHit !== 1)
    .map(record => record.coldStartStructureCallMs)
    .filter((value): value is number => value !== undefined && Number.isFinite(value))

  const tokensPerPaper = valuesOf(records, record => {
    const input = record.coldStartStructureInputTokens
    const output = record.coldStartStructureOutputTokens
    if (input === undefined && output === undefined) return undefined
    return (input ?? 0) + (output ?? 0)
  })
  store('structureTokensPerPaper', meanOf(tokensPerPaper))

  const attempted = records.length
  const fallbacks = records.filter(record => record.coldStartStructureFallback !== undefined).length
  store('structureFallbackRate', attempted > 0 ? fallbacks / attempted : undefined)
  store('avgColdStartCardCount', meanOf(valuesOf(records, record => record.coldStartCardCount)))
  store('avgColdStartPassageCount', meanOf(valuesOf(records, record => record.coldStartPassageCount)))

  return withPercentiles(metrics, { coldStartTotal: totalMs, structureCall: uncachedCallMs })
}
```

> `withPercentiles(metrics, values)`（`bench/src/metrics/aggregate.ts`，已存在）对每个 key 产出 `${key}P50Ms` 与 `${key}P95Ms`，因此本次调用产出 `coldStartTotalP50Ms/P95Ms` 与 `structureCallP50Ms/P95Ms`，与方案 §7 的聚合指标一一对应。它对空数组直接跳过该 key（不会写出 0），这正是「没有缓存未命中的调用时不报卡片耗时」想要的行为。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run bench/src/tests/passageDiagnostics.test.ts && npm run typecheck`
Expected: PASS（7 个用例）

- [ ] **Step 5: 提交**

```bash
git add bench/src/metrics/passageDiagnostics.ts bench/src/tests/passageDiagnostics.test.ts
git commit -m "feat(bench): record and aggregate passage cold-start cost"
```

---

### Task 14: `runQaTask` 接入段落索引钩子

**Files:**
- Create: `bench/src/runner/passageIndexHook.ts`
- Modify: `bench/src/runner/qa.ts`, `bench/src/cli.ts`

- [ ] **Step 1: 实现 `bench/src/runner/passageIndexHook.ts`**

```ts
/**
 * 段落索引 hook（形态对齐 `runner/semanticTreeQa.ts` 的建树 hook）：
 * 冷启动在**逐题计时之前**完成（`query-timeline-v2` 协议），因此 hook 里
 * `await` 整个 `rest`（bench 始终构建到阶段③，不评测中间阶段的检索）。
 *
 * 不写 SQLite：评测进程不引入 better-sqlite3，`persist` 是记账空函数。
 */
import type { Embedder } from '../../../src/utils/embedder'
import {
  PASSAGE_INDEX_SCHEMA_VERSION, PASSAGE_INDEX_VERSION,
  passageConfigHash, structureHash, type PassageIndex,
} from '../../../src/utils/passageIndex'
import { startPassagePipeline, type PassageStageEvent } from '../../../src/utils/passageIndexBuilder'
import type { TokenCounter } from '../../../src/utils/passages'
import { STRUCTURE_CARD_PROMPT_VERSION } from '../../../src/utils/structureCards'
import type { LlmClient } from '../llmClient'
import type { EvalSample, PaperTimingRecord } from '../types'
import { introspectPassageStageEvent } from '../metrics/passageDiagnostics'

export interface HybridKnobs {
  minTokens: number
  maxTokens: number
  maxInputChars: number
  rrfK: number
  sectionWeight: number
  neighbourFactor: number
  skipLimit: number
}

export interface PassageIndexHookOptions {
  knobs: HybridKnobs
  client: LlmClient
  /** 加载失败时为 undefined：本篇/本轮降级为 bm25*，由 cli 标为不参与正式对照 */
  embedder: Embedder | undefined
  /** 契约分词器的 token 计数适配器（`ContextTokenizer` 只有 `tokenize`） */
  countTokens: TokenCounter
  /** 卡片指纹里的模型身份；取 cli 的 `env.model`（`LlmClient` 无 identity 方法） */
  modelIdentity: string
  now?: () => number
}

export interface PassageIndexInfo {
  index: PassageIndex
  coldStart: Partial<PaperTimingRecord>
  cacheHits: number
  cacheMisses: number
}

export type PassageIndexHook = (sample: EvalSample) => Promise<PassageIndexInfo>

export function createPassageIndexHook(opts: PassageIndexHookOptions): PassageIndexHook {
  const now = opts.now ?? Date.now
  const passageConfig = passageConfigHash({
    schemaVersion: PASSAGE_INDEX_SCHEMA_VERSION,
    segmentation: { minTokens: opts.knobs.minTokens, maxTokens: opts.knobs.maxTokens },
  })
  const structure = structureHash({
    schemaVersion: PASSAGE_INDEX_SCHEMA_VERSION,
    passageConfigHash: passageConfig,
    promptVersion: STRUCTURE_CARD_PROMPT_VERSION,
    maxInputChars: opts.knobs.maxInputChars,
    model: opts.modelIdentity,
  })

  return async (sample: EvalSample): Promise<PassageIndexInfo> => {
    const before = opts.client.stats()
    const startedAt = now()
    const coldStart: Partial<PaperTimingRecord> = {}
    let structureCacheHit = false
    let inputChars = 0
    let outputChars = 0

    const llm = async (prompt: string): Promise<string> => {
      inputChars = prompt.length
      const statsBefore = opts.client.stats()
      const raw = await opts.client.complete(prompt)
      structureCacheHit = opts.client.stats().hits > statsBefore.hits
      outputChars = raw.length
      return raw
    }

    const { rest } = await startPassagePipeline(
      sample.pages,
      {
        llm,
        countTokens: opts.countTokens,
        ...(opts.embedder ? { embedder: opts.embedder } : {}),
        passageConfigHash: passageConfig,
        structureHash: structure,
        maxInputChars: opts.knobs.maxInputChars,
        now,
        persist: () => {},
        onStage: (event: PassageStageEvent) => {
          if (event.stage === 'passages') {
            coldStart.coldStartPassageMs = event.latencyMs
            coldStart.coldStartPassageCount = event.passageCount
          } else if (event.stage === 'passage-vectors') {
            coldStart.coldStartEmbedPassagesMs = event.latencyMs
          } else if (event.stage === 'card-vectors') {
            coldStart.coldStartEmbedCardsMs = event.latencyMs
          } else {
            Object.assign(coldStart, introspectPassageStageEvent(
              {
                stage: 'structure',
                latencyMs: event.latencyMs,
                ...(event.cardCount !== undefined ? { cardCount: event.cardCount } : {}),
                ...(event.fallback ? { fallback: event.fallback } : {}),
              },
              { inputChars, outputChars, cacheHit: structureCacheHit || event.cacheHit === true },
            ))
          }
        },
      },
      { force: true },
    )

    const index = await rest
    coldStart.coldStartTotalMs = Math.max(0, now() - startedAt)
    // 旧版 / 缺失段落索引在 bench 里**直接报错**，绝不静默回落旧路径（方案 §7）：
    // 一个跑到阶段③ 却没有段落的结果，会让下游拿到旧口径的数字而毫无提示
    if (index.passages.length === 0) throw new Error(`论文 ${sample.paperId} 没有切出任何段落`)
    if (index.cards === undefined) throw new Error(`论文 ${sample.paperId} 未走到阶段③，卡片刻度缺失`)

    const after = opts.client.stats()
    return {
      index,
      coldStart,
      cacheHits: after.hits - before.hits,
      cacheMisses: after.misses - before.misses,
    }
  }
}
```

> `client.stats()` 返回 `{ hits, misses }`（已确认），与 `indexCacheHits/indexCacheMisses` 同源；命中差值就是「卡片调用是否走了缓存」。`LlmClient` 没有 identity 方法，模型身份由 cli 传入。

- [ ] **Step 2: 改 `bench/src/runner/qa.ts`**

**(a) `QaTaskArgs` 追加**（`passage` 提供时走段落混合检索）：

```ts
  /** 提供时走段落级混合检索：hook 建索引、embedder 供提问时的查询向量 */
  passage?: {
    hook: PassageIndexHook
    embedder: Embedder | undefined
    countTokens: TokenCounter
    maxTokens: number
    /** 本轮 embedder 加载失败：结果标为不参与正式对照（方案 §7） */
    embedderUnavailable: boolean
  }
```

**(b) 索引构建分支**。现有代码是 `tree = await buildIndex(sample.pages, client.complete, indexOptions(config))` 包在 `try/catch` 里，失败走 `recordIndexFailure` + `continue`（`bench/src/runner/qa.ts:150-178`）。段落配置下**换掉这一行**，其余错误路径原样复用（`continue` 保证失败论文绝不会掉进 `buildPageIndex`）：

```ts
    let tree: IndexNode | undefined
    let passageInfo: PassageIndexInfo | undefined
    let indexError: unknown
    try {
      if (args.passage) {
        // 段落配置下索引由 hook 全权产出：不计 buildPageIndex 的 N+1 次调用，
        // 也不存在「hook 失败后回落平面索引」——失败即本篇记 index 阶段错误（方案 §7）
        passageInfo = await args.passage.hook(sample)
        tree = passageInfo.index.tree
      } else {
        tree = await buildIndex(sample.pages, client.complete, indexOptions(config))
      }
    } catch (e) {
      indexError = e
    }
```

**(c) 语义树分支的条件收紧**（现 `qa.ts:191`）——段落配置下不再建语义树：

```ts
    const treeInfo = !args.passage && args.semanticTree ? await args.semanticTree(sample) : undefined
```

**(d) perPaper 追加冷启动字段**（在现有 `leafCount` / `...treeRecordFields(treeInfo)` 之后）：

```ts
      ...(passageInfo ? passageInfo.coldStart : {}),
```

**(e) `papers` 组装**（把 `passageIndex` 挂上去）：

```ts
      papers: [{
        tree: tree!,
        pages: sample.pages,
        ...(treeInfo?.semantic ? { semantic: treeInfo.semantic } : {}),
        ...(passageInfo?.index ? { passageIndex: passageInfo.index } : {}),
      }],
```

**(f) 检索 deps**（把向量模型与冻结预算注入；`maxTokens` 用 `CONTEXT_BUDGET_TOKENS`，与物化器同一常量）：

```ts
      {
        now,
        materialize: args.materialize,
        ...(args.passage
          ? {
              passage: {
                ...(args.passage.embedder ? { embedder: args.passage.embedder } : {}),
                countTokens: args.passage.countTokens,
                maxTokens: args.passage.maxTokens,
              },
            }
          : {}),
      }
```

**(g) 逐题写入 `retrievalMode`**（与现有 `contextTokenCount` 同级）：

```ts
      retrievalMode: retrieval.retrievals[0]?.hybrid?.retrievalMode,
```

**(h) 索引失败分支的 perPaper 补 `coldStartFailed`**（`recordIndexFailure` 那个 `perPaper.push` 里）：

```ts
        ...(args.passage ? { coldStartFailed: 1 } : {}),
```

**(i) `finalizeQaResult` 的额外字段**：

`FinalizeQaArgs`（`bench/src/runner/support.ts:108-145`）里 `retrievalAlgorithm` 与 `extraMetrics` 是顶层参数，而 `baselineFamily` / `candidateGranularity` **不是**——它们只能经 `extraMeta?: Partial<BenchResult['meta']>` 落进 meta（`strongBaselineQa.ts:499` 就是这么写的）。照抄：

```ts
      retrievalAlgorithm: args.passage ? 'hybrid-passage' : args.semanticTree ? 'semantic-tree' : 'papermind-llm',
      extraMetrics: args.passage ? summarizeColdStart(perPaper) : {},
      extraMeta: {
        baselineFamily: 'classic',
        candidateGranularity: 'paragraph passage',
        // 向量模型不可用时本轮检索信号与其它基线不同源，如实标为不可比（方案 §7）
        ...(args.passage?.embedderUnavailable
          ? { comparisonEligible: false, comparisonIneligibleReason: 'embedder-unavailable' }
          : {}),
      },
```

不要新造顶层参数名：`FinalizeQaArgs` 没有 `baselineFamily` 字段，写成顶层参数会直接是类型错误。

- [ ] **Step 3: 改 `bench/src/cli.ts`**

`ControlledQaArgs` 那一段之后（`bench/src/cli.ts:387-413` 的分派链），在 `else if (config.kind === 'semantic-tree')` **之前**插入一支。此位置上 `config` 已被前面的 `kind` 判断收窄为 `PaperMindConfig`，可直接读 `config.passage`：

```ts
        } else if (config.passage) {
          // 冷启动全部发生在逐题计时之前（query-timeline-v2）：hook 内部 await 到阶段③。
          // 向量模型按配置显式 pin 加载，失败不中断本轮——降级为 bm25* 并标为不可比，
          // 因为「模型没下下来」和「检索不行」是两件事，混在一起读会得出错误结论
          let passageEmbedder: Embedder | undefined
          try {
            passageEmbedder = await createTransformersEmbedder({
              model: config.passage.embedder.model,
              revision: config.passage.embedder.revision,
              dtype: config.passage.embedder.dtype,
            })
          } catch (error) {
            console.warn(`向量模型加载失败，本轮降级为 bm25*：${errorMessage(error)}`)
          }
          const knobs: HybridKnobs = {
            minTokens: config.minTokens as number,
            maxTokens: config.maxTokens as number,
            maxInputChars: config.maxInputChars as number,
            rrfK: config.rrfK as number,
            sectionWeight: config.sectionWeight as number,
            neighbourFactor: config.neighbourFactor as number,
            skipLimit: config.skipLimit as number,
          }
          // 契约分词器只有 tokenize：计数口径必须与 materializeContext 完全一致，
          // 否则预算填充放得下的段落会在物化时被截断
          const countTokens = (text: string) => contractTokenizer.tokenize(text).length
          result = await runQaTask({
            ...common, ...controlled, config,
            passage: {
              hook: createPassageIndexHook({
                knobs,
                client: ragClient,
                embedder: passageEmbedder,
                countTokens,
                modelIdentity: env.model,
              }),
              embedder: passageEmbedder,
              countTokens,
              maxTokens: CONTEXT_BUDGET_TOKENS,
              embedderUnavailable: passageEmbedder === undefined,
            },
            ...(speedPolicy ? { speed: speedPolicy.runnerOptions } : {}),
          })
        } else if (config.kind === 'semantic-tree') {
```

`--mode full-context` 与段落配置互斥：在 `args.mode === 'full-context'` 分支里（或在分派链外、读配置之后）加一条前置断言：

```ts
      if (args.mode === 'full-context' && config.passage) {
        fail('--mode full-context 不支持段落混合配置：全文直投没有检索路径，混用会产出无意义的对照')
      }
```

**同时改 `comparisonEligible` 的赋值**（现为无条件 `result.meta.comparisonEligible = true`，会把上面的 `false` 覆盖掉）：

```ts
        // 显式资格声明：受控预算下产出的四个检索指标可进入横向比较。
        // runner 已自行声明 false（full-context 的生成上限、embedder-unavailable）时不得覆盖
        if (result.meta.comparisonEligible !== false) result.meta.comparisonEligible = true
```

`createTransformersEmbedder` 复用 `src/utils/transformersEmbedder.ts`（Node 下动态 import 解析到 node 构建，无需 `wasmPaths`）。

- [ ] **Step 4: 类型检查 + 单测**

Run: `npm run typecheck && npx vitest run bench/src/tests`
Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add bench/src/runner/passageIndexHook.ts bench/src/runner/qa.ts bench/src/cli.ts
git commit -m "feat(bench): run papermind-hybrid through the passage index hook"
```

---

### Task 15: 报表冷启动表 + `bench:trees` 卡片视图 + `bm25*` 标记

**Files:**
- Modify: `bench/src/report.ts`, `bench/src/treeInspect.ts`, `bench/src/treeInspectCli.ts`
- Test: `bench/src/tests/report.test.ts`（追加）

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest'
import { renderReport } from '../report'
import { renderCardReport } from '../treeInspect'
import { buildPassages, createEstimatingTokenCounter } from '../../../src/utils/passages'
import { buildTitleCards } from '../../../src/utils/structureCards'

describe('冷启动成本表', () => {
  const result = {
    task: 'qa' as const,
    config: { name: 'papermind-hybrid', kind: 'papermind' as const },
    meta: { model: 'm', timestamp: 't', gitSha: 's', completed: 1, total: 1, retrievalAlgorithm: 'hybrid-passage' as const, baselineFamily: 'classic' as const, candidateGranularity: 'paragraph passage' },
    metrics: { coldStartTotalP50Ms: 4300, coldStartTotalP95Ms: 5200, structureCallP50Ms: 4000, structureCallP95Ms: 4100, structureTokensPerPaper: 8455, structureFallbackRate: 0.1 },
    perSample: [],
    errors: [],
  }

  it('有冷启动指标时渲染独立区块，且不含 Q 列', () => {
    const report = renderReport([result as never])
    expect(report).toContain('冷启动成本')
    expect(report).toContain('4300')
    expect(report).toContain('8455')
  })

  it('没有冷启动指标时不渲染（旧报表不被污染）', () => {
    const plain = { ...result, metrics: {} }
    expect(renderReport([plain as never])).not.toContain('冷启动成本')
  })
})

describe('renderCardReport', () => {
  it('逐卡片打印范围、标题与 keyTerms', () => {
    const passages = buildPassages(['Abstract\nShort.', 'Methods\nWe use BM25.'], createEstimatingTokenCounter(), { minTokens: 1 })
    const markdown = renderCardReport({
      paperId: 'p1',
      title: 'Sample paper',
      passages,
      cards: buildTitleCards(passages),
      fallback: 'invalid-json',
    })
    expect(markdown).toContain('[P01')
    expect(markdown).toContain('回落')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run bench/src/tests/report.test.ts`
Expected: FAIL — `renderCardReport` 不存在 / 报表无冷启动区块

- [ ] **Step 3: 在 `bench/src/report.ts` 新增冷启动区块并接入**

```ts
/**
 * 「冷启动成本」区块（方案 §7）：与 Q **并列**报告，不进入 Q。
 * 只在结果里真的出现过冷启动指标时渲染，否则旧基线报表会多出一整块空表
 * （与 `renderTreeSection` 同一约定）。
 */
function renderColdStartSection(results: BenchResult[]): string[] {
  const hasColdStart = results.some(r => r.metrics.coldStartTotalP50Ms !== undefined || r.metrics.structureTokensPerPaper !== undefined)
  if (!hasColdStart) return []

  const lines: string[] = []
  lines.push('### 冷启动成本（不进入 Q）')
  lines.push('')
  lines.push('| 配置 | 冷启动端到端 P50 / P95 | 切段均值 | 段落向量均值 | 卡片调用 P50 / P95 | 卡片向量均值 | 卡片 token/篇 | 卡片回落率 | 平均卡片数 | 平均段落数 |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const result of results) {
    if (result.metrics.coldStartTotalP50Ms === undefined && result.metrics.structureTokensPerPaper === undefined) continue
    const m = result.metrics
    lines.push(
      `| ${result.config.name} | ${cell(m, 'coldStartTotal')} | ${cell(m, 'avgColdStartPassageMs')} | `
      + `${cell(m, 'avgColdStartEmbedPassagesMs')} | ${cell(m, 'structureCall')} | ${cell(m, 'avgColdStartEmbedCardsMs')} | `
      + `${m.structureTokensPerPaper === undefined ? '—' : fmtTokens(m.structureTokensPerPaper)} | `
      + `${pctCell(m, 'structureFallbackRate')} | ${numCell(m, 'avgColdStartCardCount')} | ${numCell(m, 'avgColdStartPassageCount')} |`,
    )
  }
  lines.push('')
  lines.push('> 「卡片调用 P50/P95」只统计**未命中缓存**的调用（命中时耗时接近 0，混进去会把成本稀释成假象）；')
  lines.push('> 卡片 token 由字符数估算（`LlmClient.complete` 不透传服务商 usage），每篇论文的冷启动只发生**一次**卡片调用。')
  return lines
}
```

其中需要两个小工具（与既有 `cell` / `pctCell` 并列）：

```ts
/** 单个毫秒字段渲染；缺失输出「—」。 */
function cell(metrics: Record<string, number>, prefix: string): string
```

已经存在（`${prefix}P50Ms/P95Ms` 版本）。平均数需要单值版：

```ts
const avgCell = (metrics: Record<string, number>, name: string): string =>
  metrics[name] === undefined ? '—' : fmtDuration(metrics[name])
const numCell = (metrics: Record<string, number>, name: string): string =>
  metrics[name] === undefined ? '—' : fmt(metrics[name])
```

然后把 `lines.push(...renderColdStartSection(results))` 插在 `renderTreeSection` 的调用处之后。

- [ ] **Step 4: `bench/src/treeInspect.ts` 新增卡片视图**

```ts
export interface CardInspectEntry {
  paperId: string
  title: string
  passages: Passage[]
  cards: StructureCard[]
  /** 卡片回落原因；未回落则不传 */
  fallback?: string
  paper?: { title: string; summary: string }
}

/**
 * 卡片划分的人工核对报告（方案 §7「结构抽查」）：范围、标题、keyTerms 逐张列出，
 * 供人工判断「主题划分是否合理」——这一步无法由程序校验。
 */
export function renderCardReport(entry: CardInspectEntry): string {
  const byId = new Map(entry.passages.map(passage => [passage.id, passage]))
  const lines: string[] = []
  lines.push(`## ${entry.title}（${entry.paperId}）`)
  lines.push('')
  if (entry.fallback) lines.push(`> 卡片回落：\`${entry.fallback}\`（标题卡片，无 summary / keyTerms）`)
  if (entry.paper) {
    lines.push(`- 论文标题：${entry.paper.title}`)
    lines.push(`- 论文摘要：${entry.paper.summary}`)
  }
  lines.push(`- 段落数：${entry.passages.length}，卡片数：${entry.cards.length}`)
  lines.push('')
  lines.push('| 卡片 | 范围 | 页区间 | 标题 | keyTerms |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const card of entry.cards) {
    const first = byId.get(card.range[0])
    const last = byId.get(card.range[1])
    const pages = first && last ? `${first.pieces[0].page + 1}–${last.pieces[last.pieces.length - 1].page + 1}` : '—'
    lines.push(`| ${card.id} | ${card.range[0]}–${card.range[1]} | ${pages} | ${card.title} | ${card.keyTerms.join(', ') || '—'} |`)
  }
  lines.push('')
  return lines.join('\n')
}
```

- [ ] **Step 5: `bench/src/treeInspectCli.ts` 接线**

配置带 `passage` 时走卡片视图：用 `createPassageIndexHook`（`persist: () => {}`）建一次索引，把最终 `index.cards` / `index.passages` / `index.paper` / `index.structureFallback?.reason` 交给 `renderCardReport`，输出到 `--out`（缺省 `bench/results/trees.md`）。

- [ ] **Step 6: 跑测试 + 全量**

Run: `npm test && npm run typecheck`
Expected: 全绿

- [ ] **Step 7: 提交**

```bash
git add bench/src/report.ts bench/src/treeInspect.ts bench/src/treeInspectCli.ts bench/src/tests/report.test.ts
git commit -m "feat(bench): report cold-start cost and card structure"
```

---

## 验收清单（计划完成后逐条核对）

- [ ] `npm test` 与 `npm run typecheck` 全绿。
- [ ] 产品：导入一篇论文后 <1 秒内可用（阶段①），对话时 `llmCalls` 只含回答那一次；卡片未就绪的问题不会阻塞。
- [ ] `index_json` 为 `version: 2`，逐阶段落盘；旧 v1 索引在重建完成前仍按平面路径服务。
- [ ] `bench/configs/default.json` 与 `semantic-tree.json` 未被改动。
- [ ] `npm run bench -- --task qa --config papermind-hybrid --dataset qasper --limit 5` 跑通，结果 JSON 里每篇论文有 `coldStart*`、每题有 `retrievalMode`，`meta.retrievalAlgorithm === 'hybrid-passage'`。
- [ ] 向量模型不可用时该轮结果被标为 `comparisonEligible: false`，不进入正式对照。
- [ ] `npm run bench:trees -- --config papermind-hybrid --dataset qasper --limit 5` 输出卡片划分供人工核对。
- [ ] 消融：`sectionWeight ∈ {0, 0.5, 1}` 三个展开点与 `papermind-hybrid-m3` 的 embedder 消融各自独立可跑。
