# PaperMind 复核清单修复施工方案（#1–#15 + 待定 B）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按复核结论修复 PaperMind 的 15 条界面/交互/数据持久化缺陷与「窄窗 PDF 适配」1 条，分三批交付，每任务一提交、全程 `typecheck` + 测试全绿。

**Architecture:** 沿用现有 Pinia store + IPC 四件套（`schema.ts` / `db/index.ts` / `preload.ts` / `types/db.d.ts`）分层。第 1 批先修全局确认框与问答失败/截断链路（chat store + messages 表扩展）；第 2 批做流式输出、结构化来源、导出脱敏、划选合并与命令本地处理；第 3 批清 P2 项与窄窗适配。不触碰检索/建树算法，不引入新依赖。

**Tech Stack:** Vue 3 `<script setup>` · Pinia · Element Plus 2.14 · Electron 44 + better-sqlite3 · Vitest（jsdom，`src/tests/setup.ts` 提供 `window.db` mock）

**Spec:** `~/Desktop/papermind_fixed_v1.md`（正文 15 条 + 文末「逐条审查结论与修复方案（2026-09-21 · 复核轮）」）。本方案中的 `#N` 与 `§N` 均指该文件的编号。

## Global Constraints

- 代码风格：两空格缩进、单引号、无分号、多行结构尾逗号；组件一律 `<script setup lang="ts">`（AGENTS.md）。
- 数据库 API 变更必须四处同步：`electron/db/schema.ts`、`electron/db/index.ts`、`electron/preload.ts`、`src/types/db.d.ts`。
- 每个任务收尾：`npm run typecheck` 与 `npm test` 全绿后才提交；提交信息用 Conventional Commits（`fix:`/`feat:`/`test:`）。
- 测试零真实网络：`global.fetch` 必须 mock；`window.db` 一律用 `src/tests/setup.ts` 的 `mockDb`（含 `globalThis.mockDb` 断言入口）。
- 不扩张范围：只改 Spec 条目涉及的行为；不顺手重构、不删无关代码。
- 用户可见文案使用中文；标点与既有文案一致。不新增 npm 依赖。

## Review Focus

Spec 隐含、任务测试需盯住的五类输入（每类的测试落在对应任务内）：

1. **流式回答中途失败**（已有 token 渲染到占位气泡）→ 必须移除占位气泡并落「可见失败态」，不得把半截回答静默写库或留半截气泡（T5 步骤 6）。
2. **旧库中的历史消息** `sources` 为字符串数组（升级前写入）→ 归一后渲染为不可点击的纯标签，不得崩溃（T6 步骤 1）。
3. **撤销窗口内关闭应用**（#11，5 秒未到期）→ 未到期的删除一律不执行（宁可不删，不可误删）（T12 设计约定 + 手测）。
4. **来源为空**（未建索引/检索无命中）→ `sources` 为空或 ref 无页码时，不得渲染任何可点击芯片（T6 步骤 5）。
5. **跨页划选**（#7）→ 每页合并为一条记录，不得把跨页片段错并到一个页号上（T8 步骤 1 + 手测）。

## 文件结构总览

| 文件 | 职责 | 任务 |
|---|---|---|
| `src/plugins/element.ts`（新建） | Element Plus 全局选项（zh-cn locale），main.ts 与测试共用 | T1 |
| `src/styles/global.css` | message box 宽度上限修复（一行） | T1 |
| `src/views/{LibraryView,ChatView,SettingsView}.vue` | 确认框文案带对象名 | T1 |
| `electron/db/{schema.ts,index.ts}` | messages 表 +2 列、迁移、addMessage/updateMessage/listConversations | T2/T6/T11 |
| `src/stores/chat.ts` | 失败态/重试、截断/继续、流式、来源结构化、命令处理、空对话清理、建树原因 | T2/T4/T5/T6/T9/T14/T16 |
| `src/components/ChatPanel.vue` | 失败卡、截断条、流式光标、芯片可点 | T3/T4/T5/T6/T9 |
| `src/components/PdfViewer.vue` | 划选合并、scrollToPage 加固 + 闪烁、ResizeObserver 适配 | T8/T6/T17 |
| `src/utils/{sourceRef,exportSanitize,highlightMerge}.ts`（新建） | 纯函数：来源归一、导出脱敏、片段合并 | T6/T7/T8 |
| `src/utils/{pdfUtils,libraryFilters}.ts` | SHA-256、作者截断 | T11/T10 |
| `src/views/ReaderView.vue` | 芯片跳页、`?page=` 路由参数、空对话清理 | T6/T16 |

**执行顺序**：严格按 Task 1 → 17 顺序执行（`chat.ts`/`ChatPanel.vue`/`LibraryView.vue` 被多个任务依次修改，跨任务接口在下文 Interfaces 中给全）。每批结束（T4 后、T9 后、T17 后）额外跑一次全量 `npm test`。

---

# 第 1 批（#4 → #2 → #3）

### Task 1 · #4 全局确认框：zh-cn 按钮 + 420px 居中 + 带对象名

**Files:**
- Create: `src/plugins/element.ts`
- Create: `src/tests/messageBoxLocale.test.ts`
- Modify: `src/main.ts`（`app.use(ElementPlus)` 一行）
- Modify: `src/styles/global.css:135`
- Modify: `src/views/LibraryView.vue`（`deletePaper`、`removeKb`）
- Modify: `src/views/ChatView.vue`（`delConv`）
- Modify: `src/views/SettingsView.vue`（`doRemove`）

**Interfaces:**
- Produces: `elementPlusOptions`（`{ locale: zhCn }`），T1 后所有组件调用 `ElMessageBox` 自动使用中文按钮。

- [ ] **Step 1: 建分支并跑基线**

```bash
git checkout -b fix/ui-db-review-v1
npm run typecheck && npm test
```

Expected: 全部 PASS（基线干净，任何失败先停下排查）。

- [ ] **Step 2: 写失败测试** `src/tests/messageBoxLocale.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { elementPlusOptions } from '../plugins/element'

describe('Element Plus 全局选项（#4）', () => {
  it('挂载 zh-cn locale，确认框按钮文案为中文', () => {
    expect(elementPlusOptions.locale.name).toBe('zh-cn')
    const messagebox = (elementPlusOptions.locale as any).el?.messagebox
    expect(messagebox?.confirm).toBe('确定')
    expect(messagebox?.cancel).toBe('取消')
  })
})
```

- [ ] **Step 3: 运行确认失败**

Run: `npx vitest run src/tests/messageBoxLocale.test.ts`
Expected: FAIL（`Cannot find module '../plugins/element'`）

- [ ] **Step 4: 创建插件模块与接线**

`src/plugins/element.ts`：

```ts
import zhCn from 'element-plus/es/locale/lang/zh-cn'

/** Element Plus 全局选项：main.ts 与测试共用同一份配置（#4）。 */
export const elementPlusOptions = { locale: zhCn }
```

`src/main.ts`：在 `import ElementPlus from 'element-plus'` 之后加

```ts
import { elementPlusOptions } from './plugins/element'
```

并把 `app.use(ElementPlus)` 改为：

```ts
app.use(ElementPlus, elementPlusOptions)
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run src/tests/messageBoxLocale.test.ts`
Expected: PASS

- [ ] **Step 6: 修 message box 宽度**（根因：EP 自身 `width:100%` + `max-width:420px` 被本行覆盖成整窗宽）

`src/styles/global.css:135`，把

```css
.el-message-box { max-width: calc(100vw - 32px); }
```

改为

```css
.el-message-box { max-width: min(var(--el-messagebox-width), calc(100vw - 32px)); }
```

- [ ] **Step 7: 确认框正文带对象名（四处）**

`src/views/LibraryView.vue`：模板里 `<el-dropdown-item divided @click="deletePaper(paper.id)">` 改为 `@click="deletePaper(paper)"`；函数改为（并补 `import type { Paper } from '../stores/paper'`，已有 `usePaperStore` 的 import 行一并加类型）：

```ts
async function deletePaper(paper: Paper) {
  await ElMessageBox.confirm(`确认删除《${paper.title || paper.fileName}》？`, '删除', { type: 'warning' })
  await store.removePaper(paper.id)
}
```

`src/views/LibraryView.vue` 的 `removeKb`：

```ts
async function removeKb(id: string) {
  const kb = store.knowledgeBases.find(k => k.id === id)
  await ElMessageBox.confirm(`删除知识库《${kb?.name ?? '未命名'}》会同时删除其中所有论文，确认继续？`, '删除知识库', { type: 'warning' })
  await store.removeKnowledgeBase(id)
  if (activeKbId.value === id) activeKbId.value = 'default'
}
```

`src/views/ChatView.vue` 的 `delConv`：

```ts
async function delConv(id: string) {
  const conv = chatStore.conversations.find(c => c.id === id)
  await ElMessageBox.confirm(`确认删除对话《${conv?.title ?? '未命名'}》？`, '删除', { type: 'warning' })
  await chatStore.removeConversation(id)
  if (activeConvId.value === id) activeConvId.value = ''
}
```

`src/views/SettingsView.vue` 的 `doRemove`（`profiles` 已由 `storeToRefs` 暴露）：

```ts
async function doRemove(id: string) {
  const profile = profiles.value.find(p => p.id === id)
  await ElMessageBox.confirm(`确认删除配置《${profile?.name ?? '未命名'}》？`, '删除配置', { type: 'warning' })
  await chatStore.removeProfile(id)
  chatProfileIdLocal.value = chatProfileId.value
  indexProfileIdLocal.value = indexProfileId.value
  ElMessage.success('已删除')
}
```

- [ ] **Step 8: 全量验证**

Run: `npm run typecheck && npm test`
Expected: 全部 PASS

- [ ] **Step 9: 手动验证（dev 实例）**

`npm run dev` 后依次打开：文档库→卡片菜单→删除（确认框应：约 420px 宽、水平居中、「取消/确定」、正文含论文名）；设置→重建全部语义树（中文按钮）；对话删除（含对话标题）。验证后取消所有对话框。

- [ ] **Step 10: 提交**

```bash
git add src/plugins/element.ts src/tests/messageBoxLocale.test.ts src/main.ts src/styles/global.css src/views/LibraryView.vue src/views/ChatView.vue src/views/SettingsView.vue
git commit -m "fix: localize confirm dialogs, center message box and name the target"
```

---

### Task 2 · #2 后端：空回答不落库 + 失败轮落「可重试失败态」

**Files:**
- Modify: `electron/db/schema.ts`（messages 表 +2 列）
- Modify: `electron/db/index.ts`（迁移、`addMessage`、`updateMessage`、`listConversations`）
- Modify: `electron/ipc.ts`（`chat:updateMessage`）
- Modify: `electron/preload.ts` + `src/types/db.d.ts`（`chat.updateMessage`）
- Modify: `src/tests/setup.ts`（mock 增补）
- Modify: `src/stores/chat.ts`（空校验、超时、`collectIndexedPapers`、`generateReply`、`recordFailure`、`retryMessage`、`updateMessage`、`sendMessage` 重构）
- Test: `src/tests/chat.failure.test.ts`（新建）

**Interfaces:**
- Consumes: `Message` 定义于 `src/stores/chat.ts`。
- Produces:
  - `Message` 新增 `error?: string`、`truncated?: boolean`
  - `store.updateMessage(convId: string, messageId: string, patch: { content?: string; sources?: string[]; error?: string; truncated?: boolean }): Promise<void>`
  - `store.retryMessage(convId: string, messageId: string): Promise<void>`
  - `store.collectIndexedPapers(conv: Conversation): Promise<{ papers: IndexedPaper[]; paperIds: string[] }>`
  - `window.db.chat.updateMessage(id, patch)`（T3/T4/T5 依赖以上全部）

- [ ] **Step 1: 写失败测试** `src/tests/chat.failure.test.ts`

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  default: {},
  GlobalWorkerOptions: { workerSrc: '' },
}))

import { useChatStore } from '../stores/chat'

const mockDb = () => (globalThis as any).mockDb
const llmOk = (content: string) => ({
  ok: true,
  json: () => Promise.resolve({ choices: [{ message: { content }, finish_reason: 'stop' }] }),
})
const llmEmpty = () => ({
  ok: true,
  json: () => Promise.resolve({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }),
})
const llm401 = () => ({
  ok: false, status: 401, statusText: 'Unauthorized',
  json: () => Promise.resolve({ error: { message: "You didn't provide an API key" } }),
})

