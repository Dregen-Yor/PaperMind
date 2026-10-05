# PDF Outline Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Benchmark whether a locally embedded PDF outline prior improves PaperMind's direct passage retrieval while preserving the speed-first cold-first-query and hot-query protocols.

**Architecture:** Reuse the production passage builder, RRF retriever, context materializer, answer runner, query-timeline-v2, and Q formula. Add a native PDF outline reader and PDF-QA fixture identity, thread an optional outline scoring signal through the existing passage path, and implement a separate cold-first-query runner that records actual readiness and retrieval mode. Legacy LLM-card configurations keep their current behavior.

**Tech Stack:** TypeScript, Vue/Electron shared PDF.js (`pdfjs-dist`), Vitest, existing `tsx` bench CLI, existing LLM/embedding clients.

**Spec:** `docs/superpowers/specs/2026-09-27-llm-structure-benchmark-design.md`

## Global Constraints

- Product priority is speed first, answer quality second; the default product retrieval path is not changed by this experiment.
- A/B/C use identical PDF page text, passage segmentation (120/350 tokens), BGE embedding identity for B/C, answer prompt, and 4096-token context budget.
- A/B/C perform zero generation-style LLM index calls; C uses PDF.js native outline/bookmarks and local embeddings only.
- C combines outline relevance with full BM25/dense passage retrieval using RRF weight 0.5; it must not hard-prune passages.
- A missing or invalid outline falls back to B and remains in the all-PDF denominator with explicit fallback diagnostics.
- Existing QASPER quality, speed contracts, result comparison rules, defaults, and old LLM-card behavior remain intact.
- Cold `ask-at-lexical-ready` answers from the persisted stage-1 snapshot and never waits for vector or outline completion.
- Secrets, PDF bytes, model weights, generated results, and benchmark caches do not enter commits.

## Review Focus

- Named destinations and indirect PDF page references resolve to the correct 0-based page, including same-page siblings; Task 1 pins this with mocked PDF.js refs.
- A malformed/missing/partial outline cannot silently look complete or lose the document; Task 1 tests whole-document fallback, Task 2 tests its denominator.
- Legacy indexes without cards and the default LLM-card config retain their existing behavior; Tasks 4–5 cover migration and default compatibility.
- C's outline boost cannot remove unrelated global candidates or leak outline labels into answer context; Task 6 tests full candidate retention and original-text-only context.
- Cold timing cannot wait for C's outline/vector build or accidentally use a later index snapshot; Task 8 gates build completion with controlled promises.

---

## File Map

| File | Responsibility |
|---|---|
| `src/utils/pdfDocument.ts` (new) | Load one PDF.js document, extract existing page text, read its outline, and release the document. |
| `src/utils/pdfOutline.ts` (new) | Resolve outline destinations; validate entries/ranges; produce stable tree and passage associations. |
| `src/utils/pageIndex.ts` | Delegate existing `extractPages` to shared PDF loading while preserving its return behavior. |
| `bench/src/datasets/outlineStudy.ts` (new) | Load `bench/minibatch/annotations.json` plus its PDFs as a versioned real-PDF QA source. |
| `bench/src/types.ts`, `bench/src/args.ts`, `bench/src/cli.ts` | Represent and select outline-study data/config without relabeling smoke or QASPER. |
| `bench/src/config.ts`, `bench/configs/structure-*.json` (new) | Validate explicit `lexical`, `hybrid-raw`, `hybrid-outline` experiment modes; preserve legacy mode. |
| `src/utils/passageIndexBuilder.ts` | Add an opt-in way for bench to skip generated cards while keeping legacy default. |
| `bench/src/runner/passageIndexHook.ts` | Build the A/B/C index modes and report actual stage/fallback without requiring cards. |
| `src/utils/passageRetrieval.ts` | Add optional outline-derived rank list to current RRF; preserve all passage candidates. |
| `src/utils/ragPipeline.ts`, `bench/src/runner/qa.ts` | Pass outline index into production retrieval and record outline mode/diagnostics. |
| `bench/src/metrics/qaQuality.ts`, `bench/src/scoring/qComparison.ts`, `bench/src/types.ts` | Add explicit `pdf-qa-all-questions-v1` quality contract and same-protocol PDF Q checks. |
| `bench/src/runner/coldFirstQuery.ts` (new) | Run the two cold strategies with actual index readiness and streaming answer timeline. |
| `bench/src/metrics/coldFirstQuery.ts` (new), `bench/src/report.ts` | Aggregate cold P50/P95, readiness, fallback, cohort, and render concise product tables. |
| `bench/configs/scoring/q-speed-first.json` (new) | Preserve existing Q implementation and add pinned speed-priority weights. |
| `bench/src/tests/*` | Focused tests listed task by task below. |

