# Web Page History and Multi-Session QA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Save each explicitly opened HTTPS page as a locally readable history item, with immutable cache versions and multiple archived QA sessions per page.

**Architecture:** `web_pages` groups versioned `web_snapshots`; `web_qa_sessions` references one fixed snapshot without a one-to-one constraint. A nonexecuting HTML parser derives text blocks for the offline preview, while the original DOM remains the model input. The renderer distinguishes explicit opens from ordinary site navigation and loads HTML through IPC only when a question is sent.

**Tech Stack:** TypeScript, Vue 3, Electron `WebContentsView`, `better-sqlite3`, Vitest, `parse5` as a direct runtime dependency.

**Spec:** `docs/superpowers/specs/2026-10-17-web-page-history-design.md`

## Global Constraints

- Only explicitly opened HTTPS URLs enter history automatically: address submit, paste then submit, or link drop. Site clicks, Back, Forward, Refresh and SPA navigation do not.
- Canonical page identity uses the final HTTPS URL, removes `#fragment`, and retains path and query parameters.
- Original DOM snapshots stay immutable, are limited to 8 MiB UTF-8, and remain the complete model context. Preview text is capped at 2,000 blocks and 512 KiB UTF-8, with a truncation notice.
- History selection is offline and does not fetch or execute saved HTML. The user alone initiates live loading or cache refresh.
- Never automatically evict a page, snapshot or dialogue. SQLite remains the only local store for web content and messages.
- Keep existing backup `version: 1` imports working, including backups without `webQa` and backups with sessions but no `pages` array.
- Keep `electron/db/schema.ts`, `electron/db/index.ts`, `electron/preload.ts`, `src/types/db.d.ts` and `src/types/ipcContract.ts` synchronized. PDF behavior must remain unchanged.

## Review Focus

1. A redirect followed by a rapid site click during explicit import must not archive the later clicked page by accident; Task 5 has a navigation race test.
2. Two legacy snapshots with the same URL, including one with a failed assistant message, must migrate with every ID, state and message intact; Task 1 has a migration fixture.
3. A saved HTML body containing scripts, inline event handlers and external image URLs must make no network request when selected offline; Tasks 2 and 6 test pure parsing and text rendering.
4. A write succeeding just before cancellation or a history-list error must leave the dialogue retrievable; Task 4 tests both timings.
5. An invalid page/snapshot reference in an imported backup must be rejected before clearing current SQLite rows or writing PDFs; Task 3 exercises global import.

## File Map and Interfaces

| Unit | Files | Responsibility |
| --- | --- | --- |
| URL identity and schema | `src/utils/webPageUrl.ts`, `electron/db/webQaMigration.ts`, `electron/db/schema.ts`, `electron/db/index.ts` | Canonical URL, parent rows, old-table migration and indexes. |
| Safe reading cache | `src/utils/webReadPreview.ts`, `src/types/webQa.ts`, `electron/db/webQa.ts` | Pure HTML parsing, preview limits, page/snapshot/session queries and atomic writes. |
| Backup boundary | `electron/db/backupValidation.ts`, `electron/db/index.ts`, `electron/db/webQa.ts`, `src/views/SettingsView.vue` | Version-1 compatibility, full export/import/clear and truthful copy. |
| IPC boundary | `src/types/ipcContract.ts`, `src/types/db.d.ts`, `electron/ipc.ts`, `electron/preload.ts`, `src/tests/setup.ts` | Typed methods for metadata, preview, HTML and mutation. |
| QA controller | `src/composables/useWebQa.ts`, `src/utils/webQaPrompt.ts` | Fixed-snapshot runs, saved question/answer lifecycle and recovery. |
| Page controller and UI | `electron/webPreview.ts`, `src/types/webPreview.ts`, `src/composables/useWebPageHistory.ts`, `src/views/WebPreviewView.vue`, `src/components/WebCachedPreview.vue`, `src/components/WebQaPanel.vue` | Explicit import, offline selection, safe rendering and grouped sessions. |

Public shapes to keep consistent across tasks:

```ts
type WebPreviewBlock = { kind: 'heading' | 'paragraph' | 'list' | 'quote' | 'code'; text: string; level?: number }
type WebReadPreview = { blocks: WebPreviewBlock[]; truncated: boolean }
type WebPageSummary = {
  id: string; canonicalUrl: string; title: string; createdAt: number; lastOpenedAt: number
  latestSnapshotId: string; snapshotCount: number; sessionCount: number; totalBytes: number
}
type WebSnapshotPreview = {
  id: string; pageId: string; finalUrl: string; title: string; capturedAt: number
  byteLength: number; contentHash: string; preview: WebReadPreview
}
type WebQaCreateInput = {
  sessionId: string; questionId: string; assistantId: string; snapshotId: string
  question: string; createdAt: number; modelId: string
}
type WebQaAppendInput = Omit<WebQaCreateInput, 'snapshotId'>
type WebQaSessionSummary = {
  id: string; pageId: string; snapshotId: string; firstQuestion: string
  finalUrl: string; title: string; capturedAt: number; byteLength: number
  createdAt: number; updatedAt: number
}
type WebQaSessionDetail = WebQaSessionSummary & { messages: WebQaMessage[] }
type WebQaBackup = {
  pages: Array<{ id: string; canonicalUrl: string; title: string; createdAt: number; lastOpenedAt: number }>
  snapshots: Array<{ id: string; pageId: string; lastSeenAt: number; preview: WebReadPreview } & PreviewSnapshot>
  sessions: Array<{ id: string; snapshotId: string; createdAt: number; updatedAt: number }>
  messages: WebQaMessage[]
}
```

`DbApi.webQa` exposes `listPages()`, `archive(snapshot, openedAt)`, `getPreview(snapshotId)`, `getSnapshot(snapshotId)`, `listSessions(pageId)`, `getSession(id)`, `createSession(input)`, `appendTurn(input)`, `ensureAssistantForLastUser(sessionId, assistantId, modelId)`, `updateMessage(id, patch)`, `removeSession(id)` and `removePage(id)`. `getSession` returns metadata and messages, never HTML. `getSnapshot` returns the old `PreviewSnapshot` shape only when a model run needs it. `WebQaSessionSummary` adds `pageId` and `firstQuestion`; `WebQaSessionDetail` adds `messages` and no longer embeds `snapshot`. `PreviewApi.openAndCapture(url, bounds)` returns a `PreviewSnapshot` for an explicit open; existing `open` remains for ordinary browsing.

---

### Task 1: Canonical URL and Lossless SQLite Migration

**Files:** Create `src/utils/webPageUrl.ts`, `electron/db/webQaMigration.ts`, `src/tests/webPageUrl.test.ts`, `src/tests/webQaMigration.test.ts`; modify `electron/db/schema.ts`, `electron/db/index.ts`.

**Interfaces:** Produces `canonicalWebPageUrl(value: string): string` and `migrateWebPageHistory(db: Database.Database): void`. Later tasks assume `web_pages(id, canonical_url, title, created_at, last_opened_at)`, `web_snapshots.page_id`, `.preview_json`, `.last_seen_at`, and a session table with no unique index on `snapshot_id`.

- [ ] **Step 1: Write failing URL and old-database tests.** Build the old three web tables explicitly in an in-memory SQLite database, insert two snapshots of the same URL and two sessions, including a failed assistant. Assert a repeated migration preserves every ID, HTML, message status and FK; assert a third session can refer to the first snapshot.

```ts
expect(canonicalWebPageUrl('https://EXAMPLE.org:443/a?x=1#section'))
  .toBe('https://example.org/a?x=1')
expect(canonicalWebPageUrl('https://example.org/a?x=2'))
  .not.toBe(canonicalWebPageUrl('https://example.org/a?x=1'))
migrateWebPageHistory(db)
migrateWebPageHistory(db)
expect(db.prepare('SELECT COUNT(*) n FROM web_pages').get()).toMatchObject({ n: 1 })
expect(db.prepare("SELECT status FROM web_qa_messages WHERE id='failed-answer'").get())
  .toMatchObject({ status: 'failed' })
expect(db.pragma('foreign_key_check')).toEqual([])
db.prepare('INSERT INTO web_qa_sessions (id,snapshot_id,created_at,updated_at) VALUES (?,?,?,?)')
  .run('third-session', 'old-snapshot-1', 30, 30)
```