describe('问答失败路径（#2）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockDb().chat.listConversations.mockResolvedValue([])
    mockDb().chat.addMessage.mockClear()
    mockDb().chat.updateMessage.mockClear()
    mockDb().settings.get.mockResolvedValue(null)
    mockDb().index.list.mockResolvedValue([])
  })

  it('空回答被拒：不写脏 content，而是落带 error 的失败轮', async () => {
    global.fetch = vi.fn().mockResolvedValue(llmEmpty()) as any
    const store = useChatStore()
    await store.init()
    const conv = await store.newConversation('t', [])

    await expect(store.sendMessage(conv.id, '你好')).rejects.toThrow('模型返回了空响应')

    const assistant = conv.messages.filter(m => m.role === 'assistant')
    expect(assistant).toHaveLength(1)
    expect(assistant[0].content).toBe('')
    expect(assistant[0].error).toBe('模型返回了空响应')
    const writes = mockDb().chat.addMessage.mock.calls.map((c: any[]) => c[0])
    expect(writes.some((m: any) => m.role === 'assistant' && m.content === '' && !m.error)).toBe(false)
  })

  it('401 失败轮可重试：重试成功后原地更新，不追加重复提问', async () => {
    global.fetch = vi.fn().mockResolvedValue(llm401()) as any
    const store = useChatStore()
    await store.init()
    const conv = await store.newConversation('t', [])

    await expect(store.sendMessage(conv.id, '介绍一下')).rejects.toThrow('LLM 请求失败 (401)')
    const failed = conv.messages.find(m => m.role === 'assistant')!
    expect(failed.error).toContain('LLM 请求失败 (401)')

    global.fetch = vi.fn().mockResolvedValue(llmOk('最终回答')) as any
    await store.retryMessage(conv.id, failed.id)

    expect(failed.content).toBe('最终回答')
    expect(failed.error).toBe('')
    expect(conv.messages.filter(m => m.role === 'user')).toHaveLength(1)
    const lastUpdate = mockDb().chat.updateMessage.mock.calls.at(-1)!
    expect(lastUpdate[0]).toBe(failed.id)
    expect(lastUpdate[1].content).toBe('最终回答')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/tests/chat.failure.test.ts`
Expected: FAIL（`mockDb().chat.updateMessage` 不存在 / `Message.error` 未定义）

- [ ] **Step 3: 数据库四件套**

`electron/db/schema.ts` messages 表加两列（`sources` 行之后、`timestamp` 行之前）：

```sql
  error       TEXT DEFAULT '',          -- 失败态标记：非空即渲染失败卡（#2）
  truncated   INTEGER DEFAULT 0,        -- finish_reason=length 截断标记（#3）
```

`electron/db/index.ts` `initDb()` 里（highlights 迁移块之后）：

```ts
  // 消息失败/截断标记（#2/#3，2026-09-21）
  const messageCols = (db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map(c => c.name)
  if (!messageCols.includes('error')) db.exec("ALTER TABLE messages ADD COLUMN error TEXT DEFAULT ''")
  if (!messageCols.includes('truncated')) db.exec('ALTER TABLE messages ADD COLUMN truncated INTEGER DEFAULT 0')
```

`electron/db/index.ts` `chatApi`：`listConversations` 的 messages 映射改为

```ts
      messages: (db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC').all(c.id) as any[])
        .map(m => ({ id: m.id, role: m.role, content: m.content, sources: JSON.parse(m.sources), timestamp: m.timestamp, error: m.error ?? '', truncated: !!m.truncated })),
```

`addMessage` 改为

```ts
  addMessage: (msg: { id: string; conversationId: string; role: string; content: string; sources: string[]; timestamp: number; error?: string; truncated?: boolean }) => {
    db.prepare('INSERT INTO messages (id, conversation_id, role, content, sources, error, truncated, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(msg.id, msg.conversationId, msg.role, msg.content, JSON.stringify(msg.sources), msg.error ?? '', msg.truncated ? 1 : 0, msg.timestamp)
  },
```

新增 `updateMessage`（放在 `addMessage` 之后）：

```ts
  updateMessage: (id: string, patch: { content?: string; sources?: string[]; error?: string; truncated?: boolean }) => {
    const cur = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as any
    if (!cur) return
    db.prepare('UPDATE messages SET content = ?, sources = ?, error = ?, truncated = ? WHERE id = ?')
      .run(
        patch.content ?? cur.content,
        patch.sources !== undefined ? JSON.stringify(patch.sources) : cur.sources,
        patch.error !== undefined ? patch.error : (cur.error ?? ''),
        patch.truncated !== undefined ? (patch.truncated ? 1 : 0) : (cur.truncated ?? 0),
        id,
      )
  },
```

注意：`error` 的清空必须用 `patch.error !== undefined` 判断（`??` 会把 `''` 当缺省，清不掉失败态）。

- [ ] **Step 4: IPC / preload / 类型 / 测试 mock 同步**

`electron/ipc.ts` 的 handlers 里（`'chat:addMessage'` 之后）加：

```ts
    'chat:updateMessage': (_e, id, patch) => chatApi.updateMessage(id, patch),
```

`electron/preload.ts` 的 `chat` 里加：

```ts
    updateMessage: (id: string, patch: unknown) => ipcRenderer.invoke('chat:updateMessage', id, patch),
```

`src/types/db.d.ts` 的 `chat` 里加：

```ts
    updateMessage: (id: string, patch: any) => Promise<void>
```

`src/tests/setup.ts` 的 `chat` mock 里加：

```ts
    updateMessage: vi.fn().mockResolvedValue(undefined),
```

- [ ] **Step 5: store 改造** `src/stores/chat.ts`

顶部常量（放在 `DEFAULT_PROFILE` 上方）：

```ts
/** 单次 LLM 请求上限：超时即失败，避免无声挂死（#2）。 */
const LLM_REQUEST_TIMEOUT_MS = 120_000
```

`Message` 接口加两个可选字段：

```ts
export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  sources?: string[]
  timestamp: number
  /** 非空表示这一轮失败，渲染失败卡（#2） */
  error?: string
  /** finish_reason=length：回答被截断（#3） */
  truncated?: boolean
}
```

`callLLM` 三处 fetch 都加超时与空校验：

1. ollama 分支：`fetch(...)` 的 init 加 `signal: AbortSignal.timeout(LLM_REQUEST_TIMEOUT_MS)`；把
   `if (typeof data.message?.content !== 'string') throw new Error('Ollama 未返回有效响应')`
   替换为
   `if (typeof data.message?.content !== 'string' || !data.message.content.trim()) throw new Error('模型返回了空响应')`
2. anthropic 分支：同样加 `signal`；把
   `if (typeof content !== 'string') throw new Error('Anthropic 未返回有效响应')`
   替换为
   `if (typeof content !== 'string' || !content.trim()) throw new Error('模型返回了空响应')`
3. openai 分支：同样加 `signal`；把
   `if (typeof content !== 'string') throw new Error('LLM 未返回有效响应')`
   替换为
   `if (typeof content !== 'string' || !content.trim()) throw new Error('模型返回了空响应')`

`addMessage` 改造（拒绝无 error 标记的空回答）：

```ts
  async function addMessage(
    convId: string,
    role: 'user' | 'assistant',
    content: string,
    sources?: string[],
    extra?: { error?: string; truncated?: boolean },
  ) {
    const conv = conversations.value.find(c => c.id === convId)
    if (!conv) return
    if (role === 'assistant' && !content.trim() && !extra?.error) throw new Error('拒绝写入空回答')
    const msg: Message = { id: crypto.randomUUID(), role, content, sources, timestamp: Date.now(), ...extra }
    conv.messages.push(msg)
    await window.db.chat.addMessage({
      id: msg.id, conversationId: convId, role, content,
      sources: sources ?? [], timestamp: msg.timestamp,
      error: extra?.error, truncated: extra?.truncated,
    })
  }
```

新增 `updateMessage`（放在 `addMessage` 之后）：

```ts
  async function updateMessage(
    convId: string,
    messageId: string,
    patch: { content?: string; sources?: string[]; error?: string; truncated?: boolean },
  ) {
    const conv = conversations.value.find(c => c.id === convId)
    const msg = conv?.messages.find(m => m.id === messageId)
    if (!conv || !msg) return
    Object.assign(msg, patch)
    await window.db.chat.updateMessage(messageId, patch)
  }
```

把原 `sendMessage` 拆成四个函数（`collectIndexedPapers` / `recordFailure` / `generateReply` / `sendMessage`），完整替换原 `sendMessage`（`chat.ts` 原 658-708 行）：

```ts
  async function collectIndexedPapers(conv: Conversation): Promise<{ papers: IndexedPaper[]; paperIds: string[] }> {
    const papers: IndexedPaper[] = []
    const paperIds: string[] = []
    for (const paperId of conv.paperIds) {
      let stored = await window.db.index.get(paperId)
      // 兜底：导入时后台预处理未完成（LLM未配置等），首次对话时按需构建
      if (!stored) {
        try {
          await indexPaper(paperId)
          stored = await window.db.index.get(paperId)
        } catch { /* ignore — no index available for this paper */ }
      }
      if (!stored) continue
      const semantic = await loadSemanticIndex(paperId)
      papers.push({
        tree: JSON.parse(stored.indexJson),
        pages: JSON.parse(stored.pagesJson),
        ...(semantic ? { semantic } : {}),
      })
      paperIds.push(paperId)
    }
    return { papers, paperIds }
  }

  function errorMessageOf(error: unknown): string {
    return error instanceof Error ? error.message : '未知错误'
  }

  async function recordFailure(convId: string, error: unknown) {
    await addMessage(convId, 'assistant', '', undefined, { error: errorMessageOf(error) })
  }

  async function generateReply(conv: Conversation, userMessage: string, context?: string, historyEnd?: number) {
    let papers: IndexedPaper[] = []
    if (!context && conv.paperIds.length > 0) {
      papers = (await collectIndexedPapers(conv)).papers
    }
    // 历史不含当前提问：默认排除最后一条（刚追加的用户消息）；重试时由调用方给 historyEnd
    const history = conv.messages.slice(0, historyEnd ?? -1).map(m => ({ role: m.role, content: m.content }))
    const { answer, sources } = await runRagPipeline(
      papers,
      userMessage,
      history,
      (prompt: string) => callLLM([{ role: 'user', content: prompt }]),
      callLLM,
      chatProfile.value.systemPrompt,
      { externalContext: context },
    )
    await addMessage(conv.id, 'assistant', answer, sources.length ? sources : undefined)
  }

  async function sendMessage(convId: string, userMessage: string, context?: string): Promise<string> {
    const conv = conversations.value.find(c => c.id === convId)
    if (!conv) throw new Error('Conversation not found')

    await addMessage(convId, 'user', userMessage)

    try {
      if (userMessage.trim().toLowerCase() === '/abstract') {
        const result = await generateAbstract(conv)
        await addMessage(convId, 'assistant', result.content, result.sources)
        return result.content
      }
      await generateReply(conv, userMessage, context)
      return conv.messages[conv.messages.length - 1].content
    } catch (error) {
      await recordFailure(convId, error)
      throw error
    }
  }

  async function retryMessage(convId: string, messageId: string): Promise<void> {
    const conv = conversations.value.find(c => c.id === convId)
    const index = conv ? conv.messages.findIndex(m => m.id === messageId) : -1
    if (!conv || index === -1) return
    const target = conv.messages[index]
    const userMessage = [...conv.messages.slice(0, index)].reverse().find(m => m.role === 'user')
    if (!userMessage) return

    await updateMessage(convId, messageId, { error: '' })
    try {
      if (userMessage.content.trim().toLowerCase() === '/abstract') {
        const result = await generateAbstract(conv)
        await updateMessage(convId, messageId, { content: result.content, sources: result.sources })
        return
      }
      const papers = conv.paperIds.length > 0 ? (await collectIndexedPapers(conv)).papers : []
      const history = conv.messages.slice(0, index).map(m => ({ role: m.role, content: m.content }))
      const result = await runRagPipeline(
        papers,
        userMessage.content,
        history,
        (prompt: string) => callLLM([{ role: 'user', content: prompt }]),
        callLLM,
        chatProfile.value.systemPrompt,
      )
      await updateMessage(convId, messageId, {
        content: result.answer,
        sources: result.sources.length ? result.sources : undefined,
      })
    } catch (error) {
      await updateMessage(convId, messageId, { error: errorMessageOf(error) })
      throw error
    }
  }
```

注意：`retryMessage` 的其余部分（`updateMessage(error:'')` 开头、`/abstract` 分支、catch 里写 error）保持 T2 的实现，仅按上文新增 `sources` 与 `truncated` 字段。

在 store 的 return 里补导出：`updateMessage`、`retryMessage`、`collectIndexedPapers`（加进现有 return 对象）。

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run src/tests/chat.failure.test.ts`
Expected: PASS

- [ ] **Step 7: 全量验证**

Run: `npm run typecheck && npm test`
Expected: 全部 PASS（重点看 `chat.store.test.ts`、`semanticTreeStore.test.ts` 历史用例不回归）

- [ ] **Step 8: 提交**

```bash
git add electron/db/schema.ts electron/db/index.ts electron/ipc.ts electron/preload.ts src/types/db.d.ts src/tests/setup.ts src/stores/chat.ts src/tests/chat.failure.test.ts
git commit -m "fix: reject empty answers and persist failed turns as retryable error state"
```

### Task 3 · #2 前端：气泡级失败卡（重试 / 打开设置），去掉误导 toast

**Files:**
- Modify: `src/components/ChatPanel.vue`（模板 + `send` 的 catch + 样式）
- Test: `src/tests/chatPanel.failure.test.ts`（新建）

**Interfaces:**
- Consumes: T2 的 `Message.error`、`store.retryMessage(convId, messageId)`。
- Produces: ChatPanel 无新增对外 API；失败交互由 `msg.error` 驱动。

- [ ] **Step 1: 写失败测试** `src/tests/chatPanel.failure.test.ts`

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import ElementPlus from 'element-plus'
import ChatPanel from '../components/ChatPanel.vue'
import { useChatStore, type Conversation } from '../stores/chat'

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ default: {}, GlobalWorkerOptions: { workerSrc: '' } }))

let wrapper: VueWrapper | undefined
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.restoreAllMocks() })

const failedConv = (): Conversation => ({
  id: 'c1', title: 't', paperIds: [], createdAt: 0,
  messages: [
    { id: 'm1', role: 'user', content: '你好', timestamp: 1 },
    { id: 'm2', role: 'assistant', content: '', timestamp: 2, error: 'LLM 请求失败 (401)：缺少 API Key' },
  ],
})

