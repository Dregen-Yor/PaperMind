# Official Docling Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every production Docling local/SSH path with one project-owned HTTPS service contract while leaving ordinary users able to configure only their API Key.

**Architecture:** A checked-in, strictly validated `config/docling-service.json` is the sole source for the official endpoint, 60-second timeout, and OCR/formula/table/layout/image options. User SQLite state is reduced to `DoclingCredentials`, and Electron combines credentials with the immutable official contract at the network boundary; renderer IPC cannot supply endpoint or conversion parameters.

**Tech Stack:** TypeScript, Vue 3, Pinia, Electron IPC/contextBridge, Vitest, Node test runner, JSON configuration, SQLite settings.

**Spec:** `docs/superpowers/specs/2026-11-16-official-docling-service-design.md`

## Global Constraints

- The only production endpoint is `https://docling.example.com`; no local, SSH, proxy-discovery, or fallback path may remain.
- The official timeout is exactly 60 seconds and is not user-editable.
- OCR, formula, table, layout, and image conversion options are immutable project configuration.
- The only user-editable Docling field is `apiKey`, persisted under the compatible `docling_config` settings key.
- API keys must never enter project config, logs, error messages, or default backups.
- Web HTML/MHTML parsing remains local and outside the Docling path.
- Existing PDF/response/image size limits, concurrency limits, schema versions, E-k5 contracts, and benchmark contracts remain code constants.
- Use Node `24.22.1` and npm 10; do not bypass `scripts/check-runtime.mjs`.
- Preserve unrelated worktrees and the main worktree's untracked `docs/guides/` files.

## Review Focus

- A legacy `docling_config` object containing URL, timeout, OCR, and formula fields must retain only its trimmed API Key without letting legacy fields affect requests; Task 3 pins this migration.
- A nested or differently cased secret-looking key in the checked-in config must fail validation instead of evading the top-level check; Task 1 pins recursive sensitive-key rejection.
- An unavailable placeholder endpoint must produce an explicit official-service error and never call SSH/local fallback code; Task 2 pins the failure path and Task 5 scans for regressions.
- Editing an unsaved API Key must still trigger route/window-leave protection, while late store initialization must not overwrite the edit; Task 4 pins both interactions.
- Normal conversion and summary conversion must emit identical official OCR/formula/table/layout/image fields, while retaining their distinct partial-success semantics; Task 2 pins the multipart contract.

---

### Task 1: Official Configuration Contract

**Files:**
- Create: `config/docling-service.json`
- Create: `src/types/doclingConfig.ts`
- Create: `src/utils/doclingConfig.ts`
- Create: `src/tests/doclingConfig.test.ts`

**Interfaces:**
- Produces: `DoclingCredentials`, `OfficialDoclingConfig`, `normalizeDoclingCredentials(value: unknown): DoclingCredentials`, `parseOfficialDoclingConfig(value: unknown): Readonly<OfficialDoclingConfig>`, and `OFFICIAL_DOCLING_CONFIG`.
- Coexists temporarily with the old `DoclingSettings` exports so this commit remains type-correct; Task 3 removes those exports after all consumers migrate.

- [ ] **Step 1: Write failing configuration and migration tests**

Create `src/tests/doclingConfig.test.ts` with explicit contract cases:

```ts
import { describe, expect, it } from 'vitest'
import {
  OFFICIAL_DOCLING_CONFIG,
  normalizeDoclingCredentials,
  parseOfficialDoclingConfig,
} from '../utils/doclingConfig'

const valid = () => structuredClone(OFFICIAL_DOCLING_CONFIG)

describe('official Docling configuration', () => {
  it('ships the official endpoint, timeout, and fixed parser capabilities', () => {
    expect(OFFICIAL_DOCLING_CONFIG).toMatchObject({
      schemaVersion: 1,
      baseUrl: 'https://docling.example.com',
      timeoutSeconds: 60,
      conversion: {
        fromFormat: 'pdf', toFormat: 'json', targetType: 'inbody',
        imageExportMode: 'embedded', includeImages: true, imageScale: 2,
        ocr: { enabled: true, engine: 'rapidocr', preset: 'rapidocr' },
        formula: { enabled: true, preset: 'codeformulav2' },
        table: { enabled: true, mode: 'accurate', preset: 'tableformer_v1_accurate' },
        layoutPreset: 'layout_heron_default',
      },
    })
    expect(Object.isFrozen(OFFICIAL_DOCLING_CONFIG)).toBe(true)
  })

  it.each([
    ['http URL', { baseUrl: 'http://docling.example.com' }],
    ['loopback IP', { baseUrl: 'https://127.0.0.1' }],
    ['private IP', { baseUrl: 'https://10.0.0.8' }],
    ['credentials in URL', { baseUrl: 'https://user:pass@docling.example.com' }],
    ['wrong timeout', { timeoutSeconds: 61 }],
    ['unknown field', { extra: true }],
  ])('rejects %s', (_label, patch) => {
    expect(() => parseOfficialDoclingConfig({ ...valid(), ...patch })).toThrow()
  })

  it.each([
    { apiKey: 'secret' },
    { conversion: { ...valid().conversion, token: 'secret' } },
    { conversion: { ...valid().conversion, nested: { clientSecret: 'secret' } } },
  ])('rejects sensitive or unknown config fields recursively', value => {
    expect(() => parseOfficialDoclingConfig({ ...valid(), ...value })).toThrow()
  })

  it('migrates legacy settings to API-key-only credentials', () => {
    expect(normalizeDoclingCredentials({
      apiKey: '  key  ', baseUrl: 'http://127.0.0.1:5001',
      timeoutSeconds: 600, ocr: false, formula: false,
    })).toEqual({ apiKey: 'key' })
    expect(normalizeDoclingCredentials(null)).toEqual({ apiKey: '' })
    expect(() => normalizeDoclingCredentials({ apiKey: 42 })).toThrow('API Key')
  })
})
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
npm exec vitest run src/tests/doclingConfig.test.ts
```

Expected: FAIL because `doclingConfig.ts`, its types, and the official JSON do not exist and the old deployment-settings exports are still present.

- [ ] **Step 3: Add the immutable config, types, and strict validator**

Create `config/docling-service.json` exactly from section 4.1 of the spec. Define focused types in `src/types/doclingConfig.ts`:

```ts
export interface DoclingCredentials { apiKey: string }

export interface OfficialDoclingConfig {
  schemaVersion: 1
  baseUrl: string
  timeoutSeconds: 60
  conversion: {
    fromFormat: 'pdf'
    toFormat: 'json'
    targetType: 'inbody'
    imageExportMode: 'embedded'
    includeImages: true
    imageScale: 2
    ocr: { enabled: true; engine: 'rapidocr'; preset: 'rapidocr' }
    formula: { enabled: true; preset: 'codeformulav2' }
    table: { enabled: true; mode: 'accurate'; preset: 'tableformer_v1_accurate' }
    layoutPreset: 'layout_heron_default'
  }
}
```

In `src/utils/doclingConfig.ts`, import the JSON, recursively reject unknown/sensitive keys, validate the exact literals, validate the HTTPS root URL, reject private/reserved literal IP ranges, deep-freeze the result, and export:

```ts
export function normalizeDoclingCredentials(value: unknown): DoclingCredentials
export function parseOfficialDoclingConfig(value: unknown): Readonly<OfficialDoclingConfig>
export const OFFICIAL_DOCLING_CONFIG = parseOfficialDoclingConfig(rawConfig)
```

Keep this module deterministic and browser-safe: do not import Node networking APIs. Implement literal-IP classification as a pure helper and cover IPv4 plus loopback/link-local/unique-local IPv6 spellings in tests.

Export `DOCLING_SETTINGS_KEY = 'docling_config'` from `doclingConfig.ts`. Do not remove the old export from `doclingDocument.ts` in this task; Task 3 updates all imports and removes the duplicate with the legacy types.

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```bash
npm exec vitest run src/tests/doclingConfig.test.ts
npm run typecheck
```

Expected: the focused test and typecheck PASS. The old settings API remains available during this compatibility step.

- [ ] **Step 5: Commit the configuration contract**

```bash
git add config/docling-service.json src/types/doclingConfig.ts src/utils/doclingConfig.ts src/tests/doclingConfig.test.ts
git diff --cached --check
git commit -m 'refactor(docling): 集中官方服务配置'
```

### Task 2: Official HTTP Client and SSH Removal

