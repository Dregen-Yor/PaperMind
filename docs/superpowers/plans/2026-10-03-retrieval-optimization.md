# Retrieval optimization implementation plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan, or superpowers:executing-plans where agents are unavailable.

**Goal:** Remove repeated retrieval work without changing evidence selection, then add an independently configurable heading prior that remains off by default.

**Architecture:** Keep the shared product/benchmark passage pipeline. Prepare lexical statistics and source mappings per index snapshot, reuse query embeddings only within one RAG request, maintain budget totals incrementally, and reuse parsed product indexes through a bounded content-validated cache. Add heading BM25 as a separate, optional RRF signal using existing subsection boundaries.

**Tech stack:** TypeScript, Vue 3, Pinia, Vitest, Electron, existing benchmark CLI. No database, IPC, index serialization, generation prompt, dependency, or model changes.

**Approved specification:** `docs/superpowers/specs/2026-10-03-retrieval-optimization-design.md`. Work on `codex/retrieval-optimization`; integrate and push after checks. Existing local branding was already pushed as `1649433`.

## Task 1: Prepare retrieval statistics and eliminate repeated query/budget work

Files: `src/utils/passageRetrieval.ts`, `src/utils/ragPipeline.ts`, `src/tests/passageRetrieval.test.ts`, `src/tests/ragPipeline.test.ts` (a focused helper file is permitted if needed).

- [x] Add failing tests for prepared-state reuse/invalidation, multi-paper query embedding reuse, no eager embedding for unavailable/mismatched vectors, shared request failure and next-request retry, and budget run bridging.
- [x] Cache passage/card BM25 scorers, card ranges and source-title mappings by an index snapshot. Validate relevant content when snapshots change; retain no cross-request query result or answer cache. Use weak ownership so discarded indexes can be collected.
- [x] Forward a lazy request-scoped embedder wrapper through `retrieveRagContext`. Preserve the embedder identity and other methods; call the original with its receiver. One request uses at most one query inference, including failures. External context and non-passage paths remain unchanged.
- [x] Replace repeated sorting/summing of selected orders with token total and contiguous-run count. Adding a passage with zero, one or two selected neighbors creates, extends or bridges a run. Preserve heap ordering, neighbor offering, skip behavior, short-document handling and final ordering.
- [x] Run `npx vitest run src/tests/passageRetrieval.test.ts src/tests/ragPipeline.test.ts` before and after implementation; require failures on the old implementation and green regression tests afterwards.
- [x] Obtain independent spec review, then code quality review; fix and re-review findings.

Task 1: initial RED had 19 expected failures; final focused suite passed 87 tests. Independent reviews closed in-place and whole-array mutation cases across the embedding await. Full-result reference comparison now includes 248 cases.

## Task 2: Reuse parsed product indexes at the loading boundary

Files: create `src/utils/parsedPaperCache.ts` and `src/tests/parsedPaperCache.test.ts`; modify `src/stores/chat.ts` and `src/tests/chatPassageIndex.test.ts`.

- [x] Add failing behavioral tests for same-record object reuse, changed index/pages content, progressive stage updates, record removal, bounded LRU eviction and reloading after eviction.
- [x] Add a per-store bounded cache (eight recent papers) keyed by paper ID and exact raw `indexJson`/`pagesJson`. Cache only valid passage indexes; keep legacy and malformed-index rebuild behavior. Remove entries when a record is absent and reject changed content immediately. Do not alter SQLite or serialization.
- [x] Integrate at `collectIndexedPapers` so repeated sends reuse the same parsed passage index and vectors. Preserve page parsing errors and existing fallback branches.
- [x] Run `npx vitest run src/tests/parsedPaperCache.test.ts src/tests/chatPassageIndex.test.ts src/tests/chat.store.test.ts` red then green.
- [x] Obtain independent spec review, then code quality review; fix and re-review findings.

Task 2: repeated-send identity tests failed before integration; final focused suites passed 60 tests. Both independent reviews passed, with 29 focused cache/integration tests independently rerun.

## Task 3: Stage-one equivalence, performance and integration verification

Files: create `scripts/benchmark-passage-retrieval.ts` and `docs/testing/retrieval-optimization.md`.

- [x] Compare the full passage retrieval output against source from `1649433` using deterministic synthetic fixtures. Cover absent/present cards and vectors, mismatch/failure, tied scores, budgets, passage pieces and page provenance. For multi-paper RAG, compare stable output excluding wall-clock timings. Keep baseline source in a temporary directory rather than duplicating it in the repository.
- [x] Add a repeatable local microbenchmark that loads baseline modules from a specified Git revision, warms both implementations, checks exact outputs and reports first-use preparation plus retrieval cost and warm P50/P95 on a fixed corpus/query sequence. Include parsed cache and request embedding behavioral results in documentation. Synthetic timing is engineering evidence only; private cache internals are not exported for instrumentation.
- [x] Run `npm test`, `npm run typecheck`, `git diff --check`, and `CSC_IDENTITY_AUTO_DISCOVERY=false npm run build -- --dir`. Inspect the Electron app with isolated user data.
- [ ] Record actual results and limitations, then commit/push the stage-one changes.

## Task 4: Add the experimental heading prior with full benchmark wiring

Files: `src/utils/passageRetrieval.ts`, `src/utils/ragPipeline.ts`, `bench/src/types.ts`, `bench/src/config.ts`, `bench/src/cli.ts`, `bench/src/runner/passageIndexHook.ts`, `bench/src/runner/qa.ts`, relevant passage tests; create `bench/configs/papermind-hybrid-heading.json`.

- [ ] Add failing tests for explicit zero/default equivalence, no-title-hit equivalence, positive title influence, non-hit passage eligibility and unchanged raw evidence/page provenance. Add config validation and CLI/runner propagation tests.
- [ ] Prepare contiguous subsection title ranges from existing passages. Score titles using BM25 and inherit positive-hit ranks into an independent weighted RRF list. Omit the entire signal when no title has a positive score. Never insert titles/cards into fact context or hard-filter other evidence.
- [ ] Add optional `headingWeight` with production default zero. Preserve the seven required historical passage knobs; the new knob is optional, finite and nonnegative. Flow through config validation, matrix expansion, CLI, runner and RAG dependencies. Ensure actual config values appear in benchmark result metadata.
- [ ] Add a separate matrix at heading weights `[0, 0.25, 0.5]`, fixed section weight `0.5` and the existing pinned small embedder parameters. Do not modify historical configurations.
- [ ] Run focused passage, config, CLI and runner tests red then green. Obtain spec review then code quality review and address findings.

## Task 5: Final checks, documentation and delivery

- [ ] Re-run full tests, typecheck, whitespace checks and application build after heading integration. Re-run the equivalence/microbenchmark with heading weight zero and add experimental heading timing separately.
- [ ] Update documentation with usage, default-off behavior, exact timing results and the missing frozen 60-paper/179-question dataset/model configuration. Do not report new AnswerF1, EvidenceF1, TTFT or Q quality results without that evaluation.
- [ ] Obtain final independent review of the complete diff.
- [ ] Commit the heading experiment independently. Fetch before integration, preserve remote content for conflicts, fast-forward/merge into main as appropriate, push and verify main equals origin/main with a clean working tree. Keep the pre-sync stash as a recoverable backup.
