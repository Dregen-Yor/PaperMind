# HTML Web Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a temporary HTTPS webpage preview page that displays original technical blogs inside PaperMind.

**Architecture:** A Vue route owns the toolbar and reserves a rectangle for an Electron `WebContentsView`. A main-process preview controller owns the untrusted view, validates navigation, synchronizes its bounds, and emits state through a narrow preload bridge. URL policy is a pure shared module used by both sides.

**Tech Stack:** Vue 3, TypeScript, Electron 44, Vitest, Vue Test Utils.

**Spec:** `docs/superpowers/specs/2026-10-16-html-preview-design.md`

## Global Constraints

- Preview only: no HTML import, saved URL, library entry, notes, AI indexing, database migration, or backup change.
- Embedded navigation accepts HTTPS only, including redirects and new-window requests. User-triggered external open may accept HTTP or HTTPS.
- Remote content gets no PaperMind preload, Node integration, or IPC; use context isolation, sandboxing, and a nonpersistent isolated session.
- Use existing PaperMind colors and fonts. The native view occupies a rectangular slot with approximately 12px reader-background gutter.
- Keep the current PDF reader behavior unchanged. Run `npm run typecheck` and `npm test` before completion.

## Review Focus

1. A pasted domain without a scheme or with surrounding spaces should load as HTTPS; a URL with embedded credentials must be rejected. Task 1 tests both.
2. A page redirecting from HTTPS to HTTP or `file:` must be stopped without opening the system browser. Task 2 tests both.
3. A `target=_blank` HTTPS link must reuse the current view; an unsupported target must leave the current page intact. Task 2 tests both.
4. A stale failure event after rapid address changes must not replace the newer page's state. Task 2 tests the generation guard.
5. Route exit or resize must remove the native overlay or keep it inside its current rectangle. Tasks 2 and 3 test lifecycle and bounds reporting.

---

## File Map

| File | Responsibility |
| --- | --- |
| `src/utils/webPreviewUrl.ts` | Normalize typed URLs; validate top-level and external URLs |
| `src/types/webPreview.d.ts` | Renderer-visible preview state and `window.preview` bridge |
| `electron/webPreview.ts` | Per-window native view ownership, session policy, navigation, events, bounds |
| `electron/ipc.ts` | Register preview commands and validate the application sender |
| `electron/preload.ts` | Expose narrow preview commands and state subscription |
| `electron/main.ts` | Register and dispose each app window's preview controller |
| `src/views/WebPreviewView.vue` | Toolbar, empty/loading/error UI, bounds measurement and cleanup |
| `src/router/index.ts`, `src/App.vue` | Route and sidebar entry; reading-width sidebar state |
| `src/tests/webPreviewUrl.test.ts` | URL policy cases |
| `src/tests/webPreviewController.test.ts` | Native controller behavior through Electron fakes |
| `src/tests/webPreviewView.test.ts` | User-visible Vue interaction and cleanup |

### Task 1: Shared URL policy

**Files:**
- Create: `src/utils/webPreviewUrl.ts`
- Create: `src/tests/webPreviewUrl.test.ts`

**Interfaces:**
- Produces: `normalizePreviewUrl(input: string): string`, `isAllowedPreviewUrl(url: string): boolean`, `isAllowedExternalUrl(url: string): boolean`.
- These are imported by the Vue page and the main-process controller. Normalization is for user input only; navigation checks receive absolute URLs.

- [ ] **Step 1: Write failing behavior tests.** In `src/tests/webPreviewUrl.test.ts`, assert literal outputs and rejection:

```ts
expect(normalizePreviewUrl('  example.org/article  ')).toBe('https://example.org/article')
expect(normalizePreviewUrl('https://example.org/#section')).toBe('https://example.org/#section')
expect(() => normalizePreviewUrl('http://example.org')).toThrow('仅支持 HTTPS 链接')
expect(() => normalizePreviewUrl('https://user:pass@example.org')).toThrow()
expect(isAllowedPreviewUrl('https://example.org/next')).toBe(true)
expect(isAllowedPreviewUrl('file:///tmp/test.html')).toBe(false)
expect(isAllowedPreviewUrl('https://user@example.org')).toBe(false)
expect(isAllowedExternalUrl('http://example.org')).toBe(true)
expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false)
```