## Task 1: Shared PDF extraction and native outline parsing

**Files:**
- Create: `src/utils/pdfDocument.ts`
- Create: `src/utils/pdfOutline.ts`
- Modify: `src/utils/pageIndex.ts`
- Test: `src/tests/pdfDocument.test.ts`
- Test: `src/tests/pdfOutline.test.ts`

**Interfaces:**
- Consumes: existing `reconstructTextLines(items)` from `pageIndex.ts`; PDF.js `PDFDocumentProxy` methods `getPage`, `getOutline`, `getDestination`, `getPageIndex`, `destroy`.
- Produces:
  - `extractPdfDocument(base64: string, deps?: PdfDocumentDeps): Promise<{ pages: string[]; outline: PdfOutlineEntry[] }>`; `outline` is an empty array if the PDF has no outline.
  - `PdfOutlineEntry = { id: string; title: string; page: number | null; children: PdfOutlineEntry[] }`.
  - `resolvePdfOutline(raw: PdfJsOutlineEntry[], resolvePage: (dest: string | unknown[]) => Promise<number>, pageCount: number): PdfOutlineResult` where result is `{ ok: true; roots: PdfOutlineEntry[]; entryCount: number } | { ok: false; reason: 'missing-outline' | 'invalid-title' | 'external-destination' | 'unresolved-destination' | 'page-out-of-range' | 'invalid-order'; entryCount: number }`.
  - `extractPages(base64)` delegates to the shared document helper and returns only `pages`, preserving callers.

- [ ] **Step 1: Write parser tests** for nested hierarchy/order, named destinations, indirect refs, same-page siblings, invalid target fallback, empty title, out-of-range page, and missing outline. Inject destination resolution so tests need no PDF fixture.
- [ ] **Step 2: Run the focused tests**

  Run: `npx vitest run src/tests/pdfOutline.test.ts`

  Expected: FAIL because the outline module does not exist.
- [ ] **Step 3: Implement the pure outline resolver** in `src/utils/pdfOutline.ts`. Traverse PDF.js items in source order, preserve duplicate titles using occurrence IDs, recursively resolve destinations, and reject the complete outline on an invalid internal entry. External URL entries do not count as internal entries and are omitted from `entryCount`.
- [ ] **Step 4: Write shared PDF document tests** using injected PDF.js adapters. Assert pages are byte-for-byte consistent with current extraction, outline resolves on the same document instance, and `destroy()` runs on success and rejection.
- [ ] **Step 5: Implement `extractPdfDocument` and delegate `extractPages`**. Map each PDF.js `RefProxy` destination through `getPageIndex`; map named strings through `getDestination` first. Convert PDF.js's 0-based page index directly; reject a null destination or out-of-range page. Do not change page text reconstruction.
- [ ] **Step 6: Run focused regression tests**

  Run: `npx vitest run src/tests/pdfDocument.test.ts src/tests/pdfOutline.test.ts src/tests/pageIndex.test.ts`

  Expected: PASS; existing page extraction behavior is unchanged.
