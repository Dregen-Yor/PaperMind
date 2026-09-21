[根目录](../../CLAUDE.md) > [src/](../) > **utils/**

# src/utils/ — 工具函数与 RAG 检索

**变更记录**
- 2026-09-21: 新增三个纯函数模块——`sourceRef.ts`（消息来源结构化归一）、`highlightMerge.ts`（划选片段/page 合并与历史碎片合并计划）、`exportSanitize.ts`（导出默认脱敏 + 备份文件名）
- 2026-09-15: 新增语义树检索链路——`evidenceBlock.ts`（原文证据块）、`semanticTree.ts`（单次调用建树 + 校验 + 诊断 + `semanticTreeConfigHash` 建树配置指纹）、`semanticRoute.ts`（单轮树路由 + 原文取证 + 统一上下文预算 + 平面就地回落）；`ragPipeline.ts` 的 `IndexedPaper` 增加可选 `semantic` 字段，提供时把平面叶节点与树节点放进**同一次**打分判断，因此既满足 §9 的回落要求又不增加查询阶段串行 LLM 调用
- 2026-08-02T15:49:42: 修正面包屑；新增 `markdown.ts`（Markdown+KaTeX 渲染）与 `abstractSummarizer.ts`（Hugging Face 摘要）文档
- 2026-07-18T00:00:00: pageIndex 语义分块 + 评分多选

## 模块职责

无状态工具集合：PDF 元数据解析、PageIndex RAG 检索、轻量语义树（证据块 / 建树 / 树路由）、消息 Markdown/数学渲染、学术长文摘要分块，以及消息来源/高亮/导出三类归一化纯函数（`sourceRef` / `highlightMerge` / `exportSanitize`）。均为纯函数，便于单测。

---

## pdfUtils.ts

pdfjs-dist worker 初始化（`workerSrc = './pdf.worker.min.mjs'`，由 `vite.config.ts` 复制到 `public/`，离线可用、不依赖 CDN）+ 两个导出：

### `parsePdfMeta(file: File): Promise<{ title, authors[], abstract, year, fileData }>`
提取元数据并返回 base64 原始内容。优先用 PDF metadata（Title/Author，作者按 `,`/`;` 分割），fallback 到第 1 页文本启发式：`abstract` 匹配 `/abstract[:\s]+.{100,600}/i`、`year` 匹配 `\b(19|20)\d{2}\b`；提取失败静默返回空值。`fileData` 为 base64，供主进程写盘（内存不保留）。

### `base64ToUrl(base64: string): string`
返回 `blob:` URL（`type: application/pdf`）；调用方负责组件卸载时 `URL.revokeObjectURL()`。

---

## pageIndex.ts — RAG 检索管线

### 核心类型
```ts
interface IndexNode { title; nodeId; startPage; endPage; summary; nodes: IndexNode[] }  // page 均 0-based inclusive
type LLMFn = (prompt: string) => Promise<string>
```

### 导出函数
| 函数 | 作用 |
|------|------|
| `extractPages(base64)` | 逐页提取 PDF 文本，返回 `string[]`（0-based） |
| `detectSectionBoundaries(pages)` | 用 `SECTION_PATTERNS`（英文编号/全大写/常见节名/中文章节/中文编号）扫描，返回节标题所在页码索引；无标题返回 `[]` |
| `mergeSmallSections(ranges, minPages=2)` | 将不足 `minPages` 页的节并入前一节（首节并入后节），避免碎块 |
| `buildPageIndex(pages, llm)` | 构建 2 层树：边界 ≥2 时按语义分块（保留封面/摘要预边界页）并 `mergeSmallSections`，否则降级为 5 页固定切块（`CHUNK`）；每 leaf 调 `summarizeRange` 生成 title/summary，再汇总 root |
| `scoreAndSelect(root, pages, query, llm)` | 对叶节点打分（0-10），取 Top-2（第二节点需 ≥4）按 `startPage` 升序合并（`\n\n---\n\n` 分隔）；JSON 解析失败降级首节点；单叶节点直接返回、**不发 LLM** |

> `summarizeRange` / `buildPageIndex` 的 LLM 返回按 `{"title","summary"}` JSON 解析，失败时保留默认标题。
> ⚠️ 旧 `retrieve` API 已删除，检索统一走 `scoreAndSelect`。

---

## evidenceBlock.ts — 原文证据块（方案 §5）

把逐页文本切成**可回溯到原始页码**的证据块，是语义树取证的最小单位。

```ts
interface EvidenceBlock {
  id: string            // B001 / B002…（按 order 稳定编号）
  rawText: string       // 原文，逐字保留，任何阶段都不得改写
  normalizedText: string// 供模型阅读的归一化文本（去页眉页脚、拼连字符）
  pieces: ContextPiece[]// rawText 的逐页精确分区（按序拼接即 rawText），供评测从进上下文的块反推页序
  startPage: number; endPage: number   // 0-based inclusive，由 pieces 首末推出
  order: number; previousId: string | null; nextId: string | null
  sourceType: 'body' | 'figure-caption' | 'table-caption' | 'formula' | 'footnote' | 'other'
}
```

`pieces` 由构造保证无损（`rawText === join(pieces)`、首末页等于块页区间），因此评测可以安全地从它反推「这块贡献了哪些页」，而 `rawText` 本身不因此改变；`hasExactPagePartition` 校验持久化的块在 schema v2 起必须满足这一分区不变量，不满足即整树作废重建。

| 导出 | 作用 |
|------|------|
| `buildEvidenceBlocks(pages, opts)` | 逐页切块；默认参数见导出的 `DEFAULT_EVIDENCE_OPTIONS`（`targetChars=2400` / `maxChars=3200` / `minChars=1600`），建树缓存指纹与实际分块参数取自同一处，避免改了参数而指纹没跟上。优先在段落边界收块，超大段落硬切；块间以空行连接、硬切处直接拼接，保证重组无损；尾块不足 `minChars` 且合并后不超 `maxChars` 时向前合并 |
| `detectRunningLines(pages)` | 出现在 ≥3 页的重复行（页眉页脚）与纯页码行 |
| `normalizeEvidenceText(rawText, runningLines)` | **只**影响 `normalizedText`：剥页眉页脚与页码、还原被连字符拆开的单词 |
| `classifySourceType(text)` | 判定 figure/table caption、公式、脚注 |
| `indexBlocksById` / `collectWithNeighbours` | 按 ID 建索引；取引用块及其相邻块（§9 的相邻上下文扩张） |

> §5.3 原文正确性：`rawText` 逐字来自 PDF 文本层，永不被 LLM 或归一化改写；
> 最终回答与来源页码一律走 `rawText` 与原始页码。

---

## semanticTree.ts — 轻量语义树（方案 §6–§8）

一次 LLM 调用产出的论文导航结构。**树只承担导航职责**：节点上的 label/description 是模型生成的元数据，
不能作为事实依据，回答必须依据 `evidenceRefs` 回到 `EvidenceBlock` 的原文。

```ts
interface SemanticNode { id; label; description; relationToParent: SemanticRelation | null; evidenceRefs: string[]; children: SemanticNode[] }
interface SemanticTree { schemaVersion; promptVersion; root: SemanticNode }
```

- 规模上限（§6.2）：整树 ≤16 节点、一级 ≤5、二级合计 ≤10、根外最多两层。
  校验按**天花板**执行，不设下限——简单论文可以只生成一层
- `SEMANTIC_RELATIONS`：`motivates / constitutes / supports / explains / compares / limits / contradicts`
- `isGenericSectionLabel(label)`：剥掉编号（`3.` / `III.` / `二、` / `第3节`）后命中通用章节名即判非法——
  防止树退化成目录（§7.2）
- `buildSemanticTree(blocks, llm, opts)`：**每篇论文恰好一次调用**（§8.1）；输入超过 `maxInputChars`（默认 12 万字符）
  直接报 `input-too-large`，不做递归补救；任何失败抛 `SemanticTreeBuildError(reason)`
- `validateSemanticTree(value, blocks)`：结构、引用、规模三重校验；引用不存在的块即整树作废，**不猜测修复**（§13）
- `parseSemanticTree` / `flattenSemanticTree` / `collectTreeEvidenceRefs` / `hashTreeSource`（FNV-1a 原文指纹）/ `estimateTokens`
- `semanticTreeConfigHash(config)`：把构建配置（schema、提示词版本、证据块分块参数、`maxInputChars`、模型端点）折成定长指纹，供「原文没变但配置变了」时让旧树失效（§10.3）；按固定字段顺序序列化，对象键序不同不影响结果。默认输入上限 `DEFAULT_MAX_INPUT_CHARS` 一并导出
- 诊断指标：节点数、深度、一/二级数量、被引用块覆盖率、多重归属块数、跨章节节点数

---

## semanticRoute.ts — 单轮树路由与原文取证（方案 §9）

| 导出 | 作用 |
|------|------|
| `buildSemanticRoutePrompt(tree, query, flatLeaves)` | 把**整棵树**（展平 + 父节点名）与平面叶节点一次性交给模型打分，绝不逐层调用；平面候选的 id 接在语义节点之后 |
| `routeWithSemanticTree(tree, blocks, query, llm, opts)` | 返回 `RetrievalResult & { semantic }`。默认 `topK=2` / `minScore=4` / `includeNeighbours=true` / `maxContextChars=24000`；候选总数 ≤1 时短路，**不发 LLM**。命中节点 → 证据块 → 相邻块扩张 → 统一预算裁剪 → 按 0-based 页区间产出 `selected` / `context` / `sources` |

> 查询阶段的串行 LLM 调用数与平面 `scoreAndSelect` **完全一致**（都是一次）：树节点与平面叶节点在**同一次**判断里打分（`opts.flat` 提供叶节点与逐页原文），
> 因此树取证失败时可以就地用这批平面打分回落（`usedFlatFallback`）而无需第二次调用——§9 要求「必须能回落」，§10.1 要求「不增加串行调用」，两条约束靠这一点同时满足。

**三条容易踩的口径约束**：

- **统一上下文预算**：`maxContextChars`（默认 24000，与 bench 各配置同值）按「节点直接引用的块优先、相邻块其次」消耗，**块要么整块进入要么整块丢弃，绝不从中间截断原文**；被丢弃的块数记在 `semantic.droppedBlockCount`
- **非连续证据必须拆成多个页区间**：`toPageSpans` 只合并真正相邻的块（`block.startPage <= 上一块.endPage + 1`）。用 min/max 合成一个跨度会把中间没进上下文的页也报成已选中，`evidenceRecall` / `contextPrecision` / `selected` / `sources` 会一起失真
- **检索指标只认最终页序**：`contextPageMrr` 等四个指标消费的是物化器从最终上下文**同源**产出的 `pageOrder`，**不**按 `scores` 的平面叶节点下标反推；树路由与平面回落因此共享同一份页序口径。旧的 `computeMrr`（按 `scores` 排序）与「样本自动从 MRR 分母缺席」已删除
- **相邻扩展算不算「选中」**：统一按「**真的进了上下文才算**」——`selected` / `sources` 由预算裁剪后的上下文块反推，因此相邻块计入而超预算被丢弃的块不计入；诊断里的 `expandedBlockIds` 与实际进上下文的块严格一致，指标与展示不会各说各话

---

## contextTrace.ts — 上下文物化（最终页序的唯一来源）

把候选片段在固定 token 预算内物化为最终提示词文本，并从**同一次计算**里产出真正贡献了非空文本的原文页码。

```ts
interface ContextPiece { page: number; text: string }
interface ContextGroup { pieces: ContextPiece[] }
interface MaterializedContext { text; pageOrder; tokenCount; truncated }
const CONTEXT_GROUP_SEPARATOR = '\n\n---\n\n'
```

- `materializeContext(groups, tokenizer, maxTokens)`：逐组、逐片注入。**只有贡献了非空文本（`text.trim()` 非空）的页才计入 `pageOrder`**，按首次出现顺序去重——同一页在后续组重复出现不再计一次，被预算整片截掉、一个 token 都没产出的页也不出现。`text` 与 `pageOrder` 同源产出，故不存在「文本里有、页序里没有」的矛盾
- **分组分隔符守卫**：组间用 `CONTEXT_GROUP_SEPARATOR` 连接；当「分隔符 + 至少一个内容 token」都放不下时**整组不进入**（用 `>=` 是刻意：恰好占满也拒绝），避免留下吃掉全部剩余预算的尾部分隔符。分隔符只出现在组首，第一组不带前缀
- **恰好占满只在「末组」等于未截断**：当恰好占满预算的那一组是**最后一组**时，token 数等于预算不置 `truncated`——`truncated` 是「有内容因预算被丢」的标记，不是「预算用满」。若恰好占满发生在**非末组**，后面还有组没能进入上下文，`truncated` 照置：例如两组、预算 2 token，而第 0 组自身就占满 2 token，得到 `{ tokenCount: 2, truncated: true }`（`contextTrace.ts` 的 `truncated ||= groupIndex < groups.length - 1`）
- bench 的 `contextPageMrr` 等四个检索指标（`metricSchemaVersion: 2` / `mrrDefinition: 'context-page-v1'`）正建立在这份 `pageOrder` 上，候选排序 MRR（旧 `computeMrr`）已删除

---

## ragPipeline.ts — 分阶段 RAG 主流程

产品与评测共用的 RAG 管线，拆成**检索**与**生成**两个纯函数阶段，外加一个向后兼容的组合封装：

| 导出 | 作用 |
|------|------|
| `retrieveRagContext(papers, query, history, llm, opts, deps)` | 查询改写 → 逐篇评分多选（平面或树路由）→ 合并上下文。注入 `deps.materialize` 时改走 `materializeContext` 的受控 token 预算，并产出 `contextPageOrder` / `contextTokenCount`；不注入时沿用产品的 `maxContextChars` 字符预算。返回 `RagRetrievalStage` |
| `generateRagAnswer(retrieval, query, history, generate, systemPrompt, deps)` | 用检索阶段已算好的上下文组装提示词并调用回答模型。**不改写传入的 `retrieval`**——`generate` 抛错直接向上抛，调用方据此在生成之前落盘检索指标 |
| `runRagPipeline(...)` | 上面的组合封装（检索 → 生成），产品调用方沿用；未注入 `materialize` 时行为与拆分前逐字一致 |

**关键不变量**：检索指标必须在**生成之前**持久化——生成失败（抛错）不得删除或改写已完成的检索观测。`qa.ts` 依此在 `generateRagAnswer` 之前写入四个检索指标，因此同一行可以「检索成功、生成失败」。

`externalContext` 优先级最高：跳过改写与检索，直接把该文本当上下文，`materialize` 随之失效、页序/token 不产出。`MATH_FORMAT_INSTRUCTION` 为追加在 system 提示词后的数学格式约束。

---

## sourceRef.ts — 消息来源结构化（#1）

```ts
interface SourceRef { label: string; paperId?: string; startPage?: number; endPage?: number }  // page 0-based
```

| 导出 | 作用 |
|------|------|
| `normalizeSourceList(raw: unknown)` | 把持久化的 `messages.sources` 归一为 `SourceRef[]`：兼容升级前的**字符串数组**（降级为不可跳转的纯标签），并丢弃/降级脏输入（非数组、空串、缺 label、页号非数字），绝不抛错；读取侧由 `electron/db` 的 `listConversations` 调用 |
| `isJumpable(ref)` | 芯片是否可跳页：`paperId` 为字符串且 `startPage` 为数字 |

---

## highlightMerge.ts — 划选按页合并（#7）

```ts
interface HighlightSegment { page: number; start: number; end: number }  // 页内字符区间
```

| 导出 | 作用 |
|------|------|
| `mergeSegments(segments)` | 同一页相邻/重叠的候选片段合并为一段（乱序输入先排序）：一次划选在页内只留一条记录；中间有缺口则保持两条（不同划选不误并）。PdfViewer 的划选路径用它，之后才逐段去重叠与绘制 |
| `planFragmentMerge(rows)` | 历史碎片清理的**纯计划**（不碰数据库）：同论文 + 同页 + 同文本，且按创建时间**链式时间窗 ≤2000ms** 并满足**偏移连通**（`next.startOffset <= clusterMaxEnd + 2`）的相邻行合并为一簇——保留最早一行、`updates` 把它扩到簇内最大 `endOffset`，其余进 `removals`；单行簇与含非空 `note` 的行所在簇整簇跳过（破坏性删除取最保守口径）。由 `initDb()` 在启动时执行 |

---

## exportSanitize.ts — 导出脱敏（#5）

| 导出 | 作用 |
|------|------|
| `stripApiKeysFromSettings(rows)` | 默认导出前的脱敏：`llm_profiles[*].apiKey` 与遗留 `llm_config.apiKey` 清空、`huggingface_token` 置为空字符串的 JSON 形式；非 JSON / 非对象 / 数组内非对象元素一律原样保留，不抛错 |
| `backupFileName(date)` | 可读备份文件名 `papermind-backup-<YYYY-MM-DD>-<HHmm>.json`（`electron/ipc.ts` 的 `data:export-file` 用作对话框默认名） |

---

## markdown.ts — 消息渲染

单一导出 `renderMarkdown(content: string): string`：
- `markdown-it`（`html:false, breaks:true, linkify:true`）+ `markdown-it-texmath`（`delimiters:'dollars'`，KaTeX `throwOnError:false`）
- **LaTeX 归一**：先把模型常输出的 `\[...\]` → `$$...$$`、`\(...\)` → `$...$`（markdown 会把反斜杠当转义，故需预处理）
- **链接强化**：`link_open` 规则强制 `target=_blank` + `rel=noopener noreferrer`
- **安全**：输出经 `DOMPurify.sanitize`（`USE_PROFILES: { html, mathMl }`，放行 `target`）；净化掉 `<script>`/`onerror`、拦截 `javascript:` 协议
- 引入 `katex/dist/katex.min.css`

---

## abstractSummarizer.ts — Hugging Face 摘要

服务于 `chat.ts` 的 `/abstract`。模型 `ABSTRACT_MODEL = 'Bashaarat1/t5-small-arxiv-summarizer'`，端点 `ABSTRACT_API_URL`（HF Inference API）。

| 导出 | 作用 |
|------|------|
| `splitAbstractText(text, maxChars=1600)` | 按句子边界（中英标点）切块且不超长（T5 ≤512 token）；超长句按空格硬切，保证 `join(' ')` 无损 |
| `callAbstractModel(text, token)` | `POST` HF（`inputs: "summarize: ..."`，`max_length:128/min_length:30`，`wait_for_model:true`）；解析 `summary_text`/`generated_text`；错误经 `readErrorMessage` 提取中文提示 |
| `summarizeAcademicText(text, token, summarizeChunk?)` | **递归归约**：分块 → 逐块摘要（顺序，避免压垮社区端点）→ 若 >1 块则 `join` 后再分块摘要，直至 1 块；`MAX_REDUCTION_ROUNDS=6` 上限；`summarizeChunk` 可注入（测试用） |

---

## 测试

- `pdfUtils.test.ts` — `base64ToUrl`、`detectSectionBoundaries`（英/中/大写/降级）、`mergeSmallSections`（11 用例）
- `pageIndex.test.ts` — `scoreAndSelect`（Top-2/阈值/降级/单节点短路）、`buildPageIndex`（预边界页面覆盖，6 用例）
- `abstractSummarizer.test.ts` — `splitAbstractText` 无损、`summarizeAcademicText` 递归 3 次归一（2 用例）
- `markdown.test.ts` — 结构渲染、外链、XSS 净化、危险协议、`$`/`\(\)`/`\[\]` LaTeX 归一（7 用例）
- `evidenceBlock.test.ts` — 结构契约、原文正确性（页眉只从 normalizedText 剥离）、分块边界与无损重组、运行行检测、来源分类（26 用例）
- `semanticTree.test.ts` — 提示词约束、规模上限天花板、引用校验、通用章节名拒绝、诊断指标、单次调用、`semanticTreeConfigHash` 覆盖配置各项与键序无关（54 用例）
- `semanticRoute.test.ts` — 整树单轮打分、阈值与 topK、相邻扩张、短路与降级、上下文预算、平面就地回落、非连续证据拆区间（35 用例）
- `ragPipelineSemantic.test.ts` — 树路由接入管线后的调用次数不变量、就地回落与预算裁剪（11 用例）
- `sourceRef.test.ts` — 旧字符串数组降级、结构化对象保留页区间、脏输入丢弃/降级（3 用例）
- `highlightMerge.test.ts` — 同页合并与缺口保持、乱序输入、碎片计划的时间窗 + 偏移连通 + note 保护 + 仅删不更 + 双簇互不串簇（12 用例）
- `exportSanitize.test.ts` — `llm_profiles`/`llm_config`/`huggingface_token` 三类凭据脱敏、非 JSON 与非对象原样保留、文件名格式（7 用例）

> 依赖 `pageIndex.ts` 的测试需 `vi.mock('pdfjs-dist/legacy/build/pdf.mjs')`（Node 无 DOMMatrix）。