- [ ] **Step 2: Run `npx vitest run src/tests/webPageUrl.test.ts src/tests/webQaMigration.test.ts`; expect missing-module failures.**

- [ ] **Step 3: Implement the canonical key and transactional migration.** Add the new schema for fresh installs. On an old database, turn FK enforcement off outside the transaction, create the parent rows, copy old snapshots and sessions to new tables, drop old tables in dependency order, rename new tables, run `foreign_key_check`, then restore FK enforcement. Preserve old IDs and timestamps; initialize `last_seen_at = captured_at` and `preview_json = ''`. Create indexes after the migration so `SCHEMA` never indexes a column an old table lacks.

```ts
export function canonicalWebPageUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password)
    throw new Error('仅支持 HTTPS 网页')
  url.hash = ''
  return url.href
}

// In initDb, after db.exec(SCHEMA):
migrateWebPageHistory(db)
// Migration must preserve web_qa_messages.session_id references when rebuilding
// web_qa_sessions; verify PRAGMA foreign_key_check before committing success.
```

- [ ] **Step 4: Re-run the two tests and `npm run typecheck`; expect PASS.** Verify a fresh `SCHEMA` database needs no migration and existing older rows are still readable.
- [ ] **Step 5: Commit:** `git add electron/db/schema.ts electron/db/index.ts electron/db/webQaMigration.ts src/utils/webPageUrl.ts src/tests/webPageUrl.test.ts src/tests/webQaMigration.test.ts && git commit -m 'feat: migrate webpage history schema'`.

### Task 2: Nonexecuting Reading Preview and Page Repository

**Files:** Create `src/utils/webReadPreview.ts`, `src/tests/webReadPreview.test.ts`; modify `package.json`, `package-lock.json`, `src/types/webQa.ts`, `electron/db/webQa.ts`, `src/types/ipcContract.ts`, `src/types/db.d.ts`, `electron/ipc.ts`, `electron/preload.ts`, `src/tests/setup.ts`, `src/tests/webQaRepository.test.ts`.

**Interfaces:** Consumes Task 1's schema and `canonicalWebPageUrl`. Produces `extractWebReadPreview(html: string): WebReadPreview` and the `DbApi.webQa` methods in the File Map. `archive(snapshot, openedAt)` validates the old SHA-256 and 8 MiB boundary, extracts preview, and commits page plus snapshot atomically. `getPreview` lazily materializes empty legacy `preview_json` without running HTML; `getSnapshot` returns full HTML only for QA.

- [ ] **Step 1: Write failing parser and repository tests.** Include `<article><h1>`, paragraphs, list, quote and code alongside `<script>`, `<nav>`, `<img src="https://...">` and `onclick`. Test fallback to body text, 2,000-block/512-KiB truncation, rejected textless import, URL redirect identity from `finalUrl`, same-hash deduplication, changed-version creation, two sessions sharing one snapshot, list queries without `html`, and session deletion retaining a shared snapshot.

```ts
const preview = extractWebReadPreview('<html><body><nav>菜单</nav><article><h1>标题</h1><p onclick="bad()">正文</p><script>bad()</script><img src="https://bad.invalid/x"></article></body></html>')
expect(preview.blocks.map(block => block.text)).toEqual(['标题', '正文'])
const html = '<html><body><article><p>正文</p></article></body></html>'
const validSnapshot = { finalUrl: 'https://example.org/article', title: '文章', html,
  capturedAt: 10, byteLength: Buffer.byteLength(html, 'utf8'),
  contentHash: createHash('sha256').update(html).digest('hex') }
const first = repo.archive(validSnapshot, 100)
const again = repo.archive(validSnapshot, 200)
expect(again.latestSnapshotId).toBe(first.latestSnapshotId)
expect(repo.listPages()).toHaveLength(1)
expect(repo.listPages()[0]).not.toHaveProperty('html')
expect(repo.getPreview(first.latestSnapshotId)?.preview.blocks.length).toBeGreaterThan(0)
```

