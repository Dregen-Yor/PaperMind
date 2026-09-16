[根目录](../../CLAUDE.md) > [src/](../) > **views/**

# src/views/ — 页面视图模块

**变更记录**
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
- 知识库 Tab（含删除按钮，`default` 不可删）；卡片网格展示论文，含状态 pill（未读/阅读中/已完成）、作者、摘要截断、年份、标签、操作下拉（移动/标记完成/删除）
- **批量导入**：`<input type=file multiple>` → 逐个 `parsePdfMeta` → `store.addPaper`，右下角 **导入进度面板**（`ImportItem` 状态机 `pending→parsing→saving→done|error`，含进度条与逐项阶段/错误）
- 导入成功后**后台** `chatStore.indexPaper(id).catch(()=>{})` 预建 PageIndex，不阻塞
- 当 `profiles.length > 1` 时，顶栏显示「索引模型」选择器（`setIndexProfileId`）
- 新建知识库 Dialog（名称/描述/7 色选择）

### ReaderView — 阅读器（`/library/:id`）
- 左 `PdfViewer` 右 `ChatPanel`，中间 `resizer` 拖拽调宽（25%–75%，`splitRatio` 默认 58）
- `onMounted` 读 PDF base64 → `base64ToUrl`；`status==='unread'` 自动置 `reading`
- 顶部对话下拉 + 新建；无关联对话时自动 `createConv`
- `PdfViewer` 的 `@select-text` → 若无活动对话先建，再 `chatPanelRef.addContext(text)`
- `onBeforeUnmount` `revokeObjectURL` 释放 Blob URL

### ChatView — 多论文对话
- 三栏：左（KB 选择 + 论文多选列表 + 历史对话）、中（`ChatPanel`）、右（`ParamPanel`，可收起，收起后右上角悬浮重开按钮）
- 论文列表每项显示**索引状态**：已建（`CircleCheck`）/ 构建中（`Loading` 旋转）/ 未建（`Download` 按钮触发 `doIndex`）
- 勾选论文即 `syncPaperIds` 同步到当前对话；`startNewConv` 以选中论文创建对话

### SettingsView — 设置
- **LLM 配置列表**：每行显示名称/provider·model + 「对话」「索引」徽标，编辑/删除（≤1 时禁删）
- **新增/编辑 Dialog**：名称、provider（openai/anthropic/ollama）、model、baseUrl、apiKey（ollama 隐藏）、temperature/maxTokens/topK 滑块、系统提示词 + `PROMPT_TEMPLATES` 快填
- **默认使用配置**：对话 / 论文索引两个下拉（`setChatProfileId` / `setIndexProfileId`）
- **语义树检索**：`el-switch` 绑定 `treeEnabledLocal`，`@change` → `chatStore.setTreeEnabled`（方案 §8.2 要求有关闭开关）；旁注已建好语义树的论文数量（`treeReadyPapers.size`）；「重建全部语义树」按钮 → `ElMessageBox.confirm` → `chatStore.rebuildAllTrees()`，给缓存键覆盖不到的场景（就是想换一棵树）一条显式路径；提示按 `{ attempted, rebuilt, failed, skipped }` 分档——全失败报 `ElMessage.error`、部分失败报 `warning`、全跳过才报「没有可重建的论文」
- **论文摘要模型**：展示 `ABSTRACT_MODEL`，输入并保存 Hugging Face token（`setAbstractToken`）
- **数据管理**：导出 JSON 备份、清空数据（二次确认，reload）

## 相关文件

- `src/views/LibraryView.vue` / `ReaderView.vue` / `ChatView.vue` / `SettingsView.vue`
- 依赖组件：[src/components](../components/CLAUDE.md)；状态：[src/stores](../stores/CLAUDE.md)