**Files:**
- Modify: `electron/doclingClient.ts`
- Modify: `electron/main.ts`
- Delete: `electron/doclingTunnel.ts`
- Modify: `src/tests/doclingClient.test.ts`
- Modify: `src/tests/doclingClient.security.test.ts`
- Modify: `src/tests/doclingSummary.test.ts`
- Delete: `src/tests/doclingTunnel.test.ts`

**Interfaces:**
- Consumes: `DoclingCredentials`, `OFFICIAL_DOCLING_CONFIG` from Task 1.
- Produces: `convertPdf(bytes, fileName, credentials, request?)`, `convertPdfForSummary(bytes, fileName, credentials, request?)`, and `testDoclingConnection(credentials, request?)` with no connect/tunnel dependency.
- Preserves: ordinary conversion accepts `partial_success` with a warning; summary conversion rejects it.

- [ ] **Step 1: Rewrite client tests around the official request contract**

Use a mocked `fetch` and inspect the `FormData` passed to it:

```ts
const credentials = { apiKey: 'official-key' }
const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({
  status: 'success', document: { json_content: { texts: [{ text: 'Evidence' }] } },
}), { status: 200, headers: { 'content-type': 'application/json' } }))

await convertPdf(new Uint8Array([37, 80, 68, 70]), 'paper.pdf', credentials, request)
expect(request.mock.calls[0][0]).toBe('https://docling.example.com/v1/convert/file')
expect(request.mock.calls[0][1]).toMatchObject({ method: 'POST', redirect: 'error' })
expect(new Headers(request.mock.calls[0][1].headers).get('X-Api-Key')).toBe('official-key')

const body = request.mock.calls[0][1].body as FormData
expect(Object.fromEntries(body.entries())).toMatchObject({
  from_formats: 'pdf', to_formats: 'json', target_type: 'inbody',
  image_export_mode: 'embedded', include_images: 'true', images_scale: '2',
  do_ocr: 'true', ocr_engine: 'rapidocr', ocr_preset: 'rapidocr',
  do_formula_enrichment: 'true', code_formula_preset: 'codeformulav2',
  do_table_structure: 'true', table_mode: 'accurate',
  table_structure_preset: 'tableformer_v1_accurate',
  layout_preset: 'layout_heron_default', document_timeout: '60',
})
```

Add paired assertions for `convertPdfForSummary` proving the same multipart fields. Keep existing tests for authentication errors, invalid JSON, response limits, timeout, and distinct partial-success behavior. Change the timeout fake-timer expectation to 60,000 ms. Assert connection testing calls `https://docling.example.com/openapi.json` and never invokes a connector callback.

- [ ] **Step 2: Run the client tests and verify they fail**

Run:

```bash
npm exec vitest run src/tests/doclingClient.test.ts src/tests/doclingClient.security.test.ts src/tests/doclingSummary.test.ts src/tests/doclingTunnel.test.ts
```

Expected: FAIL because the client still uses caller-supplied settings and the tunnel test/module still exist.

- [ ] **Step 3: Refactor the client and delete the tunnel**

In `electron/doclingClient.ts`:

```ts
type Request = typeof fetch

async function requestJson(
  path: string,
  credentials: DoclingCredentials,
  init: RequestInit,
  request: Request,
): Promise<unknown> {
  const config = OFFICIAL_DOCLING_CONFIG
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutSeconds * 1000)
  // Preserve runtime security gate, concurrency limit, redirect:error,
  // bounded JSON parsing, redacted errors, and finally cleanup.
}
```

Build all multipart fields from `OFFICIAL_DOCLING_CONFIG.conversion`; do not leave preset literals in the client. Remove `Connect`, `ensureManagedDoclingTunnel`, default connector parameters, and the test-only 30-second override. Delete `electron/doclingTunnel.ts` and `src/tests/doclingTunnel.test.ts`. Remove `stopManagedDoclingTunnel` and the `before-quit` hook from `electron/main.ts`.

- [ ] **Step 4: Run focused tests and the startup suite**

Run:

```bash
npm exec vitest run src/tests/doclingClient.test.ts src/tests/doclingClient.security.test.ts src/tests/doclingSummary.test.ts src/tests/singleInstanceStartup.test.ts
npm run typecheck
```

Expected: PASS and no module import references `doclingTunnel`.

- [ ] **Step 5: Commit the network-boundary change**

