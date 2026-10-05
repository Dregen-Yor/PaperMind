# E heading hierarchy retrieval implementation plan

> Execute inline with executing-plans and test-driven-development; no exploration delegation.

**Goal:** Implement E variants and report real local-PDF QASPER results on the existing 60/179 scope.

**Architecture:** A dedicated heading retrieval module builds an index from the existing D tree, scores raw section text with BM25 and heading paths with cosine, and passes selected ranges to the existing traced materializer. The benchmark harness registers the variants and records configuration and diagnostic provenance.

**Tech stack:** TypeScript, Vitest, existing BM25/BGE-small embedder, official Python QASPER evaluator.

- [x] Add `bench/src/tests/localPdfHeadingRetrieval.test.ts`: exact ancestor paths, heading-only embedding input, cosine/BM25/RRF ranking, top-k and parent pruning, duplicate-page/budget traces, explicit invalid-vector failure. Run `npx vitest run bench/src/tests/localPdfHeadingRetrieval.test.ts` and observe failure before implementation.
- [x] Add `bench/src/localPdf/headingRetrieval.ts` exporting `E_METHOD_CONFIGS`, path expansion and index preparation. Reuse `buildBm25Scorer`, `cosineSimilarity`, `resolveTocNodeIds` and `materializePageRanges`. Re-run focused tests.
- [x] Extend `types.ts`, `contract.ts`, `methods.ts`, `runtime.ts`, `query.ts`, `artifacts.ts`, `run.ts`, and `report.ts`: accepted variants, E identity, index artifacts, ranking diagnostics and labels. Add CLI/runner coverage, run the relevant localPdf tests.
- [x] Document commands and ablation semantics in `bench/README.md`; run `npm test` and `npm run typecheck`.
- [ ] Locate the original frozen data, verify 60 PDFs/179 exact question IDs and input hashes, run train mechanism validation then the real dev experiment. Store launch settings without credentials, indices, predictions, official scores, original timings and logs in an ignored fresh output directory.
- [ ] Recompute official scores offline and verify run completeness and cohort identity. Add E results to `docs/testing/2026-10-05-local-pdf-qasper-179-results.md`, preserving historical data and stating configuration, raw artifact paths, limitations and any failures.

Validation: initial module/import and CLI/method regression tests were observed failing before implementation. `npm test`: 77 files / 947 tests passed, branding 18 passed / 1 skipped. After two additional retrieval edge-case tests, all local-PDF suites passed (19 files / 87 tests), and `npm run typecheck` passed again. Real endpoint connectivity: HTTP 200, model `deepseek-flash`.

Pending external input: original 60/179 frozen PDF data and manifest location. Repository and Downloads searches found no source data; original result directory referenced in the historical report is also absent. The data-location question is still pending, so full evaluation and the historical report's E scores remain incomplete.

Continuation verification: actual PDF parsing, BGE-M3 token counting, and cached BGE-small q8 inference succeeded for all five E configurations using the existing 4-page synthetic PDF smoke fixture. Dense variants emitted 384-dimensional vectors; every source trace reconstructed original page bytes and contexts stayed below 4096 tokens. Diagnostic-only outputs are in ignored `bench/results/e-integration-smoke/result.json`; no official benchmark scores were produced. The additional managed worktree search also found no original source PDFs or frozen manifest.

Blocked evaluation: path checks show no `dataset/qasper-pdfs`, no `bench/prepared`, and no original 60/179 result directory. There is no live official evaluation process; only the completed diagnostic smoke artifact exists. Initial implementation is committed at `52bbcc1`, but full real evaluation, k comparison, offline final score audit, and the E rows in the historical results report remain incomplete until the original data/manifest location becomes available.

Code review repairs: freeze preparation-time configuration so caller mutations cannot change retrieval under the saved hash; reject sparse embedding arrays before index persistence; validate saved E index method/config/hash/tree/nodes/vectors and bind completed query diagnostics to its ranking, top-k selection and page ranges on append and offline read. Regression tests reproduced these failures before the fixes. Failed E retrievals retain their fixed-denominator scoring path without requiring successful index artifacts.

Final review validation: `npm test` passed all 77 Vitest files / 954 tests and 18 branding tests (one Linux desktop validator test skipped because the tool is absent on this Mac). `npm run typecheck` passed. The independent follow-up review found no remaining actionable issues and verified serialized diagnostic round trips for all five E configurations. The official 60-PDF/179-question evaluation remains blocked on the source data.
