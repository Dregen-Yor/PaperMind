# Module Map

本文列出当前代码中的主要模块与真实职责。它描述“现在有什么”，不把计划中的 service 层或历史实验写成已完成实现。

## Renderer and Shared Source

### `src/views/`

| 页面 | 路由 | 职责 |
|---|---|---|
| `LibraryView.vue` | `/library` | 知识库、论文导入、搜索和批量操作 |
| `ReadingMapView.vue` | `/reading-map` | 跨论文阅读关系与摘要入口 |
| `ReaderView.vue` | `/library/:id` | PDF 阅读、批注、问答和论文摘要 |
| `WebPreviewView.vue` | `/web-preview` | 隔离网页预览、保存和网页问答 |
| `ChatView.vue` | `/chat` | 通用对话与外部上下文 |
| `SettingsView.vue` | `/settings` | provider、官方 Docling API Key 和数据设置 |

`/` 重定向到 `/library`，不存在单独的 Home 页面。路由使用 hash
history；`LibraryView` 静态导入，其余页面懒加载。

### `src/components/`

该目录包含 13 个直接组件，主要分组如下：

- 对话：`ChatPanel.vue`、`ChatProfileSelect.vue`、`ChatSources.vue`、
  `ParamPanel.vue`；
- 阅读与资料：`PdfViewer.vue`、`NotesPanel.vue`、
  `PaperMetadataEditor.vue`、`ReadingStarMap.vue`；
- 摘要与网页：`PaperAbstractPanel.vue`、`WebAbstractPanel.vue`、
  `WebQaPanel.vue`、`WebCachedPreview.vue`；
- 内容渲染：`MarkdownContent.vue`。

PDF 阅读位置由 `PdfViewer.vue` 维护在 `localStorage`。批注的共享状态归 `paper` store；会话运行状态归 `chat` store。`MarkdownContent.vue` 只允许渲染摘要结果中已提供的资源引用。

### `src/stores/`

| Store | 职责 |
|---|---|
| `paper.ts` | 知识库、论文、受管文件访问和共享批注 |
| `chat.ts` | profile/provider、会话 run、E-k5、生成和 `/abstract` |
| `chatDrafts.ts` | 按会话保存草稿和外部上下文 |
| `libraryImport.ts` | 批量导入队列和进度 |
| `libraryWorkspace.ts` | Library 页面选择、搜索、排序和移动/删除状态 |
| `visualSummary.ts` | 论文/网页摘要材料、生成、缓存和取消 |

`chat.ts` 是当前实际编排中心。未来可以拆出 provider、run、retrieval 和 summary service，但这些层目前尚未实现。

### `src/composables/`

三个 composable 负责网页问答与局部持久化逻辑。它们可以调用窄范围的 `window.db` API；架构上不存在“所有 IPC 必须经过 store”的统一规则。

### `src/utils/`

`src/utils/` 有约 54 个顶层工具模块，可按产品角色划分：

- E-k5 主路径：`ek5/` 下的候选标题、目录树、heading group、索引、
  检索和持久化模块，以及 `ragPipeline.ts`、`transformersEmbedder.ts`；
- provider 与 stream：`llm.ts`、`providerStreams.ts`、
  `answerMessages.ts`、`buildGeneration.ts`；
- 摘要：`parsedSummary.ts` 和摘要资源/Markdown 辅助模块；
- PDF/内容：PDF 文本、页码、引用、Markdown 和 LaTeX 处理；
- 安全与契约：服务 URL、IPC 参数和可序列化数据校验；
- Docling 配置：`doclingConfig.ts` 校验只读官方配置并迁移用户凭据，`doclingDocument.ts` 只定义解析结果；
- 兼容/实验：PageIndex、段落检索、语义树、旧 abstract reducer。

兼容模块仍可能被测试、benchmark 或维护接口引用，但不等于生产问答会自动回退到它们。被 Electron 或 benchmark 引用的共享工具必须保持无 DOM/renderer 副作用。

### `src/types/`

这里定义数据库 API、IPC contract、网页 preview、摘要、RAG 和跨进程 DTO。类型只能提供编译期约束；来自 IPC、备份文件和远程服务的数据仍需要运行时校验。

## Electron Main Process

### 顶层模块

| 模块 | 职责 |
|---|---|
| `main.ts` | 应用生命周期、主窗口、单实例和 PDF 协议启动 |
| `preload.ts` | `window.db` / `window.preview` context bridge |
| `ipc.ts` | typed channel 注册和可信 frame gate |
| `ipcSecurity.ts` | 主窗口 frame 身份检查 |
| `paperProtocol.ts` | 受管 PDF URL、range response 和路径隔离 |
| `doclingClient.ts` | 只使用项目官方配置的 Docling HTTPS 请求和转换 |
| `docling.ts` | PDF 解析缓存编排和官方配置身份 |
| `summaryParsing.ts` | 论文/网页统一材料解析和缓存身份 |
| `htmlSummary.ts` | HTML/MHTML 到 `ParsedDocument` |
| `webPreview.ts` | live/cached preview controller |
| `webSummaryCapture.ts` | DOM、MHTML 和 visual-PDF 快照采集 |

`preview:*` channel 由 `electron/ipc.ts` 注册，再委托给 `webPreview.ts` controller。`ipcSecurity.ts` 不负责所有 payload 校验。

### `electron/db/`

SQLite schema 包含 19 张表，覆盖：

- knowledge base、paper、highlight；
- conversation、message 和 settings 中的 profile 配置；
- index、tree 与 E-k5 状态；
- web snapshot、网页问答；
- paper abstract 与统一 document summary；
- legacy parse/asset/checkpoint compatibility data。

`electron/db/index.ts` 组装公开 API、初始化 schema 和恢复流程；各 repository 负责具体领域。数据库 API 改动需同步检查 schema、repository、IPC contract、preload、全局类型和测试 mock。

文件与数据库组合操作通过 `paperFileTransactions.ts` 暂存并在失败时回滚，启动时也会清理/恢复已知中断状态。这是可恢复性机制，不是通用分布式事务。

## IPC Surface

`window.db` 暴露 13 个 namespace：

`documentSummary`、`webQa`、`docling`、`abstractCheckpoint`、`paperAbstract`、`kb`、`paper`、`chat`、`highlight`、`settings`、`data`、`index`、`tree`。

`window.preview` 独立暴露实时/缓存 preview 控制和状态订阅。修改 channel 时至少检查：

1. `src/types/ipcContract.ts`；
2. `electron/ipc.ts`；
3. `electron/preload.ts`；
4. `src/types/db.d.ts` / `src/types/webPreview.d.ts`；
5. `src/tests/setup.ts` 和运行时校验测试。

## Benchmark

`bench/` 是独立 Node/tsx 评估项目。产品 runner 复用 E-k5 和 Docling 生产代码；其他 runner 明确标识为 baseline、对比或历史实验。不要把本地 dataset、模型缓存、运行结果或机器相关耗时/文件大小写成仓库固定架构。

## Configuration and Generated Content

- `config/docling-service.json` 保存项目维护、用户不可覆盖的官方 Docling 契约；`public/` 和 `assets/` 保存其他运行时或构建资源；
- `.agents/`、`.claude/` 是已跟踪配置；
- `.worktrees/`、`.superpowers/`、`node_modules/`、构建产物和 release 不属于源代码；
- `dataset/`、`models/` 和 benchmark 输出是可选本地资产。

整体关系见 [overview.md](./overview.md)，端到端流程见 [data-flow.md](./data-flow.md)，配置边界见 [configuration.md](./configuration.md)。