```bash
git add electron/doclingClient.ts electron/main.ts src/tests/doclingClient.test.ts src/tests/doclingClient.security.test.ts src/tests/doclingSummary.test.ts
git add -u -- electron/doclingTunnel.ts src/tests/doclingTunnel.test.ts
git diff --cached --check
git commit -m 'refactor(docling): 仅使用官方 HTTPS 服务'
```

### Task 3: Credentials Persistence, Cache Identity, and IPC

**Files:**
- Modify: `electron/docling.ts`
- Modify: `electron/summaryParsing.ts`
- Modify: `electron/ipc.ts`
- Modify: `electron/preload.ts`
- Modify: `electron/db/backupValidation.ts`
- Modify: `electron/db/index.ts`
- Modify: `src/types/ipcContract.ts`
- Modify: `src/utils/doclingDocument.ts`
- Modify: `src/stores/chat.ts`
- Modify: `src/tests/setup.ts`
- Modify: `src/tests/doclingFacade.test.ts`
- Modify: `src/tests/summaryParsing.test.ts`
- Modify: `src/tests/chat.docling.test.ts`
- Modify: `src/tests/chat.store.test.ts`
- Modify: `src/tests/backupSettingsValidation.test.ts`
- Modify: `src/tests/doclingDocument.test.ts`
- Modify: `src/tests/ipcContract.scenario.test.ts`
- Modify: `src/tests/exportSanitize.test.ts`

**Interfaces:**
- Consumes: Task 1 credentials/config and Task 2 client signatures.
- Produces: `setDoclingCredentials(value: DoclingCredentials)`, `doclingCredentials`, and `docling:testConnection(credentials)`.
- Produces: `normalizeSettingForImport(row: { key: string; value: string }): { key: string; value: string }` for backup restore.
- Cache identity: SHA-256 over `{ pipelineVersion, officialConfig }`, never over legacy user URL/options.

- [ ] **Step 1: Add failing migration, cache, and IPC tests**

Pin these behaviors:

```ts
expect(normalizeSettingForImport({
  key: 'docling_config',
  value: JSON.stringify({
    apiKey: ' key ', baseUrl: 'http://127.0.0.1:5001',
    timeoutSeconds: 600, ocr: false, formula: false,
  }),
})).toEqual({ key: 'docling_config', value: JSON.stringify({ apiKey: 'key' }) })
```

Add and directly test the exported `normalizeSettingForImport` helper in `backupValidation.ts`; `importAll` must call it before inserting every settings row. Update store tests so initialization with the legacy object yields `store.doclingCredentials.apiKey === 'key'`, and saving emits exactly:

```ts
expect(window.db.settings.set).toHaveBeenCalledWith('docling_config', { apiKey: 'new-key' })
```

Update facade/summary tests so changing the legacy URL/options does not change request inputs, while changing `config/docling-service.json` identity in an injected test config changes `configHash` / `parserKey`. Update IPC tests to reject a payload containing `baseUrl` or `timeoutSeconds` and accept `{ apiKey: 'key' }`.

- [ ] **Step 2: Run focused tests and verify they fail**

Run:

```bash
npm exec vitest run src/tests/doclingFacade.test.ts src/tests/summaryParsing.test.ts src/tests/chat.docling.test.ts src/tests/chat.store.test.ts src/tests/backupSettingsValidation.test.ts src/tests/doclingDocument.test.ts src/tests/ipcContract.scenario.test.ts src/tests/exportSanitize.test.ts
```

Expected: FAIL because the old settings object still controls endpoint/options and the IPC accepts `DoclingSettings`.

- [ ] **Step 3: Narrow persistence and IPC to credentials**

Refactor dependency names from `getSettings` to `getCredentials`. At every DB read, call `normalizeDoclingCredentials(settingsApi.get(DOCLING_SETTINGS_KEY))`. Remove `DoclingSettings`, `DEFAULT_DOCLING_SETTINGS`, and `normalizeDoclingSettings` from `doclingDocument.ts`, move all key imports to `doclingConfig.ts`, and replace the old deployment-settings test with an assertion that document normalization is independent of credentials. Update the contract:

```ts
docling: {
  convert: (paperId: string) => Promise<DoclingRecord>
  save: (paperId: string, record: DoclingRecord) => Promise<DoclingRecord>
  readAsset: (id: string) => Promise<string | null>
  testConnection: (credentials: DoclingCredentials) => Promise<string>
}
```

In the store, replace `doclingConfig`/`setDoclingConfig` with:

```ts
const doclingCredentials = ref<DoclingCredentials>({ apiKey: '' })

async function setDoclingCredentials(value: DoclingCredentials) {
  const credentials = normalizeDoclingCredentials(value)
  await window.db.settings.set(DOCLING_SETTINGS_KEY, credentials)
  doclingCredentials.value = credentials
  doclingConfigError.value = ''
}
```

Make `normalizeSettingForImport` strip legacy fields and trim the key, and call it from `electron/db/index.ts` before settings insertion. Keep `stripApiKeysFromSettings` compatible with `{ apiKey }` and legacy objects. Export `officialDoclingConfigHash(config: OfficialDoclingConfig = OFFICIAL_DOCLING_CONFIG): string` so facade/parser cache tests can prove that official config changes alter identity.

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```bash
npm exec vitest run src/tests/doclingFacade.test.ts src/tests/summaryParsing.test.ts src/tests/chat.docling.test.ts src/tests/chat.store.test.ts src/tests/backupSettingsValidation.test.ts src/tests/doclingDocument.test.ts src/tests/ipcContract.scenario.test.ts src/tests/exportSanitize.test.ts
npm run typecheck
```

Expected: PASS with no `DoclingSettings`, `normalizeDoclingSettings`, or `DEFAULT_DOCLING_SETTINGS` references in production or test source.

- [ ] **Step 5: Commit credentials and IPC migration**

```bash
git add electron/docling.ts electron/summaryParsing.ts electron/ipc.ts electron/preload.ts electron/db/backupValidation.ts electron/db/index.ts src/types/ipcContract.ts src/utils/doclingDocument.ts src/stores/chat.ts src/tests/setup.ts src/tests/doclingFacade.test.ts src/tests/summaryParsing.test.ts src/tests/chat.docling.test.ts src/tests/chat.store.test.ts src/tests/backupSettingsValidation.test.ts src/tests/doclingDocument.test.ts src/tests/ipcContract.scenario.test.ts src/tests/exportSanitize.test.ts
git diff --cached --check
git commit -m 'refactor(docling): 分离官方配置与用户凭据'
```

### Task 4: API-Key-Only Settings Experience

**Files:**
- Modify: `src/views/SettingsView.vue`
- Modify: `src/views/CLAUDE.md`
- Modify: `src/tests/settings.recovery.test.ts`
- Create: `src/tests/settingsViewDocling.test.ts`

**Interfaces:**
- Consumes: `OFFICIAL_DOCLING_CONFIG`, `chatStore.doclingCredentials`, and `setDoclingCredentials` from earlier tasks.
- Produces: an API-key-only form with `data-test="docling-api-key"`, `data-test="docling-save"`, and `data-test="docling-test"`.

- [ ] **Step 1: Write failing UI and unsaved-edit tests**

Create `settingsViewDocling.test.ts` assertions:

```ts
expect(wrapper.text()).toContain('官方 Docling 文档解析服务')
expect(wrapper.text()).toContain('https://docling.example.com')
expect(wrapper.text()).toContain('PDF、OCR、公式和表格')
expect(wrapper.find('[data-test="docling-base-url"]').exists()).toBe(false)
expect(wrapper.find('[data-test="docling-timeout"]').exists()).toBe(false)
expect(wrapper.find('[data-test="docling-ocr"]').exists()).toBe(false)
expect(wrapper.find('[data-test="docling-formula"]').exists()).toBe(false)
expect(wrapper.find('[data-test="docling-table"]').exists()).toBe(false)

await wrapper.get('[data-test="docling-api-key"] input').setValue('candidate-key')
await wrapper.get('[data-test="docling-save"]').trigger('click')
expect(store.setDoclingCredentials).toHaveBeenCalledWith({ apiKey: 'candidate-key' })

await wrapper.get('[data-test="docling-test"]').trigger('click')
expect(window.db.docling.testConnection).toHaveBeenCalledWith({ apiKey: 'candidate-key' })
```

Rewrite `settings.recovery.test.ts` to edit `docling-api-key` instead of the URL. Retain tests for route leave, window close, failed save, and late initialization not overwriting an unsaved edit.