- [ ] **Step 2: Run `npx vitest run src/tests/webReadPreview.test.ts src/tests/webQaRepository.test.ts`; expect failures for the new interfaces.**

- [ ] **Step 3: Add `parse5` as a direct runtime dependency and implement pure extraction.** `npm install parse5@8.0.1 --save` records the version already present transitively. Walk the parsed tree without mounting it or following attributes; skip `script`, `style`, `nav`, `header`, `footer`, `aside`, `form`, `svg` and `iframe`. Prefer `article` then `main` then `body`. Emit only text, kind and heading level. Count UTF-8 bytes as blocks are appended; set `truncated` at the first omitted block, then use body text chunks if semantic blocks are absent.

```ts
import { parse } from 'parse5'
type HtmlNode = { nodeName: string; value?: string; childNodes?: HtmlNode[] }
const ignored = new Set(['script', 'style', 'nav', 'header', 'footer', 'aside', 'form', 'svg', 'iframe'])
function find(node: HtmlNode, name: string): HtmlNode | undefined {
  if (node.nodeName === name) return node
  for (const child of node.childNodes ?? []) {
    const match = find(child, name)
    if (match) return match
  }
}
function readableText(node: HtmlNode): string {
  if (ignored.has(node.nodeName)) return ''
  if (node.nodeName === '#text') return node.value ?? ''
  return (node.childNodes ?? []).map(readableText).join(' ')
}
export function extractWebReadPreview(html: string): WebReadPreview {
  const document = parse(html) as unknown as HtmlNode
  const root = find(document, 'article') ?? find(document, 'main') ?? find(document, 'body') ?? document
  const blocks: WebPreviewBlock[] = []
  let bytes = 0
  let truncated = false
  const append = (kind: WebPreviewBlock['kind'], raw: string, level?: number) => {
    const clean = kind === 'code' ? raw.trim() : raw.replace(/\s+/g, ' ').trim()
    if (!clean) return
    if (blocks.length >= 2000 || bytes >= 512 * 1024) { truncated = true; return }
    const chars = Array.from(clean)
    let low = 0, high = chars.length
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      if (Buffer.byteLength(chars.slice(0, mid).join(''), 'utf8') <= 512 * 1024 - bytes) low = mid
      else high = mid - 1
    }
    if (low < chars.length) truncated = true
    if (low > 0) {
      const text = chars.slice(0, low).join('')
      blocks.push({ kind, text, ...(level ? { level } : {}) })
      bytes += Buffer.byteLength(text, 'utf8')
    }
  }
  const visit = (node: HtmlNode) => {
    if (ignored.has(node.nodeName)) return
    const level = /^h[1-6]$/.test(node.nodeName) ? Number(node.nodeName[1]) : undefined
    const kind = level ? 'heading' : ({ p: 'paragraph', li: 'list', blockquote: 'quote', pre: 'code' } as const)[node.nodeName as 'p' | 'li' | 'blockquote' | 'pre']
    if (kind) { append(kind, readableText(node), level); return }
    for (const child of node.childNodes ?? []) visit(child)
  }
  visit(root)
  if (!blocks.length) append('paragraph', readableText(root))
  if (!blocks.length) throw new Error('网页没有可缓存的文字')
  return { blocks, truncated }
}
```

- [ ] **Step 4: Implement atomic repository methods and typed IPC.** Use named SQL columns instead of positional `INSERT ... VALUES` because old and new schema have different row shapes. On duplicate `(page_id, content_hash)`, update only `last_seen_at` and the parent metadata; on changed content, insert a new snapshot. `listPages`/`listSessions` select metadata only. `getPreview` reads `preview_json`, while `getSnapshot` alone selects `html`. For an old textless snapshot, `getPreview` returns an empty block array and the UI says the archived dialogue is still available. `createSession` and `appendTurn` each write a user and assistant placeholder together inside one transaction. `ensureAssistantForLastUser` verifies the final message is a user row and inserts one assistant placeholder in a transaction, allowing old user-only turns to retry without duplicating the question. Match these names in preload, IPC contract, main handlers and the Vitest mock.

