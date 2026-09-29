# PageIndex-style TOC Tree Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a D benchmark arm that builds a deterministic title-only tree from PDF outline/TOC/heading evidence, asks the configured LLM to select tree nodes, and evaluates the selected PDF text with the existing QASPER quality and latency protocol.

**Architecture:** Extend PDF extraction with line-level layout metadata while preserving the existing page text byte-for-byte. Keep fallback candidate extraction, tree construction, routing, and diagnostics in focused benchmark modules; D builds its tree before query timing, performs one title-tree routing stage during the timed query, and materializes only selected page ranges with exact source traces. Existing A/B/C/R behavior stays unchanged.

**Tech Stack:** TypeScript, PDF.js 6, Vitest 4, BGE-M3 tokenizer, the existing OpenAI-compatible/Ollama benchmark client, official vendored QASPER evaluator.

**Spec:** `docs/superpowers/specs/2026-09-30-pageindex-style-toc-tree-benchmark-design.md`

## Global Constraints

- Call the new arm `D · PageIndex-style TOC tree`; never call it an official PageIndex reproduction.
- Build trees only from native bookmarks, TOC-page entries, or heading-line text and layout. Do not pass ordinary body paragraphs, QASPER `full_text`, questions, answers, gold evidence, or canonical alignment into the builder.
- Tree nodes contain only stable ID, title, depth, inclusive 0-based page range, source, and children. They contain no body summary, keyword, embedding, or question-dependent annotation.
- D uses no BM25, dense embedding, outline-vector RRF, first-node fallback, B/C fallback, or full-context fallback.
- D uses the same configured provider/model as answering, with client cache disabled and the routing prompt/config included in the run identity.
- The routing response selects at most three known nodes. Invalid/empty responses fail after the fixed routing attempts; parent selections read their full ranges; an ancestor and descendant selection keeps the descendant.
- Final D context contains only original PDF page text, preserves an exact source trace, and is capped at 4096 BGE-M3 tokens.
- Tree construction is outside timing. The complete routing request, validation, range resolution, deduplication, and context clipping are inside retrieval latency and TTFT.
- Keep exactly six reported metrics: AnswerF1, EvidenceF1, retrieval latency P50/P95, and TTFT P50/P95. Quality uses the frozen full denominator; speed uses the common fully successful cohort.
- Do not commit PDFs, prepared assets, model output, API credentials, SQLite data, or benchmark results.
- Match repository style: two-space indentation, single quotes, no semicolons, trailing commas in multiline structures.

## Review Focus

- PDF text items with absent, degenerate, or non-finite transforms must keep existing page text unchanged and yield finite layout defaults; Task 1 pins this in `pdfDocument.test.ts`.
- Multi-column TOC pages, Roman printed page numbers, and inconsistent printed-to-physical offsets must either produce verified entries in visual order or fall through to heading candidates; Task 2 pins this in `localPdfTocCandidates.test.ts`.
- Same-page sibling headings, repeated running headers, captions, and nested nodes must not create negative ranges or false tree nodes; Task 3 pins this in `localPdfTocTree.test.ts`.
- Fenced/trailing/malformed routing output, unknown IDs, empty lists, duplicates, and ancestor/descendant pairs must follow strict retry/dedup/failure rules without fallback; Task 4 pins this in `localPdfTocRouting.test.ts`.
- Overlapping and oversized selected ranges, including non-ASCII graphemes, must consume each page once, stay within 4096 tokens, and retain byte-accurate trace coverage; Task 4 pins this in `localPdfTocRouting.test.ts`.

---

## File Structure

**Create**

