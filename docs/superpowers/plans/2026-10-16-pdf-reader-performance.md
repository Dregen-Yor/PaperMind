# PDF Reader Performance Implementation Plan

**Goal:** Reduce PDF open and navigation cost while preserving highlights, evidence jumps, and zoom behavior, with a repeatable before/after benchmark.

**Architecture:** Measure the current Vue reader in headless Chromium using a generated 60-page PDF. Keep one PDF.js loading task per document, lay out lightweight page placeholders, and render only pages near the viewport plus an explicitly requested target. Replace base64 reading on the view path with a scoped local PDF URL; retain existing backup serialization.

**Tech Stack:** Vue 3, Electron, PDF.js, Vitest, Vite.

**Spec:** User-approved design in this conversation: document reuse, visible-page rendering, and a protected local file path.

## Tasks

### Task 1: Baseline

- [x] Add a deterministic Chromium benchmark harness and generated PDF fixture.
- [x] Run the harness against the current implementation and save raw results.
- [x] Run the existing test suite and typecheck before product changes.

### Task 2: PDF document and page scheduling

- [x] Add failing tests for document reuse, nearby-page rendering, and first-page progress.
- [x] Implement page placeholders and bounded render scheduling in `PdfViewer.vue`.
- [x] Run focused tests and inspect highlight/evidence regressions.

### Task 3: Local PDF transport

- [x] Add failing tests for scoped file lookup and ReaderView's new URL path.
- [x] Implement a main-process local PDF protocol keyed by paper ID, with path lookup confined to stored papers.
- [x] Remove base64 round-trip from the ReaderView open path while retaining import and backup behavior.

### Task 4: Comparison and verification

- [x] Run the same Chromium benchmark and compare raw metrics with the baseline.
- [x] Run `npm test` and `npm run typecheck`.
- [x] Review the diff and report performance results, behavior changes, and remaining limits.