- [ ] **Step 7: Commit** `feat: extract native PDF outline destinations`

## Task 2: Frozen PDF outline QA dataset and quality contract

**Files:**
- Create: `bench/src/datasets/outlineStudy.ts`
- Modify: `bench/src/types.ts`
- Modify: `bench/src/args.ts`
- Modify: `bench/src/cli.ts`
- Modify: `bench/src/metrics/qaQuality.ts`
- Modify: `bench/src/report.ts`
- Test: `bench/src/tests/outlineStudyDataset.test.ts`
- Test: `bench/src/tests/qaQuality.test.ts`
- Test: `bench/src/tests/args.test.ts`

**Interfaces:**
- Consumes: `extractPdfDocument`, current `bench/minibatch/annotations.json`, PDF files in `bench/minibatch/`, `qasperAnswerF1`, `finalizeQaQuality`.
- Produces: `SampleSource = 'qasper' | 'smoke' | 'pdf-study'`; `loadOutlineStudyDataset(dir?: string): Promise<PdfStudySample[]>`, where `PdfStudySample` extends `EvalSample` with `pdfPath`, `manifestFingerprint`, and parsed `pdfOutline` metadata. These runtime-only fields are excluded from serialized result rows. Each question has stable `<pdf filename>#<zero-based question index>` ID, `qualityAnswers`, and `qualityDefinition: 'pdf-qa-all-questions-v1'`.
- `BenchArgs.dataset` adds `outline-study`; CLI's dataset switch loads only that frozen local set.

- [ ] **Step 1: Write dataset and quality tests**. Assert the configured three PDF filenames load as 12 questions, evidence pages convert 1-based to 0-based, answers are attached to every question, source is `pdf-study`, and malformed/missing PDF/annotation/evidence rejects with the filename/question in the error.
- [ ] **Step 2: Run the focused tests**

  Run: `npx vitest run bench/src/tests/outlineStudyDataset.test.ts bench/src/tests/args.test.ts`

  Expected: FAIL because dataset mode/loader are missing.
- [ ] **Step 3: Add `pdf-study` source and loader**. Use `extractPdfDocument` once per file; load the existing minibatch annotation manifest explicitly rather than reusing `loadSmokeDataset` (which reads a different dataset directory and lacks full QA references). Compute/store a manifest hash over PDF bytes, page text, annotations, and outline JSON. Keep the source `pdfPath` and resolved outline as runtime sample metadata so cold runs can reopen the original bytes; do not serialize PDF bytes or paths into benchmark results.
- [ ] **Step 4: Generalize QA quality finalization by explicit definition**. Add `PDF_QA_QUALITY_DEFINITION = 'pdf-qa-all-questions-v1'`; reuse `qasperAnswerF1` as the already-implemented token-multiset F1 function, but validate the PDF definition separately. Preserve the QASPER-only filter and metadata for existing runs; aggregate PDF-study rows only when explicitly requested by their definition.
- [ ] **Step 5: Update source labels and dataset CLI parsing**. Report `pdf-study` as annotated real PDF; do not label it `smoke`. Keep the smoke and QASPER datasets unchanged.
- [ ] **Step 6: Run focused regression tests**

  Run: `npx vitest run bench/src/tests/outlineStudyDataset.test.ts bench/src/tests/qaQuality.test.ts bench/src/tests/args.test.ts bench/src/tests/smoke.test.ts bench/src/tests/qasper.test.ts`

  Expected: PASS; old source quality denominators remain unchanged.
- [ ] **Step 7: Commit** `feat(bench): load frozen PDF outline QA fixture`

## Task 3: PDF outline tree and page-to-passage index

**Files:**
- Modify: `src/utils/pdfOutline.ts`
- Test: `src/tests/pdfOutline.test.ts`