- `bench/src/localPdf/tocCandidates.ts` — extract and calibrate TOC-page and heading candidates from layout lines.
- `bench/src/localPdf/tocTree.ts` — choose the source, infer hierarchy and ranges, validate, and serialize the title-only tree.
- `bench/src/localPdf/tocRouting.ts` — format the tree prompt, validate model output, resolve selections, and materialize traced page ranges.
- `bench/src/tests/localPdfTocCandidates.test.ts` — fallback candidate extraction and page calibration.
- `bench/src/tests/localPdfTocTree.test.ts` — source priority, hierarchy, range, and validation behavior.
- `bench/src/tests/localPdfTocRouting.test.ts` — routing schema, retries, selection resolution, clipping, and trace behavior.

**Modify**

- `src/utils/pdfDocument.ts` — return line-level layout metadata alongside unchanged reconstructed page strings.
- `src/tests/pdfDocument.test.ts` — layout extraction and regression coverage.
- `bench/src/localPdf/prepare.ts` — freeze layout lines in each prepared corpus and include the changed parser source identity.
- `bench/src/localPdf/context.ts` — expose the shared token-budget clipping primitive used by passage and page-range materializers.
- `bench/src/localPdf/methods.ts` — prepare and execute D without initializing passage retrieval or embeddings.
- `bench/src/localPdf/types.ts` — add method D, tree/routing artifacts, and optional D diagnostics/identity fields.
- `bench/src/localPdf/contract.ts` — validate D records and require D identity fields without invalidating old A/B/C/R runs.
- `bench/src/localPdf/runtime.ts` — inject the uncached configured LLM completion function into D and hash routing/tree config.
- `bench/src/localPdf/query.ts` — copy retrieval diagnostics into the timed query record.
- `bench/src/localPdf/artifacts.ts` — persist one immutable tree artifact per D paper.
- `bench/src/localPdf/run.ts` — write trees, preserve D index failures, and retain routing diagnostics.
- `bench/src/args.ts` — accept D and default to `A,B,C,D,R`.
- `bench/src/localPdf/report.ts` — label D accurately and explain title-tree routing.
- `bench/src/tests/localPdfMethods.test.ts`, `localPdfQuery.test.ts`, `localPdfArtifacts.test.ts`, `localPdfContract.test.ts`, `localPdfCli.test.ts`, `localPdfReport.test.ts`, `localPdfRun.test.ts`, `localPdfFixtures.ts` — D integration regressions.
- `bench/README.md` — document D, request counts, timing, failure semantics, and mini/full commands.
- `docs/superpowers/benchmark-status.md` — link this implementation plan.

---

### Task 1: Preserve PDF Line Layout in Frozen Corpora

**Files:**

- Modify: `src/utils/pdfDocument.ts`
- Modify: `src/tests/pdfDocument.test.ts`
- Modify: `bench/src/localPdf/prepare.ts`
- Modify: `bench/src/localPdf/methods.ts`
- Modify: `bench/src/tests/localPdfDataset.test.ts`

**Interfaces:**

- Produces: `PdfTextLine { page: number; text: string; x: number; y: number; fontSize: number; bold: boolean }`.
- Produces: `reconstructTextPage(items: PdfTextItem[]): { text: string; lines: Omit<PdfTextLine, 'page'>[] }` while keeping `reconstructTextLines(items): string` as a compatibility wrapper.
- Produces: `ExtractedPdfDocument.layoutLines: PdfTextLine[][]` with one array per page.
- Produces: `PreparedCorpus { paperId; pages; outline; layoutLines }` for Tasks 2–6.

- [ ] **Step 1: Write failing PDF extraction tests.** Extend `src/tests/pdfDocument.test.ts` with `preserves reconstructed text while exposing finite line layout`: use two items on one visual line and one heading item; assert the old `pages` strings are byte-identical, line text is joined in x order, `x/y` come from the transform, `fontSize` is the finite transform scale, and `bold` follows `/bold/i` on `fontName`. Add absent, zero, and `NaN` transform items and assert all numeric fields are finite defaults while their text remains in `pages`.

- [ ] **Step 2: Run the focused test and confirm the red state.**

  Run: `npx vitest run src/tests/pdfDocument.test.ts`

  Expected: FAIL because `layoutLines` and `reconstructTextPage` do not exist.