describe('ChatPanel 失败卡（#2）', () => {
  it('渲染失败卡，重试调用 store，跳转按钮进设置', async () => {
    const pinia = createPinia()
    const chatStore = useChatStore(pinia)
    const retry = vi.spyOn(chatStore, 'retryMessage').mockResolvedValue()
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', component: { template: '<div />' } },
        { path: '/settings', component: { template: '<div />' } },
      ],
    })
    await router.push('/')
    wrapper = mount(ChatPanel, {
      props: { conversation: failedConv() },
      global: { plugins: [pinia, router, ElementPlus] },
    })

    const card = wrapper.find('.msg-error')
    expect(card.exists()).toBe(true)
    expect(card.text()).toContain('LLM 请求失败 (401)')

    await wrapper.findAll('button').find(b => b.text() === '重试')!.trigger('click')
    await flushPromises()
    expect(retry).toHaveBeenCalledWith('c1', 'm2')

    await wrapper.findAll('button').find(b => b.text() === '打开设置')!.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/settings')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/tests/chatPanel.failure.test.ts`
Expected: FAIL（`.msg-error` 不存在）

- [ ] **Step 3: 模板与脚本改造**

`src/components/ChatPanel.vue` 消息循环内，把

```html
          <div class="msg-content" v-html="renderMarkdown(msg.content)" />
```

替换为

```html
          <div v-if="msg.content" class="msg-content" v-html="renderMarkdown(msg.content)" />
          <div v-if="msg.error" class="msg-error" role="alert">
            <div class="msg-error-text">{{ msg.error }}</div>
            <div class="msg-error-actions">
              <el-button size="small" :loading="retrying === msg.id" @click="retry(msg)">重试</el-button>
              <el-button size="small" text @click="router.push('/settings')">打开设置</el-button>
            </div>
          </div>
```

script 增加：

```ts
import { useRouter } from 'vue-router'
```

在 `const chatStore = useChatStore()` 之后：

```ts
const router = useRouter()
const retrying = ref('')
```

在 `send()` 之前加：

```ts
async function retry(msg: { id: string }) {
  if (retrying.value || !props.conversation) return
  retrying.value = msg.id
  try {
    await chatStore.retryMessage(props.conversation.id, msg.id)
  } finally {
    retrying.value = ''
  }
}
```

`send()` 的 catch 改为只收尾（失败已由 store 落成失败卡，不再弹误导性 toast）：

```ts
  } catch {
    // 失败已由 store 落成气泡级失败态（msg.error）；这里只负责 loading 收尾
  } finally {
    loading.value = false
    await scrollToBottom()
  }
```

- [ ] **Step 4: 样式**（加在 `.msg-content` 规则之后）

```css
.msg-error { margin-top: 10px; padding: 10px 12px; border: 1px solid var(--danger-dim); border-radius: 8px; background: var(--danger-dim); }
.msg-error-text { font-size: 12px; line-height: 1.7; color: var(--danger); overflow-wrap: anywhere; }
.msg-error-actions { display: flex; gap: 8px; margin-top: 8px; }
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run src/tests/chatPanel.failure.test.ts`
Expected: PASS

- [ ] **Step 6: 全量验证**

Run: `npm run typecheck && npm test`
Expected: 全部 PASS（`reader.view.test.ts` 不受影响：ChatPanel 新增 `useRouter` 依赖，该测试已提供 router 插件）

- [ ] **Step 7: 提交**

```bash
git add src/components/ChatPanel.vue src/tests/chatPanel.failure.test.ts
git commit -m "fix: render failed turns as in-conversation retryable error cards"
```

---

### Task 4 · #3 截断：finish_reason 捕获 + 截断标记 + 「继续」

**Files:**
- Modify: `src/stores/chat.ts`（`requestCompletion` 重构、`generateReply`/`retryMessage` 记录截断、`continueMessage`、默认 maxTokens）
- Modify: `src/components/ChatPanel.vue`（截断条 + 继续按钮）
- Modify: `src/components/ParamPanel.vue`（maxTokens 滑杆）
- Modify: `src/views/SettingsView.vue`（`EMPTY_FORM` 默认 4096）
- Test: `src/tests/chat.truncation.test.ts`（新建）

**Interfaces:**
- Produces:
  - `store.requestCompletion(messages, profileOrId?, opts?): Promise<{ content: string; truncated: boolean }>`（T5 在此基础上加 `onToken` 流式）
  - `store.continueMessage(convId: string, messageId: string): Promise<void>`
  - `Message.truncated` 由生成路径写入

- [ ] **Step 1: 写失败测试** `src/tests/chat.truncation.test.ts`

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ default: {}, GlobalWorkerOptions: { workerSrc: '' } }))

import { useChatStore } from '../stores/chat'

const mockDb = () => (globalThis as any).mockDb
const llm = (content: string, finishReason = 'stop') => ({
  ok: true,
  json: () => Promise.resolve({ choices: [{ message: { content }, finish_reason: finishReason }] }),
})

describe('截断与继续（#3）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockDb().chat.listConversations.mockResolvedValue([])
    mockDb().chat.addMessage.mockClear()
    mockDb().chat.updateMessage.mockClear()
    mockDb().settings.get.mockResolvedValue(null)
    mockDb().index.list.mockResolvedValue([])
  })

  it('finish_reason=length 标记 truncated 并落库', async () => {
    global.fetch = vi.fn().mockResolvedValue(llm('半截回答', 'length')) as any
    const store = useChatStore()
    await store.init()
    const conv = await store.newConversation('t', [])
    await store.sendMessage(conv.id, '问题')

    const assistant = conv.messages.find(m => m.role === 'assistant')!
    expect(assistant.truncated).toBe(true)
    const writes = mockDb().chat.addMessage.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m.role === 'assistant')
    expect(writes[0].truncated).toBe(true)
  })

  it('continueMessage 把续写追加到原回答并清除截断标记', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(llm('续写用查询'))     // 历史 ≥2 轮会触发查询改写
      .mockResolvedValueOnce(llm('，这是续写部分。'))
    const store = useChatStore()
    await store.init()
    const conv = await store.newConversation('t', [])
    conv.messages.push(
      { id: 'u1', role: 'user', content: '问题', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: '半截回答', timestamp: 2, truncated: true },
    )
    await store.continueMessage(conv.id, 'a1')

    expect(conv.messages[1].content).toBe('半截回答，这是续写部分。')
    expect(conv.messages[1].truncated).toBe(false)
    const last = mockDb().chat.updateMessage.mock.calls.at(-1)!
    expect(last[0]).toBe('a1')
    expect(last[1].content).toBe('半截回答，这是续写部分。')
  })

  it('默认 maxTokens 已提升到 4096', async () => {
    const store = useChatStore()
    await store.init()
    expect(store.profiles[0].maxTokens).toBe(4096)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/tests/chat.truncation.test.ts`
Expected: FAIL（`store.continueMessage` 不存在 / maxTokens 为 2048）

- [ ] **Step 3: `requestCompletion` 重构** `src/stores/chat.ts`

把现有 `callLLM` 的函数体整体改名为 `requestCompletion`，并按 provider 三个 return 处替换返回：

- ollama 分支结尾（原 `return data.message.content`）：

```ts
      return { content: data.message.content, truncated: data.done_reason === 'length' }
```

- anthropic 分支结尾（原 `return content`）：

```ts
      return { content, truncated: data.stop_reason === 'max_tokens' }
```

- openai 分支结尾（原 `return content`）：

```ts
    return { content, truncated: data.choices?.[0]?.finish_reason === 'length' }
```

新签名与 `callLLM` 薄包装：

```ts
  /** 单次对话补全的底层请求：记录 finish_reason 供截断提示使用（#3）。 */
  async function requestCompletion(
    messages: { role: string; content: string }[],
    profileOrId?: string | LLMProfile,
    opts: { onToken?: (token: string) => void } = {},
  ): Promise<{ content: string; truncated: boolean }> {
    // （原 callLLM 函数体；opts 在 T5 使用，本任务先保留形参）
  }

  async function callLLM(messages: { role: string; content: string }[], profileOrId?: string | LLMProfile): Promise<string> {
    return (await requestCompletion(messages, profileOrId)).content
  }
```

- [ ] **Step 4: 生成路径记录截断 + `continueMessage`**

`generateReply` 的生成回调改为捕获截断（保留 T2 的检索结构）：

```ts
    let lastTruncated = false
    const generate = async (msgs: { role: string; content: string }[]) => {
      const outcome = await requestCompletion(msgs)
      lastTruncated = outcome.truncated
      return outcome.content
    }
    const { answer, sources } = await runRagPipeline(
      papers, userMessage, history,
      (prompt: string) => callLLM([{ role: 'user', content: prompt }]),
      generate,
      chatProfile.value.systemPrompt,
      { externalContext: context },
    )
    await addMessage(conv.id, 'assistant', answer, sources.length ? sources : undefined, { truncated: lastTruncated })
```

`retryMessage` 同样记录截断（把其中的 `runRagPipeline(...)` 的 generate 参数替换为上面的 `generate` 包装，并在 `updateMessage(..., { content: answer, sources })` 中带上 `truncated: lastTruncated`）。

新增 `continueMessage`（放在 `retryMessage` 之后）：

```ts
  /** 「继续」：对截断的回答就地续写（#3）。检索按原问题重跑，生成时把已输出部分作为上文。 */
  async function continueMessage(convId: string, messageId: string): Promise<void> {
    const conv = conversations.value.find(c => c.id === convId)
    const index = conv ? conv.messages.findIndex(m => m.id === messageId) : -1
    if (!conv || index === -1) return
    const target = conv.messages[index]
    const userMessage = [...conv.messages.slice(0, index)].reverse().find(m => m.role === 'user')
    if (!userMessage) return

    const papers = conv.paperIds.length > 0 ? (await collectIndexedPapers(conv)).papers : []
    const history = conv.messages.slice(0, index).map(m => ({ role: m.role, content: m.content }))
    const retrieval = await retrieveRagContext(
      papers,
      userMessage.content,
      history,
      (prompt: string) => callLLM([{ role: 'user', content: prompt }]),
    )
    const messages = buildAnswerMessages(
      retrieval.context,
      '请接着上一条回答继续输出，从中断处直接续写，不要重复已经输出过的内容。',
      [...history, { role: 'assistant' as const, content: target.content }],
      chatProfile.value.systemPrompt,
    )
    const outcome = await requestCompletion(messages)
    await updateMessage(convId, messageId, {
      content: target.content + outcome.content,
      truncated: outcome.truncated,
    })
  }
```

import 行同步（`src/stores/chat.ts` 顶部 ragPipeline 的 import）：

```ts
import { runRagPipeline, retrieveRagContext, buildAnswerMessages, type IndexedPaper, type SemanticPaperIndex } from '../utils/ragPipeline'
```

store 的 return 补 `continueMessage`。

- [ ] **Step 5: 默认值与 ParamPanel**

`src/stores/chat.ts` `DEFAULT_PROFILE.maxTokens`：`2048` → `4096`。
`src/views/SettingsView.vue` `EMPTY_FORM()` 的 `maxTokens: 2048` → `maxTokens: 4096`。

`src/components/ParamPanel.vue` 在 Top-K 区块之后加：

```html
      <!-- 回答长度上限 -->
      <div class="param-section">
        <label>
          回答长度上限（Max Tokens）
          <span class="val tabular-nums">{{ chatProfile?.maxTokens ?? 4096 }}</span>
        </label>
        <el-slider
          :model-value="chatProfile?.maxTokens ?? 4096"
          @update:model-value="updateCurrent('maxTokens', $event)"
          :min="256" :max="8192" :step="256"
        />
        <p class="hint">长回答（表格、推导）建议 ≥4096</p>
      </div>
```

并把 `updateCurrent` 的类型改为：

```ts
function updateCurrent(key: 'temperature' | 'topK' | 'maxTokens', value: number) {
```

- [ ] **Step 6: ChatPanel 截断条**

在失败卡之后（同一 `msg-body` 内）加：

```html
          <div v-if="msg.truncated && !msg.error" class="msg-truncated">
            <span>回答已达长度上限</span>
            <el-button size="small" text :loading="continuing === msg.id" @click="continueMsg(msg)">继续</el-button>
          </div>
```

script 加 `const continuing = ref('')` 与：

```ts
async function continueMsg(msg: { id: string }) {
  if (continuing.value || !props.conversation) return
  continuing.value = msg.id
  try {
    await chatStore.continueMessage(props.conversation.id, msg.id)
  } finally {
    continuing.value = ''
  }
}
```

样式：

```css
.msg-truncated { display: flex; align-items: center; gap: 8px; margin-top: 8px; font-size: 12px; color: var(--gold); }
```

- [ ] **Step 7: 运行测试确认通过**

Run: `npx vitest run src/tests/chat.truncation.test.ts`
Expected: PASS

- [ ] **Step 8: 全量验证**

Run: `npm run typecheck && npm test`
Expected: 全部 PASS

- [ ] **Step 9: 提交**

```bash
git add src/stores/chat.ts src/components/ChatPanel.vue src/components/ParamPanel.vue src/views/SettingsView.vue src/tests/chat.truncation.test.ts
git commit -m "feat: surface truncated answers with a continue action and raise default max tokens"
```

> 第 1 批完成。跑一次全量 `npm test`，并可选做一次 dev 手测（无 key 提问→失败卡；`/abstract` 无 token→失败卡文案只有一句）。

---

# 第 2 批（#6 → #1 → #5 → #7 → #8）

### Task 5 · #6 流式输出（生成阶段 SSE/NDJSON 增量）

**Files:**
- Modify: `src/stores/chat.ts`（模块级流解析器 ×3、`requestCompletion` 流式分支、`generateReply`/`retryMessage` 占位气泡、`Message.streaming`）
- Modify: `src/components/ChatPanel.vue`（typing 指示条件、流式光标、自动滚动）
- Test: `src/tests/chat.stream.test.ts`（新建）

**Interfaces:**
- Consumes: T4 的 `requestCompletion(messages, profileOrId?, opts)`。
- Produces: 生成阶段 `opts.onToken` 生效；`Message.streaming?: boolean`（仅内存态，不落库）。

- [ ] **Step 1: 写失败测试** `src/tests/chat.stream.test.ts`

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ default: {}, GlobalWorkerOptions: { workerSrc: '' } }))

import { useChatStore } from '../stores/chat'

const mockDb = () => (globalThis as any).mockDb
const sse = (chunks: string[], finishReason = 'stop') => {
  const body = chunks.map(c => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`).join('')
    + `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n\n`
    + 'data: [DONE]\n\n'
  return { ok: true, status: 200, body: new Response(body).body }
}

describe('流式输出（#6）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockDb().chat.listConversations.mockResolvedValue([])
    mockDb().chat.addMessage.mockClear()
    mockDb().chat.updateMessage.mockClear()
    mockDb().settings.get.mockResolvedValue(null)
    mockDb().index.list.mockResolvedValue([])
  })

  it('增量渲染并在结束时一次性落库，占位气泡不残留', async () => {
    global.fetch = vi.fn().mockResolvedValue(sse(['你好', '，世界'])) as any
    const store = useChatStore()
    await store.init()
    const conv = await store.newConversation('t', [])
    await store.sendMessage(conv.id, '打个招呼')

    const assistants = conv.messages.filter(m => m.role === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0].content).toBe('你好，世界')
    expect(assistants[0].streaming).toBeFalsy()
    const writes = mockDb().chat.addMessage.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m.role === 'assistant')
    expect(writes).toHaveLength(1)
    expect(writes[0].content).toBe('你好，世界')
  })

  it('流式中断：移除半截占位气泡并落失败态，不留半截内容', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: '半截' } }] })}\n\n`))
        controller.error(new Error('network down'))
      },
    })
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, body: stream }) as any
    const store = useChatStore()
    await store.init()
    const conv = await store.newConversation('t', [])

    await expect(store.sendMessage(conv.id, '问题')).rejects.toThrow()
    expect(conv.messages.some(m => m.content === '半截')).toBe(false)
    const assistant = conv.messages.find(m => m.role === 'assistant')!
    expect(assistant.content).toBe('')
    expect(assistant.error).toBeTruthy()
  })

  it('流末尾 finish_reason=length 标记截断', async () => {
    global.fetch = vi.fn().mockResolvedValue(sse(['半截'], 'length')) as any
    const store = useChatStore()
    await store.init()
    const conv = await store.newConversation('t', [])
    await store.sendMessage(conv.id, '问题')
    expect(conv.messages.find(m => m.role === 'assistant')!.truncated).toBe(true)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/tests/chat.stream.test.ts`
