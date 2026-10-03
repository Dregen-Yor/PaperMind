# Retrieval optimization verification

The optimization follows the user-approved [design](../superpowers/specs/2026-10-03-retrieval-optimization-design.md). The reference implementation is `164943315e9ace985014ee71a41fcc39c7b753f6`, after the remote sync and branding integration.

## Reproduce the engineering comparison

```sh
node --import tsx scripts/benchmark-passage-retrieval.ts --baseline-ref 1649433 --passages 600 --iterations 120
```

The script extracts only the two reference retrieval modules into a temporary directory, resolves their unchanged utility dependencies from the current checkout, and removes that directory afterwards. It compares full passage results (including text, pieces, scores, selected IDs, sources, pages and diagnostics), budget filling and multi-paper RAG output with a fixed clock. It then reports first-query cost and warm P50/P95 separately for four retrieval modes. First-query cost includes preparation and retrieval; it is not an isolated index-build measurement.

The fixed synthetic corpus has 600 passages, contiguous subsection ranges, multiple raw page pieces and 4-dimensional deterministic vectors. The query sequence includes lexical hits and a complete miss. No model, model download, network request or answer generation occurs. These timings measure local retrieval computation and cannot establish real AnswerF1, EvidenceF1, TTFT or end-to-end gains.

The comparison covers lexical-only, card lexical fallback, passage dense, full card/vector fusion, title-card fallback, model identity mismatch, embedding failure, empty documents, five token budgets and randomized budget filling. Deferred array-replacement cases verify scoring/context read boundaries across embedding. Multi-paper comparison uses deterministic embeddings; the behavioral tests separately assert one lazy embedding call per RAG request and recovery after a failed request.

## Stage-one engineering measurements

Measured on 2026-10-04 with Node `v24.19.0`, macOS arm64, 600 passages and 120 measured queries per implementation/mode after 16 warmups. All 290 full-result equivalence cases passed against `1649433`.

| Mode | Baseline warm P50 / P95 (ms) | Optimized warm P50 / P95 (ms) | Baseline / optimized first query (ms) |
| --- | ---: | ---: | ---: |
| BM25 | 111.559 / 118.810 | 0.426 / 0.479 | 117.790 / 110.810 |
| Card lexical fallback | 113.647 / 157.164 | 0.795 / 1.186 | 114.663 / 135.186 |
| Passage dense | 112.190 / 118.923 | 0.650 / 0.769 | 155.874 / 113.135 |
| Full fusion | 112.249 / 119.594 | 0.783 / 0.910 | 112.014 / 118.035 |

Preparation remains a first-use cost. The first-query column includes both preparation and retrieval, and each entry is one sample; it is not a cold-start percentile. Warm savings reflect reuse of lexical statistics and mappings plus cheaper budget filling. They exclude actual embedding inference and JSON decoding. The product cache and request-scoped inference reuse are separately covered by behavioral tests. The fixed four-dimensional vectors make this a computation comparison, not a forecast of real embedding-model latency.

The same run measured repeated record parsing at P50/P95 **3.122083 / 3.321625 ms**, versus an in-process cache lookup at **0.000250 / 0.000416 ms**. Both consume the same prebuilt JSON strings. These lookup timings exclude database IPC, receiving/copying strings and any additional string-comparison cost for a fresh IPC payload. The script separately checks the cached parsed record equals a fresh parse, including decoded vectors.

Product behavior uses a cache owned by each chat store, limited to eight recent valid passage indexes. Exact raw index/pages content is checked on every collection; missing, changed or evicted records are parsed again, and invalid/legacy records stay on the existing fallback path. Retrieval statistics use weak ownership and validate mutable text/ranges. Query vectors and failures are shared only within one request; the next request retries normally.

## Stage-one integration checks

On 2026-10-04, `npm test` passed 99 files / 1357 Vitest tests and 18 branding checks. One branding check was skipped because `desktop-file-validate` is unavailable on this macOS host. `npm run typecheck` and `git diff --check` passed.

`CSC_IDENTITY_AUTO_DISCOVERY=false npm run build -- --dir` successfully compiled the renderer, Electron main/preload and packaged the macOS arm64 app directory. An Electron/Playwright smoke run used isolated temporary user data and real SQLite/IPC, opened the library, chat and settings views, verified all images loaded and observed zero renderer errors. It tested supported offline navigation; it did not perform online embedding inference or real answer generation. Generated bundles and app packages are excluded from commits.

## Evaluation boundary

The historical numbers in `prompt.md` come from different runs. They are background evidence for the design, not new measurements of this implementation. The frozen 60-paper/179-question QASPER slice and its answering-model configuration are not included in this checkout. A real comparison must reuse that slice, answer model, generation settings and prompts, the frozen 4096-token materializer and the common successful-question set for timing. Report AnswerF1, evidence metrics, retrieval P50/P95, TTFT, failure counts and index/model cold-start cost together.

Heading priors remain disabled by default until that controlled evaluation supports changing the default. Synthetic title-hit tests establish configurable behavior and provenance preservation; they do not establish answer-quality improvement.