- [ ] **Step 3: Implement the layout-preserving extraction interface.** Add `fontName?: string` to `PdfTextItem`. Produce `text` with the existing grouping algorithm unchanged. Build layout lines in a separate pass that flushes on `hasEOL`, y change beyond the existing tolerance, x reset, or an inter-item gap greater than `max(80, 4 × fontSize)` so same-row columns remain separate; derive line `x` from the minimum item x, `y` from the group y, `fontSize` from the maximum finite transform scale, and `bold` from any bold font name. Make `reconstructTextLines` return `reconstructTextPage(items).text` so existing consumers do not change output.

- [ ] **Step 4: Write the failing prepared-corpus test.** In `bench/src/tests/localPdfDataset.test.ts`, prepare a synthetic document with one `PdfTextLine`; read its `corpus.json`; assert `layoutLines` is frozen exactly, has the same page count as `pages`, and changing layout metadata changes the corpus SHA and manifest fingerprint. Assert a page-count mismatch is a parse failure rather than a corpus with misaligned layout.

- [ ] **Step 5: Freeze and type layout lines.** Update `prepareDataset` to validate and write `layoutLines`, include the relevant extraction sources in `parserIdentity`, and extend `PreparedCorpus`. Update existing extraction mocks with explicit layout arrays; do not synthesize layout from plain page strings in production.

- [ ] **Step 6: Run focused tests and typecheck.**

  Run: `npx vitest run src/tests/pdfDocument.test.ts bench/src/tests/localPdfDataset.test.ts`

  Expected: PASS.

  Run: `npm run typecheck`

  Expected: exit 0.

- [ ] **Step 7: Commit.**

  ```bash
  git add src/utils/pdfDocument.ts src/tests/pdfDocument.test.ts bench/src/localPdf/prepare.ts bench/src/localPdf/methods.ts bench/src/tests/localPdfDataset.test.ts
  git commit -m "feat(bench): preserve PDF line layout metadata"
  ```

### Task 2: Extract Verified TOC and Heading Candidates

**Files:**

- Create: `bench/src/localPdf/tocCandidates.ts`
- Create: `bench/src/tests/localPdfTocCandidates.test.ts`
- Read: `src/utils/sectionHeadings.ts`

**Interfaces:**

- Consumes: `PdfTextLine[][]` from Task 1.
- Produces: `TocCandidate { title: string; page: number; numbering: number[] | null; indent: number; fontSize: number; bold: boolean; source: 'toc-page' | 'heading' }`.
- Produces: `extractHeadingCandidates(layoutLines: PdfTextLine[][]): TocCandidate[]`.
- Produces: `extractVerifiedTocCandidates(layoutLines: PdfTextLine[][], headings: TocCandidate[]): TocCandidate[]`.

- [ ] **Step 1: Write failing candidate tests.** In `localPdfTocCandidates.test.ts`, cover: numbered and known-name headings; a short unnumbered heading at least 1.20× the document median font size; rejection of sentences over 100 characters or 20 words, captions matching `/^(figure|fig\.|table|algorithm)\b/i`, reference-list entries, and a normalized line repeated at the same y on at least three pages. Assert candidates expose only the heading line and layout fields—no adjacent body text.

- [ ] **Step 2: Add TOC-page calibration tests.** Build fixtures containing `Contents`, dotted leaders, Arabic and Roman printed page numbers, and two visual columns. Assert entries are ordered top-to-bottom within the left column before the right column, and are accepted only when normalized titles match heading candidates. Require one consistent physical-minus-printed page offset supported by at least two entries; conflicting offsets or fewer than two verified entries must return `[]` so Task 3 can use heading fallback.

- [ ] **Step 3: Run the candidate test and confirm the red state.**

  Run: `npx vitest run bench/src/tests/localPdfTocCandidates.test.ts`

  Expected: FAIL because `tocCandidates.ts` does not exist.

