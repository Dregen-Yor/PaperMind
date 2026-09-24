[根目录](../../CLAUDE.md) > [src/](../) > **stores/**

# src/stores/ — 状态管理模块

**变更记录**
- 2026-09-24: 输出上限改为可选——`maxTokens` 语义从「恒有上限」变成 `0 = 不限制`（导出 `UNLIMITED_MAX_TOKENS` / Anthropic 兜底 `CAPPED_MAX_TOKENS_DEFAULT` / 滑块量程 `MAX_TOKENS_LIMIT`）：openai 分支不再发送 `max_tokens`，ollama 分支改为「显式设了上限才发 `num_predict`」（原来永不发送），anthropic 必填字段不限制时退到兜底值、被老模型（上限 4096）拒绝时自动降级重试一次并记住，`o` 系 / `gpt-5` 系设了上限时改发 `max_completion_tokens`；`init()` 把旧落库的出厂值 4096 一次性迁移为不限制（迁移标记 `llm_max_tokens_unlimited_migrated`，改过才回写）；`updateProfile` 只在 patch 动了 provider/model/baseUrl 时才重算就绪集合
- 2026-09-24: 段落混合检索替换平面 RAG——`indexPaper` 改为**分阶段构建段落索引**（阶段① 本地切段 + 标题卡片 + 落盘即放行提问，阶段② 段落向量、阶段③ 卡片调用在后台跑），**不再触发语义树建树**；`treeEnabled` 默认值翻转为**关闭**（2026-09-15 上线时的「默认开启」作废，方案 §6.3：语义树退出默认检索路径，要用需在设置页显式开启）；新增 `passageDeps` / `waitForStage1` / `backfillPassageVectors` 与段落索引在建树/切 profile 时的作废路径
- 2026-09-21: 问答链路补失败轮/重试/继续/流式/未知命令——`Message.error/truncated/context/streaming`、`retryMessage`（`externalContext` 重放划选原文、history 截到提问前一条）、`continueMessage`（带 context 时跳过论文收集与改写/评分）、`requestCompletion`（finish_reason、流式 `onToken`、120s/300s 超时）、`/` 未知命令本地提示；来源改为结构化 `SourceRef`；`buildPaperTree` 返回 `TreeBuildOutcome`、`TreeRebuildSummary` 增加 `firstReason`（「未配置模型」短路豁免本地端点）
- 2026-09-15: `useChatStore` 增加轻量语义树状态与后台建树——`treeEnabled`（默认开启，设置页可关）、`treeReadyPapers` / `treeIndexingPapers`、`buildPaperTree` / `rebuildAllTrees` / `loadSemanticIndex` / `setTreeEnabled`；`indexPaper` 完成后在后台触发建树，`sendMessage` 按篇挂载 `semantic` 交给 RAG 管线。建树缓存身份同时覆盖原文指纹与**构建配置指纹**（schema / 提示词 / 模型端点 / 分块与输入上限），复用前还要过一遍 `validateSemanticTree`
- 2026-08-02T15:49:42: 重写以反映多 LLM 配置（profiles）、`indexPaper`/`indexedPapers`、`/abstract` 摘要（`generateAbstract`）、旧 `llm_config` 迁移、反 Proxy 持久化
- 2026-07-18T00:00:00: 更新 sendMessage RAG 管线文档（3-call 流程）
- 2026-06-07T21:33:55: 初始化文档

## 模块职责

Pinia 全局状态管理，封装所有与主进程的 IPC 通信、LLM API 请求、段落索引构建与 `/abstract` 摘要逻辑。渲染层组件通过 store 方法操作数据，不直接调用 `window.db`。

## 入口

两个 store，均为 Pinia setup 函数风格，均有幂等 `init()`（`loaded` flag），在 `App.vue` 挂载时并行调用：

- `paper.ts` — `usePaperStore`：论文列表与知识库
- `chat.ts` — `useChatStore`：对话、消息、**多 LLM 配置**、段落索引、摘要

## usePaperStore（paper.ts）

| 方法/属性 | 说明 |
|-----------|------|
| `papers` / `knowledgeBases` / `loaded` | 响应式状态 |
| `init()` | 加载 kb 列表 + 论文列表 |
| `addPaper(paper)` | 接受含 `fileData`(base64) 的对象；IPC 写盘后**内存仅保留元数据**（解构剥离 `fileData`） |
| `updatePaper(id, patch)` / `removePaper(id)` | 部分更新 / 删除（主进程同步删盘） |
| `readPaperFile(id)` | 按需读取 PDF base64（透传 `window.db.paper.readFile`） |
| `addKnowledgeBase / removeKnowledgeBase` | 知识库 CRUD（删 KB 时前端同步剔除其论文） |
| `getPapersByKb(kbId)` | 返回 `computed` 过滤结果 |
| `getPaper(id)` | 内存查找单篇 |

接口 `Paper`（`status: 'unread' | 'reading' | 'done'`）与 `KnowledgeBase` 在此定义。

## useChatStore（chat.ts）

### 状态

| 属性 | 说明 |
|------|------|
| `conversations` | 对话列表（含 messages） |
| `profiles` | **`LLMProfile[]`**，默认含一个 `DEFAULT_PROFILE`（openai/gpt-4o） |
| `chatProfileId` / `indexProfileId` | 对话用 / 索引用的当前 profile id |
| `chatProfile` / `indexProfile` | 上述 id 对应的 computed profile（回退首个） |
| `indexingPapers` / `indexedPapers` | 正在构建 / 已建索引的 paperId 集合（`Set`） |
| `abstractToken` | Hugging Face token |
| `treeEnabled` | 轻量语义树总开关，**默认关闭**（方案 §6.3：语义树退出默认检索路径，段落混合检索取而代之）；持久化键 `semantic_tree_enabled`，只有显式存过 `true` 才开启 |
| `treeReadyPapers` / `treeIndexingPapers` | 已有可用语义树 / 正在后台建树的 paperId 集合（`Set`）。前者由 `refreshTreeReadyPapers()` 按**当前构建配置指纹**过滤 `tree.list()` 得到，模型或提示词换过之后不会继续谎报可用。注意该过滤只比 `schema_version` / `build_config_hash` 两列，证明不了 JSON 内容有效——损坏记录可能短暂计入，真正加载时由 `parseTreeRecord` 拒绝 |

### Profile 与设置持久化

- `addProfile / updateProfile / removeProfile`（至少保留 1 个；删当前项自动切首个）。`updateProfile` 只在 patch 含 `provider` / `model` / `baseUrl`（`TREE_CONFIG_PATCH_KEYS`，即建树指纹的组成）且改的是当前索引配置时才 `refreshTreeReadyPapers()`——拖温度或输出上限滑块不必付一次 `tree.list` 的 IPC
- `setChatProfileId / setIndexProfileId / setAbstractToken / setTreeEnabled` — 分别写 `llm_profile_chat` / `llm_profile_index` / `huggingface_token` / `semantic_tree_enabled`；`setIndexProfileId` 额外刷新语义树就绪集合（索引配置即建树配置）
- `persistProfiles()` 将 `profiles` **深拷贝为普通对象**再 `settings.set('llm_profiles', ...)`——因 Electron 结构化克隆无法序列化 Vue 响应式 Proxy（`chat.store.test.ts` 有 `isProxy` 校验）
- `init()`：加载 `llm_profiles`；**旧版迁移**——无 profiles 但存在旧 `llm_config` 时，包装为单条 profile 并落盘；`maxTokens` 另有一个**一次性**迁移（标记 `llm_max_tokens_unlimited_migrated`，写在配置落盘之后）：首次启动把旧出厂值 4096 视为「从未显式设置」改成不限制，之后用户再显式设回 4096 不会被下次启动抹掉（请求路径用 `normalizeMaxTokens` 只做合法化，4096 不再特殊处理）；再恢复 `llm_profile_chat/index` 选择、`index.list()` 已建索引集合、`huggingface_token`、语义树开关与 `tree.list({ schemaVersion, buildConfigHash })` 过滤后的已建树集合

### LLM 调用（`requestCompletion` / `callLLM`）

`requestCompletion(messages, profileOrId?, opts)` 是底层请求：直接从渲染进程 `fetch`，按 provider 适配，并**记录 finish_reason 以标记截断**（`{ content, truncated }`）；`opts.onToken` 提供时改用流式（OpenAI SSE / Anthropic SSE / Ollama NDJSON 三个解析器），逐 token 回调并把增量交给调用方。超时：非流式 120s、流式 300s（`AbortSignal.timeout`，英文 DOMException 统一映射为中文提示）。`callLLM` 只是取 `content` 的薄包装，索引、标题、查询改写等文本调用继续走它。

- **ollama**：`POST {baseUrl}/api/chat`，`stream` 随 `opts.onToken`，`topK>0` 时附 `options.top_k`，`maxTokens>0` 时附 `options.num_predict`（不限制则整个 `options` 都不出现）
- **openai / anthropic**：`POST {baseUrl}/chat/completions`（OpenAI 兼容）
  - openai：`Authorization: Bearer {apiKey}`；采样与上限都由 `generationParams` 按模型代次产出（`o` 系 / `gpt-5` 系发 `max_completion_tokens` 且**不发 `temperature`**，非默认温度会被直接拒绝；其余含第三方兼容端点发 `max_tokens` + `temperature`），不限制时上限字段整条不发送
  - anthropic：`x-api-key` + `anthropic-version: 2023-06-01`，`topK>0` 时附 `top_k`；`max_tokens` **必填**，不限制时退到 `CAPPED_MAX_TOKENS_DEFAULT`（8192）。老模型（claude-3-opus / haiku，上限 `ANTHROPIC_LEGACY_MAX_TOKENS` = 4096）会对 8192 报 400，此时**自动降级重试一次**并把上限记进模块级 `anthropicTokenCeilings`（key = `baseUrl|model`），后续调用直接按 4096 发送；只在「不限制」的自动兜底路径降级，用户显式设过的上限被拒时原样报错
- 可传 `profileId` 指定配置（默认用 `chatProfile`）；空回答一律抛「模型返回了空响应」
- **输出上限与截断是两件事**：上限可以不设（默认），截断提示只看 `finish_reason` / `stop_reason` / `done_reason`；不设上限后，非流式请求（120s 超时）更容易被长回答顶到时间上限

### 索引构建（`indexPaper`）

`indexingPapers` 去重 → `begin` 取构建代次 → 读 PDF base64 → `extractPages` → **`startPassagePipeline`**（`src/utils/passageIndexBuilder.ts`）：

- **阶段①**（本地，<1 秒）：切段 + 标题卡片 + `window.db.index.set` 落盘 → `markStage1()` 放行提问路径
- **阶段②③**（后台）：段落向量（`embedderInstance` 已加载才用，绝不 await 下载）与卡片调用（`indexProfile` 的 LLM，**每篇恰好一次**）并行，再算卡片向量

`persist` 里写盘前用 `buildGeneration.isCurrent()` 复核，过期的一代**整体丢弃**；提问路径（`waitForStage1`）只等阶段①，不等卡片调用。由 `LibraryView` 导入后**后台触发**，或 `ChatView` 手动触发。

**不再触发语义树建树**：`indexPaper` 完成后没有 `buildPaperTree` 调用——建树只能从设置页的开关与「重建全部语义树」按钮显式发起（方案 §6.3）。

### 轻量语义树（`buildPaperTree` / `loadSemanticIndex`）

| 行为 | 说明 |
|------|------|
| 返回值 | `buildPaperTree` 返回 `TreeBuildOutcome { ok, reason? }`：`ok:false` 既覆盖良性跳过（总开关关闭 / 该篇在建树 / 已有可复用树 / 任务被取代），也覆盖真失败，任何分支都必须给出可展示的中文 `reason`（#13） |
| 触发条件 | 总开关开启、该篇未在 `treeIndexingPapers` 中、平面索引已存在 |
| 复用 | 用 `semanticTreeConfigHash` 折出的**构建配置指纹**（schema / 提示词 / 模型端点 / 分块参数 / `maxInputChars`）与 `hashTreeSource(pages)` 原文指纹共同作缓存键；两者都命中**且**记录能通过 `parseTreeRecord` 的完整校验时才直接标记就绪，**不调模型**（§10.3）。缓存键只覆盖原文会让提示词或模型更新后永远复用旧树 |
| 强制重建 | `buildPaperTree(id, pages, { force: true })` 跳过复用判断；`rebuildAllTrees()` 逐篇强制重建已索引论文（设置页「重建全部语义树」按钮），只重跑建树、不重跑平面索引。返回 `TreeRebuildSummary { attempted, rebuilt, failed, skipped, firstReason? }`——只回一个成功数会让「全部失败」在 UI 上退化成「没有可重建的论文」，而 `firstReason` 让设置页能说出失败原因（#13） |
| 配置快照 | 建树是含 await 的长流程，开始时就快照 `indexProfile`，**指纹、LLM 调用参数与落库 `buildModel` 全部取自这一份**。否则中途切换索引配置会「用模型 B 建树、按模型 A 的指纹保存」，切回 A 时会错误复用这棵树。`callLLM` 因此同时接受 profileId 与 profile 对象 |
| 就绪集合刷新 | `refreshTreeReadyPapers()` 按当前构建配置重查 `tree.list(filter)`；`init` / `setIndexProfileId` / `updateProfile`（改的是当前索引配置时）都会调用。刷新是异步的而配置可被连续切换，因此用**代次 + 返回后复核当前指纹**双重把关：只有「最后一次发起」且「配置至今未再变」的结果才落地，乱序响应不会覆盖新配置的统计 |
| 就绪标记 | `markTreeReady(paperId, configHash)` 只在**这棵树所属的配置仍等于当前配置**时才计入集合。旧配置的建树任务在切换配置之后才完成时，不会把一篇用不上的树重新算成可用 |
| 建树 | `buildEvidenceBlocks` → `buildSemanticTree`（**整篇恰好一次 LLM 调用**）→ `window.db.tree.set` 落库树 / 证据块 / schema 与提示版本 / 建树模型 / 原文指纹 / token / 时延 |
| 未配置模型短路 | 非 ollama、`apiKey` 为空且 `baseUrl` 不是本地端点（`isLocalEndpoint`：localhost / 127.0.0.1 / 0.0.0.0 / ::1）时**不发**这一次注定失败的请求，直接返回「未配置模型（请在设置中填写 API Key）」；本地端点（LM Studio / vLLM / llama.cpp 等）免 Key 照常请求，真失败由 `treeFailureReason` 归为「请求失败：…」（#13） |
| 失败降级 | 捕获一切异常返回 `{ ok: false, reason: treeFailureReason(error) }`（按 `SemanticTreeBuildError.reason` 分档：无证据 / 输入过长 / 请求失败 / 输出不合规），不写半成品树、不抛出——只是「这篇没有树」，问答照常（§8.2 / #13） |
| 代次保护 | 每篇持有一个 `treeBuildTokens` 代次，写盘前比对；期间重新建树或内容变更则丢弃本次结果，避免写入过期树 |
| 载入 | `loadSemanticIndex` 与复用判断共用 `parseTreeRecord(record, expectedConfigHash)`：记录缺失、schema 过期、配置指纹不匹配、证据块为空、结构非法都返回 `undefined`，由调用方回落平面检索（§9 / §13）。**期望指纹由调用方给出**——载入路径传当前配置，复用路径传本次建树的快照；若函数内部统一读实时 profile，`tree.get` 等待期间切换配置会让一份对快照完全匹配的有效缓存被误判失效、白白重建 |

### 对话主流程（`sendMessage` / `retryMessage` / `continueMessage`）

```
addMessage(user, ..., { context })        // 划选原文随用户消息持久化（#2）
├─ 形如 "/xxx" 且非 "/abstract" → 本地回「未识别的命令…」，不发模型（#8）
├─ == "/abstract" → generateAbstract(conv) → addMessage(assistant, sources)
└─ 否则 generateReply：检索（无外部 context 且 conv.paperIds 非空时）→ 流式生成
   Call 1（有历史时，slice(-4,-1) ≥ 2 条）rewriteQuery → retrievalQuery
   对每篇 paper：window.db.index.get（缺失则 waitForStage1 兜底）→ Call 2 段落混合检索
   （只有旧版 v1 平面记录才回落到 scoreAndSelect / 树路由）
   合并各篇 context / sources
   Call 3 requestCompletion(onToken)：占位气泡逐 token 渲染，成功后才一次性落库
失败 → recordFailure 落一条带 error 的空助手消息（失败卡）并 rethrow（#2）
```

- **失败轮**：`Message.error` 非空即失败，无半截内容入库；`error`/`truncated` 为消息级字段，随 `addMessage`/`updateMessage` 落库
- **重试** `retryMessage(convId, messageId)`：原地重放失败轮——`generateReply(..., index - 1, { writeBack })` 单次写回（成功才落内容，失败保持原失败态）；提问取失败轮之前的最近一条用户消息，带 `context` 时按 `externalContext` 重放（跳过论文收集与改写/评分），否则重跑检索；`historyEnd = index - 1` 使问题只作为 query 出现一次（与首答 `slice(0, -1)` 同口径）
- **继续** `continueMessage(convId, messageId)`：对截断回答就地续写（非流式），追加到原回答并刷新 `truncated`；带 `context` 时与重试同构，否则把已输出的半截回答并入改写历史后按原问题重跑检索
- **来源构造**：`retrievals[i].selected[j]` 与 `retrievals[i].sources[j]` 一一对齐，产出结构化 `SourceRef { label, paperId?, startPage?, endPage? }`（缺件退化为纯标签；芯片能否跳页由 `isJumpable` 判断）

每篇论文先取段落索引（`parsePassageIndex`，v2）：拿到就挂 `passageIndex` 走**段落混合检索**，且**不挂 `semantic`**（D57：树路由与段落路径互斥，这是 `treeRouted` 保持诚实的前提）。只有旧版 v1 平面记录才回落到 `loadSemanticIndex` 的树路由（同样一次 LLM 调用，上下文仍来自原文证据块）/ 平面 `scoreAndSelect`。三条路径的查询阶段 LLM 调用次数并不一致：段落路径为零，树路由与平面 `scoreAndSelect` 各一次（退化到单候选的树会短路，为零）。

- system 提示词固定追加 `MATH_FORMAT_INSTRUCTION`（要求用 `$...$` / `$$...$$`，禁用 `\(\)`/`\[\]`）
- 首条消息实际仅 1 次 LLM 调用：段落路径的检索阶段零 LLM（无历史时不触发 `rewriteQuery`）

### `/abstract` 摘要（`generateAbstract`）

- 前置校验：conv 需选 ≥1 篇论文、需已配置 `abstractToken`
- 逐篇：`readPaperPages`（优先读 `paper_indexes.pages_json` 缓存，否则 `extractPages`）→ `summarizeAcademicText`（见 [utils](../utils/CLAUDE.md)）
- 多篇时以 `## 标题` 分段，段间 `\n\n---\n\n`；`sources` 为结构化 `SourceRef[]`（摘要没有页码，只有 `label` + `paperId`，`isJumpable` 为 false，芯片渲染为不可点标签）
- 导出 `ABSTRACT_MODEL` 常量供设置页展示

### 其它导出

`newConversation / addMessage / updateMessage / removeConversation / discardEmptyConversation / syncPaperIds`；`sendMessage / retryMessage / continueMessage / requestCompletion`；`collectIndexedPapers / indexPaper / buildPaperTree / rebuildAllTrees / loadSemanticIndex`；`PROMPT_TEMPLATES`（5 个系统提示词模板）；接口 `LLMProfile` / `Message` / `Conversation` / `TreeBuildOutcome` / `TreeRebuildSummary`。

## 常见问题

**Q: 语义树开关关掉之后会怎样？**
`treeEnabled=false` 时既不建树也不载入树，但检索分派不受该开关控制：记录里只要有可解析的 v2 段落索引就走段落混合检索，只有旧版（v1）平面记录才回落到平面 `scoreAndSelect`。已落库的树只是不再被读取，不会删除。重新打开即恢复。

**Q: 对话和索引为什么用不同 profile？**
索引构建（生成节标题/摘要、评分）可用便宜/本地模型，对话回答用更强模型，分开配置更经济。

**Q: 首次对话时论文还没建好索引怎么办？**
`sendMessage` 内有兜底：`index.get` 为空时即时 `indexPaper` 再重取；失败则该篇跳过（无索引即退化为无 RAG 回答）。

**Q: LLM 请求为什么不走主进程？**
减少 IPC 往返，渲染层直接 fetch 更简单；凭据存 `settings` 表，不额外暴露到 preload 之外。

## 相关文件

- `src/stores/paper.ts` — usePaperStore
- `src/stores/chat.ts` — useChatStore（LLM/RAG/索引/摘要）
- `src/utils/pageIndex.ts` — `extractPages`/`buildPageIndex`/`scoreAndSelect`
- `src/utils/passageIndexBuilder.ts` / `passageIndex.ts` / `passages.ts` / `passageRetrieval.ts` / `structureCards.ts` / `embedder.ts` — 段落索引的分阶段构建、落盘结构、切段、融合检索、卡片与本地向量
- `src/utils/ragPipeline.ts` — `runRagPipeline` / `retrieveRagContext` / `buildAnswerMessages`
- `src/utils/sourceRef.ts` — `SourceRef` / `isJumpable`（消息来源的结构化定义）
- `src/utils/semanticTree.ts` / `src/utils/evidenceBlock.ts` — 建树与证据块
- `src/utils/semanticRoute.ts` — 单轮树路由
- `src/utils/abstractSummarizer.ts` — `summarizeAcademicText`/`ABSTRACT_MODEL`
- `src/types/db.d.ts` — `window.db` 类型声明（含 `index`）
