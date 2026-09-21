[根目录](../../CLAUDE.md) > [electron](../CLAUDE.md) > **db**

# electron/db/ — SQLite 数据层

**变更记录**
- 2026-09-21: messages 增至 `error`/`truncated`/`context` 三列并提供 `updateMessage`（失败态可重试、截断可续写、划选原文可重放）；`papers.file_hash`（SHA-256）用于重复导入检测；`exportAll` 补入 highlights/paper_indexes/paper_trees 且默认脱敏，新增 `data:export-file`（系统保存对话框）；`initDb()` 启动时合并历史高亮碎片
- 2026-09-15: 新增 `paper_trees` 表与 `treeApi`——轻量语义树的持久化（树 JSON + 原文证据块 JSON + schema/提示版本 + 建树模型 + 原文指纹 + token/时延），`exportAll`/`importAll` 同步纳入
- 2026-08-02T15:49:42: 新建文档——建表 SQL、各 api 命名空间、序列化约定、PageIndex 索引存储

## 模块职责

集中式本地数据层：建表、连接管理、以及所有实体的同步 CRUD API。所有函数直接操作 better-sqlite3，由 `electron/ipc.ts` 通过 IPC 暴露给渲染层。渲染层不感知 SQL，只调用 `window.db.*`。

## 入口与初始化

`electron/db/index.ts` 导出 `initDb()`（在 `main.ts` 的 `whenReady` 中先于 IPC 注册调用）：
1. 解析 `userData` 路径，`mkdirSync(papersDir)` 确保 `papers/` 存在
2. `new Database(papermind.db)` → `pragma('journal_mode = WAL')` → `pragma('foreign_keys = ON')` → `db.exec(SCHEMA)`
3. seed：`knowledge_bases` 为空时插入 id=`default`（「默认知识库」）
4. 迁移（均按 `PRAGMA table_info` 守卫，幂等）：为 highlights/messages/papers/paper_trees 补列（见「数据模型」），最后按 `planFragmentMerge` 合并历史高亮碎片（同论文 + 同页 + 同文本 + 链式 ≤2s 且偏移连通的一簇并为一条；含非空 note 的行整簇跳过不删）

模块级 `db` 与 `papersDir` 为闭包单例；各 api 对象直接引用。

## 建表 SQL（schema.ts）

`SCHEMA` 为单个多语句字符串，`CREATE TABLE IF NOT EXISTS`（幂等）：

| 表 | 主键 | 关键列 / 约束 |
|----|------|--------------|
| `knowledge_bases` | `id` | `name`、`color`（默认 `#3db8a0`）、`created_at` |
| `papers` | `id` | `knowledge_base_id` FK→kb（CASCADE）、`authors`/`tags` JSON、`status` 默认 `unread`、`file_path` 磁盘绝对路径、`file_hash`（SHA-256，重复导入检测） |
| `conversations` | `id` | `paper_ids` JSON、`created_at` |
| `messages` | `id` | `conversation_id` FK→conv（CASCADE）、`sources` JSON、`error`（非空即失败轮，渲染失败卡）、`truncated`（finish_reason=length）、`context`（用户划选原文，重试/续写时重放）、`role`/`content`/`timestamp` |
| `highlights` | `id` | `paper_id` FK→paper（CASCADE）、`page_num`、`color`、`note` |
| `settings` | `key` | `value`（JSON 字符串，非空） |
| `paper_indexes` | `paper_id` | FK→paper（CASCADE）、`index_json`、`pages_json`、`created_at` |
| `paper_trees` | `paper_id` | FK→paper（CASCADE）、`tree_json`、`blocks_json`、`schema_version`、`prompt_version`、`build_model`、`source_hash`、`build_config_hash`、`input_tokens`、`output_tokens`、`build_latency_ms`、`created_at` |

索引：`idx_papers_kb`、`idx_messages_conv`、`idx_highlights_paper`。

## 对外 API（index.ts）