Expected: FAIL（非流式路径不解析 SSE：内容为 undefined/抛错）

- [ ] **Step 3: 模块级流解析器**（`src/stores/chat.ts`，放在 `PROMPT_TEMPLATES` 之后、`useChatStore` 之前）

```ts
/** 流式请求整体上限（#6）：流式回答比非流式长，给更宽的预算。 */
const LLM_STREAM_TIMEOUT_MS = 300_000

/** 解析 OpenAI 兼容 SSE 流：增量回调 + 末尾 finish_reason（#6）。 */
async function readOpenAiStream(res: Response, onToken: (token: string) => void): Promise<{ content: string; truncated: boolean }> {
  if (!res.body) throw new Error('流式响应不可用')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      let parsed: any
      try { parsed = JSON.parse(payload) } catch { continue }
      const delta = parsed.choices?.[0]?.delta?.content
      if (typeof delta === 'string' && delta) { content += delta; onToken(delta) }
      if (parsed.choices?.[0]?.finish_reason === 'length') truncated = true
    }
  }
  if (!content.trim()) throw new Error('模型返回了空响应')
  return { content, truncated }
}

/** 解析 Anthropic SSE 流（content_block_delta / message_delta）（#6）。 */
async function readAnthropicStream(res: Response, onToken: (token: string) => void): Promise<{ content: string; truncated: boolean }> {
  if (!res.body) throw new Error('流式响应不可用')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      let parsed: any
      try { parsed = JSON.parse(trimmed.slice(5).trim()) } catch { continue }
      if (parsed.type === 'content_block_delta' && typeof parsed.delta?.text === 'string') {
        content += parsed.delta.text
        onToken(parsed.delta.text)
      }
      if (parsed.type === 'message_delta' && parsed.delta?.stop_reason === 'max_tokens') truncated = true
    }
  }
  if (!content.trim()) throw new Error('模型返回了空响应')
  return { content, truncated }
}

/** 解析 Ollama NDJSON 流（#6）。 */
async function readOllamaStream(res: Response, onToken: (token: string) => void): Promise<{ content: string; truncated: boolean }> {
  if (!res.body) throw new Error('流式响应不可用')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let parsed: any
      try { parsed = JSON.parse(trimmed) } catch { continue }
      if (typeof parsed.message?.content === 'string' && parsed.message.content) {
        content += parsed.message.content
        onToken(parsed.message.content)
      }
      if (parsed.done && parsed.done_reason === 'length') truncated = true
    }
  }
  if (!content.trim()) throw new Error('模型返回了空响应')
  return { content, truncated }
}
```

- [ ] **Step 4: `requestCompletion` 接入流式分支**

三个 provider 的请求体都加 `stream` 开关、超时按流式切换、并按 `opts.onToken` 选择解析器：

- openai 分支：body 加 `...(opts.onToken ? { stream: true } : {})`；fetch 的 `signal` 改为 `AbortSignal.timeout(opts.onToken ? LLM_STREAM_TIMEOUT_MS : LLM_REQUEST_TIMEOUT_MS)`；`if (!res.ok) throw ...` 之后加：

```ts
    if (opts.onToken) return readOpenAiStream(res, opts.onToken)
```

- anthropic 分支：同上（`...(opts.onToken ? { stream: true } : {})`、signal 切换、ok 检查后 `if (opts.onToken) return readAnthropicStream(res, opts.onToken)`）。
- ollama 分支：body 的 `stream: false` 改为 `stream: !!opts.onToken`；同样 signal 切换；ok 检查后 `if (opts.onToken) return readOllamaStream(res, opts.onToken)`。

- [ ] **Step 5: 占位气泡（`generateReply` 与 `retryMessage`）**

`Message` 接口加：

```ts
  /** 流式渲染中的占位气泡标记（仅内存态，不落库）（#6） */
  streaming?: boolean
```

`generateReply` 的生成回调替换为（注意 `lastTruncated` 必须先声明）：

```ts
    let lastTruncated = false
    let placeholder: Message | undefined
    const generate = async (msgs: { role: string; content: string }[]) => {
      placeholder = { id: crypto.randomUUID(), role: 'assistant', content: '', timestamp: Date.now(), streaming: true }
      conv.messages.push(placeholder)
      try {
        const outcome = await requestCompletion(msgs, undefined, {
          onToken: token => { if (placeholder) placeholder.content += token },
        })
        lastTruncated = outcome.truncated
        return outcome.content
      } finally {
        // 无论成败都移除占位：成功走 addMessage 落库，失败由 sendMessage 落失败卡（半截内容不留）
        if (placeholder) {
          const at = conv.messages.indexOf(placeholder)
          if (at !== -1) conv.messages.splice(at, 1)
          placeholder = undefined
        }
      }
    }
```

`retryMessage`：流式直接写进目标消息（不新增占位）：

```ts
    await updateMessage(convId, messageId, { error: '', content: '' })
    target.streaming = true
    try {
      const result = await runRagPipeline(
        papers,
        userMessage.content,
        history,
        (prompt: string) => callLLM([{ role: 'user', content: prompt }]),
        async msgs => {
          const outcome = await requestCompletion(msgs, undefined, {
            onToken: token => { target.content += token },
          })
          lastTruncated = outcome.truncated
          return outcome.content
        },
        chatProfile.value.systemPrompt,
      )
      await updateMessage(convId, messageId, {
        content: result.answer,
        sources: result.sources.length ? result.sources : undefined,
        truncated: lastTruncated,
      })
    } catch (error) {
      // 半截内容不入库：清空后只留失败态（Review Focus #1）
      await updateMessage(convId, messageId, { content: '', error: errorMessageOf(error) })
      throw error
    } finally {
      target.streaming = false
    }
```

（`lastTruncated` 在 `retryMessage` 内同样先声明为 `let lastTruncated = false`。）

- [ ] **Step 6: ChatPanel 流式呈现**

- typing 指示器改为只在「没有流式气泡」时显示：`<div v-if="loading && !hasStreamingBubble" class="message assistant">`；script 加：

```ts
const hasStreamingBubble = computed(() => props.conversation?.messages.some(m => m.streaming) ?? false)
```

- 消息内容加流式光标类：`<div v-if="msg.content" class="msg-content" :class="{ 'is-streaming': msg.streaming }" v-html="renderMarkdown(msg.content)" />`
- 自动滚动（跟随流式增量）：

```ts
watch(() => props.conversation?.messages.at(-1)?.content.length ?? 0, () => {
  if (loading.value) scrollToBottom()
})
```

- 样式：

```css
.msg-content.is-streaming::after { content: '▍'; margin-left: 2px; color: var(--accent); animation: caret-blink 1s steps(2) infinite; }
@keyframes caret-blink { 50% { opacity: 0; } }
```

- [ ] **Step 7: 运行测试确认通过**

Run: `npx vitest run src/tests/chat.stream.test.ts && npx vitest run src/tests/chat.failure.test.ts src/tests/chat.truncation.test.ts`
Expected: 全部 PASS

- [ ] **Step 8: 全量验证 + 手测**

Run: `npm run typecheck && npm test`
手测（有 key 环境）：提问后正文应逐字出现、末尾有光标；「继续」后原气泡追加续写。

- [ ] **Step 9: 提交**

```bash
git add src/stores/chat.ts src/components/ChatPanel.vue src/tests/chat.stream.test.ts
git commit -m "feat: stream answer generation over SSE/NDJSON with placeholder bubble"
```

### Task 6 · #1 结构化来源 + 芯片跳页（含 `?page=` 与目标页闪烁）

**Files:**
- Create: `src/utils/sourceRef.ts`
- Create: `src/tests/sourceRef.test.ts`
- Create: `src/tests/sourceRefs.test.ts`（store 侧一致性断言）
- Create: `src/tests/chatPanel.sources.test.ts`（组件 emit）
- Modify: `electron/db/index.ts`（`listConversations` 来源归一）
- Modify: `src/stores/chat.ts`（`Message.sources` 类型、`generateReply`/`retryMessage` 构造 refs、`generateAbstract` 返回 refs）
- Modify: `src/components/ChatPanel.vue`（芯片可点 + emit）
- Modify: `src/views/ReaderView.vue`（`open-source` 处理 + `?page=`）
- Modify: `src/views/ChatView.vue`（`open-source` 处理）
- Modify: `src/components/PdfViewer.vue`（`scrollToPage` 加固 + 目标页闪烁）

**Interfaces:**
- Produces:
  - `SourceRef { label: string; paperId?: string; startPage?: number; endPage?: number }`
  - `normalizeSourceList(raw: unknown): SourceRef[]`、`isJumpable(ref: SourceRef): boolean`（`src/utils/sourceRef.ts`）
  - `Message.sources?: SourceRef[]`（T7 导出、T3/T5 的失败/流式路径不受影响）

- [ ] **Step 1: 写失败测试** `src/tests/sourceRef.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { normalizeSourceList, isJumpable } from '../utils/sourceRef'

describe('来源归一（#1）', () => {
  it('旧字符串数组 → 不可跳转的纯标签', () => {
    const refs = normalizeSourceList(['Pages 1–2: 老数据', 'Pages 3–3: x'])
    expect(refs).toEqual([{ label: 'Pages 1–2: 老数据' }, { label: 'Pages 3–3: x' }])
    expect(refs.every(r => !isJumpable(r))).toBe(true)
  })
  it('结构化对象保留 paperId 与页区间', () => {
    const refs = normalizeSourceList([{ label: 'Pages 11–15: R1', paperId: 'p1', startPage: 10, endPage: 14 }])
    expect(refs[0]).toEqual({ label: 'Pages 11–15: R1', paperId: 'p1', startPage: 10, endPage: 14 })
    expect(isJumpable(refs[0])).toBe(true)
  })
  it('脏输入被丢弃或降级，不崩溃', () => {
    expect(normalizeSourceList(null)).toEqual([])
    expect(normalizeSourceList([42, '', { paperId: 'x' }, { label: 'ok', startPage: 'nope' }]))
      .toEqual([{ label: 'ok' }])
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/tests/sourceRef.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 创建 `src/utils/sourceRef.ts`**

```ts
/** 结构化来源：芯片文案 + 跳转所需的论文与页区间（#1）。 */
export interface SourceRef {
  label: string
  paperId?: string
  startPage?: number
  endPage?: number
}

/** 把持久化的 sources 归一为 SourceRef[]：兼容旧的字符串数组与脏数据（#1）。 */
export function normalizeSourceList(raw: unknown): SourceRef[] {
  if (!Array.isArray(raw)) return []
  const refs: SourceRef[] = []
  for (const item of raw) {
    if (typeof item === 'string') {
      if (item) refs.push({ label: item })
      continue
    }
    if (item && typeof item === 'object' && typeof (item as any).label === 'string' && (item as any).label) {
      const { label, paperId, startPage, endPage } = item as any
      refs.push({
        label,
        ...(typeof paperId === 'string' ? { paperId } : {}),
        ...(typeof startPage === 'number' ? { startPage } : {}),
        ...(typeof endPage === 'number' ? { endPage } : {}),
      })
    }
  }
  return refs
}

/** 芯片是否可跳页。 */
export function isJumpable(ref: SourceRef): boolean {
  return typeof ref.paperId === 'string' && typeof ref.startPage === 'number'
}
```

- [ ] **Step 4: 数据库读取归一**

`electron/db/index.ts` 顶部加 `import { normalizeSourceList } from '../../src/utils/sourceRef'`；`listConversations` 的 messages 映射中 `sources` 改为：

```ts
        sources: normalizeSourceList(JSON.parse(m.sources)),
```

（写入端不拆：`addMessage` 仍 `JSON.stringify(msg.sources)`。）

- [ ] **Step 5: store 构造 refs**

`src/stores/chat.ts`：`Message.sources` 类型改为 `SourceRef[]`（`import type { SourceRef } from '../utils/sourceRef'`）；`addMessage` 的 `sources` 参数同理。

`generateReply` 中把 index 收集改为记住 paperIds，并构造 refs：

```ts
    let papers: IndexedPaper[] = []
    let indexedIds: string[] = []
    if (!context && conv.paperIds.length > 0) {
      const collected = await collectIndexedPapers(conv)
      papers = collected.papers
      indexedIds = collected.paperIds
    }
    // history 与 generate 回调保持 T5 实现不变（此处仅改 index 收集与来源构造）
    const sourceRefs: SourceRef[] = sources.length
      ? result.retrievals.flatMap((r, i) => r.sources.map((label, j) => {
          const node = r.selected[j]
          const paperId = indexedIds[i]
          return node && paperId
            ? { label, paperId, startPage: node.startPage, endPage: node.endPage }
            : { label }
        }))
      : []
    await addMessage(conv.id, 'assistant', answer, sourceRefs.length ? sourceRefs : undefined, { truncated: lastTruncated })
```

（`result.sources` 与 `result.retrievals[i].selected[j]` 一一对齐：`pageIndex.ts` 与 `semanticRoute.ts` 都是 `sources = selected.map(formatSource)`，已核对。）

`retryMessage` 的 `updateMessage(..., { content: result.answer, sources })` 改为先构造同样的 `sourceRefs`（用 `collected.paperIds`）再写入；无来源时传 `undefined`。

`generateAbstract` 返回结构化来源：

```ts
  async function generateAbstract(conv: Conversation): Promise<{ content: string; sources: SourceRef[] }> {
    ...
      sources.push({ label: title, paperId })
    ...
  }