- [ ] **Step 4: Implement deterministic candidate extraction.** Reuse `isHeadingLine` for numbered/known headings; add only the exact short-title typography rule fixed above. Normalize title matching with NFKC, lowercase, punctuation-to-space, and collapsed whitespace. Parse terminal Arabic or Roman page tokens; use visual x/y coordinates to order columns and derive indentation. Keep all functions pure and do not accept pages, QASPER records, questions, or alignment artifacts.

- [ ] **Step 5: Run the candidate suite.**

  Run: `npx vitest run bench/src/tests/localPdfTocCandidates.test.ts src/tests/sectionHeadings.test.ts`

  Expected: PASS.

- [ ] **Step 6: Commit.**

  ```bash
  git add bench/src/localPdf/tocCandidates.ts bench/src/tests/localPdfTocCandidates.test.ts
  git commit -m "feat(bench): extract PDF TOC candidates"
  ```

### Task 3: Build and Validate the Title-only Tree

**Files:**

- Create: `bench/src/localPdf/tocTree.ts`
- Create: `bench/src/tests/localPdfTocTree.test.ts`
- Read: `src/utils/pdfOutline.ts`

**Interfaces:**

- Consumes: `TocTreeInput { paperId: string; pageCount: number; outline: PdfOutlineEntry[]; tocCandidates: TocCandidate[]; headingCandidates: TocCandidate[] }`; Task 5 creates this only after Task 2 has discarded ordinary body lines.
- Produces: `TocTreeNode { id: string; title: string; depth: number; startPage: number; endPage: number; source: TocTreeSource; children: TocTreeNode[] }`.
- Produces: `TocTreeArtifact { version: 'toc-tree-v1'; paperId: string; source: TocTreeSource; inputSha256: string; roots: TocTreeNode[] }`, where `TocTreeSource = 'native-outline' | 'toc-page' | 'heading'`.
- Produces: `buildTocTree(input: TocTreeInput): TocTreeArtifact`, `validateTocTree(value: unknown, pageCount: number): TocTreeArtifact`, `flattenTocTree(artifact): TocTreeNode[]`, and `TOC_TREE_CONFIG_SHA256`.

- [ ] **Step 1: Write failing source-priority tests.** Assert that a native outline with at least two nodes on two distinct pages is used unchanged in hierarchy and excludes fallback candidates. Assert invalid/one-page native outlines fall through first to at least two verified TOC entries, then to at least two heading candidates. Assert total failure throws `no-valid-toc-tree` and never manufactures a node.

- [ ] **Step 2: Write failing hierarchy and range tests.** Pin numbered depth (`2.1` under `2`), non-numbered font-size/indent depth, and the conflict rule that chooses the shallower depth. Stable IDs must be DFS paths `n0`, `n0.0`, and so on. The first top-level range starts at page 0; a node ends at the page before the next same-or-higher node; same-page siblings both include that page; the final top-level node ends at `pageCount - 1`; each parent covers every child.

- [ ] **Step 3: Add validation and review-focus cases.** Assert rejection of duplicate IDs, empty titles, negative/out-of-bounds/inverted ranges, child ranges outside parents, decreasing DFS start pages, fewer than two selectable nodes, captions, and repeated running headers. Assert `inputSha256` changes for any outline/candidate/page-count change and never depends on body page strings, questions, or gold.

- [ ] **Step 4: Run the tree test and confirm the red state.**

  Run: `npx vitest run bench/src/tests/localPdfTocTree.test.ts`

  Expected: FAIL because `tocTree.ts` does not exist.

- [ ] **Step 5: Implement tree selection, hierarchy, ranges, and validation.** Preserve valid native parent-child relationships; infer fallback depth from numbering first and visual rank second; assign IDs only after the final hierarchy is known. Compute `inputSha256` only from `paperId`, `pageCount`, outline, and filtered candidates; hash the exact builder version and threshold object exported by the module. Do not accept page strings/layout lines and do not import an LLM, embedder, QASPER type, or alignment module.

