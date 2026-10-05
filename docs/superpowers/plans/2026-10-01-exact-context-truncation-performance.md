# Exact Context Truncation Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking. The user selected native execution; do not delegate implementation.

**Goal:** Remove repeated Unigram lattice construction during PDF context truncation while retaining exactly the longest legal grapheme prefix and existing context/trace.

**Architecture:** Search grapheme endpoints in descending order, stopping at the first within budget; this is exact even when token counts are nonmonotonic. Cache an exact Unigram Viterbi lattice for one normalized input and reuse it for prefixes, keeping the upstream normalization, special-token handling and unknown fusion intact. Rebuild on non-prefix input; preserve predecessor ordering and floating-point comparisons of Transformers.js.

**Tech Stack:** TypeScript, Transformers.js 3.x, Vitest, local BGE-M3 tokenizer.

**Spec:** User-approved bounded design in this conversation (2026-10-01): only truncation performance plus offline equivalence verification; routing optimization deferred.

## Global Constraints

- Preserve longest legal grapheme prefix, 4096-token budget, selected pages, context text and original-source trace.
- Do not assume token counts are monotonic or normalized prefixes correspond to raw-text prefixes.
- Do not change route/answer generation, quality metrics or existing benchmark results.
- No paid API calls; reuse saved routing from the 60-paper/179-question rerun.
- Keep cache bounded to one normalized input, without altering dependency files.

## Review Focus

- Nonmonotonic counts must still choose the last legal endpoint (Task 1).
- Combining characters, emoji and non-prefix normalization must preserve stock output (Task 2).
- Ties and floating-point addition must preserve stock predecessor choice (Task 2).
- Unknown-token fusion and special-token boundaries must remain upstream (Task 2).
- Empty input, page separators and partially selected pages must retain exact trace (Tasks 1/3).

### Task 1: Exact descending grapheme search

**Files:** Modify `bench/src/localPdf/context.ts`; create `bench/src/tests/localPdfContextBudget.test.ts`.
**Interfaces:** Keep `graphemePrefixWithinBudget(base, candidate, countTokens, maxTokens): number` unchanged.

- [x] Write tests asserting longest legal nonmonotonic prefix, grapheme boundaries, full-fit/empty/no-fit behavior; count oracle calls for a near-end cut.
- [x] Run `npx vitest run bench/src/tests/localPdfContextBudget.test.ts`; verify the performance assertion fails before changing implementation.
- [x] Enumerate grapheme end offsets once and test descending, excluding the full candidate already tested. Return the first legal endpoint, else zero.
- [x] Run focused context and trace tests; expect pass.

### Task 2: Exact Unigram prefix reuse

**Files:** Create `bench/src/localPdf/unigramPrefix.ts`; modify `bench/src/localPdf/tokenizer.ts`; create `bench/src/tests/localPdfUnigramPrefix.test.ts`.
**Interfaces:** Export `optimizeUnigramPrefixes(model: unknown): void`; wrap the existing `model.tokenize(normalized: string): string[]` on this benchmark tokenizer instance only.

- [x] Write differential tests using stock `PreTrainedTokenizer` and optimized instances, enumerating prefixes, unknown strings, normalization, emoji, repeated/non-prefix inputs, ties and special tokens. Assert repeated prefix requests do not repeat trie traversal.
- [x] Run the tests and verify missing optimizer fails.
- [x] Validate model internals; construct ordered incoming lattice edges, scoring each against ordered predecessors exactly as stock does (`predecessor.score + node.score`, strict `>`). Store backpointers and UTF-16 endpoint offsets. Select the EOS winner in stock insertion order and reconstruct pieces; let stock `encode/_call` fuse unknown pieces.
- [x] Cache one normalized string and its lattice; use it only when the new normalized string is an exact prefix ending on a code-point boundary, otherwise rebuild. Empty input returns no pieces. Keep trie queries bounded by maximum vocabulary token length.
- [x] Wire optimizer after existing `optimizeUnigram` setup. Run differential tokenizer, context, TOC routing and trace suites.

### Task 3: Offline replay and acceptance

**Files:** Create `bench/replay-context-performance.ts`; create `docs/superpowers/specs/2026-10-01-context-truncation-performance-results.md`.
**Interfaces:** Standalone offline script takes an existing run directory; reads manifest/corpora/records; outputs JSON diagnostics to stdout only.

- [x] Replay every saved successful D routing using optimized tokenizer and compare context, trace and tokenCount exactly; record timings and maxima.
- [x] Replay the known slow paper 2002.03407 with the old exhaustive prefix function and old tokenizer setup, then optimized path on the same machine. Report wall time and oracle call counts without conflating network retrieval latency with local processing.
- [x] Run `npm test`, `npm run typecheck`, `git diff --check`; expect all green.
- [x] Review final diff and record exact results, limitations and any plan rulings. Retain old benchmark files unchanged. Commit implementation and documentation after verification.

## Execution ledger

- Scope confirmed by user; native execution authorized after plan creation. Routing unchanged.
- Ruling: keep the current experiment branch and workspace; existing artifacts are required for replay and no concurrent implementer is editing these files.
- Ruling: no additional agent delegation, as directed by the parent; final review will be requested from the parent rather than spawning a child.
- Task 1 complete: exact descending search and focused regressions passed.
- Task 2 refinement: prefix lattice reuse alone left a 55-second outlier (45,034 prefix counts). Cache fused-unknown token counts on the same Viterbi paths and expose `countTokens`; ordinary single-section preprocessing uses that count, while added tokens, multiple pre-tokenizer pieces and unsupported preprocessing use upstream tokenization. This retains the exact budget semantics without reconstructing token arrays on each prefix.
- Handoff: the implementer subagent reached its usage limit after the first full replay (168 exact contexts/traces). The parent continued native execution from these files, retaining that result as an intermediate measurement.
- Verification in progress: final replay includes token-array and count differential checks for every nonempty saved context across A/B/C/D/R, all successful D materializations, and an exhaustive old-algorithm slow-append comparison. No API runtime is initialized and remote model access is disabled.
- Full suite at the current implementation: 73 Vitest files / 860 tests pass; branding 18 pass / 1 environment skip; typecheck passes. Final performance evidence and review remain pending.

- Final acceptance: 884 saved nonempty contexts match stock token sequences/counts; all 168 completed D retrieval contexts/traces match exactly; max 4096 tokens. Same-machine slow append 109010.86 ms → 695.40 ms (156.8×). All-D local p50 5.26 ms / p95 691.32 ms / max 14778.97 ms.
- Final read-only review used the existing tokenizer reviewer (no new implementation agent); no Critical/Important findings. Its 3859 real BGE-M3 prefix comparisons passed.
- Ruling: report remaining ~15-second long-page normalization/prefix-scan tail honestly; further algorithm changes and route optimization are outside this completed bounded fix. Results and reproduction recorded in docs/superpowers/specs/2026-10-01-context-truncation-performance-results.md.