- [ ] **Step 2: Run `npx vitest run src/tests/webPreviewUrl.test.ts`; confirm missing module/export failure.**
- [ ] **Step 3: Implement the pure URL functions.** Trim input; add `https://` only when the input has no scheme; parse with `new URL`; require hostname and no username/password. Preview checks require `https:`; external checks allow `http:` or `https:`. Preserve path, query, and fragment via `URL.href`. Return a clear error for empty or malformed input.
- [ ] **Step 4: Run the focused test, `npm run typecheck`, then commit `feat: validate HTML preview URLs`.**

### Task 2: Isolated native preview controller and bridge

**Files:**
- Create: `electron/webPreview.ts`
- Create: `src/types/webPreview.d.ts`
- Create: `src/tests/webPreviewController.test.ts`
- Modify: `electron/main.ts`
- Modify: `electron/ipc.ts`
- Modify: `electron/preload.ts`

**Interfaces:**
- Consumes: URL policy from Task 1.
- Produces renderer API:

```ts
interface PreviewBounds { x: number; y: number; width: number; height: number }
interface PreviewState {
  url: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  error: string
  visible: boolean
}
interface PreviewApi {
  open(url: string, bounds: PreviewBounds): Promise<void>
  setBounds(bounds: PreviewBounds): Promise<void>
  back(): Promise<void>
  forward(): Promise<void>
  reload(): Promise<void>
  close(): Promise<void>
  openExternal(url: string): Promise<void>
  onState(callback: (state: PreviewState) => void): () => void
}
```

- [ ] **Step 1: Write failing controller tests with a fake window and fake native view.** The fake must record `contentView.addChildView/removeChildView`, bounds, `loadURL`, `close`, emitted navigation events and sent state. Assert: one view per window; HTTPS redirect allowed; HTTP/`file:` redirect prevented; allowed new-window target loaded into the same view; forbidden target ignored; permission and download requests denied; an old `did-fail-load` after a newer open is ignored; close removes and destroys the view; oversized or negative bounds are clamped to window content size. Start with this observable contract and add one test per remaining behavior:

```ts
const controller = registerPreviewWindow(fakeWindow as unknown as BrowserWindow)
await controller.open('https://example.org/start', { x: 80, y: 64, width: 700, height: 500 })
expect(fakeWindow.contentView.addChildView).toHaveBeenCalledTimes(1)
const event = { preventDefault: vi.fn(), url: 'http://example.org/plain', isMainFrame: true }
fakeContents.emit('will-redirect', event)
expect(event.preventDefault).toHaveBeenCalledTimes(1)
expect(fakeContents.loadURL).toHaveBeenCalledTimes(1)
```
- [ ] **Step 2: Run `npx vitest run src/tests/webPreviewController.test.ts`; confirm expected missing-controller failure.**
- [ ] **Step 3: Implement `electron/webPreview.ts`.** Use `WeakMap<BrowserWindow, PreviewController>` for per-window ownership. `registerPreviewWindow(win)` admits only the app's own renderer; `unregisterPreviewWindow(win)` closes its native view. Create the remote view with these explicit security settings, and validate every URL before loading:

```ts
const partition = 'papermind-preview'
const previewSession = session.fromPartition(partition)
previewSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
const view = new WebContentsView({
  webPreferences: {
    partition,
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
  },
})
view.webContents.setWindowOpenHandler(({ url }) => {
  if (isAllowedPreviewUrl(url)) queueMicrotask(() => void view.webContents.loadURL(url))
  return { action: 'deny' }
})
```

Register `will-navigate`, `will-redirect`, `did-navigate`, `did-navigate-in-page`, loading, and main-frame failure listeners. Cancel disallowed navigation, deny permission and download requests, and ignore aborted or stale failures by comparing the event URL with the current target.
- [ ] **Step 4: Add IPC and preload wiring.** `electron/ipc.ts` validates `event.sender === win.webContents` for a registered app window before dispatching `preview:*` channels. `electron/preload.ts` exposes `window.preview` with the signatures above; `onState` removes its listener when called. `src/types/webPreview.d.ts` declares the matching global API. `electron/main.ts` registers the created BrowserWindow and disposes it on `closed`. Use a narrow subscription, not an exposed `ipcRenderer`:

```ts
onState: (callback: (state: PreviewState) => void) => {
  const listener = (_event: Electron.IpcRendererEvent, state: PreviewState) => callback(state)
  ipcRenderer.on('preview:state', listener)
  return () => ipcRenderer.removeListener('preview:state', listener)
},
```
- [ ] **Step 5: Run focused controller tests and `npm run typecheck`; commit `feat: isolate HTML preview in Electron`.**

### Task 3: Preview page and route integration

**Files:**
- Create: `src/views/WebPreviewView.vue`
- Create: `src/tests/webPreviewView.test.ts`
- Modify: `src/router/index.ts`
- Modify: `src/App.vue`
- Modify: `src/tests/setup.ts`

**Interfaces:**
- Consumes: `window.preview` from Task 2 and `normalizePreviewUrl` from Task 1.
- Produces: route `/web-preview` and sidebar item “网页预览”.

- [ ] **Step 1: Write failing Vue tests.** Mount the real page with a complete `window.preview` fake. Assert: paste or type a domain and Enter calls `open` with normalized HTTPS URL and the measured slot bounds; invalid HTTP input displays the inline error without calling `open`; state events update the address and back/forward disabled states; edits in progress are not overwritten by state events until Enter or Escape; buttons call back/forward/reload/external commands; unmount calls `close` and unsubscribes. Start with a user interaction:

```ts
const wrapper = mount(WebPreviewView)
await wrapper.get('[aria-label="网页地址"]').setValue(' example.org/article ')
await wrapper.get('[aria-label="网页地址"]').trigger('keydown.enter')
expect(window.preview.open).toHaveBeenCalledWith(
  'https://example.org/article',
  expect.objectContaining({ width: expect.any(Number), height: expect.any(Number) }),
)
```

Check narrow-window geometry during native acceptance rather than snapshotting CSS text.
- [ ] **Step 2: Run `npx vitest run src/tests/webPreviewView.test.ts`; confirm missing-page failure.**
- [ ] **Step 3: Build the page and integrate navigation.** Add `/web-preview` to `src/router/index.ts` and a sidebar link in `src/App.vue`; include this route in the compact reading-sidebar condition. The view contains a quiet single-row toolbar (back, forward, address, reload, external) and a rectangular slot with approximately 12px reader-background gutter. Use `ResizeObserver` plus window resize to report slot bounds; subscribe to preview state on mount and close/unsubscribe on unmount. Keep toolbars in Vue DOM above the native view. The empty state is “粘贴 HTTPS 链接，按 Enter 预览原网页”; loading uses one thin line; failures show reason, retry and external-open actions. At about 520px, wrap the address and controls into two rows. The essential lifecycle is:

```ts
onMounted(() => {
  unsubscribe = window.preview.onState(next => { previewState.value = next })
  observer = new ResizeObserver(() => void syncBounds())
  observer.observe(previewSlot.value!)
})
onBeforeUnmount(() => {
  observer?.disconnect()
  unsubscribe?.()
  void window.preview.close()
})
```
- [ ] **Step 4: Run focused Vue tests, `npm run typecheck`, and `npm test`; commit `feat: add HTML preview page`.**

### Task 4: Native acceptance and final verification

**Files:**
- Modify only if a verified issue is found in Tasks 1–3.

**Interfaces:**
- Consumes the complete route, bridge and controller from Tasks 1–3.
- Produces a reviewable running preview and a verified branch.

- [ ] **Step 1: Start `npm run dev` and open `/web-preview`.** Check an HTTPS technical blog with a table of contents, code blocks and client scripts. Confirm the site is rendered as-is and that the URL updates after internal links.
- [ ] **Step 2: Verify navigation and states.** Check back/forward/reload, a new-window HTTPS link, HTTP input, offline or invalid host, external open, route exit, and a narrow window. Inspect whether the native view ever overlaps the toolbar or sidebar.
- [ ] **Step 3: If acceptance reveals a defect, write the smallest failing regression test, fix it, and rerun the relevant focused tests.**
- [ ] **Step 4: Run `npm run typecheck`, `npm test`, and `git diff --check`. Inspect `git status --short --branch` and the final diff. Present the running result and any limits for the user's final review.**