```ts
const existing = db.prepare('SELECT id FROM web_snapshots WHERE page_id=? AND content_hash=? ORDER BY captured_at DESC LIMIT 1')
  .get(pageId, snapshot.contentHash) as { id: string } | undefined
if (existing) db.prepare('UPDATE web_snapshots SET last_seen_at=? WHERE id=?').run(openedAt, existing.id)
else db.prepare(`INSERT INTO web_snapshots
  (id,page_id,final_url,title,html,captured_at,content_hash,byte_length,preview_json,last_seen_at)
  VALUES (?,?,?,?,?,?,?,?,?,?)`).run(snapshotId, pageId, snapshot.finalUrl,
  snapshot.title, snapshot.html, snapshot.capturedAt, snapshot.contentHash,
  snapshot.byteLength, JSON.stringify(preview), openedAt)
```

- [ ] **Step 5: Run the focused tests, `npm run typecheck`, and commit** with `git commit -m 'feat: add cached webpage repository and preview extraction'` after staging the listed files.

### Task 3: Backup, Import, Clear and Settings Copy

**Files:** Modify `electron/db/backupValidation.ts`, `electron/db/webQa.ts`, `electron/db/index.ts`, `src/types/webQa.ts`, `src/views/SettingsView.vue`, `src/tests/webQaRepository.test.ts`, `src/tests/ipcContract.scenario.test.ts`.

**Interfaces:** `WebQaBackup` exported with `pages`, `snapshots`, `sessions`, `messages`. `normalizeWebQaBackup(value: unknown): WebQaBackup` accepts the current backup and old backups without `pages` or `webQa`; all references are checked before `importAll` begins mutating data.

- [ ] **Step 1: Add failing round-trip and compatibility tests.** Export a page with two snapshots and two sessions, clear, import and check content and counts. Import an old `version: 1` fixture with one snapshot/session/message and no pages; import a backup with no `webQa`. Corrupt `snapshot.pageId`, `session.snapshotId`, URL, content hash and duplicate ID separately; verify each rejection leaves previous rows and PDFs intact.

```ts
const saved = exportAll()
expect(saved.webQa.pages).toHaveLength(1)
clearAll()
importAll(saved)
expect(getWebQaRepository().listSessions(saved.webQa.pages[0].id)).toHaveLength(2)
const invalid = structuredClone(saved)
invalid.webQa.snapshots[0].pageId = 'missing'
expect(() => importAll(invalid)).toThrow()
expect(getWebQaRepository().listPages()).toHaveLength(1)
```

- [ ] **Step 2: Run `npx vitest run src/tests/webQaRepository.test.ts src/tests/ipcContract.scenario.test.ts`; expect backup tests to fail.**

- [ ] **Step 3: Normalize and validate before import writes.** For old backups, generate deterministic parent IDs from canonical URLs within that import and attach snapshots to those parents. Retain every original snapshot/session/message ID. Validate page URL uniqueness, snapshot parent URL, hash/byte length, preview shape or regenerate preview from HTML, and all child references. Keep global `version: 1`. Import in parent → snapshot → session → message order; delete in reverse order. Add `web_pages` to `clearAll`, and update settings copy to name webpages, cache and conversations.

