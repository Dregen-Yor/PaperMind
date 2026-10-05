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

The historical numbers in `prompt.md` come from different runs. They are background evidence for the design, not new measurements of this implementation. On 2026-10-04, the repository's public fetch script downloaded the expected 60-paper/179-question QASPER slice into the ignored dataset path. At that stage, an answering-model configuration had not yet been supplied; the later controlled DeepSeek follow-up below supersedes that limitation. A full comparison must reuse that slice, answer model, generation settings and prompts, the frozen 4096-token materializer and the common successful-question set for timing. Report AnswerF1, evidence metrics, retrieval P50/P95, TTFT, failure counts and index/model cold-start cost together.

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

This real-data lexical comparison showed unchanged evidence recall and small page-order/precision changes. It does not establish improvement for the full dense/card method or answer quality. For this heading-only experiment, AnswerF1, EvidenceF1, TTFT and Q scores were unmeasured. Heading priors remain off by default; the later DeepSeek experiments below keep heading weight zero.

## Follow-up: exact-tokenizer materialization

Profiling eight papers / 20 questions found that tokenization accounted for 4104.329 of 4121.112 ms of materialization, with 863.521 ms spent on repeated inputs in the same call. The materializer now reuses the first piece's guard tokens for emission and reuses separator tokens within the call. It retains no cross-request token or answer cache.

```sh
node --import tsx scripts/benchmark-context-materialization.ts --baseline-ref 5331fc6
```

The helper compares the baseline/current complete `{text, pageOrder, tokenCount, truncated}` outputs on all 179 questions at budgets 1, 64, 256 and 4096. All **716 comparisons passed**. It alternates baseline/current timing order, uses the actual frozen BGE-M3 tokenizer, and reports shared index preparation separately. With the same dataset fingerprint and 122-question evidence cohort above, all final evidence metrics were identical.

On 2026-10-04, Node `v24.19.0`, macOS arm64, 4096-budget materialization P50/P95 fell from **214.157 / 329.433 ms** to **172.500 / 233.167 ms**. Tokenizer calls across 179 measured questions fell from **6713 to 4320**. Tokenizer loading took 650.933 ms; shared passage segmentation and lexical-statistics preparation took 47119.552 ms. The run used uncommitted changes on `5331fc6` with source/helper fingerprint `360aebeabe2f1cea4ccc602d1e9da59d73ac14fd1431c26f0b2f0669d0d6a943`.

This is a controlled exact-tokenizer context-processing improvement. The desktop currently uses estimated token counts, so these measurements do not establish the same reduction in desktop response latency. The user's accuracy objective remains separate: baseline/candidate answer quality must now be measured using the user-supplied DeepSeek endpoint and an identical generation protocol. No answer-quality gain is claimed for this result-preserving change.


## Controlled DeepSeek quality follow-up

The user supplied a DeepSeek endpoint for actual answer evaluation. These runs use `deepseek-flash` at `https://api.deepseek.com`, thinking disabled, temperature 0, requested top-p 1, maximum output 4096, streaming, no answer-cache reuse and concurrency one. They use the same 60 papers / 179 questions, 122 eligible evidence questions, BGE-M3/4096 materializer, and `Xenova/bge-small-en-v1.5` q8/384 embedder. Section weight is 0.5 and heading weight remains zero. Model, tokenizer and dataset file hashes are preserved in the local run protocol. They are not directly comparable to the historical model runs in `prompt.md`.

The baseline at `65073f0` completed 179/179 questions with no request failures. Its 60 raw card responses revealed a concrete reliability problem: only 26 passed validation. Thirty otherwise usable responses placed `sections` under `paper` or supplied more than 12 valid keywords. The narrow normalization at `78de389` restores those responses without another request, preserves already-valid inputs, and retains the complete original range/coverage/title validation. Four responses still fail: three have too many cards and one has an invalid range. The versioned build contract rebuilds old cards while retaining reusable passage vectors.

The normalization-only arm replays the exact baseline card responses and generates every answer live. It completed 179/179 questions with no errors; all dataset/model/generation/framing identities match. This isolates output processing from a second stochastic card-generation run. Replayed cold-index call counters represent logical client calls, and their timing, token estimates and cache counters must **not** be interpreted as live index cost or compared with the baseline cold start.

