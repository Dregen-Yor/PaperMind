# Docling Illustrated Abstract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. User requests native implementation in the current session and branch.

**Goal:** Generate detailed Chinese paper explanations with original PDF figures, tables, formulas, and verified page references through `/abstract`.

**Architecture:** Electron calls configurable docling-serve and persists normalized documents and immutable SQLite image assets. PDF.js recovers source-region crops; the existing chat model generates bounded evidence summaries and a final Markdown explanation using validated item IDs. A Vue Markdown component resolves assets through IPC and emits existing PDF navigation events.

**Tech Stack:** TypeScript, Vue 3, Pinia, Electron, better-sqlite3, PDF.js, Markdown-it, KaTeX, Vitest.

## File ownership

- `src/utils/doclingDocument.ts`: shared settings, document contracts, Docling JSON normalization and bbox mapping.
- `electron/doclingClient.ts`: HTTP upload, OpenAPI connectivity, timeout and Chinese errors.
- `electron/db/docling.ts`: injected SQLite repository for atomic manifests, BLOB assets and backups.
- `electron/docling.ts`: convert/save facade, PDF/config hashes and stale-result rejection.
- `src/utils/doclingPdf.ts`: PDF.js source-region cropping and document preparation.
- `src/utils/doclingAbstract.ts`: evidence chunks, bounded reduction, prompt construction and reference validation.
- `src/components/MarkdownContent.vue`: sanitized Markdown, local asset loading, image preview, PDF source events.
- Modify database schema/index, IPC/preload/types/setup, chat store, SettingsView, ChatPanel, markdown renderer, export sanitation, README.

## Task 1: Shared document contracts and normalization

- [x] Write `src/tests/doclingDocument.test.ts` covering reading order, referenced captions, tables, formula, embedded raster images, bottom-left/top-left regions and unknown provenance. Start with a fixture whose body children refer to picture before a heading; verify the output order follows those references rather than array order.
```ts
expect(normalizeDoclingDocument({ body: { children: [{ $ref: '#/pictures/0' }] },
  pictures: [{ self_ref: '#/pictures/0', prov: [{ page_no: 2,
    bbox: { l: 10, r: 90, t: 80, b: 20, coord_origin: 'BOTTOMLEFT' } }] }],
  pages: { '2': { size: { width: 100, height: 100 } } },
}).items[0].regions[0]).toMatchObject({ page: 1, x: .1, y: .2, width: .8, height: .6 })
```
- [x] Run `npx vitest run src/tests/doclingDocument.test.ts`; observe missing-module failure before implementation.
- [x] Implement the shared contract, settings normalization, body reference traversal with cycle guard, caption lookup, all valid provenance pages/regions, typed image checks, table cells in reading order. Every normalized item uses stable generated IDs such as `item-0`.
```ts
export interface SourceRegion { page: number; x: number; y: number; width: number; height: number }
export interface DocumentImage { page?: number; data?: string; assetId?: string }
export interface DocumentItem {
  id: string; kind: 'text' | 'heading' | 'picture' | 'table' | 'formula'
  text: string; caption: string; pages: number[]; regions: SourceRegion[]; images: DocumentImage[]
}
export interface ParsedDocument { version: 1; items: DocumentItem[]; warnings: string[] }
export interface DoclingRecord { document: ParsedDocument; sourceHash: string; configHash: string; cached: boolean }
```
- [x] Re-run targeted suite; resolve malformed objects, finite numeric boundaries, duplicate references, invalid image URI and empty conversion tests.
- [x] Commit shared parser and its tests.

## Task 2: Docling HTTP client

- [x] Write `src/tests/doclingClient.test.ts` using an injected fetch. Inspect real FormData, uploaded PDF and options; test authenticated upload, failure status, malformed result, partial_success, timeout and incompatible OpenAPI.
```ts
const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({
  status: 'success', document: { json_content: { texts: [{ text: 'evidence' }] } },
})))
await convertPdf(new Uint8Array([37, 80, 68, 70]), 'paper.pdf', settings, request)
expect(request.mock.calls[0][0]).toBe('http://localhost:5001/v1/convert/file')
expect((request.mock.calls[0][1].body as FormData).get('to_formats')).toBe('json')
```
- [x] Run `npx vitest run src/tests/doclingClient.test.ts`; verify it fails before writing the client.
- [x] Implement POST multipart with `files`, `from_formats=pdf`, `to_formats=json`, `target_type=inbody`, `image_export_mode=embedded`, `table_mode=accurate`, OCR and formula options. Use AbortController with configured seconds, cancel timer in finally, reject unsupported or empty conversion responses, retain partial warnings. Normalize service root; accept only HTTP/HTTPS without URL credentials. Use X-Api-Key only if configured. Test connection via OpenAPI paths.
- [x] Re-run tests and commit.

## Task 3: SQLite repository and IPC facade

- [x] Write repository tests against injected database or a narrow stateful SQL fake: persist image, read image, store only immutable ID in manifest, change parse without removing old image, export/import image bytes. Write facade tests for content/config cache identity and stale saves.
```ts
const stored = repository.save('paper', record)
expect(stored.document.items[0].images[0].data).toBeUndefined()
expect(repository.readAsset(stored.document.items[0].images[0].assetId!)).toMatch(/^data:image\/png;base64,/)
```
- [x] Run the repository/facade tests to verify red.
- [x] Add `document_parses` and `document_assets` with cascading paper foreign keys. Repository save validates image types/size, computes SHA-256 with paper identity, writes BLOBs and manifest in one transaction. Exports encode BLOB to base64; imports validate data and stable hashes; retain older images while paper exists.
- [x] Wire `convert`, `save`, `readAsset`, `testConnection` into IPC and both type declarations. Main facade fingerprints actual file bytes plus normalized parsing configuration; on save recheck source and config before committing. Cache hit validates the document and every referenced asset. Backup/clear/import include new tables; old version-1 backups have empty optional fields. Redact `docling_config.apiKey` in default exports.
- [x] Extend shared IPC mocks; run repository, facade, IPC/export tests plus typecheck; commit.