- [ ] **Step 6: Run focused tests.**

  Run: `npx vitest run bench/src/tests/localPdfTocTree.test.ts bench/src/tests/localPdfTocCandidates.test.ts src/tests/pdfOutline.test.ts`

  Expected: PASS.

- [ ] **Step 7: Commit.**

  ```bash
  git add bench/src/localPdf/tocTree.ts bench/src/tests/localPdfTocTree.test.ts
  git commit -m "feat(bench): build title-only PDF TOC trees"
  ```

### Task 4: Route Questions and Materialize Traced Node Text

**Files:**

- Create: `bench/src/localPdf/tocRouting.ts`
- Create: `bench/src/tests/localPdfTocRouting.test.ts`
- Modify: `bench/src/localPdf/context.ts`
- Modify: `bench/src/tests/localPdfTrace.test.ts`

**Interfaces:**

- Consumes: `TocTreeArtifact`, `(prompt: string) => Promise<string>`, PDF `pages`, and `countTokens`.
- Produces: `TocRoutingDiagnostic { rawAttempts: string[]; reasoning: string; requestedNodeIds: string[]; selectedNodeIds: string[]; selectedRanges: { nodeId: string; startPage: number; endPage: number }[] }`.
- Produces: `routeTocQuestion(question: string, tree: TocTreeArtifact, complete: (prompt: string) => Promise<string>): Promise<TocRoutingDiagnostic>`.
- Produces: `materializePageRanges(pages, ranges, countTokens, maxTokens): { text: string; trace: ContextTrace[]; tokenCount: number }`.
- Produces: `TOC_ROUTING_CONFIG = { maxNodeIds: 3, logicalAttempts: 2, contextBudget: 4096 }`, `TOC_ROUTING_PROMPT_VERSION`, and `TOC_ROUTING_CONFIG_SHA256`.

- [ ] **Step 1: Write failing prompt and parser tests.** Assert the prompt contains only the question and each node's ID, indentation, title, and 1-based display range; it must not contain page text or summaries. Accept only one strict JSON object with string `reasoning` and one-to-three string `node_ids`; reject fenced JSON, leading/trailing prose, unknown IDs, non-string IDs, more than three IDs, and an empty list.

- [ ] **Step 2: Write failing retry and resolution tests.** Assert valid output makes one completion call; invalid JSON followed by valid JSON makes exactly two logical calls and records both raw attempts; two invalid outputs reject. Deduplicate repeated IDs in first-occurrence order. When ancestor and descendant are both selected, keep the descendant; retain relevance order across unrelated nodes; never substitute the first node.

- [ ] **Step 3: Write failing materialization tests.** Select overlapping parent/child and disjoint ranges; assert every physical page is included at most once, selected-node relevance order is preserved, pages within a node are ascending, separators have `source: null`, and every non-null trace slice equals the exact source page substring. With a count function that exceeds 4096 inside a non-ASCII grapheme sequence, assert `tokenCount <= 4096`, clipping starts from the selected node's beginning, and the trace ends at the exact clipped source offset.

- [ ] **Step 4: Run the routing test and confirm the red state.**

  Run: `npx vitest run bench/src/tests/localPdfTocRouting.test.ts bench/src/tests/localPdfTrace.test.ts`

  Expected: FAIL because the routing and page-range APIs do not exist.

- [ ] **Step 5: Implement routing and page materialization.** Keep prompt creation, strict parse, selection resolution, and materialization as separate exported pure functions. Share one grapheme-safe budget clipping helper with `materializeTracedContext`; do not assume tokenizer monotonicity. The two logical attempts include all underlying client transport retries and therefore remain inside query timing.

- [ ] **Step 6: Run focused tests.**

  Run: `npx vitest run bench/src/tests/localPdfTocRouting.test.ts bench/src/tests/localPdfTrace.test.ts bench/src/tests/localPdfQuery.test.ts`

  Expected: PASS.

