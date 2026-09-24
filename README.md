<p align="center">
  <img src="./assets/papermind-icon.svg" width="112" alt="PaperMind">
</p>

<h1 align="center">PaperMind</h1>

<p align="center">本地优先的学术论文阅读助手 —— 导入 PDF，在同一个窗口里读原文、划词高亮、跨论文问答。</p>

---

## 这是什么

PaperMind 是一个跑在你电脑上的论文阅读工作台：左侧读 PDF，右侧问问题。选中原文就能直接丢进对话当上下文，也可以把多篇论文一起交给模型做跨文献问答。检索与索引全部在本地完成，**没有后端服务**，论文原文、对话、高亮都存在本机 SQLite，模型请求由客户端直连你配置的 provider。

## 主要功能

- **阅读与笔记** — 多知识库分类管理 PDF；内置渲染支持翻页、缩放、适宽、文本选中、划选高亮（可点来源跳回原页）；阅读笔记面板
- **跨论文问答** — 多篇论文共同作为上下文；回答中的来源以可点击的引用芯片给出，直接跳回原文页；支持流式输出、失败重试、截断续写
- **段落级混合检索** — 导入后本地切段建索引；提问时融合「BM25 词法 + 本地向量 + 章节卡片先验」三路打分选出原文段落，**回答前零模型调用**，索引缺失时逐级降级而不是直接失败
- **多 LLM 配置** — OpenAI / Anthropic / Ollama；可建多套命名配置，对话与索引分别指定模型；temperature / top-k / 回答长度上限（可不限制）可实时调整
- **提示词模板与摘要** — 内置精读、通俗解释、要点提取、批判分析、翻译等模板；对话中输入 `/abstract` 调用摘要模型概括所选论文
- **数据自主** — 一键导出/导入全量备份（含 PDF 原文），随时迁移或存档

## 快速开始

**前置依赖**：Node.js `20.19+ / 22.13+ / 24+`，npm 10

```bash
# 安装依赖（自动为 Electron 重建 better-sqlite3）
npm install

# 开发模式（Vite + Electron）
npm run dev

# 类型检查 / 单元测试
npm run typecheck
npm test

# 构建安装包（产物在 release/）
npm run build
```

## 配置模型

打开 **设置页 → 新建配置**，填入 provider 与凭据；也可在对话页右侧参数面板临时切换。

| Provider | 需要填写 | 默认地址 |
|----------|----------|----------|
| OpenAI | API Key | `https://api.openai.com/v1` |
| Anthropic | API Key | 官方端点 |
| Ollama | 本地地址 | `http://localhost:11434` |

- 可以创建多套配置，并分别指定**对话模型**与**索引模型**（索引可选用更便宜的模型）。
- `maxTokens = 0` 表示**不限制**回答长度（OpenAI 兼容端点与 Ollama 不发上限参数；Anthropic 因接口必填会退到兜底值）。
- 对话中输入 `/abstract` 需要额外的 Hugging Face Access Token（设置页填写），摘要走 HF 推理接口。
- ⚠️ API Key 以明文存于本地 SQLite 的 `settings` 表，纯单机场景可接受；如需加固可改用 Electron `safeStorage`。

## 数据存储

全部位于系统 userData 目录（macOS `~/Library/Application Support/PaperMind/`，Linux `~/.config/PaperMind/`）：

- `papermind.db` — SQLite（WAL 模式），知识库、论文、对话、消息、高亮、设置、索引均在单文件内
- `papers/<id>.pdf` — 论文 PDF 原文件

## 目录结构

```
PaperMind/
├── electron/           主进程：生命周期、IPC 注册、preload 桥
│   └── db/             SQLite 建表与全部 CRUD / 索引 / 导出
├── src/
│   ├── views/          知识库 / 阅读器 / 对话 / 设置 四个路由页面
│   ├── components/     PdfViewer、ChatPanel、ChatSources、NotesPanel、ParamPanel
│   ├── stores/         Pinia：论文与知识库、对话与多 LLM 配置
│   ├── utils/          PDF 解析、段落索引与混合检索、语义树、Markdown+KaTeX、摘要
│   └── tests/          Vitest 用例与 IPC mock
├── bench/              离线评测套件（QA 检索/答案 + 摘要，配置矩阵消融）
└── scripts/            图标生成与校验、开发启动脚本
```

技术栈：Electron + Vue 3 + TypeScript（strict）+ Pinia + Element Plus + better-sqlite3 + pdfjs-dist。

## 开发备注

- 各模块的详细说明见同级目录下的 `CLAUDE.md`（架构、IPC 约定、检索链路口径）。
- 离线评测见 [`bench/README.md`](./bench/README.md)（需配置 `BENCH_*` 环境变量）。
- 应用图标母版为 `assets/papermind-icon.svg`，改后运行 `npm run icons:generate` 与 `npm run icons:check`，并提交 `assets/icons` 内的平台产物；逐平台验收见 [`docs/testing/app-branding.md`](./docs/testing/app-branding.md)。
- 修改数据模型或新增 IPC 通道时，需同步 `electron/db/schema.ts`、`electron/db/index.ts`、`electron/preload.ts`、`src/types/db.d.ts` 四处。

## 参与贡献

欢迎 Issue 与 PR。基于 `main` 创建功能分支（如 `feat/your-feature`），保持现有代码风格（TypeScript strict、Vue `<script setup>`、setup 风格 store），逻辑变更请在 `src/tests/` 补充测试；提交 PR 前确保 `npm test` 与 `npm run typecheck` 全部通过，并在描述中说明变更、验证方式与是否有破坏性改动。

## License

[MIT](./LICENSE) © 2026 Dregen_Yor