```

（`/abstract` 的外链没有页码：ref 只有 `label` + `paperId`，`isJumpable` 为 false，芯片渲染为不可点标签——符合 Review Focus #4。）

- [ ] **Step 6: 写一致性测试** `src/tests/sourceRefs.test.ts`

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ default: {}, GlobalWorkerOptions: { workerSrc: '' } }))

import { useChatStore } from '../stores/chat'

const mockDb = () => (globalThis as any).mockDb
const llm = (content: string) => ({
  ok: true,
  json: () => Promise.resolve({ choices: [{ message: { content }, finish_reason: 'stop' }] }),
})
const INDEX_JSON = JSON.stringify({
  title: 'R', nodeId: 'root', startPage: 0, endPage: 3, summary: '',
  nodes: [
    { title: 'A', nodeId: '0', startPage: 0, endPage: 1, summary: 'a', nodes: [] },
    { title: 'B', nodeId: '1', startPage: 2, endPage: 3, summary: 'b', nodes: [] },
  ],
})

describe('来源芯片与跳转一致性（#1）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockDb().chat.listConversations.mockResolvedValue([])
    mockDb().chat.addMessage.mockClear()
    mockDb().settings.get.mockResolvedValue(null)
    mockDb().index.list.mockResolvedValue(['p1'])
    mockDb().index.get.mockResolvedValue({ indexJson: INDEX_JSON, pagesJson: JSON.stringify(['p0', 'p1', 'p2', 'p3']) })
  })

  it('芯片文本页区间与 startPage 一致，且带 paperId', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(llm('[{"id":0,"score":9},{"id":1,"score":2}]')) // 打分
      .mockResolvedValueOnce(llm('答案')) // 生成
    const store = useChatStore()
    await store.init()
    const conv = await store.newConversation('t', ['p1'])
    await store.sendMessage(conv.id, '问题')

    const assistant = conv.messages.find(m => m.role === 'assistant')!
    expect(assistant.sources!.length).toBeGreaterThan(0)
    for (const ref of assistant.sources!) {
      const match = /^Pages (\d+)/.exec(ref.label)
      if (match && ref.startPage !== undefined) expect(Number(match[1])).toBe(ref.startPage + 1)
      expect(ref.paperId).toBe('p1')
      expect(typeof ref.endPage).toBe('number')
    }
  })

  it('检索无来源时不产生任何芯片数据', async () => {
    global.fetch = vi.fn().mockResolvedValue(llm('答案')) as any
    const store = useChatStore()
    await store.init()
    const conv = await store.newConversation('t', []) // 未选论文 → 无来源
    await store.sendMessage(conv.id, '问题')
    expect(conv.messages.find(m => m.role === 'assistant')!.sources).toBeUndefined()
  })
})
```

- [ ] **Step 7: 组件 emit 测试 + ChatPanel 改造**

`src/tests/chatPanel.sources.test.ts`：

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import ElementPlus from 'element-plus'
import ChatPanel from '../components/ChatPanel.vue'
import type { Conversation } from '../stores/chat'

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ default: {}, GlobalWorkerOptions: { workerSrc: '' } }))

let wrapper: VueWrapper | undefined
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.restoreAllMocks() })

const conv = (sources: Conversation['messages'][number]['sources']): Conversation => ({
  id: 'c1', title: 't', paperIds: [], createdAt: 0,
  messages: [{ id: 'm1', role: 'assistant', content: '回答', timestamp: 1, sources }],
})

async function mountPanel(conversation: Conversation) {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }] })
  await router.push('/')
  return mount(ChatPanel, { props: { conversation }, global: { plugins: [createPinia(), router, ElementPlus] } })
}

describe('来源芯片交互（#1）', () => {
  it('可跳转芯片点击发出 open-source（含 page 0-based）', async () => {
    wrapper = await mountPanel(conv([{ label: 'Pages 11–15: R1', paperId: 'p1', startPage: 10, endPage: 14 }]))
    const chip = wrapper.find('.source-chip.is-jumpable')
    expect(chip.exists()).toBe(true)
    await chip.trigger('click')
    expect(wrapper.emitted('open-source')![0][0]).toEqual({ label: 'Pages 11–15: R1', paperId: 'p1', startPage: 10, endPage: 14 })
  })

  it('旧数据/无页码芯片不可点、不崩溃', async () => {
    wrapper = await mountPanel(conv([{ label: 'Pages 1–2: 老数据' }, { label: '/abstract 摘要', paperId: 'p1' }]))
    expect(wrapper.findAll('.source-chip.is-jumpable')).toHaveLength(0)
    await wrapper.findAll('.source-chip')[0].trigger('click')
    expect(wrapper.emitted('open-source')).toBeUndefined()
  })
})
```

`src/components/ChatPanel.vue`：

- script：`import { isJumpable, type SourceRef } from '../utils/sourceRef'`；把 `defineEmits<{ (e: 'create'): void }>()` 改为 `const emit = defineEmits<{ (e: 'create'): void; (e: 'open-source', ref: SourceRef): void }>()`
- 模板芯片改为：

```html
            <span
              v-for="(s, i) in msg.sources"
              :key="i"
              class="source-chip"
              :class="{ 'is-jumpable': isJumpable(s) }"
              :role="isJumpable(s) ? 'button' : undefined"
              :tabindex="isJumpable(s) ? 0 : undefined"
              @click="isJumpable(s) && emit('open-source', s)"
              @keydown.enter="isJumpable(s) && emit('open-source', s)"
            >{{ s.label }}</span>
```

- 样式追加：

```css
.source-chip.is-jumpable { cursor: pointer; }
.source-chip.is-jumpable:hover { border-color: var(--accent); color: var(--accent); }
```

- [ ] **Step 8: ReaderView / ChatView 处理跳转；PdfViewer 加固**

`src/views/ReaderView.vue`：

- `import { useRoute, useRouter } from 'vue-router'`；`const router = useRouter()`；`import { isJumpable, type SourceRef } from '../utils/sourceRef'`
- 模板：`<ChatPanel ref="chatPanelRef" :conversation="activeConv" @create="createConv" @open-source="onOpenSource" />`
- 处理函数：

```ts
function onOpenSource(ref: SourceRef) {
  if (!ref.paperId || ref.startPage === undefined) return
  if (ref.paperId === paper.value?.id) {
    void jumpToPage(ref.startPage + 1)
    return
  }
  void router.push({ path: '/library/' + ref.paperId, query: { page: String(ref.startPage + 1) } })
}
```

- `?page=` 支持：在既有 watch 中 `pdfUrl.value = base64ToUrl(base64)`（约 172 行）之后插入：

```ts
      const targetPage = Number(route.query.page)
      if (Number.isInteger(targetPage) && targetPage > 0) {
        await nextTick()
        pdfViewerRef.value?.scrollToPage(targetPage)
      }
```

`src/views/ChatView.vue`：

- `import { useRouter } from 'vue-router'`；`const router = useRouter()`；`import type { SourceRef } from '../utils/sourceRef'`
- 模板加 `@open-source="onOpenSource"`；处理函数：

```ts
function onOpenSource(ref: SourceRef) {
  if (!ref.paperId || ref.startPage === undefined) return
  void router.push({ path: '/library/' + ref.paperId, query: { page: String(ref.startPage + 1) } })
}
```

`src/components/PdfViewer.vue` `scrollToPage` 加固（页面可能尚未渲染完成）并加目标页闪烁：

```ts
async function scrollToPage(num: number, opts: { flash?: boolean } = {}) {
  const flash = opts.flash ?? true
  const pages = pagesRef.value
  if (!pages) return
  const deadline = Date.now() + 5000
  let el = pages.querySelector<HTMLElement>(`[data-page="${num}"]`)
  while (!el && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 60))
    el = pages.querySelector<HTMLElement>(`[data-page="${num}"]`)
  }
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth' })
  if (flash) {
    el.classList.add('page-flash')
    setTimeout(() => el.classList.remove('page-flash'), 1400)
  }
}
```

样式（`:deep(.pdf-page)` 规则附近）：

```css
:deep(.pdf-page.page-flash) { animation: page-flash 1.4s var(--ease-out); }
@keyframes page-flash {
  0% { outline: 3px solid var(--accent); outline-offset: 2px; }
  100% { outline: 3px solid transparent; outline-offset: 2px; }
}
```

- [ ] **Step 9: 运行测试确认通过**

Run: `npx vitest run src/tests/sourceRef.test.ts src/tests/sourceRefs.test.ts src/tests/chatPanel.sources.test.ts`
Expected: PASS（如 ChatPanel 组件测试因 EP 渲染告警，按告警修 stubs，不得跳过断言）

- [ ] **Step 10: 全量验证 + 手测**

Run: `npm run typecheck && npm test`
手测：阅读页点「Pages X–Y」芯片 → PDF 平滑滚到该页并闪烁一次；在论文问答页点芯片 → 跳进对应论文的阅读页并定位；旧对话（升级前）的芯片不可点但正常显示。

- [ ] **Step 11: 提交**

```bash
git add src/utils/sourceRef.ts src/tests/sourceRef.test.ts src/tests/sourceRefs.test.ts src/tests/chatPanel.sources.test.ts electron/db/index.ts src/stores/chat.ts src/components/ChatPanel.vue src/views/ReaderView.vue src/views/ChatView.vue src/components/PdfViewer.vue
git commit -m "feat: structure answer sources and make citation chips jump to their page"
```

---

### Task 7 · #5 导出：系统保存对话框 + 默认脱敏 + 可读文件名

**Files:**
- Create: `src/utils/exportSanitize.ts`
- Create: `src/tests/exportSanitize.test.ts`
- Modify: `electron/db/index.ts`（`exportAll(opts)`）
- Modify: `electron/ipc.ts`（`data:export-file`）
- Modify: `electron/preload.ts` + `src/types/db.d.ts` + `src/tests/setup.ts`
- Modify: `src/views/SettingsView.vue`（导出对话框）

**Interfaces:**
- Produces:
  - `stripApiKeysFromSettings(rows: { key: string; value: string }[]): { key: string; value: string }[]`
  - `backupFileName(date: Date): string`
  - `window.db.data.exportFile(options: { includeApiKey?: boolean }): Promise<{ canceled: boolean; filePath?: string }>`

- [ ] **Step 1: 写失败测试** `src/tests/exportSanitize.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { stripApiKeysFromSettings, backupFileName } from '../utils/exportSanitize'