- [ ] **Step 7: Commit.**

  ```bash
  git add bench/src/localPdf/tocRouting.ts bench/src/localPdf/context.ts bench/src/tests/localPdfTocRouting.test.ts bench/src/tests/localPdfTrace.test.ts
  git commit -m "feat(bench): route queries through TOC trees"
  ```

### Task 5: Add D to the Benchmark Contract and Runtime

**Files:**

- Modify: `bench/src/localPdf/types.ts`
- Modify: `bench/src/localPdf/contract.ts`
- Modify: `bench/src/localPdf/methods.ts`
- Modify: `bench/src/localPdf/runtime.ts`
- Modify: `bench/src/localPdf/query.ts`
- Modify: `bench/src/args.ts`
- Modify: `bench/src/tests/localPdfFixtures.ts`
- Modify: `bench/src/tests/localPdfContract.test.ts`
- Modify: `bench/src/tests/localPdfMethods.test.ts`
- Modify: `bench/src/tests/localPdfQuery.test.ts`
- Modify: `bench/src/tests/localPdfCli.test.ts`

**Interfaces:**

- Consumes: Tasks 1–4 tree, routing, and materialization APIs.
- Changes: `Method = 'A' | 'B' | 'C' | 'D' | 'R'` and `METHODS = ['A', 'B', 'C', 'D', 'R']`.
- Changes: `MethodDeps` adds `routeToc?: (prompt: string) => Promise<string>`.
- Changes: `PreparedMethod.retrieve` returns `{ text; trace; routing? }`; D's prepared method also exposes `tree?: TocTreeArtifact`.
- Changes: `QueryRecord` adds optional `routing?: TocRoutingDiagnostic`; `RunIdentity` adds optional `tocTreeSha256` and `tocRoutingSha256`, required whenever the header includes D.

- [ ] **Step 1: Write failing contract and CLI tests.** Default run methods must equal `A,B,C,D,R`; explicit D must parse; unknown/duplicate methods must still fail. A D header without both TOC identity hashes must fail; old headers containing only A/B/C/R must remain valid. Completed D retrieval must include a valid routing diagnostic, while non-D records must reject one.

- [ ] **Step 2: Write failing D method tests.** Prepare D with layout lines and a routing mock; assert tree construction happens before `retrieve`, no embedder/BM25/passage pipeline is called, the routing prompt has no body text, and the returned context/trace/routing match the selected range. Missing `routeToc`, invalid trees, or final invalid routing output must throw without B/C/R fallback. Keep existing C missing-outline fallback behavior unchanged.

- [ ] **Step 3: Write failing timing-boundary tests.** In `localPdfQuery.test.ts`, advance the injected clock inside D's routing mock and assert that routing plus materialization occurs between `t0` and `tContextReady`; the answer stream's first visible token remains the TTFT endpoint. A D retrieval error must skip generation with `stage: 'retrieve'` and preserve no fabricated evidence.

- [ ] **Step 4: Run the integration tests and confirm the red state.**

  Run: `npx vitest run bench/src/tests/localPdfContract.test.ts bench/src/tests/localPdfMethods.test.ts bench/src/tests/localPdfQuery.test.ts bench/src/tests/localPdfCli.test.ts`

  Expected: FAIL because D is not wired.

- [ ] **Step 5: Implement D types, validation, runtime identity, and method preparation.** Inject `client.complete` from the same uncached configured model as `routeToc`; initialize the tokenizer for D, but initialize the dense embedder only for B/C. In D preparation, call Task 2 candidate extraction, pass only `TocTreeInput` into Task 3, then discard the full layout lines before routing. Hash prompt version, strict response schema, max three IDs, two logical attempts, model/provider generation options, and tree builder config. Branch D before the existing A/B/C passage pipeline.

- [ ] **Step 6: Copy D diagnostics into query records.** Set `routing` only after successful retrieval, before `tContextReady`; leave EvidenceF1 derivation in `run.ts` based solely on final context trace. Do not pass routing reasoning into answer messages.