- [ ] **Step 2: Run settings tests and verify they fail**

Run:

```bash
npm exec vitest run src/tests/settingsViewDocling.test.ts src/tests/settings.recovery.test.ts
```

Expected: FAIL because the old URL/timeout/checkbox form still exists and store method names differ.

- [ ] **Step 3: Implement the API-key-only card**

Use a local reactive credentials object, not a copy of deployment settings:

```ts
const doclingLocal = reactive<DoclingCredentials>({ apiKey: '' })
const doclingDirty = computed(() =>
  doclingLocal.apiKey !== chatStore.doclingCredentials.apiKey,
)

async function saveDocling() {
  await chatStore.setDoclingCredentials({ apiKey: doclingLocal.apiKey })
}

async function testDocling() {
  const result = await window.db.docling.testConnection({ apiKey: doclingLocal.apiKey.trim() })
  ElMessage.success(result)
}
```

Display `OFFICIAL_DOCLING_CONFIG.baseUrl` read-only. Remove URL, timeout, OCR, formula, and table controls and their mutations. Explicitly tell users that PDFs and extracted OCR/formula/table content are sent to the official service. Keep password masking, unsaved-change guards, save failure state, and the connection-test error surface.

- [ ] **Step 4: Run settings tests and accessibility-adjacent suites**

Run:

```bash
npm exec vitest run src/tests/settingsViewDocling.test.ts src/tests/settings.recovery.test.ts src/tests/chatInteraction.test.ts
```

Expected: PASS; only the API Key is editable and all unsaved-change behavior remains.

- [ ] **Step 5: Commit the settings experience**

```bash
git add src/views/SettingsView.vue src/views/CLAUDE.md src/tests/settingsViewDocling.test.ts src/tests/settings.recovery.test.ts
git diff --cached --check
git commit -m 'feat(settings): 仅开放官方 Docling API Key'
```

### Task 5: Regression Guard and Architecture Documentation

**Files:**
- Create: `scripts/tests/docling-production-config.test.mjs`
- Modify: `package.json`
- Create: `docs/architecture/configuration.md`
- Modify: `docs/architecture/overview.md`
- Modify: `docs/architecture/modules.md`
- Modify: `docs/architecture/data-flow.md`
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`
- Modify: `electron/CLAUDE.md`
- Modify: `src/CLAUDE.md`
- Modify: `src/stores/CLAUDE.md`
- Modify: `src/utils/CLAUDE.md`

**Interfaces:**
- Consumes: final production file layout and names from Tasks 1–4.
- Produces: a Node test that prevents local/SSH/private Docling behavior from returning and documentation matching the shipped architecture.

- [ ] **Step 1: Write the failing production-source scan**

Create `scripts/tests/docling-production-config.test.mjs` using `node:test` and `readFileSync`. Scan production files, not fixtures, for forbidden behavior:

```js
const forbidden = [
  /doclingTunnel|ensureManagedDoclingTunnel|stopManagedDoclingTunnel/,
  /SSH_HOST|ExitOnForwardFailure|ServerAliveInterval/,
  /http:\/\/(?:127\.0\.0\.1|localhost):5001/,
  /101\.76\.222\.(?:151|224)/,
]

const productionFiles = [
  'electron/main.ts',
  'electron/doclingClient.ts',
  'electron/docling.ts',
  'electron/summaryParsing.ts',
  'electron/ipc.ts',
  'src/utils/doclingConfig.ts',
  'src/utils/doclingDocument.ts',
  'src/stores/chat.ts',
  'src/views/SettingsView.vue',
]

test('production Docling uses only the official service contract', () => {
  for (const file of productionFiles) {
    const source = readFileSync(file, 'utf8')
    for (const pattern of forbidden) assert.doesNotMatch(source, pattern, `${file}: ${pattern}`)
  }
})

