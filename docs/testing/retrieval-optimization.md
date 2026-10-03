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

The historical numbers in `prompt.md` come from different runs. They are background evidence for the design, not new measurements of this implementation. On 2026-10-04, the repository's public fetch script downloaded the expected 60-paper/179-question QASPER slice into the ignored dataset path. The existing answering-model configuration is still unavailable. A full comparison must reuse that slice, answer model, generation settings and prompts, the frozen 4096-token materializer and the common successful-question set for timing. Report AnswerF1, evidence metrics, retrieval P50/P95, TTFT, failure counts and index/model cold-start cost together.

Heading priors remain disabled by default until that controlled evaluation supports changing the default. Synthetic title-hit tests establish configurable behavior and provenance preservation; they do not establish answer-quality improvement.

## Final engineering comparison

After heading integration, the same 600-passage/120-query command passed **450 full-result equivalence cases** against `1649433`, including explicit zero weight versus omitted weight. On the same host/date, it measured:

| Mode | Baseline warm P50 / P95 (ms) | Final warm P50 / P95 (ms) | Baseline / final first query (ms) |
| --- | ---: | ---: | ---: |
| BM25 | 110.366 / 117.061 | 0.425 / 0.543 | 118.558 / 110.791 |
| Card lexical fallback | 111.500 / 120.711 | 1.351 / 2.487 | 112.934 / 127.021 |
| Passage dense | 110.785 / 118.072 | 0.638 / 0.781 | 187.117 / 110.568 |
| Full fusion | 111.536 / 117.976 | 0.719 / 0.976 | 112.300 / 110.400 |

Repeated parsing measured P50/P95 3.135375 / 3.666458 ms, versus 0.000250 / 0.000375 ms for the same in-process string cache lookup. The stage-one scope and limitations above apply unchanged.

The separate synthetic full-fusion heading arms measured first-query / warm P50 / warm P95 at weight 0: 110.914 / 0.747 / 0.954 ms; weight 0.25: 114.822 / 0.759 / 0.860 ms; weight 0.5: 110.831 / 0.723 / 0.824 ms. These sequential microbenchmarks demonstrate low local scoring overhead, not end-to-end model latency or a reliable advantage for a particular positive weight.

The final `npm test` run passed 101 files / 1379 Vitest tests and 18 branding checks, with the same unavailable Linux desktop validator skipped. `npm run typecheck` and `git diff --check` passed. The macOS arm64 app directory build passed again, followed by isolated Electron offline smoke checks for library, chat and settings: all images loaded, zero renderer errors. The final independent review found no issues.

## Heading experiment

`headingWeight` is optional and defaults to zero. Positive weights add a sparse BM25 subsection-title RRF signal; they do not filter other passages or insert headings into fact context. Zero weight and queries without a positive heading hit preserve the preceding implementation's results. Historical benchmark configurations are unchanged.

The separate `papermind-hybrid-heading` configuration compares weights `0`, `0.25` and `0.5`, holding section weight at `0.5` and the existing small embedder identity/settings fixed. With the same answering-model environment configured privately, run:

```sh
npm run bench -- --task qa --dataset qasper --config papermind-hybrid-heading --speed
```

The speed mode disables answer-cache reuse and runs with concurrency one. The selected weight is forwarded through the CLI, runner and shared RAG pipeline and recorded in each experiment's config metadata. This command was not run with an answering model in this verification.

For the separate retrieval-only lexical ablation:

```sh
QASPER_LIMIT=60 node --import tsx bench/datasets/qasper/fetch.ts
node --import tsx scripts/evaluate-heading-retrieval.ts
```

The helper uses all 179 questions, real passage segmentation at 120–350 tokens, the shared product RAG pipeline and the frozen BGE-M3 tokenizer/materializer at 4096 tokens. Evidence metrics use the fixed 122-question eligible cohort and final materialized page order. There are no dense vectors, structure cards or generated answers. The helper aborts rather than recording failed questions as zero-valued results.

Measured on 2026-10-04 with Node `v24.19.0`, macOS arm64:

| Heading weight | Evidence recall | Evidence hit rate | Context precision | Context-page MRR | Retrieval + materialization P50 / P95 (ms) | Changed selections / 179 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 0.989754 | 0.991803 | 0.197089 | 0.409170 | 206.889 / 308.299 | 0 |
| 0.25 | 0.989754 | 0.991803 | 0.197872 | 0.410819 | 208.966 / 312.611 | 6 |
| 0.5 | 0.989754 | 0.991803 | 0.197944 | 0.411082 | 206.295 / 311.390 | 6 |

No eligible question's recall improved or worsened, and no context exceeded the budget or required truncation. Tokenizer loading took 6198.711 ms; segmentation and three warm retrieval/materialization calls per paper took 79849.655 ms in total. These preparation costs are reported separately from the measured query percentiles. The arms run sequentially on one host, so the small latency differences do not establish a speed gain.

Dataset fingerprint: `ad7851b9c08b693f133396eff17df0bad055084c9fcefa81d31d8ebe93f1c83d`. Eligible-question IDs hash: `736a84c84883c8ea530714a1989339166e240aa189850d741b37bcc037e5e9fe`. Retrieval/helper source fingerprint: `8278932d0d494d2144e3a73ba9efcd4b6710d3d45277d6f14c98c53366b293f1`. The run used uncommitted heading changes on base `fff50cc`; the fingerprint identifies the measured source. Tokenizer revision is `main`, matching the frozen evaluation contract.

This real-data lexical comparison showed unchanged evidence recall and small page-order/precision changes. It does not establish improvement for the full dense/card method or answer quality. AnswerF1, EvidenceF1, TTFT and Q scores remain unmeasured, and heading priors remain off by default.