- [ ] **Step 7: Run focused tests and typecheck.**

  Run: `npx vitest run bench/src/tests/localPdfContract.test.ts bench/src/tests/localPdfMethods.test.ts bench/src/tests/localPdfQuery.test.ts bench/src/tests/localPdfCli.test.ts`

  Expected: PASS.

  Run: `npm run typecheck`

  Expected: exit 0.

- [ ] **Step 8: Commit.**

  ```bash
  git add bench/src/localPdf/types.ts bench/src/localPdf/contract.ts bench/src/localPdf/methods.ts bench/src/localPdf/runtime.ts bench/src/localPdf/query.ts bench/src/args.ts bench/src/tests/localPdfFixtures.ts bench/src/tests/localPdfContract.test.ts bench/src/tests/localPdfMethods.test.ts bench/src/tests/localPdfQuery.test.ts bench/src/tests/localPdfCli.test.ts
  git commit -m "feat(bench): add PageIndex-style D arm"
  ```

### Task 6: Persist Trees and Complete End-to-end Reporting

**Files:**

- Modify: `bench/src/localPdf/artifacts.ts`
- Modify: `bench/src/localPdf/run.ts`
- Modify: `bench/src/localPdf/report.ts`
- Modify: `bench/src/tests/localPdfArtifacts.test.ts`
- Modify: `bench/src/tests/localPdfRun.test.ts`
- Modify: `bench/src/tests/localPdfReport.test.ts`

**Interfaces:**

- Consumes: D `PreparedMethod.tree`, `QueryRecord.routing`, and existing scoring/timing interfaces.
- Changes: `RunWriter` adds `writeTree(paperId: string, tree: TocTreeArtifact): Promise<void>` and writes immutable `trees/<paperId>.json` files.
- Produces: reports with the D label and unchanged six-key `SixMetrics` schema.

- [ ] **Step 1: Write failing artifact tests.** Assert one D tree is written at `trees/p.json`, a duplicate paper tree is rejected, the stored object passes `validateTocTree`, contains no page/body text, and interrupted runs leave any already-written tree auditable. A run without D must not create a trees directory.

- [ ] **Step 2: Write failing run tests.** Extend the synthetic end-to-end fixture to include `layoutLines`, A/D/R, a valid routing completion, and streamed answers. Assert D tree persistence, routing diagnostics in `records.jsonl`, EvidenceF1 derived from D's final trace, and offline `reportRun` equality. Add a second fixture whose tree construction fails and assert D records are index failures with fixed-denominator zero scores while A/R still execute.

- [ ] **Step 3: Write failing report/cohort tests.** Use A/B/C/D/R records and make one D generation fail; assert all methods receive the same empty/common speed cohort, quality IDs still include the question, D EvidenceF1 remains numeric, R null rules remain unchanged, and every method still has exactly six metric keys. Assert the report label is `D · PageIndex-style TOC tree` and includes the statement that D routes over title/page metadata without summaries.

- [ ] **Step 4: Run end-to-end tests and confirm the red state.**

  Run: `npx vitest run bench/src/tests/localPdfArtifacts.test.ts bench/src/tests/localPdfRun.test.ts bench/src/tests/localPdfReport.test.ts`

  Expected: FAIL because tree persistence/report integration is missing.

- [ ] **Step 5: Implement tree persistence and D run wiring.** Write the tree immediately after successful D preparation and before the paper's queries. Preserve the existing per-question append/fsync behavior. Treat a tree write failure as D index failure for that paper; never continue D with an unpersisted tree.

- [ ] **Step 6: Extend the report without adding metrics.** Add only the D label and explanatory prose; leave official scoring and `aggregateRun` arithmetic unchanged. Verify the generic scorer already handles D through its `Method` parameter rather than adding a parallel evaluator.

- [ ] **Step 7: Run the local-PDF benchmark test group.**

  Run: `npx vitest run bench/src/tests/localPdf*.test.ts`

  Expected: PASS.