```ts
const webQa = normalizeWebQaBackup(data.webQa ?? { snapshots: [], sessions: [], messages: [] })
// validateBackupInput calls the same normalizer before the importAll transaction.
db.exec('DELETE FROM web_qa_messages; DELETE FROM web_qa_sessions; DELETE FROM web_snapshots; DELETE FROM web_pages;')
const insertPage = db.prepare('INSERT INTO web_pages (id,canonical_url,title,created_at,last_opened_at) VALUES (?,?,?,?,?)')
const insertSnapshot = db.prepare(`INSERT INTO web_snapshots
  (id,page_id,final_url,title,html,captured_at,content_hash,byte_length,preview_json,last_seen_at)
  VALUES (?,?,?,?,?,?,?,?,?,?)`)
for (const page of webQa.pages) insertPage.run(page.id, page.canonicalUrl, page.title, page.createdAt, page.lastOpenedAt)
for (const snapshot of webQa.snapshots) {
  let preview: WebReadPreview = { blocks: [], truncated: false }
  try { preview = extractWebReadPreview(snapshot.html) }
  catch { preview = { blocks: [], truncated: false } }
  insertSnapshot.run(snapshot.id, snapshot.pageId, snapshot.finalUrl, snapshot.title,
    snapshot.html, snapshot.capturedAt, snapshot.contentHash, snapshot.byteLength,
    JSON.stringify(preview), snapshot.lastSeenAt ?? snapshot.capturedAt)
}
```

- [ ] **Step 4: Re-run both tests and `npm run typecheck`; expect PASS.**
- [ ] **Step 5: Commit:** `git commit -m 'feat: preserve webpage history in backups'` after staging the listed files.

### Task 4: Fixed-Snapshot QA Lifecycle and Archival Recovery

**Files:** Modify `src/composables/useWebQa.ts`, `src/types/webQa.ts`, `src/tests/webQaRun.test.ts`, `src/tests/webQaPrompt.test.ts` if signatures change.

**Interfaces:** `createWebQaController` uses `repository: DbApi['webQa']`, `selectSnapshot(pageId, snapshotId)`, `load(sessionId)`, `newSession()`, `send(question)`, `retry()`, `stop()`. The page controller selects a saved snapshot before the first question. The QA controller fetches the fixed HTML through `getSnapshot(snapshotId)` only during a run.

- [ ] **Step 1: Replace obsolete first-question-capture tests with failing fixed-snapshot tests.** Verify no model call without selected snapshot; two sessions on one snapshot; old session uses old HTML after selecting a changed page; first-question transaction writes both user and assistant placeholder; a failed transaction leaves no half-turn; a successful transaction survives immediate `newSession()`, abort and `listSessions` failure; user-only legacy turn gains a retry path; incomplete assistant text stays out of the next prompt.

```ts
qa.selectSnapshot('page-1', 'snap-1')
const pending = qa.send('问题')
await vi.waitFor(() => expect(repository.createSession).toHaveBeenCalledOnce())
const savedSessionId = repository.createSession.mock.calls[0][0].sessionId
qa.newSession()
expect(await pending).toBe(false)
expect(await repository.getSession(savedSessionId)).not.toBeNull()
expect(requestCompletion).not.toHaveBeenCalled()
```

- [ ] **Step 2: Run `npx vitest run src/tests/webQaRun.test.ts src/tests/webQaPrompt.test.ts`; expect failures against the old capture/create contract.**

- [ ] **Step 3: Rewrite run preparation around saved snapshots and atomic turns.** Fetch `getSnapshot` before the model call. For a new session use `createSession`, for another turn use `appendTurn`; both already include a streaming assistant placeholder. Once either transaction returns, never call `removeSession` from an error handler. Treat history refresh as a separate best-effort read. If selection changes after a write, stop the run but leave the saved turn. On load, mark orphaned `streaming` assistants interrupted; when the last row is a user message from old data, call `ensureAssistantForLastUser` before retrying.

```ts
const saved = currentSession.value
  ? await repository.appendTurn({ sessionId: currentSession.value.id, questionId, assistantId, question, createdAt, modelId })
  : await repository.createSession({ sessionId, snapshotId: selectedSnapshotId, questionId, assistantId, question, createdAt, modelId })
if (!ownsRun(controller)) return false // saved remains in SQLite
const snapshot = await repository.getSnapshot(saved.snapshotId)
if (!snapshot) throw new Error('网页快照不存在')
const prompt = buildWebQaMessages(snapshot, saved.messages, question, profile.systemPrompt)
```

