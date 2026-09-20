[根目录](../CLAUDE.md) > **src**

# src/ — 应用入口与全局配置

**变更记录**
- 2026-09-15: `types/db.d.ts` 增加 `tree` 命名空间与 `PaperTreeRecord`；测试目录扩充（证据块 / 语义树 / 树路由 / 管线接入 / 设置页开关）
- 2026-08-02T15:49:42: 修正面包屑（root 为 `../CLAUDE.md`）；补记 `main.ts` 引导、新增 CSS 变量、router 拆分为独立模块、测试目录扩充至 6 文件、`src/types` 说明
- 2026-07-19T14:49:32: UI 美化——主色改为青绿、侧栏/卡片/空态/对话气泡视觉升级
- 2026-06-07T21:33:55: 初始化
- 2026-06-07T21:51:00: 补全 App.vue / global.css / router 文档

---

## 目录概览

| 子路径 | 说明 | 独立文档 |
|--------|------|---------|
| `main.ts` | Vue 应用引导入口 | 本文 |
| `App.vue` | 应用根组件（侧栏 + 路由内容区） | 本文 |
| `router/` | Vue Router hash 路由 | [src/router](./router/CLAUDE.md) |
| `stores/` | Pinia 状态管理 | [src/stores](./stores/CLAUDE.md) |
| `views/` | 四个路由页面 | [src/views](./views/CLAUDE.md) |
| `components/` | 公共 UI 组件 | [src/components](./components/CLAUDE.md) |
| `utils/` | PDF/检索/Markdown/摘要工具 | [src/utils](./utils/CLAUDE.md) |
| `styles/global.css` | 全局样式与 CSS 变量 | 本文 |
| `types/` | `db.d.ts`、`markdown-it-texmath.d.ts` | 本文 |
| `tests/` | Vitest 单测 | 本文 |
| `shims-vue.d.ts` | `*.vue` / `*.png` 模块声明 | 本文 |

## main.ts — 引导入口

`createApp(App)` → 全局注册所有 `@element-plus/icons-vue` 图标 → `use(createPinia())` → `use(ElementPlus)` → `use(router)` → `mount('#app')`；引入 `element-plus/dist/index.css` 与 `./styles/global.css`。

## App.vue — 应用根组件

布局结构：固定侧边栏 + 路由内容区，应用全局唯一入口。

```
┌─ sidebar (var(--sidebar-width)) ─┬─ main-content (flex:1) ─────┐
│  logo（P 徽标 + 副标题）          │  <router-view>               │
│  nav-items（知识库 / 对话）        │  (fade 0.18s 过渡)           │
│  settings link（底部独立）         │                              │
└──────────────────────────────────┴──────────────────────────────┘
```

**关键行为**
- `onMounted` 中 `Promise.all([paperStore.init(), chatStore.init()])`，确保 SQLite 数据在首次路由渲染前就绪
- `<transition name="fade" mode="out-in">` 包裹路由切换
- 侧栏使用 `backdrop-filter: blur` + `color-mix` 半透明；徽标为渐变方块

## src/styles/global.css — 全局样式与 CSS 变量

### 颜色 / 尺寸 / 动效变量（`:root`，`color-scheme: dark`）

| 变量 | 值 | 用途 |
|------|----|------|
| `--bg-base` | `#0c0e11` | 页面最底层背景 |
| `--bg-surface` | `#13161b` | 侧边栏、卡片底色 |
| `--bg-elevated` | `#1a1f27` | 弹窗、悬浮面板 |
| `--bg-hover` | `#222830` | 悬停高亮 |
| `--border` / `--border-light` | `#2a313c` / `#3a4452` | 默认 / 次级边框 |
| `--text-primary` / `--text-secondary` / `--text-muted` | `#e6e9ef` / `#8b95a8` / `#5a6578` | 文字层级 |
| `--accent` / `--accent-dim` / `--accent-hover` | `#3db8a0` / `rgba(...,.14)` / `#52c9b2` | 主色（青绿）及其变体 |
| `--gold` / `--gold-dim` | `#d4a84b` / `rgba(...,.12)` | AI/上下文高亮色 |
| `--success` / `--danger` | `#4caf7d` / `#e05c5c` | 状态色 |
| `--sidebar-width` | `220px` | 侧边栏宽度 |
| `--radius-sm/md/lg` | `6/10/14px` | 圆角 |
| `--shadow-sm` / `--shadow-card` | 阴影 | 卡片 / 悬浮 |
| `--ease-out` | `cubic-bezier(.22,1,.36,1)` | 统一缓动 |

