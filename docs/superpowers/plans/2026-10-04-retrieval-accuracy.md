# Retrieval and answer accuracy follow-up

> Use superpowers:subagent-driven-development for implementation and spec/code-quality review. Continue the user's explicit accuracy-and-speed optimization request; the context materialization commit is only the completed speed subtask.

**Goal:** Improve evidence usefulness and actual answer accuracy with controlled model/data/settings, while retaining the zero-LLM retrieval path and measuring latency.

**Current evidence:** A complete 60-paper / 179-question baseline is running at code `65073f0`, using user-authorized DeepSeek `deepseek-flash`, thinking disabled, temperature 0, requested top-p 1, max output 4096, streaming, answer cache disabled and concurrency one. The index uses the existing small q8/384 embedder, section weight 0.5, heading weight 0, and the frozen BGE-M3/4096 materializer. Raw public-corpus index responses are captured for diagnosis without credentials.

In the first ten index responses, only three passed the existing card validation. Five otherwise usable responses placed `sections` under `paper`; two exceeded the maximum keyword count. A prototype that moved the uniquely located nested array and bounded valid string keyword lists restored all ten while retaining strict range/coverage/title checks. This is a diagnostic sample, not a claim of answer improvement.

## Task 1: Normalize only recoverable structure-card response shapes

Files: `src/utils/structureCards.ts`, `src/tests/structureCards.test.ts`.

- [x] Write failing build-level tests for a nested `paper.sections` array and an otherwise valid card with more than 12 nonempty string keywords. Keep the existing validator strict; direct validation of the original malformed form must still fail.
- [x] Add a small pure normalizer between JSON parsing and validation. Only if top-level `sections` is absent and `paper.sections` is an array, use that array as top-level sections. An explicitly present malformed top-level field is never replaced. For over-limit keyword arrays, trim to the first 12 only when every original entry is a nonempty string. Do not discard invalid entries, invent ranges or metadata, merge cards, repair coverage, retry the LLM, or change already valid responses.
- [x] Preserve source object/arrays (copy-on-change), paper title/summary, order and all strict semantic/range/title validation. A repaired shape must still pass the complete original validator.
- [x] Bump the structure build/prompt protocol identity using the existing version constant so old fallback indexes rebuild their cards while reusable passage vectors remain reusable. Explain that this invalidates the response-processing contract; keep prompt text unchanged for the paired experiment.
- [x] Cover malformed/ambiguous nested shapes, root-field precedence, mixed/empty over-limit keyword arrays, invalid ranges/coverage/generic titles, nonmutation and already-valid parity. Observe red tests before implementation, then run focused structure-card/index-builder contracts. Strict isolated TypeScript verification passed; required whole-project checks are deferred until the timed baseline finishes.
- [x] Obtain independent spec review, then quality review.

Task 1 verification: expected red build-level failures were observed; 44 focused tests and isolated strict TypeScript compilation passed. Spec review identified a narrowing error, which was fixed and re-reviewed; final spec and quality reviews passed. An initial attempt to filter `npm test` inadvertently ran the full suite during the baseline, so small cross-run latency differences must not be interpreted as a causal speed gain.

## Task 2: Diagnose and compare accuracy

- [ ] Complete the baseline and retain all-question AnswerF1, fixed-cohort page evidence metrics, question-level answers/errors, fallback causes, TTFT and evidence-ready P50/P95. Do not replace the existing fixed denominator or drop failed questions.
- [ ] Validate all captured responses with the original and normalized schema. Record recoverable versus genuinely invalid counts, with no relaxation of evidence provenance or coverage.
- [ ] Use the same model, endpoint, generation parameters, corpus, tokenizer and final 4096 budget for the candidate. Compare all 179 question-level answers, inspect both gains and regressions, and distinguish metric changes from semantically supported correctness.
- [ ] Investigate evidence-content omissions and unsupported/excess answer text from actual errors. Further algorithm or prompt changes must have their own clear comparison; do not silently mix them into this normalization experiment.
- [ ] Preserve raw results and experimental identity. Report actual AnswerF1 and evidence metrics together with speed, including failures and the limitations of a single corpus/model run.

## Task 3: Deliver only verified gains

- [ ] Run required full tests/typecheck/build and independent complete review after final code changes.
- [ ] Record which changes are justified by real accuracy and speed evidence. Keep any unverified ranking/prompt changes experimental, rather than claiming success from tests alone.
- [ ] Commit, fetch remote, apply the established remote-priority conflict policy, push, and verify clean/equal local and remote main. Preserve the pre-sync stash.

## Follow-up hypothesis: grounded, question-focused answers

The complete baseline finished 179/179 questions without request failures, with all-question F1 0.231928. A manual audit found a direct logical error on `2003.03106#2`: the answer says BERT is best, then cites NLNDE outperforming it. On `1611.04798#0`, absence of a statement about hyperparameter search becomes a definite negative. These examples justify testing explicit grounding and conclusion/evidence consistency. Some apparent F1 failures are metric limitations: a correct natural-language abstention scores zero against the literal reference `Unanswerable`, and correct explained yes/no answers score low. Do not force benchmark labels or remove necessary reasoning to inflate F1.

Candidate design: when reference context exists, append a short general instruction to use that evidence for paper facts, distinguish statements from inferences, answer the precise question first with necessary support/qualifiers, and express uncertainty when context is insufficient. Absence of evidence must not become a negative fact. Respect requests for detailed explanations; no hard answer-length limit, no dataset-specific words, and no new model call. Preserve context, history, custom system prompt and math instructions. No-context behavior stays unchanged.

- [x] Add focused regression tests and shared answer-message instruction, with separate spec/quality review. Four expected red failures were observed, then all 118 focused contracts passed. Independent spec and quality reviews found no remaining issues; model efficacy is still pending.
- [ ] Finish the normalization-only arm before interpreting this prompt arm. Replay the same raw card responses and use live uncached answers for all 179 questions.
- [ ] Run this as a separately labeled prompt ablation with a different framing hash; it is not a same-prompt retrieval/Q comparison. Inspect known errors and regressions against paper evidence, and disclose verbosity/F1 confounding.
- [ ] Retain this candidate only if the evidence supports the behavior; otherwise revert the prompt while keeping independently justified fixes.