describe('导出脱敏（#5）', () => {
  it('剔除 llm_profiles 的 apiKey，其余字段原样保留', () => {
    const rows = [
      { key: 'llm_profiles', value: JSON.stringify([{ id: 'a', name: 'ds', apiKey: 'sk-secret', model: 'm' }]) },
      { key: 'llm_profile_chat', value: '"a"' },
    ]
    const out = stripApiKeysFromSettings(rows)
    const profiles = JSON.parse(out[0].value)
    expect(profiles[0].apiKey).toBe('')
    expect(profiles[0].model).toBe('m')
    expect(out[1]).toEqual(rows[1])
  })

  it('非 JSON 的 value 原样保留，不抛错', () => {
    const rows = [{ key: 'llm_profiles', value: 'not-json' }]
    expect(stripApiKeysFromSettings(rows)).toEqual(rows)
  })

  it('文件名带可读日期', () => {
    expect(backupFileName(new Date(2026, 8, 21, 15, 4))).toBe('papermind-backup-2026-09-21-1504.json')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/tests/exportSanitize.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 创建 `src/utils/exportSanitize.ts`**

```ts
/** 备份脱敏（#5）：默认导出不含明文 API Key。 */
export function stripApiKeysFromSettings(rows: Array<{ key: string; value: string }>): Array<{ key: string; value: string }> {
  return rows.map(row => {
    if (row.key !== 'llm_profiles') return row
    try {
      const profiles = JSON.parse(row.value)
      if (!Array.isArray(profiles)) return row
      const redacted = profiles.map(profile => ({ ...profile, apiKey: '' }))
      return { ...row, value: JSON.stringify(redacted) }
    } catch {
      return row
    }
  })
}

/** 可读备份文件名（#5）。 */
export function backupFileName(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `papermind-backup-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}.json`
}
```

- [ ] **Step 4: 主进程导出链路**

`electron/db/index.ts`：顶部 import `stripApiKeysFromSettings`；`exportAll` 改为：

```ts
export function exportAll(opts: { includeApiKey?: boolean } = {}) {
  const paperRows = db.prepare('SELECT * FROM papers ORDER BY added_at DESC').all() as any[]
  const papers = paperRows.map(row => ({
    ...deserializePaper(row),
    fileData: existsSync(row.file_path) ? readFileSync(row.file_path).toString('base64') : null,
  }))
  const settingsRows = db.prepare('SELECT * FROM settings').all() as Array<{ key: string; value: string }>
  return {
    version: 1,
    exportedAt: Date.now(),
    knowledgeBases: kbApi.list(),
    papers,
    conversations: chatApi.listConversations(),
    highlights: db.prepare('SELECT * FROM highlights').all(),
    paperIndexes: db.prepare('SELECT paper_id, index_json, pages_json FROM paper_indexes').all(),
    paperTrees: db.prepare('SELECT * FROM paper_trees').all(),
    settings: opts.includeApiKey ? settingsRows : stripApiKeysFromSettings(settingsRows),
  }
}
```

`electron/ipc.ts`：顶部 import 改为 `import { app, dialog, ipcMain } from 'electron'`，并加 `import { writeFileSync } from 'fs'`、`import { join } from 'path'`、`import { backupFileName } from '../src/utils/exportSanitize'`；handlers 里（`'data:export'` 之后）加：

```ts
    'data:export-file': async (_e, opts?: { includeApiKey?: boolean }) => {
      const { canceled, filePath } = await dialog.showSaveDialog({
        title: '导出备份',
        defaultPath: join(app.getPath('downloads'), backupFileName(new Date())),
        filters: [{ name: 'JSON', extensions: ['json'] }],
      })
      if (canceled || !filePath) return { canceled: true }
      writeFileSync(filePath, JSON.stringify(exportAll({ includeApiKey: !!opts?.includeApiKey }), null, 2))
      return { canceled: false, filePath }
    },
```

`electron/preload.ts` 的 `data` 里加：

```ts
    exportFile: (options: unknown) => ipcRenderer.invoke('data:export-file', options),
```

`src/types/db.d.ts` 的 `data` 里加：

```ts
    exportFile: (options: { includeApiKey?: boolean }) => Promise<{ canceled: boolean; filePath?: string }>
```

`src/tests/setup.ts` 的 `data` mock 里加：

```ts
    exportFile: vi.fn().mockResolvedValue({ canceled: false, filePath: '/tmp/papermind-backup-test.json' }),
```

- [ ] **Step 5: SettingsView 导出对话框**

模板：`<el-button @click="exportData">导出数据</el-button>` 改为 `<el-button @click="exportDialogVisible = true">导出数据</el-button>`；在 `clearData` 所在 section 之后加对话框：

```html
    <el-dialog v-model="exportDialogVisible" title="导出备份" width="460px">
      <p class="card-desc">备份包含：知识库、论文（含 PDF 原文）、对话与消息、高亮、索引与语义树、全部设置。</p>
      <el-checkbox v-model="exportIncludeApiKey">包含 API Key（明文，分享前请谨慎）</el-checkbox>
      <template #footer>
        <el-button @click="exportDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="exporting" @click="doExport">导出</el-button>
      </template>
    </el-dialog>
```

script：删掉旧 `exportData`，新增：

```ts
const exportDialogVisible = ref(false)
const exportIncludeApiKey = ref(false)
const exporting = ref(false)

async function doExport() {
  exporting.value = true
  try {
    const result = await window.db.data.exportFile({ includeApiKey: exportIncludeApiKey.value })
    if (result.canceled) {
      ElMessage.info('已取消导出')
      return
    }
    ElMessage.success(`已导出到 ${result.filePath}`)
    exportDialogVisible.value = false
  } catch (err) {
    ElMessage.error(`导出失败：${err instanceof Error ? err.message : '未知错误'}`)
  } finally {
    exporting.value = false
  }
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run src/tests/exportSanitize.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 7: 手测（dev 实例）**

导出 → 出现系统保存面板（默认文件名如 `papermind-backup-2026-09-21-1530.json`）→ 保存 → toast 显示完整路径 → 校验文件：

```bash
F=~/Downloads/papermind-backup-*.json   # 用实际返回路径
jq -c '.settings[] | select(.key=="llm_profiles") | .value | fromjson | map(.apiKey)' "$F"
```

Expected: `["","",…]`（全空）。删除测试文件。

- [ ] **Step 8: 提交**

```bash
git add src/utils/exportSanitize.ts src/tests/exportSanitize.test.ts electron/db/index.ts electron/ipc.ts electron/preload.ts src/types/db.d.ts src/tests/setup.ts src/views/SettingsView.vue
git commit -m "feat: export backups via save dialog with readable name and redacted api keys"
```

---

### Task 8 · #7 划选按页合并（含历史碎片清理）

**Files:**
- Create: `src/utils/highlightMerge.ts`
- Create: `src/tests/highlightMerge.test.ts`
- Modify: `src/components/PdfViewer.vue`（使用 `mergeSegments`、类型改由工具模块导出）
- Modify: `electron/db/index.ts`（启动时合并历史碎片）

**Interfaces:**
- Produces:
  - `HighlightSegment { page: number; start: number; end: number }`（从 PdfViewer 移到工具模块）
  - `mergeSegments(segments: HighlightSegment[]): HighlightSegment[]`
  - `planFragmentMerge(rows: FragmentRow[]): { updates: Array<{ id: string; endOffset: number }>; removals: string[] }`

- [ ] **Step 1: 写失败测试** `src/tests/highlightMerge.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { mergeSegments, planFragmentMerge } from '../utils/highlightMerge'

describe('划选合并（#7）', () => {
  it('相邻/重叠片段合并为一段（一次划选只留一条记录）', () => {
    expect(mergeSegments([
      { page: 1, start: 252, end: 298 },
      { page: 1, start: 298, end: 392 },
      { page: 1, start: 392, end: 449 },
    ])).toEqual([{ page: 1, start: 252, end: 449 }])
  })

  it('中间有缺口的片段保持两条（不同划选不误并）', () => {
    expect(mergeSegments([
      { page: 1, start: 10, end: 20 },
      { page: 1, start: 30, end: 40 },
    ])).toHaveLength(2)
  })

  it('乱序输入按起点排序后合并', () => {
    expect(mergeSegments([
      { page: 1, start: 100, end: 120 },
      { page: 1, start: 50, end: 101 },
    ])).toEqual([{ page: 1, start: 50, end: 120 }])
  })

  it('历史碎片计划：同论文/页/文本/秒的 3 条 → 1 更新 + 2 删除', () => {
    const base = { paperId: 'p1', pageNum: 1, text: 'ale reinforcement learning (RL) without', createdAt: 1000 }
    const plan = planFragmentMerge([
      { id: 'a', ...base, startOffset: 252, endOffset: 298 },
      { id: 'b', ...base, startOffset: 298, endOffset: 392 },
      { id: 'c', ...base, startOffset: 392, endOffset: 449 },
    ])
    expect(plan.updates).toEqual([{ id: 'a', endOffset: 449 }])
    expect(plan.removals).toEqual(['b', 'c'])
  })

  it('不同秒的相同文本不合并（跨会话重复划选保持独立）', () => {
    const plan = planFragmentMerge([
      { id: 'a', paperId: 'p1', pageNum: 1, text: 'x', startOffset: 0, endOffset: 10, createdAt: 1000 },
      { id: 'b', paperId: 'p1', pageNum: 1, text: 'x', startOffset: 0, endOffset: 10, createdAt: 2000 },
    ])
    expect(plan.updates).toEqual([])
    expect(plan.removals).toEqual([])
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/tests/highlightMerge.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 创建 `src/utils/highlightMerge.ts`**

```ts
/** PDF 划选片段（页内字符区间，0-based 页号）（#7）。 */
export interface HighlightSegment {
  page: number
  start: number
  end: number
}

/** 合并重叠/相邻片段：一次划选在页内只留一条记录（#7）。 */
export function mergeSegments(segments: HighlightSegment[]): HighlightSegment[] {
  if (segments.length === 0) return []
  const sorted = [...segments].sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: HighlightSegment[] = [{ ...sorted[0] }]
  for (const segment of sorted.slice(1)) {
    const last = merged[merged.length - 1]
    if (segment.start <= last.end) last.end = Math.max(last.end, segment.end)
    else merged.push({ ...segment })
  }
  return merged
}

export interface FragmentRow {
  id: string
  paperId: string
  pageNum: number
  text: string
  startOffset: number
  endOffset: number
  createdAt: number
}

export interface FragmentMergePlan {
  updates: Array<{ id: string; endOffset: number }>
  removals: string[]
}

/** 历史碎片合并计划（#7）：同论文/同页/同文本/同一秒的连续片段是一次划选被拆段的产物。 */
export function planFragmentMerge(rows: FragmentRow[]): FragmentMergePlan {
  const groups = new Map<string, FragmentRow[]>()
  for (const row of rows) {
    const key = `${row.paperId}|${row.pageNum}|${row.text}|${row.createdAt}`
    const list = groups.get(key)
    if (list) list.push(row)
    else groups.set(key, [row])
  }
  const updates: FragmentMergePlan['updates'] = []
  const removals: string[] = []
  for (const list of groups.values()) {
    if (list.length <= 1) continue
    const sorted = [...list].sort((a, b) => a.startOffset - b.startOffset || a.endOffset - b.endOffset)
    const keep = sorted[0]
    const maxEnd = Math.max(...sorted.map(r => r.endOffset))
    if (maxEnd !== keep.endOffset) updates.push({ id: keep.id, endOffset: maxEnd })
    for (const extra of sorted.slice(1)) removals.push(extra.id)
  }
  return { updates, removals }
}
```

- [ ] **Step 4: PdfViewer 使用合并**

`src/components/PdfViewer.vue`：

- 删除本地 `interface HighlightSegment { page; start; end }`（约 60-64 行），改为 `import { mergeSegments, type HighlightSegment } from '../utils/highlightMerge'`。
- `highlightSelection` 里把

```ts
    const added: HighlightSegment[] = []
    for (const candidate of candidates) {
```

替换为

```ts
    const added: HighlightSegment[] = []
    for (const candidate of mergeSegments(candidates)) {
```

（其余 `subtractExisting` / 逐段 `addHighlight` 逻辑不动：并合后通常只剩一段，每页最多一条。）

- [ ] **Step 5: 历史碎片清理（启动时一次）**

`electron/db/index.ts`：顶部 import `planFragmentMerge`；`initDb()` 末尾（seed 默认知识库之后）加：

```ts
  // 历史碎片合并（#7，2026-09-21）：一次划选被按文本节点拆成的多行，合并为一条
  const fragmentRows = db.prepare('SELECT id, paper_id, page_num, text, start_offset, end_offset, created_at FROM highlights').all() as any[]
  const mergePlan = planFragmentMerge(fragmentRows.map(r => ({
    id: r.id, paperId: r.paper_id, pageNum: r.page_num, text: r.text,
    startOffset: r.start_offset, endOffset: r.end_offset, createdAt: r.created_at,
  })))
  if (mergePlan.removals.length > 0) {
    const updateFragment = db.prepare('UPDATE highlights SET end_offset = ? WHERE id = ?')
    const removeFragment = db.prepare('DELETE FROM highlights WHERE id = ?')
    db.transaction(() => {
      for (const item of mergePlan.updates) updateFragment.run(item.endOffset, item.id)
      for (const id of mergePlan.removals) removeFragment.run(id)
    })()
  }
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run src/tests/highlightMerge.test.ts && npm run typecheck && npm test`
Expected: 全部 PASS

- [ ] **Step 7: 手测**

dev 实例：跨行/跨文本节点划选一段 → 笔记面板只出现 1 张卡；对真实库升级后首次启动：原 3 条碎片合并为 1 条（可在「阅读笔记」核对，并顺带验证高亮仍在原位置）。

- [ ] **Step 8: 提交**

```bash
git add src/utils/highlightMerge.ts src/tests/highlightMerge.test.ts src/components/PdfViewer.vue electron/db/index.ts
git commit -m "fix: merge text-node fragments of one selection into a single highlight"
```

---

### Task 9 · #8 未知命令本地处理 + 错误文案归一

**Files:**
- Modify: `src/stores/chat.ts`（`sendMessage` 未知命令分支）
- Test: `src/tests/chat.commands.test.ts`（新建）

**Interfaces:**
- Consumes: T2 的 `recordFailure`（失败且带准确文案）。
- Produces: `/` 开头的未知命令在本地返回提示且不调用模型。

- [ ] **Step 1: 写失败测试** `src/tests/chat.commands.test.ts`

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ default: {}, GlobalWorkerOptions: { workerSrc: '' } }))

import { useChatStore } from '../stores/chat'

const mockDb = () => (globalThis as any).mockDb

describe('命令识别（#8）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockDb().chat.listConversations.mockResolvedValue([])
    mockDb().chat.addMessage.mockClear()
    mockDb().settings.get.mockResolvedValue(null)
    mockDb().index.list.mockResolvedValue([])
  })

  it('未知命令本地回应、不发模型、不落用户问题以外的脏数据', async () => {
    const fetchMock = vi.fn()
    global.fetch = fetchMock as any
    const store = useChatStore()
    await store.init()
    const conv = await store.newConversation('t', [])

    await store.sendMessage(conv.id, '/ab')
    expect(fetchMock).not.toHaveBeenCalled()
    const assistant = conv.messages.find(m => m.role === 'assistant')!
    expect(assistant.content).toContain('未识别的命令')
    expect(assistant.content).toContain('/abstract')
  })

  it('/ABSTRACT 大小写不敏感仍按命令处理；缺 token 的失败文案只有一句', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('should not be called')) as any
    const store = useChatStore()
    await store.init()
    const conv = await store.newConversation('t', [])

    await expect(store.sendMessage(conv.id, '/ABSTRACT')).rejects.toThrow('请先在设置中填写 Hugging Face Token')
    const assistant = conv.messages.find(m => m.role === 'assistant')!
    expect(assistant.error).toBe('请先在设置中填写 Hugging Face Token')
    expect(assistant.error).not.toContain('请检查设置中的 API 配置')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/tests/chat.commands.test.ts`
Expected: FAIL（当前 `/ab` 会被发往模型）

- [ ] **Step 3: 实现**

`src/stores/chat.ts` `sendMessage` 的 try 块开头（`/abstract` 分支之前）插入：

```ts
      const normalized = userMessage.trim().toLowerCase()
      if (normalized.startsWith('/') && normalized !== '/abstract') {
        await addMessage(convId, 'assistant', `未识别的命令：${userMessage.trim()}。当前可用命令：/abstract（总结当前所选论文）。`)
        return userMessage
      }
      if (normalized === '/abstract') {
        // 原 /abstract 分支（条件判断沿用 normalized）
      }
```

注意：原 `/abstract` 判断 `userMessage.trim().toLowerCase() === '/abstract'` 由上面的 `normalized` 复用，避免两处重复。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/tests/chat.commands.test.ts`
Expected: PASS

- [ ] **Step 5: 全量验证**

Run: `npm run typecheck && npm test`
Expected: 全部 PASS

- [ ] **Step 6: 提交**

```bash
git add src/stores/chat.ts src/tests/chat.commands.test.ts
git commit -m "fix: handle unknown slash commands locally with accurate error copy"
```

> 第 2 批完成。跑一次全量 `npm test`；可选 dev 手测：流式逐字、芯片跳页+闪烁、导出保存面板、跨节点划选单条记录、`/ab` 本地提示。

# 第 3 批（#9 → #15 + 窄窗适配）

### Task 10 · #9 作者墙截断

**Files:**
- Modify: `src/utils/libraryFilters.ts`（`formatAuthors`）
- Modify: `src/tests/libraryFilters.test.ts`（追加用例）
- Modify: `src/views/LibraryView.vue`（卡片作者行）

**Interfaces:**
- Produces: `formatAuthors(authors: string[] | undefined, max = 4): string`

- [ ] **Step 1: 追加失败测试**（`src/tests/libraryFilters.test.ts` 末尾）

```ts
import { formatAuthors } from '../utils/libraryFilters'

describe('作者展示（#9）', () => {
  it('4 位以内原样展示', () => {
    expect(formatAuthors(['A', 'B'])).toBe('A, B')
  })
  it('超过 4 位截断为「等 N 位作者」', () => {
    expect(formatAuthors(['A', 'B', 'C', 'D', 'E', 'F'])).toBe('A, B, C, D 等 2 位作者')
  })
  it('空/缺省回退占位文案', () => {
    expect(formatAuthors([])).toBe('作者信息待补充')
    expect(formatAuthors(undefined)).toBe('作者信息待补充')
  })
})
```

（把 `formatAuthors` 的 import 并入文件顶部现有的 import 行。）

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/tests/libraryFilters.test.ts`
Expected: FAIL（`formatAuthors` 未导出）

- [ ] **Step 3: 实现**

`src/utils/libraryFilters.ts` 末尾追加：

```ts
/** 卡片作者行：超长作者列表截断为「前 N 位 等 M 位作者」（#9）。 */
export function formatAuthors(authors: string[] | undefined, max = 4): string {
  const list = (authors ?? []).filter(Boolean)
  if (list.length === 0) return '作者信息待补充'
  if (list.length <= max) return list.join(', ')
  return `${list.slice(0, max).join(', ')} 等 ${list.length - max} 位作者`
}
```

`src/views/LibraryView.vue` 卡片模板：

```html
                <p class="card-authors">{{ formatAuthors(paper.authors) }}<span v-if="paper.year" class="card-year tabular-nums">{{ paper.year }}</span></p>
```

（import 行 `import { filterLibraryPapers, type LibraryFilters } from '../utils/libraryFilters'` 里追加 `formatAuthors`。）

- [ ] **Step 4: 运行确认通过 + 全量**

Run: `npx vitest run src/tests/libraryFilters.test.ts && npm run typecheck && npm test`
Expected: PASS。手测：文档库中 Kimi 卡片作者行不再超过 4 位 + 后缀，卡片高度随内容回落。

- [ ] **Step 5: 提交**

```bash
git add src/utils/libraryFilters.ts src/tests/libraryFilters.test.ts src/views/LibraryView.vue
git commit -m "fix: clamp long author lists on library cards"
```

---

### Task 11 · #10 重复导入内容哈希查重

**Files:**
- Modify: `src/utils/pdfUtils.ts`（`sha256Hex`、`parsePdfMeta` 增 `fileHash`）
- Modify: `src/tests/pdfUtils.test.ts`（追加哈希用例）
- Modify: `electron/db/schema.ts`（papers 表 +`file_hash`）
- Modify: `electron/db/index.ts`（迁移、`create`、`deserializePaper`）
- Modify: `src/stores/paper.ts`（`Paper.fileHash`）
- Modify: `src/views/LibraryView.vue`（查重提示 + `skipped` 状态）

**Interfaces:**
- Produces:
  - `sha256Hex(data: ArrayBuffer): Promise<string>`
  - `parsePdfMeta(file: File)` 返回值新增 `fileHash: string`
  - `Paper.fileHash: string`（旧行迁移后为 `''`，空则跳过查重）
  - `ImportStatus` 增加 `'skipped'`

- [ ] **Step 1: 追加失败测试**（`src/tests/pdfUtils.test.ts`）

```ts
import { webcrypto } from 'node:crypto'
import { sha256Hex } from '../utils/pdfUtils'

describe('文件哈希（#10）', () => {
  it('相同字节返回稳定十六进制哈希', async () => {
    if (!globalThis.crypto?.subtle) vi.stubGlobal('crypto', webcrypto)
    const bytes = new TextEncoder().encode('paper-content').buffer
    const first = await sha256Hex(bytes)
    const second = await sha256Hex(bytes)
    expect(first).toBe(second)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
  })
})
```

（`vi` 需并入该文件顶部现有 vitest import。）

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/tests/pdfUtils.test.ts`
Expected: FAIL（`sha256Hex` 未导出）

- [ ] **Step 3: pdfUtils 实现**

`src/utils/pdfUtils.ts`（`parsePdfMeta` 上方）：

```ts
/** 文件内容 SHA-256（十六进制），用于重复导入检测（#10）。 */
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}
```

`parsePdfMeta`：返回类型加 `fileHash: string`；`return { ... }` 里加 `fileHash: await sha256Hex(arrayBuffer)`。

- [ ] **Step 4: 数据库与 store 透传**

`electron/db/schema.ts` papers 表 `added_at INTEGER NOT NULL` 行之前加：

```sql
  file_hash         TEXT DEFAULT '',    -- 文件内容 SHA-256，重复导入检测（#10）
```

`electron/db/index.ts`：initDb 迁移区（messageCols 迁移之后）加：

```ts
  const paperCols = (db.prepare('PRAGMA table_info(papers)').all() as Array<{ name: string }>).map(c => c.name)
  if (!paperCols.includes('file_hash')) db.exec("ALTER TABLE papers ADD COLUMN file_hash TEXT DEFAULT ''")
```

`paperApi.create` 的 INSERT 列表加 `file_hash` 列与 `paper.fileHash ?? ''` 值；`deserializePaper` 返回对象加 `fileHash: row.file_hash ?? ''`。

`src/stores/paper.ts` `Paper` 接口加 `fileHash: string`（`addPaper` 已把整个 meta 透传，无需另改）。

- [ ] **Step 5: 导入查重**

`src/views/LibraryView.vue`：

- `type ImportStatus` 加 `'skipped'`；`stageLabel` 加 `skipped: '已跳过'`；列表项图标模板在 `error` 分支之后加 `<span v-else-if="item.status === 'skipped'">–</span>`；样式加：

```css
.import-item[data-status='skipped'] .import-item-stage { color: var(--text-muted); }
```

- script：`import { useRouter } from 'vue-router'`、`const router = useRouter()`；`onFilesSelected` 内（`const meta = await parsePdfMeta(file)` 之后）：

```ts
      const existing = store.papers.find(p => p.fileHash && p.fileHash === meta.fileHash)
      if (existing) {
        try {
          await ElMessageBox.confirm(
            `《${existing.title || existing.fileName}》已在库中，是否打开现有条目？`,
            '重复导入',
            { type: 'info', confirmButtonText: '打开现有条目', cancelButtonText: '跳过' },
          )
          openPaperIdAfterImport = existing.id
          item.status = 'done'
        } catch {
          item.status = 'skipped'
        }
        continue
      }
```

- 循环之前声明 `let openPaperIdAfterImport = ''`；循环结束（`(e.target as HTMLInputElement).value = ''` 之前）加：

```ts
  if (openPaperIdAfterImport) void router.push('/library/' + openPaperIdAfterImport)
```

- [ ] **Step 6: 运行测试 + 全量**

Run: `npx vitest run src/tests/pdfUtils.test.ts && npm run typecheck && npm test`
Expected: PASS

- [ ] **Step 7: 手测**

dev 实例：同一 PDF 导入两次 → 第二次弹「已在库中」；选「跳过」→ 不新增卡片、进度项显示「已跳过」；选「打开现有条目」→ 导入结束后跳到该论文阅读页。拖拽导入（同一条代码路径）同样生效。

- [ ] **Step 8: 提交**

```bash
git add src/utils/pdfUtils.ts src/tests/pdfUtils.test.ts electron/db/schema.ts electron/db/index.ts src/stores/paper.ts src/views/LibraryView.vue
git commit -m "feat: detect duplicate imports by file hash and offer to open the existing entry"
```

---

### Task 12 · #11 删除论文：5 秒撤销条

**Files:**
- Modify: `src/views/LibraryView.vue`（模板 + 删除流程）

**Interfaces:**
- Produces: `deletePaper(paper: Paper)` 改为「先隐藏、5 秒后落库、可撤销」；`finalizeDelete()` / `undoDelete()` 组件内部函数。

- [ ] **Step 1: 实现（该条为纯 UI 时序逻辑，验收用手测；改动全在一个函数块内）**

`src/views/LibraryView.vue` script（替换 T1 后的 `deletePaper`，并新增两个函数）：

```ts
interface PendingDelete { paper: Paper; index: number; timer: number }
const pendingDelete = ref<PendingDelete | null>(null)

async function deletePaper(paper: Paper) {
  await ElMessageBox.confirm(`确认删除《${paper.title || paper.fileName}》？`, '删除', { type: 'warning' })
  const index = store.papers.findIndex(p => p.id === paper.id)
  if (index === -1) return
  store.papers.splice(index, 1)            // 先从列表移除，5 秒内可撤销
  if (pendingDelete.value) finalizeDelete() // 上一个未到期的删除立即落库
  const timer = window.setTimeout(() => finalizeDelete(), 5000)
  pendingDelete.value = { paper, index, timer }
}

function undoDelete() {
  if (!pendingDelete.value) return
  clearTimeout(pendingDelete.value.timer)
  const { paper, index } = pendingDelete.value
  store.papers.splice(Math.min(index, store.papers.length), 0, paper)
  pendingDelete.value = null
}

function finalizeDelete() {
  if (!pendingDelete.value) return
  clearTimeout(pendingDelete.value.timer)
  const { paper } = pendingDelete.value
  pendingDelete.value = null
  void store.removePaper(paper.id)
}
```

设计约定（Review Focus #3）：撤销窗口内关闭应用 → 定时器不执行、文件不删（宁可不删不可误删）；在应用内导航离开文档库，定时器继续，返回后仍可撤销。

模板：在导入进度面板（`transition name="slide-up"`）之后加：

```html
    <transition name="slide-up">
      <div v-if="pendingDelete" class="undo-bar" role="status">
        <span>已删除《{{ pendingDelete.paper.title || pendingDelete.paper.fileName }}》</span>
        <button type="button" class="undo-btn" @click="undoDelete">撤销</button>
      </div>
    </transition>
```

样式（`slide-up` 过渡已在本文件定义，直接复用）：

```css
.undo-bar { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); display: flex; align-items: center; gap: 14px; padding: 10px 16px; background: var(--text-primary); color: var(--bg-surface); border-radius: 8px; font-size: 13px; z-index: 1000; box-shadow: var(--shadow-card); }
.undo-btn { border: 0; background: transparent; color: var(--gold); font-size: 13px; font-weight: 600; cursor: pointer; }
```

- [ ] **Step 2: 验证（手测）**

dev 实例：
1. 删除一篇论文 → 卡片立即消失、底部出现「已删除《X》 撤销」；**不做操作**等 5 秒 → 重新加载后确认已删除。
2. 再删除一篇 → 立即点「撤销」→ 卡片回到原位置、刷新后仍在。
3. 点删除后立刻再删另一篇 → 第一篇立即落库，第二篇的撤销条替换显示。

- [ ] **Step 3: 全量验证 + 提交**

Run: `npm run typecheck && npm test`
Expected: PASS

```bash
git add src/views/LibraryView.vue
git commit -m "feat: add a five-second undo bar for paper deletion"
```

---

### Task 13 · #12 导入进度面板自动收起

**Files:**
- Modify: `src/views/LibraryView.vue`

- [ ] **Step 1: 实现**

`src/views/LibraryView.vue`：vue import 行加 `watch`；在 `importHasError` 等 computed 之后加：

```ts
let importPanelTimer: number | undefined
watch(allDone, done => {
  if (importPanelTimer) { clearTimeout(importPanelTimer); importPanelTimer = undefined }
  if (done && !importHasError.value) {
    importPanelTimer = window.setTimeout(() => { showImportPanel.value = false }, 2500)
  }
})
```

`onFilesSelected` 开头（`importItems.value = Array.from(files)...` 之前）加一行清理：

```ts
  if (importPanelTimer) { clearTimeout(importPanelTimer); importPanelTimer = undefined }
```

- [ ] **Step 2: 验证（手测）**

导入 1-2 个 PDF → 全部完成后约 2.5 秒面板自动收起；含失败项时不自动收起（保留 ✕ 手动关闭）；导入中途再次导入 → 计时器重置、面板保持显示。

- [ ] **Step 3: 全量验证 + 提交**

Run: `npm run typecheck && npm test`

```bash
git add src/views/LibraryView.vue
git commit -m "fix: auto-collapse the import progress panel after completion"
```

---

### Task 14 · #13 语义树重建失败带原因

**Files:**
- Modify: `src/stores/chat.ts`（`TreeBuildOutcome`、`buildPaperTree`、`rebuildAllTrees`、`treeFailureReason`）
- Modify: `src/views/SettingsView.vue`（结果文案）
- Test: `src/tests/treeFailureReason.test.ts`（新建）

**Interfaces:**
- Produces:
  - `interface TreeBuildOutcome { ok: boolean; reason?: string }`
  - `buildPaperTree(...): Promise<TreeBuildOutcome>`（原 `Promise<boolean>`）
  - `TreeRebuildSummary` 新增 `firstReason?: string`

- [ ] **Step 1: 写失败测试** `src/tests/treeFailureReason.test.ts`

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(() => ({
    promise: Promise.resolve({
      numPages: 1,
      getPage: async () => ({
        getTextContent: async () => ({ items: [{ str: 'Attention is all you need.', transform: [1, 0, 0, 1, 0, 10], hasEOL: true }] }),
      }),
    }),
  })),
}))