- [ ] **Step 4: Re-run focused tests and `npm run typecheck`; expect PASS.**
- [ ] **Step 5: Commit:** `git commit -m 'fix: keep webpage dialogue across interrupted runs'` after staging the listed files.

### Task 5: Explicit Import and Safe Native View Ownership

**Files:** Modify `electron/webPreview.ts`, `src/types/webPreview.ts`, `src/types/ipcContract.ts`, `electron/ipc.ts`, `electron/preload.ts`, `src/tests/webPreviewController.test.ts`.

**Interfaces:** Add `PreviewApi.openAndCapture(url, bounds): Promise<PreviewSnapshot>`. Existing `open` serves explicit live browsing of an old source without archiving; existing `captureSnapshot` serves the explicit Save/Update current-page buttons. A capture result is still persisted only by `DbApi.webQa.archive`.

- [ ] **Step 1: Write a failing native-controller test for redirect/click races and failed loads.** A successful explicit open returns final redirected HTTPS URL and complete DOM. A site navigation after explicit load begins, an HTTP redirect, a load failure, or a newer explicit request must reject the import result; existing history is untouched because no repository method is called.

```ts
const bounds = { x: 80, y: 64, width: 700, height: 500 }
await controller.open('https://example.org/previous', bounds)
const contents = fake.views[0].webContents
let finishLoad!: () => void
contents.loadURL.mockImplementationOnce(() => new Promise<void>(resolve => { finishLoad = resolve }))
const pending = controller.openAndCapture('https://example.org/start', bounds)
contents.emit('will-redirect', { url: 'https://example.org/final', isMainFrame: true, preventDefault: vi.fn() })
contents.currentUrl = 'https://example.org/final'
contents.emit('did-start-navigation', { url: 'https://example.org/final', isMainFrame: true })
contents.emit('did-navigate', {}, 'https://example.org/final')
contents.emit('did-stop-loading')
finishLoad()
expect((await pending).finalUrl).toBe('https://example.org/final')
```

- [ ] **Step 2: Run `npx vitest run src/tests/webPreviewController.test.ts`; expect the new method to be missing.**

- [ ] **Step 3: Implement explicit-open capture as one main-process operation.** Move the current `open` body into a private `load` helper. Let `open`, Back, Forward, Reload, `will-navigate` and a newer explicit open increment an import token; a valid `will-redirect` leaves it alone. `waitForIdle` listens for `did-stop-loading` and `did-fail-load`, removes its listeners and rejects after 20 seconds. After a successful load call the existing `captureSnapshot()`; its before/after URL and generation checks still apply. Keep failures as errors to the renderer; do not persist anything from the preview controller.

```ts
private explicitOpenRequest = 0
open(url: string, bounds: PreviewBounds): Promise<void> {
  this.explicitOpenRequest++
  return this.load(url, bounds)
}
async openAndCapture(url: string, bounds: PreviewBounds): Promise<PreviewSnapshot> {
  const request = ++this.explicitOpenRequest
  await this.load(url, bounds)
  await this.waitForIdle(request)
  if (request !== this.explicitOpenRequest || this.state.error || !this.state.visible)
    throw new Error('网页未能完成加载')
  const snapshot = await this.captureSnapshot()
  if (request !== this.explicitOpenRequest) throw new Error('网页已变化，请重新打开')
  return snapshot
}
```

- [ ] **Step 4: Re-run controller tests and `npm run typecheck`; expect PASS.**
- [ ] **Step 5: Commit:** `git commit -m 'feat: capture only explicit webpage opens'` after staging the listed files.

### Task 6: Grouped History UI and Offline Cached Preview

**Files:** Create `src/composables/useWebPageHistory.ts`, `src/components/WebCachedPreview.vue`, `src/tests/webCachedPreview.test.ts`; modify `src/views/WebPreviewView.vue`, `src/components/WebQaPanel.vue`, `src/tests/webPreviewView.test.ts`, `src/tests/webQaPanel.test.ts`.

