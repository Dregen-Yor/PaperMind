[根目录](../../CLAUDE.md) > [src/](../) > **stores/**

# src/stores/ — 状态管理模块

**变更记录**
- 2026-09-15: `useChatStore` 增加轻量语义树状态与后台建树——`treeEnabled`（默认开启，设置页可关）、`treeReadyPapers` / `treeIndexingPapers`、`buildPaperTree` / `rebuildAllTrees` / `loadSemanticIndex` / `setTreeEnabled`；`indexPaper` 完成后在后台触发建树，`sendMessage` 按篇挂载 `semantic` 交给 RAG 管线。建树缓存身份同时覆盖原文指纹与**构建配置指纹**（schema / 提示词 / 模型端点 / 分块与输入上限），复用前还要过一遍 `validateSemanticTree`
- 2026-08-02T15:49:42: 重写以反映多 LLM 配置（profiles）、`indexPaper`/`indexedPapers`、`/abstract` 摘要（`generateAbstract`）、旧 `llm_config` 迁移、反 Proxy 持久化
- 2026-07-18T00:00:00: 更新 sendMessage RAG 管线文档（3-call 流程）
- 2026-06-07T21:33:55: 初始化文档

## 模块职责

Pinia 全局状态管理，封装所有与主进程的 IPC 通信、LLM API 请求、PageIndex 构建与 `/abstract` 摘要逻辑。渲染层组件通过 store 方法操作数据，不直接调用 `window.db`。

## 入口

两个 store，均为 Pinia setup 函数风格，均有幂等 `init()`（`loaded` flag），在 `App.vue` 挂载时并行调用：

- `paper.ts` — `usePaperStore`：论文列表与知识库
- `chat.ts` — `useChatStore`：对话、消息、**多 LLM 配置**、PageIndex 索引、摘要

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
| `treeEnabled` | 轻量语义树总开关，**默认开启**；持久化键 `semantic_tree_enabled`，只有显式存过 `false` 才关闭 |
| `treeReadyPapers` / `treeIndexingPapers` | 已有可用语义树 / 正在后台建树的 paperId 集合（`Set`）。前者由 `refreshTreeReadyPapers()` 按**当前构建配置指纹**过滤 `tree.list()` 得到，模型或提示词换过之后不会继续谎报可用。注意该过滤只比 `schema_version` / `build_config_hash` 两列，证明不了 JSON 内容有效——损坏记录可能短暂计入，真正加载时由 `parseTreeRecord` 拒绝 |

### Profile 与设置持久化

- `addProfile / updateProfile / removeProfile`（至少保留 1 个；删当前项自动切首个）
- `setChatProfileId / setIndexProfileId / setAbstractToken / setTreeEnabled` — 分别写 `llm_profile_chat` / `llm_profile_index` / `huggingface_token` / `semantic_tree_enabled`；`setIndexProfileId` 额外刷新语义树就绪集合（索引配置即建树配置）
- `persistProfiles()` 将 `profiles` **深拷贝为普通对象**再 `settings.set('llm_profiles', ...)`——因 Electron 结构化克隆无法序列化 Vue 响应式 Proxy（`chat.store.test.ts` 有 `isProxy` 校验）
- `init()`：加载 `llm_profiles`；**旧版迁移**——无 profiles 但存在旧 `llm_config` 时，包装为单条 profile 并落盘；再恢复 `llm_profile_chat/index` 选择、`index.list()` 已建索引集合、`huggingface_token`、语义树开关与 `tree.list({ schemaVersion, buildConfigHash })` 过滤后的已建树集合

### LLM 调用（`callLLM`）

直接从渲染进程 `fetch`，按 provider 适配：
- **ollama**：`POST {baseUrl}/api/chat`，`stream:false`，`topK>0` 时附 `options.top_k`
- **openai / anthropic**：`POST {baseUrl}/chat/completions`（OpenAI 兼容）
  - openai：`Authorization: Bearer {apiKey}`
  - anthropic：`x-api-key` + `anthropic-version: 2023-06-01`，`topK>0` 时附 `top_k`
- 可传 `profileId` 指定配置（默认用 `chatProfile`）

### 索引构建（`indexPaper`）

`indexingPapers` 去重 → 读 PDF base64 → `extractPages` → `buildPageIndex`（用 `indexProfile` 的 LLM）→ `window.db.index.set(paperId, indexJson, pagesJson)` → 加入 `indexedPapers`。由 `LibraryView` 导入后**后台触发**，或 `ChatView` 手动触发。

写盘后**不 await** 地触发 `buildPaperTree(paperId, pages)`：语义树建在独立的后台任务里，不阻塞导入、阅读与首次提问。

### 轻量语义树（`buildPaperTree` / `loadSemanticIndex`）

| 行为 | 说明 |
|------|------|
| 触发条件 | 总开关开启、该篇未在 `treeIndexingPapers` 中、平面索引已存在 |
| 复用 | 用 `semanticTreeConfigHash` 折出的**构建配置指纹**（schema / 提示词 / 模型端点 / 分块参数 / `maxInputChars`）与 `hashTreeSource(pages)` 原文指纹共同作缓存键；两者都命中**且**记录能通过 `parseTreeRecord` 的完整校验时才直接标记就绪，**不调模型**（§10.3）。缓存键只覆盖原文会让提示词或模型更新后永远复用旧树 |
| 强制重建 | `buildPaperTree(id, pages, { force: true })` 跳过复用判断；`rebuildAllTrees()` 逐篇强制重建已索引论文（设置页「重建全部语义树」按钮），只重跑建树、不重跑平面索引。返回 `TreeRebuildSummary { attempted, rebuilt, failed, skipped }`——只回一个成功数会让「全部失败」在 UI 上退化成「没有可重建的论文」 |
| 配置快照 | 建树是含 await 的长流程，开始时就快照 `indexProfile`，**指纹、LLM 调用参数与落库 `buildModel` 全部取自这一份**。否则中途切换索引配置会「用模型 B 建树、按模型 A 的指纹保存」，切回 A 时会错误复用这棵树。`callLLM` 因此同时接受 profileId 与 profile 对象 |
| 就绪集合刷新 | `refreshTreeReadyPapers()` 按当前构建配置重查 `tree.list(filter)`；`init` / `setIndexProfileId` / `updateProfile`（改的是当前索引配置时）都会调用。刷新是异步的而配置可被连续切换，因此用**代次 + 返回后复核当前指纹**双重把关：只有「最后一次发起」且「配置至今未再变」的结果才落地，乱序响应不会覆盖新配置的统计 |
| 就绪标记 | `markTreeReady(paperId, configHash)` 只在**这棵树所属的配置仍等于当前配置**时才计入集合。旧配置的建树任务在切换配置之后才完成时，不会把一篇用不上的树重新算成可用 |
| 建树 | `buildEvidenceBlocks` → `buildSemanticTree`（**整篇恰好一次 LLM 调用**）→ `window.db.tree.set` 落库树 / 证据块 / schema 与提示版本 / 建树模型 / 原文指纹 / token / 时延 |
| 失败降级 | 捕获一切异常返回 `false`，不写半成品树、不抛出——只是「这篇没有树」，问答照常（§8.2） |
| 代次保护 | 每篇持有一个 `treeBuildTokens` 代次，写盘前比对；期间重新建树或内容变更则丢弃本次结果，避免写入过期树 |
| 载入 | `loadSemanticIndex` 与复用判断共用 `parseTreeRecord(record, expectedConfigHash)`：记录缺失、schema 过期、配置指纹不匹配、证据块为空、结构非法都返回 `undefined`，由调用方回落平面检索（§9 / §13）。**期望指纹由调用方给出**——载入路径传当前配置，复用路径传本次建树的快照；若函数内部统一读实时 profile，`tree.get` 等待期间切换配置会让一份对快照完全匹配的有效缓存被误判失效、白白重建 |

### 对话主流程（`sendMessage`）

```
addMessage(user)
├─ 若 == "/abstract" → generateAbstract(conv) → addMessage(assistant, sources) ── return
└─ 否则 RAG（无外部 context 且 conv.paperIds 非空时）：
   Call 1（有历史时，slice(-4,-1) ≥ 2 条）rewriteQuery → retrievalQuery
   对每篇 paper：window.db.index.get（缺失则兜底 indexPaper）→ Call 2 scoreAndSelect
   合并各篇 context / sources
   Call 3 callLLM（system=systemPrompt + 数学格式指令 + 参考内容；带最近 20 条历史）
```

每篇论文经 `loadSemanticIndex` 取树：取到则挂 `semantic` 字段交给 `runRagPipeline` 走**单轮树路由**（同样一次 LLM 调用，上下文仍来自原文证据块）；取不到或总开关关闭则该篇走平面 `scoreAndSelect`。两种路径的查询阶段调用次数一致。

- system 提示词固定追加 `MATH_FORMAT_INSTRUCTION`（要求用 `$...$` / `$$...$$`，禁用 `\(\)`/`\[\]`）
- 单节点索引（root 无子节点）时 `scoreAndSelect` 不发 LLM 调用——故首条消息实际仅 1 次 LLM 调用

### `/abstract` 摘要（`generateAbstract`）

- 前置校验：conv 需选 ≥1 篇论文、需已配置 `abstractToken`
- 逐篇：`readPaperPages`（优先读 `paper_indexes.pages_json` 缓存，否则 `extractPages`）→ `summarizeAcademicText`（见 [utils](../utils/CLAUDE.md)）
- 多篇时以 `## 标题` 分段，段间 `\n\n---\n\n`；`sources` 为论文标题列表
- 导出 `ABSTRACT_MODEL` 常量供设置页展示

### 其它导出

`newConversation / addMessage / removeConversation / syncPaperIds`；`buildPaperTree` / `loadSemanticIndex`；`PROMPT_TEMPLATES`（5 个系统提示词模板）；接口 `LLMProfile` / `Message` / `Conversation`。

## 常见问题

**Q: 语义树开关关掉之后会怎样？**
`treeEnabled=false` 时既不建树也不载入树，全部检索退回原有平面路径；已落库的树只是不再被读取，不会删除。重新打开即恢复。

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
- `src/utils/semanticTree.ts` / `src/utils/evidenceBlock.ts` — 建树与证据块
- `src/utils/semanticRoute.ts` — 单轮树路由
- `src/utils/abstractSummarizer.ts` — `summarizeAcademicText`/`ABSTRACT_MODEL`
- `src/types/db.d.ts` — `window.db` 类型声明（含 `index`）