**Interfaces:**
- Consumes: validated `PdfOutlineEntry[]`, page count, `Passage[]`.
- Produces:
  - `PdfOutlineNode = { id: string; title: string; path: string[]; depth: number; startPage: number; endPage: number; passageOrders: number[]; children: PdfOutlineNode[] }`.
  - `buildPdfOutlineIndex(roots: PdfOutlineEntry[], passages: Passage[], pageCount: number): PdfOutlineNode[]`.
  - `pdfOutlinePassages(roots: PdfOutlineNode[], passages: Passage[]): Map<number, PdfOutlineNode[]>`.

- [ ] **Step 1: Add range tests** for parent introduction pages, descendant span, end at next non-descendant start page inclusive, same-page siblings/overlap, final entry through final page, preamble passages without outline membership, and passages crossing page boundaries.
- [ ] **Step 2: Run test to verify failure**

  Run: `npx vitest run src/tests/pdfOutline.test.ts -t 'passage ranges'`

  Expected: FAIL because range building is missing.
- [ ] **Step 3: Implement `buildPdfOutlineIndex`**. For each depth-first entry, set its range from its destination through the start page of the next later non-descendant entry, inclusive. Allow same-page siblings and parent/child ranges to overlap. The last entry extends through `pageCount - 1`; parent ranges cover their introductory text and descendant subtree. Clamp no values silently; invalid ranges reject the whole index.
- [ ] **Step 4: Associate passages by their actual `pieces[].page` overlap**. Keep passages outside all outline ranges in the global BM25/dense lists with an empty outline association.
- [ ] **Step 5: Run PDF outline unit tests**

  Run: `npx vitest run src/tests/pdfOutline.test.ts`

  Expected: PASS for all parsing, range, and association cases.
- [ ] **Step 6: Commit** `feat: map PDF outline entries to passages`

## Task 4: Explicit A/B/C passage modes and zero-generation index build

**Files:**
- Modify: `bench/src/types.ts`
- Modify: `bench/src/config.ts`
- Modify: `bench/src/runner/passageIndexHook.ts`
- Modify: `src/utils/passageIndexBuilder.ts`
- Create: `bench/configs/structure-lexical.json`
- Create: `bench/configs/structure-hybrid-raw.json`
- Create: `bench/configs/structure-hybrid-outline.json`
- Test: `src/tests/passageIndexBuilder.test.ts`
- Test: `bench/src/tests/passageConfig.test.ts`
- Test: `bench/src/tests/passageIndexHook.test.ts`

**Interfaces:**
- Consumes: `PassageMode = 'legacy-llm' | 'lexical' | 'hybrid-raw' | 'hybrid-outline'`; explicit config mode; Task 1 extraction and Task 3 outline-index builder.
- Produces: `PassagePipelineDeps.buildStructure?: boolean` (default `true`); `PassageIndexHookOptions.mode` and `outlineIndex?`; `PassageIndexInfo.outline?: { nodes: PdfOutlineNode[]; available: boolean; fallbackReason?: string }`. The hook returns a handle `{ lexicalReady: PassageIndexInfo; ready: Promise<PassageIndexInfo> }` so cold strategy selection uses a stable stage-1 snapshot while background stages continue.
- Legacy absent mode resolves to `legacy-llm`; A/B/C resolve to zero generation calls. A loads no embedder; B/C require the same configured embedder.

- [ ] **Step 1: Add failing config tests**. Assert legacy configs retain legacy mode, all three new configs validate, matrix expansion carries `mode`, lexical rejects embedder config, hybrid modes require pinned embedder identity, and unknown modes fail loudly.
- [ ] **Step 2: Add failing builder tests**. With `buildStructure: false`, assert the index becomes stage 1 without embedder or stage 2 with embedder, `llm` is never called, no `cards`/`cardVectors` are produced, and the returned `rest` waits only for requested vectors.
- [ ] **Step 3: Run focused tests and confirm failure**

  Run: `npx vitest run src/tests/passageIndexBuilder.test.ts bench/src/tests/passageConfig.test.ts`

  Expected: FAIL on the missing mode and build policy.