## Task 4: Original PDF crops and bounded generation

- [x] Write `src/tests/doclingPdf.test.ts` with injected PDF rendering to assert crop coordinates, multiple pages and destroy in finally. Write `src/tests/doclingAbstract.test.ts` with a deterministic injected model: all evidence reaches map passes; final valid IDs materialize; invented references and image URLs are rejected; actual sources use normalized pages; malformed formula falls back; bounded reduction stops if the model does not shrink input.
```ts
const result = materializeAbstract('说明 {{asset:item-0}} {{cite:item-0}}', document, 'paper')
expect(result.content).toContain('asset:')
expect(result.sources[0]).toMatchObject({ paperId: 'paper', startPage: 1 })
expect(materializeAbstract('{{cite:invented}}', document, 'paper').sources).toEqual([])
```
- [x] Run the new suites to verify red.
- [x] Implement local PDF.js crops when asset pixels are absent; initialize worker, bound canvas resolution, collect each valid region, mark failures as warnings, destroy PDF when done. Call bridge save only after crop preparation.
- [x] Build input chunks without losing text, containing evidence IDs and accurate pages. For multiple chunks, map with the same frozen chat profile; reduce under a fixed character budget (max six rounds, fail on non-shrinking responses); final request includes section requirements and only valid asset/citation protocol. Model receives no image data or local file paths. Materialize validated IDs into local asset links/PDF links, append warnings and capture source refs. Support continuation with previous output and the same evidence.
- [x] Re-run suites and commit.

## Task 5: Native settings and chat integration

- [x] Add store regression tests before changing `/abstract`: missing URL gets Docling guidance, current chat profile is used, multiple papers stay separated, generation failure retains parse cache, retry updates the original message, continuation avoids RAG. Update the old missing-HF-token command test to expect missing Docling URL; observe its red failure.
- [x] Implement Docling config refs/save/test actions, per-conversation progress state and new generator in `src/stores/chat.ts`; keep old benchmark summary utility intact. Snapshot paper IDs and current profile; main process checks parsing configuration before saving each paper. Wrap all progress in finally cleanup; keep partial-output truncation status and source references in both initial and retry branches. Persist a namespaced resume state in the existing assistant context field so multi-paper truncation preserves completed sections and resumes remaining original papers.
- [x] Replace old HF settings card with URL/key/timeout/OCR/formula/save/test controls; explicitly say files go to that service and generation uses current chat configuration. Empty URL may be saved. Add progressive labels in ChatPanel and command suggestion copy.
- [x] Run store/command/failure/settings suites and typecheck; commit.

## Task 6: Rendering, documentation and full acceptance

- [x] Add `markdown` and `MarkdownContent` tests before changing rendering. Verify source links emit paper/page; image bytes load from the bridge after mounting/re-mounting; image preview supports click/keyboard; unsupported schemes and HTML are sanitized. Test old Markdown remains readable.
- [x] Implement Markdown-it renderer rules for controlled `asset:`/`paper-source:` links, retaining DOMPurify. Vue component resolves safe asset IDs via IPC, exposes loading failure, supports ElDialog preview and emits SourceRef. Replace ChatPanel's direct v-html with the component; keep existing deep Markdown styles, add constrained image width and readable captions.
- [x] Document configuration, expected Docling endpoints/options, model deployment responsibilities, cache/backups, partial extraction and manual real-service verification in README and `docs/testing/docling-abstract.md`. Add a synthetic fixture preview for visual verification if a browser is available.
- [x] Run `npm test`, `npm run typecheck`, `npx vite build`. Use verification-before-completion; fix reproducible failures before claiming success. Check `git diff --check` and exclude user `prompt.md` from commits.
- [x] Mark checked steps from actual results, commit implementation and report real-service validation is pending the user's URL.


## Execution record — 2026-10-11

Implemented natively on `feat/docling` in this session. Tasks 1–2 share the parser/client commit; remaining native integration is committed together. Independent review fixes include explicit `target_type=inbody`, decoded Markdown destination checks before and after reference materialization, preserved separators during removal, canonical image identities for backup restoration, and persisted multi-paper continuation.

Final checks: `npx vitest run --maxWorkers=4` passed all 113 files / 1462 tests; `npm run typecheck` passed; `npx vite build` passed renderer, main and preload bundles. The `npm test` workflow also passed before the last reference regression; branding tests passed 18 tests with one environment-dependent skip (`desktop-file-validate` unavailable). Vite reported existing dependency annotation and large-chunk warnings. Installer packaging was not run.

A temporary localhost page mounted the actual ChatPanel and MarkdownContent components with synthetic figures/table data and mocked asset IPC. Browser checks verified original-image display/preview, accurate page-navigation events, table display and KaTeX rendering. The page and server were closed afterward. This does not replace real Docling service/model validation; the service URL is pending user configuration. User-owned `prompt.md` remains uncommitted.
