# PaperMind Architecture Overview

本文描述当前分支在 PR #14 基础上完成官方 Docling 服务重构后的架构。

## 1. 系统定位

PaperMind 是基于 Electron、Vue 3、Pinia、TypeScript 和 SQLite 的桌面论文阅读与问答应用。核心能力包括：

- 知识库与 PDF 导入管理；
- PDF 阅读、批注和阅读位置恢复；
- 基于 E-k5 索引的多论文 RAG 问答；
- 论文和网页材料的结构化摘要；
- 隔离式网页预览、快照保存和网页问答；
- 本地数据备份与恢复。

## 2. 运行时边界

```text
Vue renderer
  ├─ views / components / Pinia stores
  ├─ provider requests and parsed-summary generation
  └─ window.db / window.preview
                │ contextBridge
Electron preload│
                ▼
Electron main process
  ├─ typed IPC and caller-frame checks
  ├─ SQLite repositories and managed PDF files
  ├─ local PDF protocol and web preview controllers
  └─ official Docling HTTPS client
                │
                ├─ SQLite + userData/papers
                └─ Docling and captured web resources
```

`src/` 不是纯 renderer 目录。`src/types/` 以及部分无浏览器副作用的 `src/utils/` 同时被 Electron 主进程和 benchmark 引用。共享模块不得在导入时访问 DOM、Pinia 或 Electron renderer API。

## 3. 当前产品主路径

### 论文问答

生产问答固定使用 E-k5：解析标题层级和原文分组，对标题路径做 embedding，并与原文 BM25 结果通过 RRF 融合，最终把排名靠前的原文分组交给模型生成答案。索引缺失或损坏时会明确失败，不会静默切换到 PageIndex、段落检索或语义树。

### 结构化摘要

当前统一摘要链路为：

```text
visualSummary store
  → documentSummary:parse
  → document_summary_records / document_summary_assets
  → requestParsedSummary
  → report cache
```

该路径当前只支持 OpenAI-compatible 配置。`abstractCheckpoint`、旧 `document_parses` / `document_assets` 和旧 reducer 不属于这条主路径；`webSummaryCapture` 负责网页材料采集，而不是模型摘要生成。

### 本地数据

- 论文文件由主进程管理在 `userData/papers/`，renderer 不接收任意文件路径。
- 元数据、会话、索引、批注和摘要记录保存在 SQLite。
- 阅读位置保存在 renderer `localStorage`，不在 SQLite。
- `paperFileTransactions.ts` 为部分文件/数据库组合操作提供暂存、回滚和启动恢复，但不构成跨资源 ACID 事务。
- 默认备份会移除明文 API key，且不导出 `abstract_checkpoints`。

## 4. 仓库结构

| 路径 | 角色 |
|---|---|
| `src/views/` | 六个路由页面 |
| `src/components/` | 阅读器、聊天、摘要和通用组件 |
| `src/stores/` | 六个 Pinia store 与产品编排 |
| `src/composables/` | 网页问答和持久化等组合逻辑 |
| `src/utils/` | RAG、模型、PDF、Markdown 和共享纯函数 |
| `src/types/` | IPC、数据库和跨进程共享类型 |
| `electron/` | 主进程、preload、IPC、协议、网络与数据库 |
| `bench/` | E-k5 产品评估和显式 baseline/实验 runner |
| `docs/` | 架构、指南和截图 |
| `scripts/` | 运行时检查和构建辅助脚本 |
| `.agents/`, `.claude/` | 已跟踪的代理/编辑器项目配置 |

`dist/`、`dist-electron/`、`release/`、`node_modules/`、`.worktrees/` 和 `.superpowers/` 是生成或本地工作目录。`dataset/`、`models/`、benchmark 缓存和结果也可能只存在于本机，不应被架构文档写成仓库必备内容。

## 5. 安全与信任模型

- BrowserWindow 使用 sandbox、context isolation，关闭 Node integration，并限制导航和新窗口。
- `ipcSecurity.ts` 只确认调用来自已注册主窗口的可信主 frame；参数运行时校验分布在 IPC handler、repository、备份校验器和服务 URL 校验器中。
- provider 密钥在本地设置中保存，并因 renderer 直接请求 provider 而对 renderer 可见。
- Docling 请求由主进程发往项目维护的唯一 HTTPS 地址；普通用户只能提供 API Key，请求禁止重定向。
- 网页内容运行在隔离 preview 窗口中，通过受控快照和缓存接口进入应用数据层。

## 6. Official Docling Boundary

`config/docling-service.json` 是地址、60 秒时限和 OCR/公式/表格解析能力的唯一项目配置。当前 `https://docling.example.com` 是部署前占位地址，预期在正式服务上线前连接失败；失败会显式返回，不会启动 SSH、本地服务、端口探测或降级解析。

普通用户只维护 `docling_config.apiKey`。PDF 和提取出的 OCR、公式、表格材料由主进程发往官方服务；网页 HTML/MHTML 材料仍在本地解析。完整字段和所有权见 [configuration.md](./configuration.md)。

## 7. 已知架构债务

- `src/stores/chat.ts` 同时承担 provider、会话运行、检索、生成和兼容路径，职责过重。
- `electron/db/index.ts` 聚合多个 repository 和迁移/恢复入口，仍是较大的协调模块。
- provider、run、retrieval、summary service 是可行的拆分方向，但当前并不存在这些独立 service 层。
- E-k5 的 `contextGroups` 以分组起始页代表跨页内容，引用页映射仍可能不够精确。
- SQLite 同步调用和完整备份运行在主进程，数据量增大后需要用测量结果评估阻塞风险。

## 8. 文档维护规则

代码和 schema 是最终事实来源。以下变化必须同步更新本目录：

- runtime 或进程边界；
- 生产 RAG/摘要路径；
- IPC namespace、channel 或 payload；
- SQLite table、备份范围或文件所有权；
- 页面、store、核心模块的职责划分。

模块索引见 [modules.md](./modules.md)，关键数据流见 [data-flow.md](./data-flow.md)，配置所有权见 [configuration.md](./configuration.md)。
