# Data Flow

本文描述 PR #14 基线中实际运行的数据流、持久化边界和失败语义。

## 1. Application Startup

```text
app startup
  → declare privileged protocol / set product identity
  → acquire single-instance lock
  → app.whenReady()
  → initDb()
  → register papermind-paper protocol
  → registerIpc()
  → create main BrowserWindow
  → register preview controller
```

主窗口开启 sandbox 和 context isolation，关闭 Node integration。preload 只通过 `window.db` 和 `window.preview` 暴露白名单能力。

## 2. PDF Import and Reading

```text
renderer selects PDF
  → fileData crosses typed IPC
  → main process validates metadata and ownership
  → stage managed file
  → write paper metadata
  → finalize file transaction
  → papermind-paper:// serves PDF with range support
```

导入、替换、删除等选定操作使用 `paperFileTransactions.ts` 暂存、回滚和启动恢复。SQLite 与文件系统并没有共享事务管理器，因此异常恢复依赖显式状态和补偿逻辑。

批注经 `highlight` API 写入 SQLite，并由 `paper` store 在阅读组件之间共享。当前阅读页码/位置由 renderer 写入 `localStorage`，不会进入数据库或备份。

## 3. Production Paper QA

```text
user question + selected papers
  → collectIndexedPapers
  → load/validate E-k5 index
  → optionally rewrite multi-turn query
  → embed heading paths
  → rank heading groups by vector similarity
  → rank path/text by BM25
  → fuse ranks with RRF
  → take top original-text context groups
  → provider request
  → stream assistant message
  → persist run/message terminal state
```

`generateReply` 调用 `runRagPipeline` 时显式使用 `retrievalMode: 'ek5'`。索引缺失、版本不匹配或内容无效会产生错误；不会静默改用 PageIndex、passage 或 semantic tree。

查询重写只在多轮上下文足够时发生。回答可使用 OpenAI、Anthropic 或 Ollama profile。每个会话同一时间最多有一个 active run；占位消息、分段持久化、取消、失败和 interrupted 状态都归原会话所有，不随路由切换重新绑定。

E-k5 `contextGroups` 当前使用分组起始页表示可能跨页的文本，因此 source 页码对跨页分组可能不够精确。

## 4. Structured Summary

### Paper source

```text
PaperAbstractPanel / WebAbstractPanel
  → visualSummary store
  → documentSummary:parse(paper)
  → main reads managed PDF
  → Docling conversion
  → document_summary_records + document_summary_assets
  → requestParsedSummary
  → validate asset:ID references
  → persist task/report cache
```

### Web source

```text
isolated preview
  → capture DOM + MHTML + optional visual PDF
  → save snapshot
  → documentSummary:parse(web snapshot)
  → parse HTML/MHTML into ParsedDocument
  → document_summary_records + document_summary_assets
  → requestParsedSummary
  → report cache
```

`webSummaryCapture` 是采集阶段。模型生成在 renderer 的 parsed-summary client 中完成，当前只接受 OpenAI-compatible profile。`abstractCheckpoint`、旧 Hugging Face reducer 和 `document_parses` / `document_assets` 是兼容接口，不是统一摘要链路的一部分。

摘要任务绑定 source hash、parser identity 和 generation/revision。取消或过期任务返回时不得覆盖更新后的材料。模型输出中的 `asset:ID` 只有在对应资源确实存在时才可渲染。

## 5. Web Preview and Web QA

```text
WebPreviewView
  → window.preview command
  → preview:* IPC handler
  → webPreview controller
  → isolated BrowserWindow / cached snapshot
  → controlled state events back to renderer
```

preview channel 在 `electron/ipc.ts` 注册，控制逻辑委托给 `webPreview.ts`。网页问答的 snapshot、conversation 和 message 数据通过 `webQa` namespace 持久化。外部网页不能直接获得主窗口 preload 能力。

## 6. IPC Validation Flow

```text
renderer invoke
  → ipcSecurity: trusted main-frame check
  → channel-specific runtime validation
  → repository / network / preview operation
  → serializable result
```

TypeScript contract 不替代运行时校验。可信 frame 检查只回答“调用来自哪里”；URL、备份内容、枚举、ID、文件元数据和远程响应仍由各自 handler 或 validator 校验。

## 7. Docling at the #14 Baseline

```text
documentSummary:parse(paper)
  → convertPdfForSummary
  → resolve Docling settings
  → default http://127.0.0.1:5001 ? start managed SSH tunnel
  → Docling HTTP conversion
  → normalized ParsedDocument
```

默认 loopback 配置会转发至 `ubuntu@101.76.222.224`。自定义服务 URL 仍需通过 `serviceSecurity` 规则；请求不跟随重定向。Settings 页面中旧主机提示不是行为依据。

## 8. Backup and Restore

备份从 SQLite 和受管文件生成可校验的数据包。默认行为：

- 导出业务表和受管论文文件；
- 从 settings 中移除明文 API key；
- 不导出 `abstract_checkpoints`；
- 导入前校验结构、版本和记录形状；
- 通过暂存/替换/恢复步骤降低中断后损坏风险。

这不表示所有本地状态都会进入备份：renderer `localStorage` 阅读位置、生成目录、本地 benchmark 资产和未纳入 schema 的缓存不在保证范围内。

## 9. Failure and Recovery Principles

- run、summary 和 import 异步结果必须带所有权或 revision 检查；
- stream 的错误、取消和 EOF 必须写入终态；
- 远程服务失败应显式呈现，不能静默改变检索算法；
- 文件/数据库组合操作依赖补偿和启动恢复，不宣称跨资源原子性；
- 兼容表和兼容 API 的存在不代表当前产品路径正在使用它们。

系统边界见 [overview.md](./overview.md)，模块归属见 [modules.md](./modules.md)。
