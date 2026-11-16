# PaperMind

> Architecture baseline: `a9651fd` (PR #14, 2026-10-28).
> The authoritative architecture map is under [`docs/architecture/`](docs/architecture/overview.md).

PaperMind is a local-first academic reading assistant built with Vue 3, Pinia,
TypeScript, Electron, and SQLite. PDF files remain on disk; metadata,
conversations, highlights, indexes, summaries, and archived web content live
in SQLite.

## Runtime Boundaries

```text
Renderer (Vue + Pinia)
  ├─ views/components
  ├─ stores and product orchestration
  ├─ direct LLM/provider fetches
  └─ window.db / window.preview
               │ typed contextBridge IPC
Electron main/preload
  ├─ sender checks and IPC handlers
  ├─ SQLite + managed PDF files
  ├─ papermind-paper protocol
  ├─ Docling HTTP client / managed SSH tunnel (#14)
  └─ isolated web preview and snapshot capture
```

`src/` is not a pure renderer boundary: `src/types/` and selected pure
`src/utils/` modules are imported by Electron and benchmark code. There is no
dedicated shared package yet.

## Current Product Paths

### Paper question answering

`chat.ts` loads or builds an E-k5 index, then calls `runRagPipeline` with
`retrievalMode: 'ek5'`:

1. Extract PDF pages and verified heading candidates.
2. Build leaf heading groups.
3. Optionally rewrite a multi-turn query before retrieval.
4. Embed heading paths and score with dense similarity plus BM25.
5. Fuse ranks with RRF and select the top five groups.
6. Send the selected original text to the configured chat model.

The legacy PageIndex, passage, and semantic-tree branches remain for tests,
benchmarks, and compatibility. They are not silent production fallbacks.

### Parsed summaries

PDF and archived HTML share the parsed-summary pipeline:

1. `documentSummary:parse` runs in the main process.
2. PDF uses Docling; HTML parses the saved snapshot/MHTML.
3. Materials and original images are cached in
   `document_summary_records` / `document_summary_assets`.
4. `visualSummary` calls `requestParsedSummary` directly from the renderer.
5. Reports and task markers are saved back through `documentSummary`.

The current request path requires an OpenAI-compatible API. The old Hugging
Face T5 helper, `abstractCheckpoint`, and legacy Docling tables are not the
active unified-summary path.

## Module Index

| Module | Responsibility |
|---|---|
| [`electron/`](electron/CLAUDE.md) | Main process, preload, IPC, protocols, Docling, web capture |
| [`electron/db/`](electron/db/CLAUDE.md) | 19-table SQLite schema, repositories, backups, file recovery |
| [`src/`](src/CLAUDE.md) | Renderer application plus shared contracts and pure logic |
| [`src/stores/`](src/stores/CLAUDE.md) | Six Pinia stores and product orchestration |
| [`src/views/`](src/views/CLAUDE.md) | Six route-level screens |
| [`src/components/`](src/components/CLAUDE.md) | Thirteen reusable UI components |
| [`src/utils/`](src/utils/CLAUDE.md) | E-k5, RAG, parsing, Markdown, provider and security utilities |
| [`src/router/`](src/router/CLAUDE.md) | Hash-mode route table |
| [`bench/`](bench/CLAUDE.md) | Product evaluation and explicit baselines |

## Commands

Use Node `24.22.1` and npm 10.

```bash
npm install
npm run dev
npm run typecheck
npm test
npm run build
npm run bench -- --task qa --dataset smoke --limit 5
npm run bench:product -- --help
```

Generated outputs are `dist/`, `dist-electron/`, `release/`, benchmark
`cache/`, `prepared/`, `results/`, and `minibatch/`.

## Shared Contracts

- `src/types/ipcContract.ts` is the compile-time IPC source of truth.
- `electron/ipc.ts` registers channels and enforces trusted caller frames.
- `electron/preload.ts` exposes typed wrappers.
- `src/types/db.d.ts` and `src/types/webPreview.d.ts` declare renderer globals.
- Runtime payload checks live in repositories and validators; types alone are
  not a security boundary.

Database/IPC changes normally require synchronized updates to the schema or
repository, IPC contract, handler, preload wrapper, test mock, and focused
runtime tests.

## Known Architectural Debt

- `src/stores/chat.ts` still combines provider clients, run lifecycle,
  retrieval, settings, and summary command orchestration.
- `electron/db/index.ts` still aggregates several data domains.
- Product, compatibility, and experimental retrieval implementations share
  the same source tree.
- E-k5 `contextGroups` currently labels a multi-page group with its first page
  instead of emitting exact per-page pieces.
- File recovery coordinates SQLite and disk changes but cannot provide a true
  cross-resource ACID transaction.
- Real Docling + LLM end-to-end behavior and packaged Electron behavior remain
  deployment-time verification requirements.

Do not describe proposed `ConversationRunService`, `ProviderClient`, or
`ManagedPaperFiles` boundaries as implemented until those modules exist.

## Delivery Checks

For code changes, run `npm test` and `npm run typecheck` on the supported
runtime. For documentation-only changes, validate referenced paths, links,
Markdown, and `git diff --check`. Never report historical verification as a
fresh local result.
