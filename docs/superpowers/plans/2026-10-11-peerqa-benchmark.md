# PeerQA Sentence Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking. The user explicitly selected native execution in this conversation and authorized implementation after this plan; execute inline without another approval gate or subagents.

**Goal:** Run PeerQA through existing single-paper retrieval methods, score final sentence evidence coverage, and report answer quality and real streaming TTFT/Full Answer P50/P95 separately.

**Architecture:** A native TypeScript importer converts official QA and paper JSONL into frozen benchmark samples with sentence IDs and source spans. The common materializer exposes retained source fragments; a shared benchmark evaluator computes sentence coverage before generation, while shared finalization computes fixed-denominator PeerQA answer quality. Existing streaming contracts remain authoritative; optional external model scores enter through a validated offline artifact importer.

**Tech Stack:** TypeScript, Node.js filesystem/crypto APIs, existing tsx and Vitest, BGE-M3 materializer, existing production RAG pipeline. No new runtime package or database change.

---

## File responsibilities

- `bench/src/datasets/peerqa.ts`: official field validation, canonical sentence IDs/spans, normalization and normalized dataset loading.
- `bench/datasets/peerqa/import.ts`: local official JSONL import CLI, atomic normalized output and preparation counts.
- `bench/src/metrics/sentenceRetrieval.ts`: source fragment tracing, full sentence coverage, eligibility and fixed-denominator aggregation.
- `src/utils/contextTrace.ts`: expose exact emitted text fragments without changing generated context bytes or budgets.
- `src/utils/ragPipeline.ts`: forward materializer fragments to benchmark callers.
- `bench/src/runner/{qa,traditionalRagQa,strongBaselineQa}.ts`: call the common sentence evaluator before generation.
- `bench/src/metrics/peerqaQuality.ts`: ROUGE-L, missing prediction handling and answerability macro-F1; model-score artifact validation.
- `bench/datasets/peerqa/score.ts`: import AlignScore/Prometheus scores offline with original-result SHA-256.
- `bench/src/runner/support.ts`: initialize sentence zeros and finalize PeerQA metrics for all retrieval engines.
- `bench/src/runner/fullContextQa.ts`: finalize only PeerQA answer quality; keep full-context out of sentence ranking.
- `bench/src/{types,args,cli,evaluationContract,report}.ts`: sample types, dataset choice, wiring, fingerprints, separate reporting/comparisons.
- `bench/src/tests/peerqa*.test.ts`: offline unit and runner/stream regression tests.
- `bench/README.md`, `bench/datasets/peerqa/README.md`, `.gitignore`, `package.json`: runnable workflow and private local data paths.

## Task 1: Native dataset preparation

- [x] Write `bench/src/tests/peerqaDataset.test.ts` with a paper containing a heading, two sentences, evidence, an unanswerable question, and a free-answer-only question.

```ts
const paper = 'openreview/ICLR-2022-conf/example'
const rows = [
  { paper_id: paper, idx: 0, pidx: 0, sidx: 0, type: 'sentence', content: 'First evidence.', last_heading: 'Methods' },
  { paper_id: paper, idx: 1, pidx: 0, sidx: 1, type: 'sentence', content: 'Second evidence.', last_heading: 'Methods' },
]
const qa = [{ paper_id: paper, question_id: 'q1', question: 'What is reported?', answerable: true,
  answer_free_form: 'First evidence.', answer_evidence_mapped: [{ sentence: 'First evidence.', idx: [0] }] }]
```

- [x] Run `npx vitest run bench/src/tests/peerqaDataset.test.ts`; expect failure because the loader is missing.
- [x] Add shared types to `bench/src/types.ts` and implement `normalizePeerQa`/`loadPeerQaDataset` in `bench/src/datasets/peerqa.ts`. Use official `(paper_id, pidx, sidx)` IDs, deterministic row order, grouping by paragraph and injected heading, and exact normalized spans. Validate duplicate question/row/sentence IDs, invalid qrels, missing papers and non-finite indices. Preserve author answers independently from evidence eligibility.

```ts
export interface EvidenceSentence {
  id: string
  page: number
  text: string
  start: number
  end: number
}
export const normalizeSentenceText = (text: string): string =>
  text.normalize('NFKC').replace(/[\s\u00ad]+/gu, '')
```