| Metric | Baseline | Card normalization |
| --- | ---: | ---: |
| All-question AnswerF1 | 0.231928 | 0.228795 |
| Page evidence recall | 0.987705 | 0.987705 |
| Page evidence hit rate | 0.991803 | 0.991803 |
| Context precision | 0.199526 | 0.199212 |
| Context-page MRR | 0.413710 | 0.413710 |
| Card fallback rate | 34/60 (56.7%) | 4/60 (6.7%) |
| Evidence ready P50 / P95 (ms) | 186.778 / 257.209 | 190.852 / 266.054 |
| TTFT P50 / P95 (ms) | 825.911 / 1192.959 | 853.046 / 1187.963 |
| Full answer P50 / P95 (ms) | 1344.501 / 2472.414 | 1330.242 / 2353.941 |

Normalization improves card reliability; this experiment does **not** establish an answer-quality gain. The AnswerF1 delta is -0.003134, with a 60-paper clustered bootstrap 95% interval of [-0.015619, 0.008408] (5000 resamples, seed 20261004). On the 86 questions belonging to recovered-card papers, the delta is +0.000708. On the other 93 questions it is -0.006686, illustrating variation even when index handling is unchanged. Page order changed for 12 questions and final context token count for 31. An unchanged-index example, `1809.01202#0`, gives the same baseline list in both answers but falls from F1 0.609 to 0.147 due to extra explanation; `1909.09067#0` also loses useful page-segmentation detail and needs to be treated as a substantive regression, not dismissed as verbosity.

The baseline ran for 886638 ms including real indexing. Its cold-index total P50/P95 was 10418/14844 ms, and card-call P50/P95 was 9459/13577 ms. An unintended full test run overlapped part of the baseline, and focused tests overlapped candidate development. Network/provider variability and this local activity limit interpretation of small sequential speed differences. The separate exact-tokenizer equivalence experiment above is the evidence for the local materialization speed gain.

The local, ignored artifact directory is `bench/results/2026-10-04-retrieval-quality/`. It preserves raw results, all 60 raw card responses, strict-validator diagnostics, comparison code, credential-free capture/replay wrappers and `protocol.json`. Dataset file SHA-256: `ea45d94ccc1fc5cd798257bf872d3fef580ae4be6e2c970119b5e42ab7cb6716`. The baseline and normalization result byte hashes are `c992de12e3615d4d8378982d648768ba004a99ecd17599d667f80354dd87356a` and `6090cfad297800526eeab5396b23270444795cf63e395c04ac698e8caf0b809e`. Credentials are supplied through a private configuration file; they are not in these artifacts or source control.

### Rejected grounding prompt

A first prompt (`80a5ad9`) asked for a direct answer followed by necessary evidence and qualifications. Its separately labeled prompt ablation completed 179/179 questions. Retrieved page order, final token count, selected pages, retrieval mode and truncation status matched normalization-only for every question. The framing hash changed, so this is not an eligible same-framing Q comparison.

It was rejected: AnswerF1 fell to **0.151755**, with a clustered delta interval of **[-0.100073, -0.055652]** versus normalization-only. Median answer length grew from 71 to 141 words. Full-answer P50/P95 grew to 1658.603/2716.848 ms; TTFT was 802.309/1167.737 ms. It did not fix the audited BERT scope contradiction or the unsupported negative about automatic hyperparameter optimization. Two TLS connection resets were retried successfully (181 answer attempts for 179 completed questions); their incomplete usage accounting leaves aggregate online token usage unavailable. Rejected results and actual request messages are retained locally as `grounded-rejected*` and `grounding-rejected-comparison.json`.

A revised candidate gives structured, adaptive-detail rules after the reference context. It asks for the smallest complete factual answer, keeps necessary qualifications, and retains reasoning for explanations, comparisons, derivations and explicit requests for detail. The fixed 12-question diagnostic gave F1 0.273014 → 0.410233, but the questions were selected from inspected categories: this is debugging evidence, not a general accuracy estimate. Three generic scope/uncertainty examples were also tested privately; they did not fix the known errors and were discarded. Two additional live Chinese/English detail requests retained substantive explanations of tokenization, output-space alignment, embedding dimensions and limitations. The revised prompt then advanced to the complete-slice comparison and regression inspection below.

### Final adaptive-detail comparison

