# Context materialization performance follow-up

> For agentic workers: use superpowers:subagent-driven-development to implement and independently review the production change. This follows the already approved design's result-preserving removal of repeated work and the user's request to continue improving performance.

**Goal:** Reduce measured real-corpus context processing cost while preserving the complete materialized output and evaluation contract.

**Goal scope clarification:** The user explicitly clarified that performance includes accuracy, not just speed. This materializer change is only one supporting task; completing it does not complete the active optimization goal. Continue with real evidence-error analysis and controlled retrieval/answer quality experiments. The user will provide the answering model and local configuration location; model-dependent evaluation awaits that information, while offline evidence analysis can proceed.

**Architecture:** Reuse tokens already computed for a group's first piece and separator within one `materializeContext` call. Keep the existing tokenizer, piece boundaries, rendering, separator guard, truncation semantics, provenance and 4096-token contract. Retain no cross-request cache, answer cache or new dependency.

**Evidence:** At baseline `5331fc6`, an instrumented 8-paper / 20-question QASPER sample spent 4121.112 ms materializing contexts, including 4104.329 ms in tokenization. Repeated inputs within the same call consumed 863.521 ms (315 of 818 tokenizer calls). The current implementation tokenizes each first piece for the guard and again for emission, and tokenizes separators repeatedly.

## Task 1: Remove duplicate materializer work

Files: `src/utils/contextTrace.ts`, `src/tests/contextTrace.test.ts`.

- [x] Add a deterministic counting tokenizer test showing that each first piece is tokenized once, and a separator at most once per materialization. Assert the complete text/page/token/truncation output as well as the expensive-call bound.
- [x] Add regression coverage for exact-fit and separator-only remaining budget, partial pieces, whitespace groups, zero-token pieces, Unicode rendering and isolation between calls/tokenizer instances. Keep existing budget validation behavior.
- [x] Run `npx vitest run src/tests/contextTrace.test.ts` and observe the duplicate-call regression fail before changing production code.
- [x] Change the internal emitter to consume the token array already computed by the caller; pass first-piece tokens through to emission. Lazily reuse separator tokens only inside this call. Keep the empty-prefix tokenization and zero-token behavior compatible.

```ts
const emit = (tokens: string[], page?: number): boolean => {
  // Existing take/render/provenance/truncation logic uses this array.
}
// In the group loop, retain firstTokens as an array for both guard and emit.
// Subsequent pieces are tokenized only as they are visited.
```

- [x] Run focused context and evaluation-contract tests plus typecheck. Obtain spec review, then code-quality review before moving on.

## Task 2: Real-corpus equivalence and performance

Files: create `scripts/benchmark-context-materialization.ts`; update `docs/testing/retrieval-optimization.md`.

- [x] Load the baseline materializer from `git show 5331fc6:src/utils/contextTrace.ts` into a temporary module and clean it up afterwards.
- [x] Use the public fixed 60-paper/179-question QASPER slice, existing BGE-M3 tokenizer and unchanged passage retrieval to produce candidate groups. Assert full baseline/current materialized-result equality at budgets 1, 64, 256 and 4096; report the frozen cohort/dataset identity. No LLM calls.
- [x] Measure baseline/current 4096-budget calls with alternating execution order to reduce drift; report P50/P95, tokenizer calls and first-use preparation separately. Count time spent creating indexes separately from materialization. Record source hashes for baseline/current helper and production code.
- [x] Include complete raw-result equality in acceptance; evidence metric equality follows from the identical final text and page order. Explicitly identify this as exact-tokenizer context processing, which is used in controlled benchmarks; the desktop currently uses estimated token counts and its overall response latency is not established by this measurement.

## Task 3: Integration and delivery

- [x] Run full `npm test`, `npm run typecheck`, `git diff --check` and `CSC_IDENTITY_AUTO_DISCOVERY=false npm run build -- --dir` after production changes.
- [x] Review the complete diff independently and fix concrete findings. Record measured improvement and practical limits; do not assert AnswerF1 or TTFT gains without a real answering model.
- [x] Commit, fetch remote and integrate/push with the user's existing remote-priority policy. Preserve the pre-sync stash. Verify a clean checkout and matching local/remote main.

Verification: duplicate-call regression failed before implementation; 10 focused tests passed afterwards. Spec review independently compared 24,696 deterministic edge combinations, then closed missing Unicode/multiple-separator coverage. Code-quality review of production, tests and the real-data helper found no actionable issues. Full suite: 101 files / 1382 tests, 18 branding passes and one unavailable Linux validator skipped. Typecheck, whitespace checks and macOS arm64 app directory build passed. Real-corpus 716 comparisons preserved all output fields; materialization P95 fell from 329.433 to 233.167 ms.

Accuracy work continues: the user supplied a DeepSeek endpoint and credentials for controlled evaluation. A one-question `deepseek-flash` pilot completed successfully with thinking disabled, temperature 0, max output 4096 and streaming. Its card generation fell back with `invalid-structure`; inspect full-run raw card responses and answer errors before choosing an accuracy change. The one-question pilot is connectivity evidence, not an accuracy estimate. Credentials remain outside the repository.

Delivery follow-up: the complete accuracy experiments and final source checks are recorded in `2026-10-04-retrieval-accuracy.md` and `docs/testing/retrieval-optimization.md`. On 2026-10-04, all verified changes and the evaluation report were fast-forwarded into main and pushed at `fb75dae`; local and remote main matched with a clean checkout. No merge conflict occurred. Both pre-existing stashes were preserved.