- [x] Implement local import flags `--qa`, `--papers`, `--out`, optional positive `--limit`; parse with literal argv values, not shell interpolation. Write a schema-versioned normalized JSONL plus preparation metadata using Node filesystem APIs. Add `bench:peerqa:import` npm command and ignore imported JSONL/metadata.
- [x] Run dataset tests; expect all passing. No PDFs, dataset corpus or credentials enter Git.

## Task 2: Final context provenance and sentence metrics

- [x] Add materializer tests asserting emitted fragments exclude budget-truncated content and reconstruct the emitted source text. Add `peerqaSentenceRetrieval.test.ts` for partial evidence, duplicate selection, adjacent halves, non-adjacent fragments, identical text at different positions and trace failures.

```ts
expect(computeSentenceMetrics(['s1', 's2'], ['s1'])).toEqual({
  sentenceEvidenceRecall: 0.5,
  annotatedSentencePrecision: 1,
  allGoldSentenceCoverage: 0,
})
```

- [x] Run both tests and observe failures for missing provenance/metrics.
- [x] Add optional `pieces: ContextPiece[]` to materialized output and `contextPieces` to `RagRetrievalStage`; append exactly the token slice actually emitted per source page. Tokenization, separators, `.trim()` and pageOrder remain unchanged. Forward `pieces` only when provided.
- [x] Implement unique source-fragment lookup on normalized source pages, union covered source intervals by page, and count only sentence spans fully contained in the interval union. Gold IDs must exist in the frozen sentence corpus; empty context scores zero. Missing provenance or ambiguous/unmapped nonempty fragments throw a distinct contract error.
- [x] Add `applySentenceRetrieval(record, sample, question, pieces)`; store covered sentence IDs for audits. Initialize eligible records with all three zero metrics in `newSampleRecord`, so index/retrieval failure remains observable.
- [x] Wire the helper immediately after successful materialization in all three shared RAG engines and before generation. Contract errors bypass ordinary retrieval-failure catches.
- [x] Run sentence/materializer tests; expect passing and unchanged existing context text assertions.

## Task 3: Frozen sentence comparison identity

- [x] Write contract tests showing changing sentence text/IDs/spans/gold mappings changes the fingerprint, missing observations fail fixed-denominator validation, and different sentence definitions/cohorts suppress deltas.
- [x] Run `npx vitest run bench/src/tests/peerqaContract.test.ts`; expect new-field/denominator assertions to fail.
- [x] Extend `buildEvaluationContract` only when a PeerQA source is present. Add sentence definition, mapping version, eligible sentence question hash/count, reference/mapping counts and executed question IDs. Include sentence corpus and question evidence IDs/mapping in canonical fingerprints only for sentence-enabled samples, preserving QASPER identities.

```ts
export const SENTENCE_METRICS = [
  'sentenceEvidenceRecall', 'annotatedSentencePrecision', 'allGoldSentenceCoverage',
] as const
export const SENTENCE_RETRIEVAL_DEFINITION = 'final-context-sentence-v1' as const
```

- [x] In shared finalization, assert each sentence metric observation count equals the frozen eligible count; zero eligible questions produce no quality mean, only count zero. Extend comparison gates without weakening existing page/speed gates.
- [x] Run contract tests and existing `evaluationContract.test.ts`; expect passing.

## Task 4: Answer quality with explicit denominators

- [x] Write `peerqaQuality.test.ts`: ROUGE-L on reference-bearing questions, skipped/failed answers zero, missing/duplicate records rejected, successful refusal vs substantive response, and failure counted as true-class FN.
- [x] Run the quality tests and observe missing-module failures.
- [x] Implement `finalizePeerQaQuality` using existing `rougeL` and refusal detector. Compute per-reference maximum ROUGE-L F1, then mean over fixed reference question IDs. Compute macro-F1 from per-class TP/FP/FN; a missing prediction adds only true-class FN. Store quality definition, expected IDs, original references, output word counts and completed/reference counts.
- [x] Pass executed PeerQA questions to the finalizer in each RAG engine and full-context runner; do not reuse QASPER quality fields or Q scoring. Finalize after streaming completion and before reporting.
- [x] Implement optional offline model-score artifact validation. Require schema version 1, source result SHA-256, model identities, known unique IDs and answer SHA-256; validate AlignScore `[0,1]` and Prometheus `[1,5]`. Store raw score per question and normalized correctness `(score - 1) / 4`; missing valid model score contributes zero to the frozen reference denominator and yields a coverage count. Create-new output protects source results.
- [x] Add `bench:peerqa:score`; run native offline score tests for wrong answer hashes, ranges, identities and source hashes. Expect all passing.