The final candidate at `1249248` completed all **179/179** questions with **179 live answer requests, no retries and no errors**. All 60 index responses matched their exact recorded requests. Compared with normalization-only, all 179 questions have identical page order, selected pages, context token count, retrieval mode and truncation status; the four evidence metrics are unchanged. Dataset, model, generation and runtime-environment identities match. The new framing hash is `f4dbab07e8c878b8e9b31ef4ec0c178c9418e36b1c15a26c032eb39e374f2ae2`, so this remains a separately labeled prompt ablation.

| Metric | Normalization, original prompt | Adaptive-detail prompt |
| --- | ---: | ---: |
| All-question AnswerF1 | 0.228795 | 0.348090 |
| Page evidence recall | 0.987705 | 0.987705 |
| Context-page MRR | 0.413710 | 0.413710 |
| Median / mean answer words | 71 / 99.017 | 26 / 39.084 |
| Evidence ready P50 / P95 (ms) | 190.852 / 266.054 | 196.752 / 302.906 |
| TTFT P50 / P95 (ms) | 853.046 / 1187.963 | 825.396 / 1148.007 |
| Full answer P50 / P95 (ms) | 1330.242 / 2353.941 | 1104.825 / 1660.141 |
| Mean online tokens per answer | 3440.877 | 3525.721 |

There are 129 higher-F1 answers, 32 lower and 18 equal. The paired mean delta is **+0.119295**, with a paper-clustered bootstrap interval of **[+0.089414, +0.152149]** under the same resampling protocol. Relative to the original pre-normalization baseline, the final F1 is 0.231928 → 0.348090. This is a substantial lexical-score improvement, largely from focused expression. It does **not** establish a corresponding percentage increase in semantic correctness. The repeated prompt iterations use this same development slice, so the bootstrap describes these recorded answers and is not held-out generalization evidence.

Full-answer P95 is 29.5% lower than normalization-only in this run; answer generation is shorter. TTFT changes are small, evidence-ready P95 actually rises, and sequential host/provider variation still applies. This prompt does not improve the retrieval algorithm. Online token usage rises about 2.5% because the longer instruction adds input tokens despite shorter answers. Cold replay costs remain excluded.

Qualitative checks retain both improvements and limitations:

- Dataset, metric and language-pair questions such as `1910.10781#0`, `1708.01464#2` and `1611.01576#0` retain the requested facts while removing unrequested background. These large F1 gains mainly reflect expression, not newly discovered facts.
- `1809.01541#1` falls from F1 0.56 to 0 because the answer uses correct language codes (`de`, `en`, etc.) instead of the full language names. Likewise, `1811.00383#1` uses “Five” instead of “5” while retaining the correct five pairs. These are metric/wording differences.
- `1809.04267#0` loses the explicit relationship between candidate-answer semantics and question generation; this is a substantive completeness regression. Necessary information can still be omitted despite the instruction to give a complete answer.
- The BERT all-systems comparison (`2003.03106#2`) still starts with an incorrect affirmative followed by a counterexample. The hyperparameter question (`1611.04798#0`) still turns missing information into a definite negative. The English-only question (`1802.06024#0`) still infers a stronger claim than the provided evidence supports. These problems are unresolved.
- All six unanswerable-reference questions still have zero official lexical F1, including natural-language abstentions. The legacy pattern metric changes from 2/6 to 1/6 because “does not report” is not recognized where “does not mention” was. That pattern also incorrectly credits a negative answer containing “does not mention”; it is not a reliable semantic accuracy measure. The frozen scoring rules were not changed to improve the reported score.
- Separate live Chinese/English requests for detailed explanation still produce substantive discussion rather than terse fact-only replies. These are two behavior diagnostics, not broad multilingual validation.

Retain the adaptive-detail prompt for its measured lexical score and shorter complete-response latency, with these limitations explicit. Keep heading priors disabled. The final source passed **101 files / 1398 Vitest tests**, **18 branding checks** (one Linux desktop-validator check skipped on macOS), `npm run typecheck`, `git diff --check`, and the macOS arm64 directory build. Spec and code-quality reviews passed. Final result SHA-256: `52047c3b6efa8fd195a6ed550d99e0ab89ae45548d7660d56a69eaa7b4f64206`; local results, request messages, diagnostics and reproduction instructions are preserved in the artifact directory above.
