# Repository Guidelines

## Baseline and Architecture

This branch is based on `a9651fd` (PR #14). PaperMind is a TypeScript, Vue 3,
Pinia, and Electron desktop application.

- `src/views/` contains six route screens; reusable UI belongs in
  `src/components/`.
- `src/stores/` contains six Pinia stores. `chat.ts` is still the main
  orchestration store for chat, providers, E-k5 retrieval, and `/abstract`.
- `src/types/` and selected pure modules under `src/utils/` are shared by the
  renderer, preload, Electron main process, and benchmark. Do not describe all
  of `src/` as renderer-only.
- `electron/` contains the main process, preload bridge, typed IPC handlers,
  local PDF protocol, Docling client, web capture, and SQLite layer.
- `bench/` is a Node/tsx evaluation project. Its product runner reuses
  production E-k5/Docling code; other runners are explicit baselines or
  historical experiments.
- `docs/architecture/` is the current architecture map. Update it when a
  runtime boundary, product path, IPC surface, or data model changes.

The production paper-QA path is E-k5. It does not silently fall back to the
legacy PageIndex, passage, or semantic-tree paths. The production parsed
summary path uses `documentSummary` plus `requestParsedSummary` and currently
requires an OpenAI-compatible API.

## Database and IPC Changes

The schema currently has 19 tables. When changing a database or IPC API, check
all affected layers rather than treating TypeScript types as runtime
validation:

1. `electron/db/schema.ts` and the owning repository/API implementation.
2. `src/types/ipcContract.ts`, the shared channel/argument/result contract.
3. `electron/ipc.ts` and `electron/preload.ts`.
4. `src/types/db.d.ts` and `src/types/webPreview.d.ts` global declarations.
5. `src/tests/setup.ts` plus focused runtime-validation tests.

`electron/ipcSecurity.ts` validates the caller frame only. Payload validation
is distributed across handlers, repositories, and shared validators.

## Build, Test, and Development Commands

The supported toolchain is Node `24.22.1` and npm 10, as pinned by `.nvmrc`,
`package.json`, and the runtime gate.

- `npm install` installs dependencies and rebuilds native modules.
- `npm run dev` starts Vite and Electron.
- `npm run typecheck` runs strict Vue/TypeScript checks.
- `npm test` runs Vitest and script-level checks.
- `npm run build` checks icons, type-checks, bundles, and creates installers.
- `npm run rebuild` rebuilds `better-sqlite3`.
- `npm run bench` and `npm run bench:product` run evaluation CLIs.

Do not bypass `scripts/check-runtime.mjs` to make an unsupported runtime pass.

## Coding and Testing Conventions

Use two-space indentation, single quotes, no semicolons, and trailing commas in
multiline structures. Prefer Vue `<script setup lang="ts">`, Composition API,
and explicit shared-data interfaces. Name components in PascalCase, utilities
in camelCase, and tests `*.test.ts`.

No standalone formatter or linter is configured. Match neighboring code.
Add focused Vitest coverage under `src/tests/` or `bench/src/tests/`. Mock
`window.db` and `window.preview` through `src/tests/setup.ts`.

For code changes, run `npm test` and `npm run typecheck`. For documentation-only
changes, validate links, referenced paths, Markdown structure, and
`git diff --check`; do not claim product tests passed unless they were run on
the supported runtime.

## Product Boundaries

- LLM credentials are stored locally in SQLite settings and exposed to the
  renderer because chat and parsed-summary requests are sent directly to the
  configured provider.
- Docling requests run in the main process. At the #14 baseline, the default
  loopback URL starts a managed SSH tunnel to the configured remote service.
- PDF files live under the managed `userData/papers/` directory; metadata lives
  in SQLite.
- Reading position is renderer `localStorage` state, not a SQLite record.
- `paperFileTransactions.ts` provides staging, rollback, and startup recovery
  for selected cross-resource operations; it is not a filesystem/SQLite ACID
  transaction.
- Backups exclude plaintext API keys by default and do not export
  `abstract_checkpoints`.

Never commit real credentials, user PDFs, databases, benchmark caches/results,
or generated bundles.

## Git Delivery

Use task branches and Conventional Commits. Preserve unrelated working-tree
changes. Stage explicit paths, inspect `git diff --cached`, and record only
verification actually performed. Commit, push, rewrite history, or force-push
only when explicitly authorized.