import { useChatStore } from '../stores/chat'

const mockDb = () => (globalThis as any).mockDb
const FLAT_INDEX_JSON = JSON.stringify({ title: '平面标题', nodeId: 'only', startPage: 0, endPage: 0, summary: '', nodes: [] })
const KEYED_PROFILE = [{ id: 'p1', name: 'ds', provider: 'openai', model: 'm', apiKey: 'sk-test', baseUrl: 'https://example.com/v1', temperature: 0, maxTokens: 1024, topK: 0, systemPrompt: '' }]

describe('语义树重建失败原因（#13）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockDb().chat.listConversations.mockResolvedValue([])
    mockDb().settings.get.mockResolvedValue(null)
    mockDb().index.list.mockResolvedValue(['p1'])
    mockDb().index.get.mockResolvedValue({ indexJson: FLAT_INDEX_JSON, pagesJson: JSON.stringify(['一页正文']) })
    mockDb().tree.get.mockResolvedValue(null)
  })

  it('未配置模型时不发请求，直接给出原因', async () => {
    const fetchMock = vi.fn()
    global.fetch = fetchMock as any
    const store = useChatStore()
    await store.init()
    const summary = await store.rebuildAllTrees()
    expect(summary.attempted).toBe(1)
    expect(summary.failed).toBe(1)
    expect(summary.firstReason).toContain('未配置模型')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('服务端错误归类为请求失败并带原始信息', async () => {
    mockDb().settings.get.mockImplementation((key: string) => {
      if (key === 'llm_profiles') return Promise.resolve(KEYED_PROFILE)
      if (key === 'llm_profile_index') return Promise.resolve('p1')
      return Promise.resolve(null)
    })
    global.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 500, statusText: 'Server Error',
      json: () => Promise.resolve({ error: { message: 'boom' } }),
    }) as any
    const store = useChatStore()
    await store.init()
    const summary = await store.rebuildAllTrees()
    expect(summary.failed).toBe(1)
    expect(summary.firstReason).toContain('请求失败')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/tests/treeFailureReason.test.ts`
Expected: FAIL（`summary.firstReason` 为 undefined；未配置模型仍会发请求）

- [ ] **Step 3: store 改造** `src/stores/chat.ts`

- import 行补 `SemanticTreeBuildError`。
- 类型：

```ts
/** 单篇建树结果：失败必须带可展示的原因（#13）。 */
export interface TreeBuildOutcome {
  ok: boolean
  reason?: string
}
```

- `TreeRebuildSummary` 加字段：

```ts
  /** 首个失败原因（人类可读），供设置页展示（#13） */
  firstReason?: string
```

- 模块级原因分类（放在 `useChatStore` 之前）：

```ts
/** 建树失败原因分类（#13）。 */
function treeFailureReason(error: unknown): string {
  if (error instanceof SemanticTreeBuildError) {
    switch (error.reason) {
      case 'no-evidence': return '没有可用的原文证据块'
      case 'input-too-large': return '论文过长，超出单次建树输入上限'
      case 'llm-failed': return `请求失败：${error.message.slice(0, 80)}`
      default: return `输出不合规：${error.message.slice(0, 80)}`
    }
  }
  return error instanceof Error ? `未知错误：${error.message.slice(0, 80)}` : '未知错误'
}
```

- `buildPaperTree` 返回类型改 `Promise<TreeBuildOutcome>`，所有 return 点：

| 原 return | 新 return |
|---|---|
| `if (!treeEnabled.value) return false` | `return { ok: false, reason: '语义树总开关已关闭' }` |
| `if (treeIndexingPapers.value.has(paperId)) return false` | `return { ok: false, reason: '该论文正在建树中' }` |
| 无索引/无原文 `return false` | `return { ok: false, reason: '缺少可用原文（请先建立索引）' }` |
| 复用命中 `markTreeReady(...); return false` | `return { ok: false, reason: '已有可复用的语义树' }` |
| 代次过期 `return false` | `return { ok: false, reason: '建树任务已被更新的任务取代' }` |
| 成功 `return true` | `return { ok: true }` |
| `catch { return false }` | `catch (error) { return { ok: false, reason: treeFailureReason(error) } }` |

- 在建树 LLM 调用之前、指纹/sourceHash 计算之后加「未配置模型」短路（避免无谓请求）：

```ts
      if (buildProfile.provider !== 'ollama' && !buildProfile.apiKey.trim()) {
        return { ok: false, reason: '未配置模型（请在设置中填写 API Key）' }
      }
```

- `rebuildAllTrees` 汇总：

```ts
      summary.attempted++
      const outcome = await buildPaperTree(paperId, undefined, { force: true })
      if (outcome.ok) summary.rebuilt++
      else {
        summary.failed++
        if (!summary.firstReason && outcome.reason) summary.firstReason = outcome.reason
      }
```

（`indexPaper` 中的后台调用 `void buildPaperTree(paperId, pages).catch(() => {})` 不用改：返回值被忽略。）

- [ ] **Step 4: SettingsView 文案**

`src/views/SettingsView.vue` `onRebuildTrees` 解构加 `firstReason`：

```ts
    const { attempted, rebuilt, failed, skipped, firstReason } = await chatStore.rebuildAllTrees()
    if (attempted > 0 && rebuilt === 0) {
      ElMessage.error(`语义树重建失败（${failed}/${attempted} 篇）：${firstReason ?? '原因未知'}`)
    } else if (failed > 0) {
      ElMessage.warning(`已重建 ${rebuilt} 篇，${failed} 篇失败：${firstReason ?? '原因未知'}`)
    }
```

- [ ] **Step 5: 运行测试 + 全量**

Run: `npx vitest run src/tests/treeFailureReason.test.ts && npm run typecheck && npm test`
Expected: PASS（`semanticTreeStore.test.ts` 里对 `buildPaperTree` 布尔返回的断言如存在，需同步为 `outcome.ok`——按失败输出逐处修正，不允许放宽断言。）

- [ ] **Step 6: 提交**

```bash
git add src/stores/chat.ts src/views/SettingsView.vue src/tests/treeFailureReason.test.ts src/tests/semanticTreeStore.test.ts
git commit -m "fix: report why semantic tree rebuild failed"
```

---

### Task 15 · #14 唯一配置的删除按钮加 tooltip

**Files:**
- Modify: `src/views/SettingsView.vue`

- [ ] **Step 1: 实现**

`profile-actions` 区块里把删除按钮包进 tooltip（disabled 的按钮不派发 hover，必须用 `span` 包裹）：

```html
              <el-tooltip content="至少保留一个配置" placement="top" :disabled="profiles.length > 1">
                <span class="tooltip-wrap">
                  <el-button
                    size="small"
                    plain
                    :disabled="profiles.length <= 1"
                    @click="doRemove(p.id)"
                  >删除</el-button>
                </span>
              </el-tooltip>
```

样式（`.profile-actions` 附近）：

```css
.tooltip-wrap { display: inline-flex; }
```

- [ ] **Step 2: 验证（手测）**

只剩一个配置时 hover 删除按钮 → 出现「至少保留一个配置」；有两个及以上时不出现、按钮可点。

- [ ] **Step 3: 全量验证 + 提交**

Run: `npm run typecheck && npm test`

```bash
git add src/views/SettingsView.vue
git commit -m "fix: explain the disabled delete button for the last llm profile"
```

---

### Task 16 · #15 空对话清理

**Files:**
- Modify: `src/stores/chat.ts`（`discardEmptyConversation` + `init` 清理）
- Modify: `src/views/ReaderView.vue`（离开/切换时丢弃）
- Modify: `src/views/ChatView.vue`（切换/新建/离开时丢弃）
- Test: `src/tests/emptyConversations.test.ts`（新建）

**Interfaces:**
- Produces: `store.discardEmptyConversation(id: string): Promise<void>`

- [ ] **Step 1: 写失败测试** `src/tests/emptyConversations.test.ts`

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ default: {}, GlobalWorkerOptions: { workerSrc: '' } }))

import { useChatStore } from '../stores/chat'

const mockDb = () => (globalThis as any).mockDb

describe('空对话清理（#15）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockDb().chat.removeConversation.mockClear()
    mockDb().settings.get.mockResolvedValue(null)
    mockDb().index.list.mockResolvedValue([])
  })

  it('init 清理历史遗留的 0 消息对话', async () => {
    mockDb().chat.listConversations.mockResolvedValue([
      { id: 'e1', title: '对话 1', paperIds: ['p1'], createdAt: 0, messages: [] },
      { id: 'n1', title: '正常', paperIds: [], createdAt: 1, messages: [{ id: 'm', role: 'user', content: 'hi', sources: [], timestamp: 1 }] },
    ])
    const store = useChatStore()
    await store.init()
    expect(store.conversations.map(c => c.id)).toEqual(['n1'])
    expect(mockDb().chat.removeConversation).toHaveBeenCalledWith('e1')
  })

  it('discardEmptyConversation 只删 0 消息会话，有消息的不动', async () => {
    mockDb().chat.listConversations.mockResolvedValue([])
    const store = useChatStore()
    await store.init()
    const empty = await store.newConversation('新对话', [])
    const used = await store.newConversation('有内容', [])
    await store.addMessage(used.id, 'user', 'hi')

    await store.discardEmptyConversation(empty.id)
    await store.discardEmptyConversation(used.id)

    expect(store.conversations.map(c => c.id)).toEqual([used.id])
    expect(mockDb().chat.removeConversation).toHaveBeenCalledTimes(1)
    expect(mockDb().chat.removeConversation).toHaveBeenCalledWith(empty.id)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/tests/emptyConversations.test.ts`
Expected: FAIL（`discardEmptyConversation` 不存在；init 未清理）

- [ ] **Step 3: store 实现**

`src/stores/chat.ts`：

- `init()` 在 `conversations.value = await window.db.chat.listConversations()` 之后加：

```ts
    // 清理历史遗留的 0 消息对话（#15）：启动时不会有正在进行的空会话
    const emptyConversations = conversations.value.filter(c => c.messages.length === 0)
    for (const conv of emptyConversations) {
      await window.db.chat.removeConversation(conv.id)
    }
    conversations.value = conversations.value.filter(c => c.messages.length > 0)
```

- `removeConversation` 之后加：

```ts
  /** 丢弃「已创建但从未发问」的空会话（#15）。 */
  async function discardEmptyConversation(id: string) {
    const conv = conversations.value.find(c => c.id === id)
    if (!conv || conv.messages.length > 0) return
    await removeConversation(id)
  }
```

- store return 补 `discardEmptyConversation`。

- [ ] **Step 4: 视图侧调用点**

`src/views/ReaderView.vue`：

- watch 内把 `activeConvId.value = ''`（约 168 行，切换论文时）改为：

```ts
  if (activeConvId.value) void chatStore.discardEmptyConversation(activeConvId.value)
  activeConvId.value = ''
```

- `onBeforeUnmount` 里加：

```ts
  if (activeConvId.value) void chatStore.discardEmptyConversation(activeConvId.value)
```

`src/views/ChatView.vue`：

- `startNewConv` 开头加 `if (activeConvId.value) void chatStore.discardEmptyConversation(activeConvId.value)`
- `selectConv` 开头加 `if (activeConvId.value && activeConvId.value !== c.id) void chatStore.discardEmptyConversation(activeConvId.value)`
- `onBeforeUnmount` 里加同样的丢弃（该组件已有 onBeforeUnmount，清理媒体查询监听）。

- [ ] **Step 5: 运行测试 + 全量**

Run: `npx vitest run src/tests/emptyConversations.test.ts && npm run typecheck && npm test`
Expected: PASS（`reader.view.test.ts` 的 unmount 会触发 discard：mock 已提供 `removeConversation`，不回归）

- [ ] **Step 6: 提交**

```bash
git add src/stores/chat.ts src/views/ReaderView.vue src/views/ChatView.vue src/tests/emptyConversations.test.ts
git commit -m "fix: drop never-used empty conversations instead of keeping them forever"
```

---

### Task 17 · 待定 B：PDF「适合宽度」跟随容器尺寸

**Files:**
- Modify: `src/components/PdfViewer.vue`

**Interfaces:**
- Produces: 缩放模式标记 `fitMode`；窗口/容器尺寸变化时仅在 fit 模式下重算。

- [ ] **Step 1: 实现**

`src/components/PdfViewer.vue` script：

- 在 `let fitOnNextRender = true` 附近加：

```ts
let fitMode = true
let resizeTimer: number | undefined
const resizeObserver = new ResizeObserver(() => {
  if (!fitMode) return
  if (resizeTimer) clearTimeout(resizeTimer)
  resizeTimer = window.setTimeout(() => {
    fitOnNextRender = true
    void renderPdf()
  }, 150)
})
```

- `fitToWidth()` 改为：

```ts
function fitToWidth() {
  fitMode = true
  fitOnNextRender = true
  renderPdf()
}
```

- `zoomIn` / `zoomOut` 里在改 `scale` 之前加 `fitMode = false`。
- `onMounted` 里（`renderPdf()` 调用旁）加：

```ts
  if (scrollRef.value) resizeObserver.observe(scrollRef.value)
```

- `onBeforeUnmount` 里加：

```ts
  resizeObserver.disconnect()
  if (resizeTimer) clearTimeout(resizeTimer)
```

- [ ] **Step 2: 验证（手测）**

dev 实例打开论文：
1. 拖窄/拖宽窗口 → PDF 自动按新宽度重排（约 150ms 防抖），「适合宽度」百分比随之变化；
2. 手动缩放（+/−）后再拖窗口 → 不再自动重排（保持手动缩放）；
3. 点一次「适合宽度」→ 恢复跟随。

- [ ] **Step 3: 全量验证 + 提交**

Run: `npm run typecheck && npm test`

```bash
git add src/components/PdfViewer.vue
git commit -m "fix: keep pdf fit-to-width in sync with the container size"
```

> 第 3 批完成。全量 `npm test` + 一次完整的 dev 手测走查（第 1/2/3 批的验收点合并跑一遍）。

---

## 覆盖对照表（自检）

| Spec 条目 | 任务 | 关键验收 |
|---|---|---|
| #1 来源芯片 | T6 | 芯片可点、跳对页、旧数据降级；store 断言页区间一致 |
| #2 失败静默/空回答 | T2 + T3 | 空内容抛出、失败轮带 error 可重试、气泡级失败卡 |
| #3 截断 | T4 | truncated 落库 + 「继续」就地续写 + 默认 4096 |
| #4 确认框 | T1 | zh-cn 按钮、420px 居中、正文带对象名 |
| #5 导出 | T7 | 保存面板、可读文件名、默认剔除 apiKey、toast 带路径 |
| #6 流式 | T5 | 逐字渲染、中断不留半截、末尾 finish_reason 可用 |
| #7 高亮重复 | T8 | 一次划选一条记录 + 历史碎片启动时合并 |
| #8 命令 | T9 | `/ab` 本地提示不发模型；错误文案只有一句 |
| #9 作者墙 | T10 | 前 4 位 +「等 N 位作者」 |
| #10 重复导入 | T11 | 内容哈希命中弹「打开现有条目？」 |
| #11 删除撤销 | T12 | 5 秒撤销条；关窗不误删 |
| #12 进度面板 | T13 | 完成后 2.5s 自动收起 |
| #13 建树失败原因 | T14 | 「未配置模型/请求失败/论文过长/输出不合规」 |
| #14 禁用态 | T15 | hover 显示「至少保留一个配置」 |
| #15 空对话 | T16 | 启动清理 + 离开即丢弃 |
| 待定 B | T17 | 适宽度跟随容器；手动缩放后不跟随 |

## 执行提示

- 三个批次可独立交付：T1–T4（第 1 批）→ T5–T9（第 2 批）→ T10–T17（第 3 批）；每批结束跑全量 `npm test` 并做一次 dev 手测。
- 共享文件（`chat.ts` / `ChatPanel.vue` / `LibraryView.vue`）被多任务顺序修改：按 Task 号顺序执行，不要并行改同一文件。
- 任何任务的测试断言失败，先判定是实现问题还是计划问题；计划问题（例如 `semanticTreeStore.test.ts` 的布尔断言）就地修正计划再改代码，并保留失败输出作为证据。