## Task 5: CLI, separate reporting and real streaming regression

- [x] Extend args tests to accept `--dataset peerqa` and reject PeerQA summary/all task requests before requests or writes. Add optional `--dataset-path` for a custom normalized PeerQA dataset; `all` keeps the existing datasets to avoid breaking default runs.
- [x] Run args/report tests and observe failures for unsupported source/new tables.
- [x] Wire PeerQA loading and English answer framing in `cli.ts`; forward frozen materializer fragments. Existing `--speed` creates the same streaming policy. The importer metadata goes into normalized samples/contracts, not generation prompts.
- [x] Add `peerqaReport.ts` with independent sentence, answer and speed diagnostics. Native ROUGE-L/Macro-F1 always show available values; missing AlignScore/Prometheus show `—` and scoring instructions. Report reference counts, mapping coverage, attempt/completion counts, timeouts, stream failures and answer word-length P50/P95. Reuse the existing speed table for actual TTFT/Full Answer numbers. Export PeerQA quality separately from legacy page diagnostics.
- [x] Include a sentence comparison section in `--compare`; version/budget/fingerprint/eligible-cohort mismatch suppresses deltas. Never generate Q for PeerQA.
- [x] Add runner integration tests across PaperMind, traditional, strong and full-context. Use the real materializer and simulated streaming client; assert captured generation context and covered sentence IDs agree, generator failure preserves recall, index failure contributes zero, and all four latency percentiles come from the same successful IDs.
- [x] Run `npx vitest run bench/src/tests/peerqa*.test.ts bench/src/tests/args.test.ts bench/src/tests/speedQualityRegression.test.ts`; expect passing without network/credentials.

## Task 6: Documentation, final review and checks

- [x] Document official source preparation, native import/score commands, dataset-path selection and limitations in `bench/datasets/peerqa/README.md`; link it from `bench/README.md`.

```sh
npm run bench:peerqa:import -- --qa /path/to/qa.jsonl --papers /path/to/papers.jsonl
npm run bench -- --task qa --dataset peerqa --config default --speed
npm run bench -- --task qa --dataset peerqa --config rag-bm25 --speed
npm run bench -- --task qa --dataset peerqa --mode full-context --speed
```

- [x] Run `npm test`; expect all Vitest and branding checks to pass.
- [x] Run `npm run typecheck`; expect exit 0, including all benchmark modules.
- [x] Run `git diff --check` and review the diff against every design requirement. Fix any uncovered defect with a regression test, then rerun relevant checks.
- [x] Mark plan checkboxes completed with validation evidence; commit only this task's files. Preserve pre-existing `prompt.md` modifications.
- [x] Report document paths, implementation entrypoints and verification results. Distinguish mocked-stream regression checks from real PeerQA benchmark runs; do not invent quality or latency numbers.

## Validation evidence (2026-10-11)

- Native work completed inline on `codex/peerqa-benchmark`; no subagents or new runtime packages.
- Tests first exposed missing dataset/metric/report support; later regressions exposed empty official source units, unlabeled questions, duplicate formula/figure sentence identities, out-of-bounds spans, and incomplete quality comparison denominators. Those cases now pass.
- `npm test`: 120 Vitest files / 1500 tests passed; branding checks 18 passed, one environment-dependent `desktop-file-validate` check skipped.
- `npm run typecheck`: exit 0, including benchmark sources and tests.
- Native CLI regressions cover spaced paths, normalized reload and sidecar SHA-256, input overwrite protection, exact source/answer scoring identity, create-only scored output, and offline comparison.
- Official v1.0 archive import (outside the repository): 579 input rows, 53 unlabeled, 332 labeled questions lacking published source text, 85 papers / 194 imported questions. This verifies preparation compatibility, not benchmark quality or speed.
- Production retrieval/materializer and mock-stream integration covers all three shared RAG engines plus full-context, including index/retrieval/generation failures, missing provenance, final truncation and the shared successful latency cohort. No paid API or actual AlignScore/Prometheus inference ran.
- `git diff --check`: exit 0; all requested files are committed, pre-existing `prompt.md` edits remain unstaged.

Implementation refinements are recorded in the design findings: official null labels are counted and excluded, collided sentence IDs retain source text while being marked ambiguous, and native ROUGE-L is explicitly distinguished from the paper's tokenizer. Word lengths are computed over successful answers in the report and stored per answer for audits.
