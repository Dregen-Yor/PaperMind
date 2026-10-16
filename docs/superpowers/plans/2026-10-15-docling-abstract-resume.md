# Docling Abstract Resume Implementation Plan

> **For agentic workers:** Execute these tasks in order in the current `feat/docling-metrics` worktree. The user has requested inline execution and a real Kimi-K3 run.

**Goal:** Make long `/abstract` runs resumable after transient model failures, report the failing stage, and verify with the existing Kimi-K3 paper.

**Architecture:** Store validated per-stage LLM outputs in a paper-scoped SQLite table. A SHA-256 run key covers the parsed document, title, selected model settings, prompt, and continuation context. The generator loads completed map/reduce/batch outputs before making a model call. Abstract requests use a longer per-call timeout and one retry for transient failures; errors include the active stage.

**Tech Stack:** TypeScript, Vue/Pinia, Electron IPC, better-sqlite3, Vitest.

**Spec:** User-approved in-chat design from 2026-10-15: checkpoint every evidence block, then stage-specific errors, then timeout and limited retry.

## Global Constraints

- Preserve existing uncommitted changes in this worktree.
- Do not persist API keys in checkpoints or log raw paper evidence.
- Existing Docling parse cache and previously generated reports must remain usable.
- Run `npm test` and `npm run typecheck`; use the real Kimi-K3 PDF only after automated checks pass.

## Review Focus

- A failed middle chunk must resume without regenerating completed chunks.
- PDF, prompt, title, or model-setting changes must produce a different run key.
- A 401 or invalid request must not be retried.
- An abort during response-body reading must be shown as a timeout rather than raw English text.
- Deleting a paper must cascade-delete its checkpoints.

### Task 1: Durable checkpoint storage

**Files:** `electron/db/schema.ts`, `electron/db/abstractCheckpoint.ts`, `electron/db/index.ts`, `electron/ipc.ts`, `electron/preload.ts`, `src/types/db.d.ts`, `src/tests/setup.ts`, `src/tests/abstractCheckpoint.test.ts`.

- [x] Write a failing repository test that saves/loads stage output and checks paper-delete cascade.
- [x] Run `npx vitest run src/tests/abstractCheckpoint.test.ts` and observe failure.
- [x] Add the SQLite table and bridge methods, then rerun the test.

### Task 2: Deterministic run key and stage resume

**Files:** `src/utils/doclingAbstract.ts`, `src/tests/doclingAbstract.test.ts`, `src/stores/chat.ts`, `src/tests/chat.docling.test.ts`.

- [x] Write failing tests for run-key invalidation and map-stage resume after a middle-chunk failure.
- [x] Run focused tests and observe failure.
- [x] Add WebCrypto SHA-256 key creation and checkpoint load/save around validated map, reduce, and batch outputs.
- [x] Wire the paper-scoped IPC checkpoint adapter in `generateAbstract`; rerun focused tests.

### Task 3: Timeout, retry, and stage-specific error

**Files:** `src/stores/chat.ts`, `src/utils/doclingAbstract.ts`, `src/tests/chat.docling.test.ts`, `src/tests/chat.failure.test.ts`, `src/tests/doclingAbstract.test.ts`.

- [x] Write failing tests for body-read abort translation, 401 non-retry, and a retryable failure reporting its map position.
- [x] Run focused tests and observe failure.
- [x] Give `/abstract` a 300-second per-call timeout, retry one transient failure with short backoff, and prefix terminal errors with the active stage.
- [x] Rerun focused tests, `npm test`, `npm run typecheck`, and `git diff --check`.

### Task 4: Real Kimi-K3 verification

**Files:** `docs/testing/docling-abstract.md`.

- [x] Start or reuse the development app in this worktree and trigger `/abstract` for `Kimi K3: Open Frontier Intelligence` using computer use.
- [x] Observe stage progress and checkpoint rows; 14 map outputs have been saved during the first run.
- [x] Verify a nonempty report in SQLite, page/source links, and image assets; document the observed result and any remaining limitation.