- [ ] **Step 4: Add `buildStructure` with legacy-compatible default**. Guard only stage-3 card generation and card-vector work; keep stage-1 title tree needed by existing index consumers. Do not change product defaults or index schema.
- [ ] **Step 5: Implement explicit config modes and three pinned config files**. `expandMatrix` must preserve mode. Use identical existing passage segmentation, RRF=60, sectionWeight=0.5, neighbourFactor=0.5, skipLimit=20, and embedder pin for B/C; A specifies no embedder.
- [ ] **Step 6: Adapt passage hook per mode**. A skips embedder and vectors; B builds stage 2; C builds the same stage 2 plus validated PDF outline index and its local outline embeddings. Remove the unconditional `index.cards` requirement for experiment modes. Record outline parse/embed failure separately; do not record an LLM fallback or estimated LLM tokens. Return the persisted lexical-ready snapshot separately from the promise for requested remaining stages.
- [ ] **Step 7: Run focused and legacy tests**

  Run: `npx vitest run src/tests/passageIndexBuilder.test.ts bench/src/tests/passageConfig.test.ts bench/src/tests/passageIndexHook.test.ts`

  Expected: PASS; default legacy-card tests and index serialization tests remain unchanged.
- [ ] **Step 8: Commit** `feat(bench): add zero-generation passage modes`

## Task 5: Local outline prior in production passage retrieval

**Files:**
- Modify: `src/utils/passageRetrieval.ts`
- Modify: `src/utils/ragPipeline.ts`
- Modify: `bench/src/runner/qa.ts`
- Test: `src/tests/passageRetrieval.test.ts`
- Test: `src/tests/ragPipeline.test.ts`
- Test: `bench/src/tests/passageQa.test.ts`

**Interfaces:**
- Consumes: `PdfOutlineNode[]` with `passageOrders`, Task 4 passage modes.
- Produces: `PassageRetrievalOptions.outline?: { nodes: PdfOutlineNode[]; weight: number }`; `HybridPassageDiagnostics.retrievalMode` adds `'bm25+dense+outline'`; diagnostics add `outlineAvailable`, `outlineUsed`, optional `outlineFallbackReason`.
- `retrievePassageContext(index, query, opts)` still returns the production `PassageRetrievalResult`; answer text comes only from original `Passage.text`.

- [ ] **Step 1: Write failing rank tests**. A passage covered by sibling/parent nodes receives the highest related-node score once; overlapping ancestry does not duplicate or sum score; preamble passages retain BM25/dense rank; invalid vector dimensions fail/fallback according to current vector policy; no outline reproduces B's exact candidate order/context.
- [ ] **Step 2: Run focused test to confirm failure**

  Run: `npx vitest run src/tests/passageRetrieval.test.ts -t outline`

  Expected: FAIL because no outline scoring branch exists.
- [ ] **Step 3: Add pure `rankOutlinePassages(queryVector, outlineNodes, passageCount)`**. Score each node title plus parent path against the query vector; assign each covered passage the max similarity among its associated nodes; rank uncovered passages after valid outline nodes, with stable passage-order ties. Do not remove any passage candidate.
- [ ] **Step 4: Add the optional outline list to existing weighted RRF**. Keep BM25 and dense weights unchanged; apply configured 0.5 outline weight as the third list. Keep card and outline lists mutually exclusive in the experiment hook; leave all legacy card behavior unchanged.
- [ ] **Step 5: Thread optional outline through `RagRetrievalDeps`**. `ragPipeline.ts` forwards it only when a paper has a passage index and outline metadata; `qa.ts` records actual `retrievalMode` and outline diagnostics per question.
- [ ] **Step 6: Run retrieval and pipeline tests**

  Run: `npx vitest run src/tests/passageRetrieval.test.ts src/tests/ragPipeline.test.ts bench/src/tests/passageQa.test.ts`

  Expected: PASS; B context hash is identical before/after this optional feature.