### 字体

- 正文：`DM Sans`（Google Fonts）；标题：`Playfair Display`（`.font-display` 类）；`.tabular-nums` 等宽数字
- `#app` 叠加青绿/金色径向渐变作氛围背景

### Element Plus 主题覆盖

覆盖 EP CSS 变量以贴合暗色主题：`.el-button--primary`（accent）、`.el-dialog`/`.el-message-box`（elevated 背景）、`.el-input__wrapper`/`.el-textarea__inner`（focus 时 accent 描边）、`.el-select-dropdown`、`.el-tag`、`.el-slider`（accent 填充）、`.el-scrollbar`；输入类覆盖用 `!important`。

### 动画 / 无障碍

- `.fade-*`（路由 opacity 0.18s）；`prefers-reduced-motion` 下将过渡与 `.typing`/`.message` 动画降至 0.01ms
- 全局 `:focus-visible` accent 描边（EP input 内部关闭以避免双重描边）

## src/types/ — 类型声明

- `db.d.ts` — `window.db` 的 `DbApi` 接口（含 `index` 与 `tree` 命名空间，后者配 `PaperTreeRecord` / `PaperTreeRecordInput`），并 `declare global { interface Window { db: DbApi } }`
- `markdown-it-texmath.d.ts` — 为无类型的 `markdown-it-texmath` 提供 `TexmathOptions` 声明
- `shims-vue.d.ts` — `*.vue`（`DefineComponent`）与 `*.png`（`string`）模块声明，支撑 `ChatPanel` 引入头像

## src/tests/ — 测试目录

| 文件 | 覆盖 |
|------|------|
| `setup.ts` | 全局 `window.db` mock（含 `index` / `tree` 命名空间），所有测试自动注入 |
| `paper.store.test.ts` | usePaperStore 7 用例 |
| `chat.store.test.ts` | useChatStore 12 用例（含 profiles、RAG 次数、`/abstract`） |
| `pdfUtils.test.ts` | base64ToUrl + detectSectionBoundaries + mergeSmallSections（11 用例） |
| `pageIndex.test.ts` | scoreAndSelect + buildPageIndex（6 用例） |
| `abstractSummarizer.test.ts` | splitAbstractText + summarizeAcademicText 递归（2 用例） |
| `markdown.test.ts` | renderMarkdown 结构/安全/LaTeX（7 用例） |
| `evidenceBlock.test.ts` | buildEvidenceBlocks 结构契约/原文正确性/分块无损（26 用例） |
| `semanticTree.test.ts` | buildSemanticTree 单次调用、校验与诊断、建树配置指纹（54 用例） |
| `semanticRoute.test.ts` | routeWithSemanticTree 单轮路由、原文取证、上下文预算与平面回落（35 用例） |
| `ragPipelineSemantic.test.ts` | 树路由接入 runRagPipeline 的调用次数、就地回落与预算（11 用例） |
| `semanticTreeStore.test.ts` | 开关、后台建树、缓存身份（原文+构建配置）、配置快照与切换竞态、就绪集合刷新、强制重建摘要、非法树回落（31 用例） |
| `settingsViewTree.test.ts` | 设置页语义树开关与强制重建按钮及其成败提示（挂载 Element Plus，7 用例） |
| `contextTrace.test.ts` | materializeContext：文本与首次出现页序同源、预算边界计页与丢弃、分组分隔符守卫、恰好占满不截断（7 用例） |
| `ragPipeline.test.ts` | runRagPipeline / retrieveRagContext / generateRagAnswer：调用次数、字符与 token 两条预算路径、externalContext 优先、生成失败不改写检索结果、分阶段时延（17 用例） |
| `queryRewrite.test.ts` | rewriteQuery：改写结果、带入历史轮、trim、LLM 抛错/空返回回落原问题、不引入 pdfjs（6 用例） |
| `libraryFilters.test.ts` | filterLibraryPapers：大小写不敏感搜索 × 阅读状态组合、排序、清空查询恢复（6 用例） |
| `reader.view.test.ts` | ReaderView 对话生命周期：早先的创建请求迟到返回不覆盖当前论文对话（挂载 Element Plus，1 用例） |

> 依赖 `pageIndex.ts` 的测试文件顶部需 `vi.mock('pdfjs-dist/legacy/build/pdf.mjs')`，否则 Node 环境缺 `DOMMatrix` 报错。
