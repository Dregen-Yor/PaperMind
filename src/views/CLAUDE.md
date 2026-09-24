[根目录](../../CLAUDE.md) > [src/](../) > **views/**

# src/views/ — 页面视图模块

**变更记录**
- 2026-09-24: 段落混合检索上线后的界面口径——SettingsView 的「语义树检索」总开关**默认关闭**（2026-09-15 的默认开启作废，方案 §6.3），要用需显式打开；LibraryView 导入后预建的是**段落索引**（阶段① 本地切分落盘即放行提问，②③ 在后台），不再是 PageIndex 预建
- 2026-09-21: LibraryView 增加删除撤销条（5 秒）、重复导入查重确认（`skipped` 终态）与导入面板自动收起；ReaderView / ChatView 支持来源芯片跳页（`?page=` 定位 + 目标页闪烁）与空对话丢弃；SettingsView 导出改为保存对话框（默认脱敏、可勾选明文）、重建失败文案带 `firstReason`、唯一配置的删除按钮加 tooltip
- 2026-09-15: SettingsView 增加「语义树检索」卡片——总开关（默认开启，关闭后全部检索回到平面路径）与已建树论文数
- 2026-08-02T15:49:42: 补记 LibraryView 导入进度面板 + 索引模型选择、ChatView 索引状态/建索引入口、SettingsView 多 profile CRUD Dialog + HF token
- 2026-07-19T14:49:32: 知识库/对话/设置页视觉美化（空态、状态 pill、卡片交互）
- 2026-06-07T21:33:55: 初始化文档

## 模块职责

四个路由页面组件，构成应用的全部用户界面。路由为 hash 模式，配置见 [src/router](../router/CLAUDE.md)。

## 路由与页面

| 路由 | 组件 | 职责 |
|------|------|------|
| `/library` | `LibraryView.vue` | 知识库管理、论文卡片网格、PDF 批量导入 |
| `/library/:id` | `ReaderView.vue` | 论文阅读器（PDF + 对话分屏） |
| `/chat` | `ChatView.vue` | 多论文上下文对话中心 |
| `/settings` | `SettingsView.vue` | 多 LLM 配置、摘要 token、数据管理 |

## 各页面说明

### LibraryView — 知识库主页
- 知识库 Tab（含删除按钮，`default` 不可删）；卡片网格展示论文，含状态 pill（未读/阅读中/已完成）、作者行（`formatAuthors`：超 4 位截断为「前 4 位 等 N 位作者」）、摘要截断、年份、标签、操作下拉（移动/标记完成/删除）
- **批量导入**：`<input type=file multiple>` → 逐个 `parsePdfMeta` → `store.addPaper`，右下角 **导入进度面板**（`ImportItem` 状态机 `pending→parsing→saving→done|error|skipped`，含进度条与逐项阶段/错误）
- **重复导入查重**（#10）：按 `meta.fileHash` 命中已有论文时弹确认——「打开现有条目」跳到该论文（循环结束统一 `router.push`），「跳过」把该项置为 `skipped`（`skipped` 计为终态，进度条才会走完）
- **删除撤销条**（#11）：删除先把卡片移出列表并显示底部撤销条（5 秒），到期才 `removePaper` 落库；点「撤销」按原位置插回；未到期又删下一篇则前一篇立即落库。关应用不执行未到期的删除
- 导入完成后约 2.5 秒导入面板自动收起（含失败项时保留，需手动关闭；再次导入会重置计时器）
- 导入成功后**后台** `chatStore.indexPaper(id).catch(()=>{})` 预建段落索引（阶段① 本地切分 + 落盘，<1 秒；段落向量与卡片调用在后台继续），不阻塞
- 当 `profiles.length > 1` 时，顶栏显示「索引模型」选择器（`setIndexProfileId`）
- 新建知识库 Dialog（名称/描述/7 色选择）

### ReaderView — 阅读器（`/library/:id`）
- 左 `PdfViewer` 右 `ChatPanel`，中间 `resizer` 拖拽调宽（25%–75%，`splitRatio` 默认 58）
- `onMounted` 读 PDF base64 → `base64ToUrl`；`status==='unread'` 自动置 `reading`
- 顶部对话下拉 + 新建；无关联对话时自动 `createConv`；**切换论文 / 卸载**时丢弃「已创建但从未发问」的空会话（`discardEmptyConversation`，#15）
- `PdfViewer` 的 `@select-text` → 若无活动对话先建，再 `chatPanelRef.addContext(text)`
- **来源芯片跳页**（#1）：`@open-source` 若为本论文则 `viewer.scrollToPage(startPage + 1)`；`?page=` 路由参数在 PDF 加载后同样滚动定位（`scrollToPage` 内部等待目标页并闪烁）
- `onBeforeUnmount` `revokeObjectURL` 释放 Blob URL

### ChatView — 多论文对话
- 三栏：左（KB 选择 + 论文多选列表 + 历史对话）、中（`ChatPanel`）、右（`ParamPanel`，可收起，收起后右上角悬浮重开按钮）
- 论文列表每项显示**索引状态**：已建（`CircleCheck`）/ 构建中（`Loading` 旋转）/ 未建（`Download` 按钮触发 `doIndex`）
- 勾选论文即 `syncPaperIds` 同步到当前对话；`startNewConv` 以选中论文创建对话；**新建 / 切换对话 / 卸载**时丢弃当前空会话（#15）
- **来源芯片跳页**（#1）：`@open-source` 带 `paperId` + `startPage` 时 `router.push('/library/<id>?page=<startPage+1>')`

### SettingsView — 设置
- **LLM 配置列表**：每行显示名称/provider·model + 「对话」「索引」徽标，编辑/删除（≤1 时禁删；禁用的删除按钮外包 `el-tooltip`「至少保留一个配置」，disabled 元素不派发事件故需 `span` 包裹）
- **新增/编辑 Dialog**：名称、provider（openai/anthropic/ollama）、model、baseUrl、apiKey（ollama 隐藏）、temperature/maxTokens/topK 滑块、系统提示词 + `PROMPT_TEMPLATES` 快填
- **默认使用配置**：对话 / 论文索引两个下拉（`setChatProfileId` / `setIndexProfileId`）
- **语义树检索**：`el-switch` 绑定 `treeEnabledLocal`（**默认关闭**，段落混合检索是默认检索路径），`@change` → `chatStore.setTreeEnabled`（方案 §8.2 要求有关闭开关）；旁注已建好语义树的论文数量（`treeReadyPapers.size`）；「重建全部语义树」按钮 → `ElMessageBox.confirm` → `chatStore.rebuildAllTrees()`，给缓存键覆盖不到的场景（就是想换一棵树）一条显式路径；提示按 `{ attempted, rebuilt, failed, skipped, firstReason }` 分档——全失败报 `ElMessage.error`、部分失败报 `warning`、全跳过才报「没有可重建的论文」，失败文案带上首个原因（#13）
- **论文摘要模型**：展示 `ABSTRACT_MODEL`，输入并保存 Hugging Face token（`setAbstractToken`）
- **数据管理**：导出 JSON 备份走「导出备份」对话框——勾选「包含 API Key（明文，分享前请谨慎）」后 `window.db.data.exportFile({ includeApiKey })` 弹系统保存对话框（默认 `papermind-backup-<日期>.json`，取消给出 info toast）；清空数据（二次确认，reload）

## 相关文件

- `src/views/LibraryView.vue` / `ReaderView.vue` / `ChatView.vue` / `SettingsView.vue`
- 依赖组件：[src/components](../components/CLAUDE.md)；状态：[src/stores](../stores/CLAUDE.md)