test('the settings view exposes only API-key controls', () => {
  const source = readFileSync('src/views/SettingsView.vue', 'utf8')
  assert.match(source, /docling-api-key/)
  assert.doesNotMatch(source, /docling-base-url|docling-timeout|docling-ocr|docling-formula|docling-table/)
})
```

Register a dedicated script and include it in the full test chain:

```json
"test:architecture": "node --test scripts/tests/docling-production-config.test.mjs",
"test": "vitest run && npm run test:branding && npm run test:architecture"
```

- [ ] **Step 2: Run the guard and verify it fails before final cleanup**

Run:

```bash
npm run test:architecture
```

Expected: FAIL if any stale tunnel/private/local production reference remains. Use the output to remove only genuine production references; keep loopback fixture URLs in tests.

- [ ] **Step 3: Update architecture and configuration documentation**

Create `docs/architecture/configuration.md` with three tables:

1. Project-maintained official Docling fields and their source (`config/docling-service.json`).
2. User-maintained secrets (`docling_config.apiKey`) and backup behavior.
3. Intentional constants: protocol/schema versions, size/concurrency/security limits, E-k5 contract, benchmark contract, and UI timing/layout values.

Update architecture data flow to:

```text
Settings API Key → SQLite credentials
PDF parse → official config + credentials → HTTPS official service
          → normalized document → cache/summary
```

Remove all SSH/default-loopback wording from root and module instructions. Record that web HTML/MHTML parsing remains local and that `https://docling.example.com` is a placeholder official endpoint not expected to succeed until deployment.

- [ ] **Step 4: Run documentation and regression checks**

Run:

```bash
npm run test:architecture
git diff --check
rg -n 'doclingTunnel|SSH_HOST|101\.76\.222\.(151|224)|http://(127\.0\.0\.1|localhost):5001' electron src docs/architecture AGENTS.md CLAUDE.md --glob '!src/tests/**'
```

Expected: architecture test PASS; `git diff --check` has no output; `rg` has no production/documentation matches.

- [ ] **Step 5: Commit the regression guard and documentation**

```bash
git add scripts/tests/docling-production-config.test.mjs package.json docs/architecture/configuration.md docs/architecture/overview.md docs/architecture/modules.md docs/architecture/data-flow.md AGENTS.md CLAUDE.md electron/CLAUDE.md src/CLAUDE.md src/stores/CLAUDE.md src/utils/CLAUDE.md
git diff --cached --check
git commit -m 'docs(architecture): 记录官方 Docling 配置边界'
```

### Task 6: Whole-Branch Verification and Review

**Files:**
- Verify only; modify files only to address a demonstrated failure within this plan's scope.

**Interfaces:**
- Consumes: all earlier task commits.
- Produces: validation evidence for the complete branch against the approved spec.

- [ ] **Step 1: Verify branch scope and history**

Run:

```bash
git status --short --branch
git log --oneline origin/main..HEAD
git diff --stat origin/main...HEAD
git diff origin/main...HEAD
```

Expected: only the approved official-Docling implementation, tests, configuration, and documentation are present; no unrelated `docs/guides/` content appears.

- [ ] **Step 2: Run static validation**

Run:

```bash
npm run typecheck
git diff --check origin/main...HEAD
```

Expected: PASS with no TypeScript or whitespace errors.

- [ ] **Step 3: Run the complete test suite**

Run on Node 24.22.1. On macOS environments where `os.tmpdir()` returns the `/var` symlink while production path checks return `/private/var`, use the canonical equivalent temporary directory as in the established baseline command:

```bash
env TMPDIR=/private/tmp npm test
```

Expected: all Vitest, branding, runtime-security, and architecture tests PASS; `desktop-file-validate` may remain skipped when it is not installed.

- [ ] **Step 4: Run the production build check**

Run:

```bash
npm run build
```

Expected: runtime gate, icon checks, typecheck, Vite/Electron bundle, and installer generation complete successfully. The build must not contact `https://docling.example.com`.

- [ ] **Step 5: Inspect secrets and final staged state**

Run:

```bash
git status --short
git grep -n -I -E 'BEGIN (RSA|OPENSSH|EC|DSA) PRIVATE KEY|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}' HEAD -- . ':(exclude)src/tests' ':(exclude)bench/src/tests'
```

Expected: clean working tree and no credential matches. `https://docling.example.com` is public configuration, not a secret.

- [ ] **Step 6: Review against the ten acceptance criteria**

Read `docs/superpowers/specs/2026-11-16-official-docling-service-design.md` and confirm each numbered acceptance criterion with a code location and test result. If any criterion lacks evidence, add the missing focused test and implementation in the owning task's commit scope before delivery.