- [ ] **Step 7: Commit** `feat: rank passages with local PDF outline prior`

## Task 6: PDF quality protocol and guarded Q comparison

**Files:**
- Modify: `bench/src/metrics/qaQuality.ts`
- Modify: `bench/src/runner/qa.ts`
- Modify: `bench/src/types.ts`
- Modify: `bench/src/scoring/qComparison.ts`
- Modify: `bench/src/report.ts`
- Create: `bench/configs/scoring/q-speed-first.json`
- Test: `bench/src/tests/qaQuality.test.ts`
- Test: `bench/src/tests/qComparison.test.ts`
- Test: `bench/src/tests/report.test.ts`

**Interfaces:**
- Consumes: `pdf-study` questions from Task 2; existing `qasperAnswerF1`, `aggregateSpeedMetrics`, `calculateQ`, and `pdf-qa-all-questions-v1`.
- Produces: explicit quality-definition dispatch for QASPER versus PDF study; Q comparison accepts matching PDF-study results and rejects cross-source or cross-manifest comparison.
- Existing QASPER definition, result validation, and default Q weights remain unchanged.

- [ ] **Step 1: Add failing quality tests**. PDF-study completed answer uses the same token F1; failed/skipped rows score zero and remain in fixed denominator; missing/wrong quality definition is rejected; QASPER legacy results retain exact fields/values.
- [ ] **Step 2: Add failing Q comparison tests**. Matched PDF-study pair with identical IDs/manifest/model/speed contract gets a score; QASPER pair still works; PDF-vs-QASPER and different PDF manifests return no score with a diagnostic; tampered answer/F1/speed fields are rechecked.
- [ ] **Step 3: Run focused tests to confirm failure**

  Run: `npx vitest run bench/src/tests/qaQuality.test.ts bench/src/tests/qComparison.test.ts`

  Expected: FAIL for the new PDF quality definition/source.
- [ ] **Step 4: Add PDF quality finalization**. Keep the QASPER source filter intact; compute PDF-study rows from their explicit `qualityDefinition`. Store source, definition, manifest fingerprint, and expected question IDs in result metadata.
- [ ] **Step 5: Generalize `qComparison` only for two explicit same-protocol cases**. Recompute the correct F1 implementation for each accepted definition; require same source, definition, dataset fingerprint, executed IDs, completed cohort, model/endpoint/framing/settings/environment, and speed schema. Never treat PDF study as QASPER.
- [ ] **Step 6: Add `q-speed-first.json`** with weights `{ answerF1: 0.2, ttftP50: 0.4, ttftP95: 0.4 }`. Preserve `q-score.json`; compute both by invoking existing offline comparison separately.
- [ ] **Step 7: Run quality, comparison, and report regressions**

  Run: `npx vitest run bench/src/tests/qaQuality.test.ts bench/src/tests/qComparison.test.ts bench/src/tests/report.test.ts bench/src/tests/qScore.test.ts`

  Expected: PASS; original QASPER-only data remains comparable and PDF cannot cross-compare with it.
- [ ] **Step 8: Commit** `feat(bench): compare speed-priority PDF QA results`

## Task 7: Cold first-query runner and metrics

**Files:**
- Create: `bench/src/runner/coldFirstQuery.ts`
- Create: `bench/src/metrics/coldFirstQuery.ts`
- Modify: `bench/src/args.ts`
- Modify: `bench/src/cli.ts`
- Modify: `bench/src/report.ts`
- Test: `bench/src/tests/coldFirstQuery.test.ts`
- Test: `bench/src/tests/coldFirstQueryMetrics.test.ts`
- Test: `bench/src/tests/args.test.ts`