| 导出 | 方法 | 说明 |
|------|------|------|
| `kbApi` | `list / create / remove` | `remove` 会先 `unlinkSync` 该 KB 下所有论文 PDF |
| `paperApi` | `list / get / create / update / remove / readFile` | `create` 将 base64 `fileData` 写盘、仅存 `file_path`；`readFile` 读盘回 base64；`remove` 删盘 |
| `chatApi` | `listConversations / createConversation / updateConversation / removeConversation / addMessage / updateMessage` | `listConversations` 联表加载每个对话的 messages，`sources` 经 `normalizeSourceList` 归一为结构化数组、并补齐 `error`/`truncated`/`context` 三列；`updateMessage(id, patch)` 按补丁部分更新（`error`/`truncated` 用 `!== undefined` 判断，`''`/`false` 才能清掉旧态） |
| `highlightApi` | `listByPaper / create / remove` | 按 paper 查询 |
| `settingsApi` | `get / set` | `set` 用 `INSERT ... ON CONFLICT(key) DO UPDATE`；值 `JSON.stringify`，读时 `JSON.parse` |
| `indexApi` | `list / get / set` | PageIndex：`list` 返回已建索引的 `paper_id[]`；`get` 返回 `{ indexJson, pagesJson }`；`set` upsert |
| `treeApi` | `list / get / set / remove` | 轻量语义树：`list` 返回已建树的 `paper_id[]`，可传 `{ schemaVersion, buildConfigHash }` 只取当前构建配置下可复用的论文（只查 id，不把 `tree_json` 拖过 IPC）；`get` 经 `deserializeTree` 转 camelCase（去掉 `build_model` 等模型元数据外的列映射）；`set` upsert |
| （顶层） | `exportAll(opts) / clearAll` | 导出 kb + papers（含 base64 `fileData`）+ conversations + highlights + paper_indexes + paper_trees + settings；`settings` **默认脱敏**（`stripApiKeysFromSettings`：`llm_profiles[*].apiKey`、`huggingface_token`、遗留 `llm_config.apiKey` 清空），只有 `includeApiKey: true` 才原样；清空全部并重建默认 KB。IPC 侧 `data:export` 走默认脱敏，`data:export-file` 弹系统保存对话框后写盘 |

## 序列化约定

- **写入**：`authors`/`tags`/`paper_ids`/`sources` 由调用方或 api 内 `JSON.stringify` 存为 TEXT；`settings.value` 亦为 JSON 字符串
- **读取**：`deserializePaper` 将行的 snake_case 列映射为 camelCase 并 `JSON.parse` 数组字段；`chatApi.listConversations` 就地反序列化 `paper_ids`/`sources`
- **列名风格**：SQLite 用 snake_case，跨 IPC 后统一 camelCase（渲染层接口）

## 数据模型（关键点）

- PDF 二进制**不入库**，仅 `papers.file_path` 指向 `userData/papers/<id>.pdf`；`readFile` 按需读盘转 base64
- `paper_indexes.pages_json` 缓存逐页文本，`index_json` 缓存 `IndexNode` 树；`chat.ts` 的 `readPaperPages` 优先读此缓存，避免重复解析 PDF
- `exportAll` **含** highlights、paper_indexes 与 paper_trees（此前的「仅 kb/papers/conversations/settings」描述已过时）；`papers.fileData` 为磁盘 PDF 的 base64，缺失文件时该字段为 `null`
- `data:export-file`（`electron/ipc.ts`）弹 `dialog.showSaveDialog`，默认路径 `下载目录/papermind-backup-<日期>.json`，返回 `{ canceled, filePath }`；文件内容即 `exportAll({ includeApiKey })`
- `papers.file_hash` 存文件内容 SHA-256（十六进制），重复导入检测的判据；旧行迁移后为空串（空则不参与查重）
- `messages.error/truncated/context` 由渲染层写入：`error` 非空即失败轮（可重试），`truncated` 标记被长度上限截断（可续写），`context` 保存划选原文（重试/续写按原上下文重放，不退回检索）
- `paper_trees.source_hash` 是原文指纹（FNV-1a），`build_config_hash` 是建树配置指纹（schema / 提示词 / 模型端点 / 分块与输入上限）。两者共同构成缓存键：只比原文会让提示词或模型的更新永远不生效（方案 §10.3）。`initDb()` 按 `PRAGMA table_info` 守卫 `ALTER TABLE` 补列，旧记录留空串——空串不等于任何真实指纹，那些树会被当作过期并在下次建树时重建，无需回填

## 相关文件

- `electron/db/schema.ts` — `SCHEMA` 建表字符串
- `electron/db/index.ts` — `initDb` + 全部 api 对象 + `exportAll`/`clearAll`
- `src/utils/semanticTree.ts` / `src/utils/evidenceBlock.ts` — `tree_json` / `blocks_json` 的结构定义
- `src/utils/sourceRef.ts` — `normalizeSourceList`（读取 messages.sources 时归一旧字符串数组）
- `src/utils/highlightMerge.ts` — `planFragmentMerge`（启动时历史高亮碎片的合并计划）
- `src/utils/exportSanitize.ts` — `stripApiKeysFromSettings` / `backupFileName`（导出脱敏与默认文件名）
- 调用方：`electron/ipc.ts`（channel 映射）、`electron/preload.ts`（`window.db`）

## 常见问题

**Q: 为什么用同步 better-sqlite3？**
Electron 主进程单实例、数据量小，同步 API 更简单且无回调地狱；IPC 层用 `ipcMain.handle` 已提供异步边界。

**Q: 新增一张表要改哪些地方？**
`schema.ts` 加 `CREATE TABLE` → `index.ts` 加 api 对象 → `ipc.ts` 注册 channel → `preload.ts` 暴露 → `src/types/db.d.ts` 补类型 → 调用方 store。
