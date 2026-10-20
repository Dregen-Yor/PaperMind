# Remaining review findings implementation plan

> **For agentic workers:** Use subagent-driven development with exclusive file ownership. Each owner diagnoses and proves regressions before implementation; the parent performs integration review, full verification and ship.

**Goal:** Complete the remaining 7 UX findings, 4 interaction gaps and 7 technical findings listed by the existing audit, deliver through GitHub, and leave the normal local npm development service running for user acceptance.

**Architecture:** Preserve Vue/Pinia/Electron and existing typed IPC. Extend existing flows with state scoped to the correct object and explicit persistence/cancellation boundaries. Retain previous database recovery, PDF repair, drafts and canonical highlights.

**Tech Stack:** TypeScript, Vue 3, Pinia, Element Plus, Electron, Vitest, existing benchmark tools.

**Spec:** `docs/reviews/2026-10-20-user-experience-review.md` (remaining findings and acceptance goals); `docs/reviews/2026-10-20-engineering-review.md` (F04/F06/F08/F10/F11/F12/F13).

## Global constraints

- Baseline `7efa9ad03fac2980b3f4dd2df6059773954ae83a`; task branch `fix/review-completion`.
- One shared checkout, exclusive owner per source file. Parent alone stages, commits, pushes and merges.
- No real user data, paid model calls, added dependencies, installer publication or credentials in artifacts.
- No new database schema/API required; coordinate any shared-contract changes first.
- Parent must satisfy full test/typecheck/build, independent review and current-head CI before squash merge.
- User explicitly selected parallel execution and full ship followed by local npm dev startup; routine design decisions follow the report's acceptance goals.

## Review focus

- Late asynchronous completions after navigation or cancellation cannot mutate another paper/conversation.
- Persistence failure must preserve recoverable user inputs and render truthful success/error state.
- Existing/legacy documents, unusual IDs and corrupt saved UI state must remain safe.
- Reference jumps outrank saved reading position; canvas/evidence/highlight virtualization remain intact.
- Product benchmark identities and results must describe the actual E-k5/Docling path and distinguish synthetic smoke from real-provider evidence.

## Task 1 — Library management (library agent)

Own LibraryView, new libraryWorkspace store and metadata editor, related tests. Consume existing paper store APIs only.

- [x] Diagnose and observe failing tests for U08/U13/U16 and missing metadata editing.
- [x] Preserve current KB/query/status/sort across remount, safely handle deleted KB.
- [x] Choose move destination; await persistence; allow cancellation and truthful errors.
- [x] Independent 5-second pending deletion per paper, stable ownership across routes, failure restoration.
- [x] Edit title/authors/year/tags without mutating persisted values until save succeeds.
- [x] Focused regressions cover navigation, failure, repeated deletes, cancellation and previous importer behavior; freeze and report.

## Task 2 — Chat lifecycle and input (chat agent)

Own chat store, ChatPanel/ChatSources/ChatView/WebQaPanel and provider streaming helper/tests.

- [x] Diagnose RED cases for F04/F06/F08/U10/U14 and send-key gap.
- [x] Strict terminal/error/EOF handling including final buffers; preserve partial replies and failure status.
- [x] Unify summary commands with run lock/placeholder/cancellation/retry association; retain shared cache semantics.
- [x] Send normalized Ollama temperature.
- [x] Pause follow-scroll when user reads history; show full selected-paper list; unify Enter/Shift+Enter with IME protection.
- [x] Focused tests cover late completion, navigation, cancellation, mixed commands, draft regression, unavailable selected papers; freeze and report.

## Task 3 — PDF reading and provenance (PDF agent)

Own PdfViewer/ReaderView, doclingPdf/doclingDocument/doclingAbstract, sourceRef and coordinated source consumers/tests.

- [x] Diagnose RED cases for U12/F10/F11 and direct-page gap.
- [x] Persist paper reading location and add validated page input; explicit source route has precedence.
- [x] Preserve provenance charspans for exact page mapping; old documents or unknown mapping show truthful multi-page range.
- [x] Destroy actual loading task after successful/failed/cancelled image processing.
- [x] Focused tests cover corrupt/oversized position, cross-page/repeated text/no boxes/legacy documents and existing highlights/evidence/canvas; freeze and report.

## Task 4 — Settings, product benchmark, release (parent)

Own SettingsView, settings-specific helper/tests, bench product entry/runner/docs and release workflow/tests. Do not modify agents' files without handoff.

- [x] U01: select backup, preview replacement scope and counts, optionally export current data, explicit confirm, cancel before IPC write; prevent overlapping restores.
- [x] Settings gap: clear automatic vs explicit save labels, dirty indicators and route/window leave protection for unsaved form changes, retain drafts on failed save.
- [x] F13: verify Windows artifact variable regression, fix naming and validate without publishing.
- [x] F12: preserve historical benchmark results, label legacy runners accurately and add executable product E-k5/Docling benchmark with versioned identity, real PDF/model adapters and offline deterministic smoke.
- [x] Verify targeted tests and CLI help/smoke; never silently replace real-provider quality evaluation with synthetic scores.

## Task 5 — Integration and delivery (parent)

- [x] Freeze all writers; independent full diff review; resolve confirmed blockers and rerun affected checks.
- [x] Full npm test, npm run typecheck, Vite production build; browser UI acceptance using isolated fixtures when available.
- [ ] Update review status with actual resolved scope, validation and remaining empirical limits; stage only task files and authorized reports.
- [ ] Conventional atomic commits, push, PR attachment, published diff/reviews/current-head CI; squash merge, verify remote, synchronize main, clean task branch.
- [ ] Start npm run dev on merged main, verify readiness and actual Electron launch, retain process for user; report service URL/session and any genuine runtime limitation.