**Interfaces:** `useWebPageHistory` owns `pages`, `selectedPage`, `selectedSnapshotPreview`, `sessions`, `mode: 'live' | 'cached'`, `openExplicit(url, bounds)`, `saveCurrent()`, `selectPage(id)`, `selectSession(id)`, `refreshPage()`, `removePage(id)`. It calls QA `selectSnapshot` and `load` after database selection. `WebCachedPreview` receives `WebSnapshotPreview` and emits `open-source`; the view's live toolbar offers Return to Cache.

- [ ] **Step 1: Add failing UI tests.** Address submit and dropped `text/uri-list` call `openAndCapture` then `archive`; merely pasting or clicking a site link does not. Selecting a page displays cached title/text without calling `preview.open`; selecting a session changes to its snapshot and displays messages; two sessions under one page remain distinct. After starting a new session on an unarchived navigated page, send is disabled and Save is shown; a cache load hides the native view; cached script-like text is escaped. Deletion asks for confirmation and removes all related sessions only on confirmation.

```ts
await wrapper.get('[aria-label="网页地址"]').setValue('example.org/article')
expect(window.db.webQa.archive).not.toHaveBeenCalled()
await wrapper.get('[aria-label="网页地址"]').trigger('keydown.enter')
await flushPromises()
expect(preview.openAndCapture).toHaveBeenCalledOnce()
expect(window.db.webQa.archive).toHaveBeenCalledOnce()
await wrapper.get('[data-action="history-page"]').setValue('page-1')
expect(preview.open).not.toHaveBeenCalled()
expect(wrapper.text()).toContain('本地缓存')
```

- [ ] **Step 2: Run `npx vitest run src/tests/webCachedPreview.test.ts src/tests/webPreviewView.test.ts src/tests/webQaPanel.test.ts`; expect failures.**

- [ ] **Step 3: Build the page controller and text-only cached component.** Render blocks through Vue interpolation, never `v-html`. Add the page selector above a session list in `WebQaPanel`; label sessions by first question and times. In `WebPreviewView`, wire address submit and link drop to `openExplicit`, and wire Save current/Update cache to `captureSnapshot` then `archive`. The live source button calls old `preview.open`; history selection switches to cached mode. In cached mode and narrow QA mode pass zero bounds to the native view. Keep the existing split, keyboard resize and active model UI.

```vue
<article v-for="(block, index) in snapshot.preview.blocks" :key="index">
  <component :is="`h${Math.min(6, Math.max(1, block.level ?? 2))}`" v-if="block.kind === 'heading'">{{ block.text }}</component>
  <pre v-else-if="block.kind === 'code'">{{ block.text }}</pre>
  <p v-else>{{ block.text }}</p>
</article>
<p v-if="snapshot.preview.truncated">缓存预览已截断；问答仍依据完整快照。</p>
```

- [ ] **Step 4: Re-run focused UI tests and `npm run typecheck`; expect PASS.** Manually inspect a long article, a dynamic article and a disconnected original URL.
- [ ] **Step 5: Commit:** `git commit -m 'feat: show cached webpages with grouped QA history'` after staging the listed files.

### Task 7: Cross-Boundary Verification and Final Review

**Files:** Modify only focused tests or user copy if the checks expose a concrete defect.

**Interfaces:** No new public API. Verify all requirements in the spec and the five Review Focus failures.

- [ ] **Step 1: Run `npm run typecheck`, `npm test`, and `git diff --check main...HEAD`; capture exact pass/fail output.**
- [ ] **Step 2: Manually exercise one real HTTPS article:** explicit open → history item before QA → two sessions → offline cached reopen → update cache with changed content → old session still pinned. If an external model is not configured, verify the save/history path and report that model completion was not manually exercised.
- [ ] **Step 3: Inspect backup round-trip, old-data migration and delete paths once more; fix only demonstrated gaps and rerun the affected focused suite.**
- [ ] **Step 4: Use the repository's code-review workflow for one whole-branch review, resolve actionable findings, then report remaining limits and commit IDs.**
