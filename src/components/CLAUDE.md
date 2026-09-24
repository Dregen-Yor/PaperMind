[根目录](../../CLAUDE.md) > [src/](../) > **components/**

# src/components/ — 公共组件模块

**变更记录**
- 2026-09-24: ParamPanel 的回答长度上限改用「不限制」开关 + 滑块（`maxTokens = 0` 即不限制；关掉开关按 profile 还原 `lastCappedTokens` 里记的上一次有限值，没有才用 `CAPPED_MAX_TOKENS_DEFAULT`；滑块量程 `MAX_TOKENS_LIMIT`）
- 2026-09-21: 问答链路补失败卡 / 截断条 / 流式光标（ChatPanel），来源芯片结构化并可跳页；PdfViewer 划选按页合并（`mergeSegments`）且高亮接入 IPC 落库、适宽度跟随容器（ResizeObserver + 宽度守卫 + 渲染代次）、`scrollToPage` 等待目标页并闪烁
- 2026-08-02T15:49:42: 补记 ChatPanel 的 `renderMarkdown`/KaTeX 渲染与 `/abstract` 命令提示、头像资源、IME 组合态处理；PdfViewer 高亮叠加层与 HiDPI 渲染；ParamPanel 改为多 profile 选择
- 2026-07-19T14:49:32: ChatPanel / ParamPanel / PdfViewer 视觉与 a11y 微调
- 2026-06-07T21:33:55: 初始化文档

## 模块职责

三个可复用 UI 组件，被 `ReaderView` / `ChatView` 引用。ChatPanel 由 `conversation` prop 驱动，失败态/截断态/来源跳转全部经 emit 交给视图层处理。

## PdfViewer.vue

- **Props**：`src: string`（Blob URL）　**Emits**：`select-text(text: string)`
- 基于 `pdfjs-dist/legacy/build/pdf.mjs`（兼容 Electron 31）；worker 相对路径 `./pdf.worker.min.mjs`
- 一次性渲染全部页面：每页 `canvas`（按 `devicePixelRatio` 放大以适配 HiDPI，避免模糊）+ 透明 `TextLayer`（原生文本选择）
- 工具栏：分页跳转（滚动定位当前页）、缩放 0.5x–3x（缩放会 `renderPdf()` 全量重渲，大文档有开销）
- **适宽度跟随容器**：`ResizeObserver` 观察滚动容器，仅在 fit 模式且宽度变化 ≥1px 时防抖 150ms 重渲（宽度守卫避免噪声触发）；`renderPdf()` 持渲染代次令牌，各 `await` 后校验、卸载时再递增，重叠渲染不会把旧页 append 进容器；手动缩放（+/−）置 `fitMode=false` 后不再自动跟随，点「适合宽度」恢复
- `scrollToPage(num, { flash })`：目标页可能尚未渲染完成，带 5 秒轮询等待（60ms 间隔），到位后 `scrollIntoView({ behavior: 'smooth' })` 并加 `.page-flash` 闪烁一次（1400ms）
- 选中文本弹浮层：**发送到对话**（emit `select-text`）/ **高亮**
- **高亮已接入 IPC 落库**：一次划选按文本节点拆出的候选先经 `mergeSegments`（[src/utils/highlightMerge.ts](../utils/CLAUDE.md)）合并，再 `subtractExisting` 去重叠、逐个 `paperStore.addHighlight`（`window.db.highlight`，带 `pageNum`/`startOffset`/`endOffset`），最后 `drawSegment` 按 caret 矩形绘制 `.pdf-highlight-overlay`（`mix-blend-mode: multiply`）；同一划选在页内只留一条记录

## ChatPanel.vue

- **Props**：`conversation: Conversation | null`　**Exposes**：`addContext(text: string)`（`defineExpose`）
- 消息列表：用户/助手头像（`assets/user.png` / `assets/agent.png`），内容经 **`renderMarkdown`**（`v-html`）渲染——支持标题/列表/表格/代码块/引用/链接与 **KaTeX 数学公式**；`:deep()` 样式定制 `.katex-display`、`pre`、`table` 等
- `msg.sources` 为结构化 `SourceRef[]`（旧字符串数组由 store/DB 侧的 `normalizeSourceList` 归一），以 chip 展示：`isJumpable(s)` 为真时加 `.is-jumpable` 并可点/回车，emit `open-source`；不可跳转的渲染为纯标签
- **失败卡**（`msg.error` 非空）：`.msg-error` 展示错误文案 + 「重试」（`chatStore.retryMessage`，`retrying` 防重入）/「打开设置」；**截断条**（`msg.truncated && !msg.error`）：文案 + 「继续」（`chatStore.continueMessage`，`continuing` 防重入），失败不再销毁原回答、可再次点击
- **流式呈现**：正文 `.msg-content.is-streaming` 有闪烁光标；`hasStreamingBubble` 为真时 typing 三点指示器让位（不叠占位）；流式增量时自动滚动到底部
- **上下文 chip**：`addContext` 接收 PdfViewer 选中文本，暂存 `pendingContext`，发送时 `join('\n---\n')` 作为 `context` 传给 `sendMessage`
- **`/abstract` 命令提示**：输入以 `/` 开头且为 `/abstract` 前缀时，输入框上方浮出命令建议，点击填入
- 输入：`Enter` 发送、`Shift+Enter` 换行；`handleEnter` 检测 `isComposing`/`keyCode 229` 以避免中文 IME 组合期误发
- 失败反馈：发送/继续的 catch 里检查本轮是否已落失败卡/截断条——已落卡则静默（卡即反馈），未落卡才用 `ElMessage.error` 兜底 toast（`retry()` 另有 catch 收尾）

## ParamPanel.vue

- **Emits**：`close`
- 可折叠的对话参数面板（`ChatView` 右栏）：
  - **对话模型选择**：下拉切换 `chatProfileId`（`setChatProfileId`），显示 provider·model 元信息 chip
  - **Temperature / Top-K / Max Tokens** 滑块：`updateCurrent` → `chatStore.updateProfile(chatProfile.id, {...})` 即时持久化；Max Tokens 另有「不限制」开关（`maxTokens = 0`，滑块禁用），提示按 provider 区分 Anthropic 的必填兜底；关掉开关还原本 profile 上次设过的有限值（`lastCappedTokens`，组件内按 profile id 记）
  - 底部「前往设置」链接到 `/settings` 做完整配置
- 通过 `storeToRefs` 读取 `profiles` / `chatProfileId` / `chatProfile`

## 相关文件

- `src/components/PdfViewer.vue` / `ChatPanel.vue` / `ParamPanel.vue`
- `assets/user.png`、`assets/agent.png` — 对话头像
- `src/utils/pdfUtils.ts` — `base64ToUrl`（由 ReaderView 调用后传入 `src`）
- `src/utils/markdown.ts` — `renderMarkdown`（ChatPanel 消息渲染）
- `src/utils/sourceRef.ts` — `SourceRef` / `isJumpable`（ChatPanel 来源芯片）
- `src/utils/highlightMerge.ts` — `mergeSegments` / `HighlightSegment`（PdfViewer 划选合并）
- 状态：[src/stores](../stores/CLAUDE.md)