- [ ] **Step 8: Commit.**

  ```bash
  git add bench/src/localPdf/artifacts.ts bench/src/localPdf/run.ts bench/src/localPdf/report.ts bench/src/tests/localPdfArtifacts.test.ts bench/src/tests/localPdfRun.test.ts bench/src/tests/localPdfReport.test.ts
  git commit -m "feat(bench): persist and report TOC tree runs"
  ```

### Task 7: Document, Verify, and Stage the Real Mini-batch

**Files:**

- Modify: `bench/README.md`
- Modify: `docs/superpowers/benchmark-status.md`

**Interfaces:**

- Consumes: the completed A/B/C/D/R CLI and frozen local datasets.
- Produces: reproducible commands and a clean, tested branch ready for the user-approved train mini-batch.

- [ ] **Step 1: Update benchmark documentation.** Document source priority, title-only tree contents, two routing attempts, maximum three nodes, 4096-token prefix clipping, no fallback, D timing, `trees/` and routing diagnostics, and the PageIndex-style naming limitation. Change default examples to `A,B,C,D,R`; state that D adds one or two routing calls per D question in addition to its answer call.

- [ ] **Step 2: Add exact preparation commands for fresh layout-aware manifests.** Use:

  ```bash
  npm run bench -- prepare --split train --dataset-root dataset --limit-papers 3 --out bench/prepared/train-3-toc-tree-v1.json
  npm run bench -- prepare --split dev --dataset-root bench/prepared/qasper-60-179-source --limit-papers 60 --out bench/prepared/qasper-60-179-toc-tree-v1.json
  ```

  Record that the second command must produce exactly 60 papers / 179 questions and `subset: true`; abort before any API request if it does not.

- [ ] **Step 3: Run the complete automated verification.**

  Run: `npm test`

  Expected: all Vitest and branding tests pass.

  Run: `npm run typecheck`

  Expected: exit 0.

  Run: `git diff --check`

  Expected: no output.

- [ ] **Step 4: Prepare the three-paper train manifest without model requests.** Run the first command from Step 2 and inspect the manifest/corpus artifacts: exactly 3 papers / 4 questions, one `layoutLines` array per page, no questions/answers/gold in any `corpus.json`, and no credentials in prepared files. Prepared assets remain ignored.

- [ ] **Step 5: Run the user-authorized train mini-batch through the existing detached supervisor.** Create an ignored launcher directory `bench/results/ds-train-3-toc-tree-v1-<timestamp>-launch/` using the established `launch.py` pattern: open `/Users/xmdjy/Library/Application Support/papermind/papermind.db` read-only, select exactly profile `ds`, pass its provider/model/base URL/key only through child environment variables, never log the key, start `npm run bench -- run --manifest bench/prepared/train-3-toc-tree-v1.json --methods A,B,C,D,R --out bench/results/ds-train-3-toc-tree-v1-<timestamp>` in a detached process, attach `caffeinate -i -w <child-pid>`, wait for the child, write `status.json`, terminate the keep-awake process, and exit. Queries remain serial. Do not launch the 179-question run in this task.

- [ ] **Step 6: Audit the mini-batch before declaring D ready.** Require 20 query records for 4 questions × 5 methods; inspect every D tree source, ensure tree files have titles/ranges only, ensure D routing requests occur after `t0`, validate contexts/traces and six metrics, and report any D index/routing failures without filtering them. If the mini-batch fails, return to the owning task and add a regression test before fixing.

- [ ] **Step 7: Commit documentation after verification.**

  ```bash
  git add bench/README.md docs/superpowers/benchmark-status.md
  git commit -m "docs(bench): document TOC tree comparison"
  ```

- [ ] **Step 8: Stop for result review.** Present the mini-batch table and tree/routing audit to the user. Start the frozen 60-paper / 179-question A/B/C/D/R run only after the user accepts the mini-batch result; use the second fresh manifest from Step 2 and the same auto-stopping detached supervisor.