**Interfaces:**
- Consumes: Task 1 PDF loading, Task 2 outline-study dataset/manifest, Task 4 mode-specific readiness, Task 5 retrieval modes, existing `StreamingLlmClient`, `startQueryTimeline`, and `assertCompletedSpeedRecord`.
- Produces: CLI flags `--cold-first-query` and `--cold-strategy ready-before-query|ask-at-lexical-ready`; mode mutually exclusive with `--speed`.
- `ColdFirstQueryRecord` fields: `{ id; paperId; strategy; inputKind: 'pdf-bytes'; pdfLoadMs; localModelInitMs; lexicalReadyMs; denseReadyMs?; outlineReadyMs?; actualPassageStage; retrievalMode; outlineUsed; outlineFallbackReason?; timeToFirstTokenMs?; fullAnswerLatencyMs?; completionStatus; failureStage? }`.
- Runner entry: `runColdFirstQuery(args: { samples: PdfStudySample[]; mode: PassageMode; strategy: ColdStrategy; ...existing injected clients/deps }): Promise<ColdFirstQueryResult>`.

- [ ] **Step 1: Write controlled-promise tests**. In ask-at-lexical-ready, resolve stage 1, keep vector/outline promises pending, and assert answer retrieval/stream begins with stage-1 BM25 before either promise resolves. In ready-before-query assert it waits for the requested readiness. Assert next paper starts only after background tasks settle.
- [ ] **Step 2: Add metrics tests**. Assert P50/P95 use complete same-scenario cohort, failures/counts remain visible, absent A vector/outline readiness is not encoded as zero, and incompatible strategy/input cohorts cannot be aggregated together.
- [ ] **Step 3: Add CLI parser tests** for both strategy values, required `--cold-first-query`, rejected unknown values, and mutual exclusion with `--speed`/unsupported tasks.
- [ ] **Step 4: Implement an index readiness handle**. Split passage hook result into the persisted lexical-ready snapshot and `ready: Promise<PassageIndexInfo>` for remaining requested stages. Keep ordinary `--speed` behavior waiting for the full configured index, preserving query-timeline-v2.
- [ ] **Step 5: Implement `runColdFirstQuery`**. Start monotonic t0 before reopening `pdfPath` and reading PDF bytes; use one PDF document extraction; start index build; select lexical snapshot or await configured readiness according to strategy; run exactly the manifest's first question through the production retrieval/materializer/streamed answer path; capture t0-to-TTFT/full-answer directly; await background readiness and record its status before starting the next paper. The annotation/question sidecar is already in memory and excluded from t0; PDF read, parse, index, and model initialization are included as specified by the cold protocol.
- [ ] **Step 6: Implement metric aggregation/report**. Emit independent `cold-first-query-v1` JSON/result metadata and P50/P95 by mode/strategy, with sample count, failures, readiness timings, actual retrieval mode, outline availability/use/fallback. Never feed these fields to `aggregateSpeedMetrics` or Q.
- [ ] **Step 7: Run cold runner and CLI tests**

  Run: `npx vitest run bench/src/tests/coldFirstQuery.test.ts bench/src/tests/coldFirstQueryMetrics.test.ts bench/src/tests/args.test.ts`

  Expected: PASS; cold strategy is measured from its own t0 and hot v2 contract is unchanged.
- [ ] **Step 8: Commit** `feat(bench): measure PDF cold first query`

## Task 8: Wire the product experiment and reports

**Files:**
- Modify: `bench/src/cli.ts`
- Modify: `bench/src/report.ts`
- Modify: `bench/README.md`
- Test: `bench/src/tests/cli.test.ts`
- Test: `bench/src/tests/report.test.ts`
- Test: `bench/src/tests/speedQualityRegression.test.ts`

**Interfaces:**
- Consumes: all three configs, `outline-study` data, Task 6 PDF quality protocol, Task 7 cold CLI output, existing `--speed`, `--compare` and report sections.
- Produces: documented commands for outline-study A/B/C/R hot speed and quality, separate cold strategies, and two Q configs; result metadata pins PDF/outline/manifest hashes and outlines' valid/fallback counts.

- [ ] **Step 1: Add CLI integration tests with fake embedder and streaming client**. One command runs each A/B/C on the same 3 PDFs; C invalid/missing outline remains in cohort as B fallback. R uses full-context mode with the same sample/question manifest.
- [ ] **Step 2: Run the integration test to confirm failure**

  Run: `npx vitest run bench/src/tests/cli.test.ts -t outline-study`

  Expected: FAIL because outline-study mode is not wired.
- [ ] **Step 3: Wire dataset, configs, expected retrieval mode, and metadata**. Do not alter QASPER dataset semantics; use the explicit PDF quality definition and source. Record outline entry count/availability/use/fallback separately for all papers.
- [ ] **Step 4: Render three product tables**: cold first-query by strategy; existing hot speed seven metrics with F1/Q_default/Q_speed; outline parse/build/use/fallback cost. Keep all-PDF denominator and valid-outline paired subset visibly distinct.
- [ ] **Step 5: Document exact pilot commands and scope**. State 3 PDFs/12 questions are a pilot; list expected logical request counts (hot A/B/C/R = 48; cold A/B/C × 2 strategies × 3 PDFs = 18, before retries), and explain no long-tail P95 claim from n=3.
- [ ] **Step 6: Run CLI/report/speed quality regression tests**

  Run: `npx vitest run bench/src/tests/cli.test.ts bench/src/tests/report.test.ts bench/src/tests/speedQualityRegression.test.ts bench/src/tests/qComparison.test.ts`

  Expected: PASS; existing QASPER speed/Q fixtures remain valid.
- [ ] **Step 7: Commit** `feat(bench): wire PDF outline speed comparison`

## Task 9: End-to-end pilot readiness

**Files:**
- Modify: `bench/README.md` only if the final commands/output paths differ from Task 8.
- No fixture PDF, credentials, model weights, benchmark outputs, or caches are committed.

**Interfaces:**
- Consumes: completed Tasks 1–8 and the current `exp/llm-structure` branch.
- Produces: a validated command sequence and a ready-to-run pilot; this task does not launch paid/model benchmark calls without an explicit runtime invocation from the user.

- [ ] **Step 1: Run the outline parser preflight** against all three minibatch PDFs and report pages, outline entry count, resolved count, destination failures, and fallback.
- [ ] **Step 2: Verify no-generation invariant** with fake-client counters for A/B/C; all structure/index generation counters must be exactly zero.
- [ ] **Step 3: Run code verification**

  Run: `npm run typecheck && npm test`

  Expected: PASS; all existing product and bench tests remain green.
- [ ] **Step 4: Run the offline index preflight** with local fixture PDFs and fake embedder counters; print A/B/C readiness, outline fallback, and manifest checks without making answer-model requests.
- [ ] **Step 5: Commit** `docs(bench): document PDF outline pilot protocol`

---

## Plan Self-Review

- **Spec coverage:** A/B/C/R, native outline destination resolution, zero-generation indexing, local 0.5 RRF prior, fallback denominator, PDF-QA source and guarded Q, existing hot speed protocol, both cold strategies, answer F1, pilot size/request count, report, CLI, and test coverage all map to Tasks 1–9.
- **Step scan:** Each task pairs named failing tests with a command, an interface contract, a code task, a passing check, and a commit. No task requires a future implementer to invent a symbol used by a later task.
- **Type consistency:** `PassageMode`, `PdfOutlineEntry`, `PdfOutlineNode`, `PassageIndexInfo.outline`, `PassageRetrievalOptions.outline`, `HybridPassageDiagnostics`, PDF QA definition, and `ColdFirstQueryRecord` are introduced before their consumers.
- **Review focus:** All five highest-risk inputs have owning tests in Tasks 1, 2, 4, 5, and 7.
- **Proportion:** The plan is longer than the design because it spells out exact interfaces, file boundaries, commands, and result gates; it does not include implementation bodies.
