# Query Timeline Speed Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the benchmark's public time-efficiency view with the seven query-timeline metrics defined by the approved design, while preserving every retrieval-quality, answer-quality, accuracy, judge, and current main-branch diagnostic definition unchanged.

**Architecture:** Add an opt-in `--speed` execution mode around the current main-branch QA runners. A shared monotonic `QueryTimeline` starts only after indexing/local initialization, marks the already-materialized final context as Evidence Ready, streams the final answer through one shared prompt builder, and computes per-query token usage from cumulative provider telemetry. Existing non-speed execution remains the default; its retrieval, answer, judge, aggregation, checkpoint, and legacy timing paths stay intact. Speed aggregation, identity gates, and reporting live in separate modules so the new protocol cannot silently alter current quality denominators.

**Tech Stack:** TypeScript, Node.js `performance.now()`, Web Streams, OpenAI-compatible SSE, Ollama NDJSON, SHA-256 run identities, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-19-query-timeline-speed-benchmark-design.md`

## Global Constraints

- The current `main` branch is the quality-metric source of truth. Do not change `contextPageMrr`, `evidenceRecall`, `evidenceHitRate`, `contextPrecision`, `answerF1`, `unanswerableAccuracy`, `judge*`, their sample eligibility, their denominators, or their names.
- The implementation baseline for that source of truth is commit `6bd4cbb` (`docs: design query timeline speed benchmark`); use it for the final semantic diff audit even if implementation commits are made on the same branch.
- Do not change retrieval candidates, ranking/reranking, semantic-tree routing, context materialization, the 4096-token retrieval budget, answer normalization, refusal matching, or judge prompts/rubrics.
- `--speed` is opt-in. A run without it must follow the current main-branch code path and produce the same quality observations, answers, statuses, and provenance as before this work.
- The seven public speed values are exactly Evidence Ready P50/P95, TTFT P50/P95, Full Answer P50/P95, and mean online tokens per completed answer. Counts and failure totals are supporting diagnostics, not extra headline metrics.
- All six time percentiles use the identical set of completed speed question IDs. The token mean is emitted only when every member of that set has complete provider usage.
- `t0`, `t1`, `t2`, and `t3` use one injected monotonic clock. Missing, non-finite, negative, or out-of-order completed timings invalidate the run; never clamp or reorder them.
- Evidence Ready includes rewrite, retrieval/routing/rerank, candidate selection, and final context materialization. Indexing, embedding/reranker loading, and semantic-tree construction finish before `t0`.
- TTFT is triggered only by the first non-empty visible final-answer delta from a real stream. Metadata, role, reasoning, finish, empty, and usage-only events do not trigger it.
- Full Answer ends when the visible answer stream completes normally. Retry/backoff is included; judge work starts afterward and is excluded.
- Online tokens include all provider-reported input plus output tokens from online LLM calls between snapshots around `t0` and `t3`. Index/tree build and judge usage are outside those snapshots.
- Never estimate answer-model tokens. Missing usage on any attempted online request makes that completed query's token accounting incomplete.
- Speed mode is serial (`queryConcurrency: 1`), streaming, and response-cache-free. Strong-baseline query checkpoints must not be reused in speed mode.
- Full-context remains a separate generation ceiling. It reports TTFT, Full Answer, and token mean; Evidence Ready is `—`; it never enters retrieval-speed ranking or delta.
- Existing `PipelineTiming`, network latency, index/tree-build timing, wall clock, cache diagnostics, and deprecated latency aliases remain readable as explicitly labeled diagnostics/legacy data.
- Result identities and logs must never contain API keys, URL userinfo, usernames, absolute paths, or raw machine names.
- Follow repository style: two-space indentation, single quotes, no semicolons, trailing commas in multiline structures.

## File Structure

- Create `bench/src/speed/queryTimeline.ts`: monotonic timeline state, partial records, token-snapshot deltas, and strict completed-record validation.
- Create `bench/src/speed/contract.ts`: speed schema constants, executed/completed ID hashes, answer/endpoint/generation/environment identities, and comparison gates.
- Create `bench/src/speed/metrics.ts`: completed-cohort aggregation for the seven values and supporting counts.
- Create `bench/src/speed/generate.ts`: shared streaming-generation adapter used by every QA runner.
- Create `bench/src/speed/policy.ts`: pure execution-policy helpers for cache, concurrency, checkpoint, backend, and monotonic-clock requirements.
- Create `bench/src/streaming/openaiSse.ts`: chunk-safe OpenAI-compatible SSE parser.
- Create `bench/src/streaming/ollamaNdjson.ts`: chunk-safe Ollama NDJSON parser.
- Modify `src/utils/ragPipeline.ts`: export the exact final-answer message builder and make the existing non-streaming generator call it.
- Modify `bench/src/llmClient.ts`: add streaming requests and cumulative provider-usage telemetry without removing the current non-streaming interface.
- Modify `bench/src/types.ts`: speed records/meta, `stream` failure stage, and speed metric shape.
- Modify `bench/src/runner/support.ts`: optional speed aggregation/meta finalization layered after the unchanged quality aggregation.
- Modify `bench/src/runner/qa.ts`, `traditionalRagQa.ts`, `strongBaselineQa.ts`, and `fullContextQa.ts`: start the common timeline at the correct boundary and use the common streaming helper only in speed mode.
- `bench/src/runner/semanticTreeQa.ts`, `hybridRerankQa.ts`, and `longSectionQa.ts` continue delegating to the shared PaperMind/strong runner; only their argument types need to propagate the optional speed settings if TypeScript requires it.
- Modify `bench/src/args.ts` and `bench/src/cli.ts`: opt-in mode, cache/checkpoint enforcement, monotonic clock, and identity construction.
- Modify `bench/src/report.ts`: seven-column-equivalent speed table, full-context ceiling table, legacy timing labeling, failure counts, and speed comparison gates.
- Create focused tests under `bench/src/tests/` and modify existing runner/report/CLI tests named by the tasks below.
- Modify `bench/README.md`: speed invocation, seven metrics, eligibility, missing-token behavior, and comparison requirements.

## Review Focus

- Verify quality metric code and fixtures are not redefined or reweighted; speed mode may add fields but may not change quality values or sample membership.
- Verify every runner marks `t1` after final materialization and before message construction/streaming, with all index/model initialization before `t0`.
- Verify partial stream failure retains partial timeline diagnostics but never enters the completed speed cohort.
- Verify provider usage is accumulated per real attempt, including retries; an attempt without usage increments the incomplete counter.
- Verify speed comparison gates are independent from the existing retrieval-quality gates: failing one must suppress only its own deltas.
- Verify full-context has no synthetic Evidence Ready zero and cannot appear in retrieval speed ranking.
- Verify legacy JSON without speed fields still renders without crashing and is never treated as query-timeline-comparable.

---

### Task 1: Freeze Speed Types and the Monotonic Timeline

**Files:**
- Modify: `bench/src/types.ts`
- Create: `bench/src/speed/queryTimeline.ts`
- Create: `bench/src/tests/queryTimeline.test.ts`

**Interfaces:**

```ts
export interface TokenSnapshot {
  totalTokens: number
  incompleteRequestCount: number
}

export interface QuerySpeedRecord {
  evidenceReadyLatencyMs?: number
  timeToFirstTokenMs?: number
  fullAnswerLatencyMs?: number
  onlineTokenCount?: number
  tokenAccountingComplete: boolean
}

export interface QueryTimeline {
  markEvidenceReady(): void
  onVisibleText(delta: string): void
  complete(readAfter: () => TokenSnapshot, evidenceRequired?: boolean): QuerySpeedRecord
  partial(after: TokenSnapshot): QuerySpeedRecord
}
```

- [ ] **Step 1: Write failing timeline tests**

Cover normal `t0 < t1 < t2 < t3`, equal timestamps, first-visible-text recorded once, empty callbacks ignored, non-empty visible whitespace treated consistently as text, empty context still allowing `markEvidenceReady`, partial records after retrieval/stream failure, token snapshot differences, and strict rejection of missing/non-finite/negative/reversed completed fields.

Use a scripted clock rather than sleeps:

```ts
const ticks = [10, 20, 30, 40]
const now = () => ticks.shift()!
const timeline = startQueryTimeline(now, { totalTokens: 100, incompleteRequestCount: 2 })
timeline.markEvidenceReady()
timeline.onVisibleText('hello')
expect(timeline.complete(() => ({ totalTokens: 130, incompleteRequestCount: 2 }))).toEqual({
  evidenceReadyLatencyMs: 10,
  timeToFirstTokenMs: 20,
  fullAnswerLatencyMs: 30,
  onlineTokenCount: 30,
  tokenAccountingComplete: true,
})
```

- [ ] **Step 2: Run the focused test and verify the missing-module/type failure**

Run: `npx vitest run bench/src/tests/queryTimeline.test.ts`

Expected: FAIL because the speed types and timeline module do not exist.

- [ ] **Step 3: Add the result types without changing existing quality fields**

Add `speed?: QuerySpeedRecord` to `PerSampleRecord`, add `'stream'` to `SampleStage`, and add the speed meta fields from the spec as optional fields on `BenchResult['meta']`. Keep `PipelineTiming` and `metrics: Record<string, number>` unchanged.

- [ ] **Step 4: Implement one-shot timeline transitions and strict validation**

`startQueryTimeline` captures `t0` and the initial token snapshot. `markEvidenceReady` and the first non-empty `onVisibleText` callback capture their timestamps only once. `complete` captures `t3` first, then invokes `readAfter`, builds a record, and calls `assertCompletedSpeedRecord`; this ordering keeps telemetry-read overhead outside Full Answer. `partial` returns only reached milestones and never invents missing ones. Token completeness is `after.incompleteRequestCount === before.incompleteRequestCount`; token count is emitted only when complete.

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run bench/src/tests/queryTimeline.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add bench/src/types.ts bench/src/speed/queryTimeline.ts bench/src/tests/queryTimeline.test.ts
git commit -m "feat: add query timeline speed record"
```

### Task 2: Make Final-Answer Messages a Single Source of Truth

**Files:**
- Modify: `src/utils/ragPipeline.ts`
- Modify: `src/tests/ragPipeline.test.ts`
- Create: `bench/src/tests/answerMessages.test.ts`

- [ ] **Step 1: Add failing byte-for-byte prompt tests**

Pin messages for empty/non-empty context, language-augmented system prompts, and history truncation. Assert that the current `generateRagAnswer` passes exactly the output of the exported builder to its injected `generate` function.

- [ ] **Step 2: Run the focused tests**

Run: `npx vitest run src/tests/ragPipeline.test.ts bench/src/tests/answerMessages.test.ts`

Expected: FAIL because `buildAnswerMessages` is not exported.

- [ ] **Step 3: Extract the builder without changing prompt bytes**

```ts
export function buildAnswerMessages(
  context: string,
  query: string,
  history: ChatTurn[],
  systemPrompt: string,
): ChatMessage[] {
  return [
    {
      role: 'system',
      content: `${systemPrompt}\n\n${MATH_FORMAT_INSTRUCTION}`
        + (context ? `\n\n参考内容：\n${context}` : ''),
    },
    ...history.slice(-GENERATE_HISTORY_WINDOW),
    { role: 'user', content: query },
  ]
}
```

Replace only the inline array in `generateRagAnswer` with this helper. Do not alter `retrieveRagContext`, context materialization, or any prompt literal.

- [ ] **Step 4: Run focused and production tests**

Run: `npx vitest run src/tests/ragPipeline.test.ts src/tests/ragPipelineSemantic.test.ts bench/src/tests/answerMessages.test.ts`

Expected: PASS with unchanged non-streaming answers/messages.

- [ ] **Step 5: Commit**

```bash
git add src/utils/ragPipeline.ts src/tests/ragPipeline.test.ts bench/src/tests/answerMessages.test.ts
git commit -m "refactor: share final answer message builder"
```

### Task 3: Parse OpenAI-Compatible SSE and Ollama NDJSON

**Files:**
- Create: `bench/src/streaming/openaiSse.ts`
- Create: `bench/src/streaming/ollamaNdjson.ts`
- Create: `bench/src/tests/openaiSse.test.ts`
- Create: `bench/src/tests/ollamaNdjson.test.ts`

**Parser result:**

```ts
export interface ParsedStream {
  content: string
  usage?: { inputTokens: number; outputTokens: number }
}
```

- [ ] **Step 1: Write failing SSE tests**

Feed identical fixtures as one chunk, byte-by-byte chunks, line-boundary chunks, and randomized deterministic boundaries. Cover multiple events in one chunk, CRLF, `[DONE]`, empty data, role, `reasoning_content`, finish-only and usage-only events. Assert only non-empty `choices[].delta.content` reaches `onVisibleText`, while final usage maps `prompt_tokens`/`completion_tokens`.

- [ ] **Step 2: Write failing NDJSON tests**

Cover one JSON object split across chunks, multiple lines per chunk, trailing buffer flush, content accumulation, `done: true`, and `prompt_eval_count`/`eval_count` usage mapping.

- [ ] **Step 3: Run tests and observe missing modules**

Run: `npx vitest run bench/src/tests/openaiSse.test.ts bench/src/tests/ollamaNdjson.test.ts`

Expected: FAIL.

- [ ] **Step 4: Implement parsers over `ReadableStream<Uint8Array>`**

Use one `TextDecoder` with `{ stream: true }`, maintain a carry buffer, and parse only complete SSE events or NDJSON lines. Throw a diagnostic error for malformed non-empty payloads and for a normally ended stream with empty final content. Do not add provider requests in these modules.

- [ ] **Step 5: Verify parser tests**

Run: `npx vitest run bench/src/tests/openaiSse.test.ts bench/src/tests/ollamaNdjson.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add bench/src/streaming bench/src/tests/openaiSse.test.ts bench/src/tests/ollamaNdjson.test.ts
git commit -m "feat: parse benchmark answer streams"
```

### Task 4: Add Streaming and Real Usage Telemetry to the LLM Client

**Files:**
- Modify: `bench/src/llmClient.ts`
- Modify: `bench/src/tests/llmClient.test.ts`

**Interfaces:**

```ts
export interface TokenUsage { inputTokens: number; outputTokens: number }
export interface StreamCompletion { content: string; usage?: TokenUsage }
export interface StreamingLlmClient extends LlmClient {
  chatStream(messages: ChatMessage[], onVisibleText: (delta: string) => void): Promise<StreamCompletion>
  tokenSnapshot(): TokenSnapshot
  cacheEnabled(): boolean
}
```

- [ ] **Step 1: Add failing non-stream usage tests**

Assert OpenAI-compatible `usage.prompt_tokens/completion_tokens` and Ollama `prompt_eval_count/eval_count` advance `totalTokens`. Assert a response without usage increments `incompleteRequestCount`. Keep existing `chat()`/`complete()` return values and cache tests unchanged.

- [ ] **Step 2: Add failing streaming request tests**

Assert OpenAI/anthropic-compatible requests send `stream: true` plus `stream_options: { include_usage: true }`; Ollama sends `stream: true`. Assert correct auth headers, timeout behavior, retry/backoff, final content, visible callbacks, and usage snapshots.

For a retry after a partial stream, assert the callback can mark TTFT only once, the returned content belongs only to the successful attempt, and the failed attempt increments `incompleteRequestCount`.

- [ ] **Step 3: Run the client tests**

Run: `npx vitest run bench/src/tests/llmClient.test.ts`

Expected: FAIL because streaming/usage telemetry is absent.

- [ ] **Step 4: Refactor request internals to return content plus optional usage**

Record telemetry once for every real network attempt, including failures. Cache hits never occur in speed mode, but normal cached non-speed calls must keep their existing stats/timing behavior. Return `StreamingLlmClient` from `createLlmClient`; keep `LlmClient` as the smaller structural interface so existing test fakes and quality runners do not need new methods.

- [ ] **Step 5: Implement `chatStream` using Task 3 parsers**

Apply the existing timeout/retry policy around each streaming attempt. Buffer content per attempt so a failed partial response is not concatenated into the successful answer. Pass visible deltas through immediately for TTFT measurement. Never write streamed speed responses to the response cache.

- [ ] **Step 6: Run focused and regression tests**

Run: `npx vitest run bench/src/tests/llmClient.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add bench/src/llmClient.ts bench/src/tests/llmClient.test.ts
git commit -m "feat: stream benchmark answers with usage telemetry"
```

### Task 5: Build the Speed Contract and Seven-Metric Aggregator

**Files:**
- Create: `bench/src/speed/contract.ts`
- Create: `bench/src/speed/metrics.ts`
- Create: `bench/src/tests/speedContract.test.ts`
- Create: `bench/src/tests/speedMetrics.test.ts`

**Contract:**

```ts
export const SPEED_METRIC_SCHEMA_VERSION = 1 as const
export const SPEED_DEFINITION = 'query-timeline-v1' as const

export interface SpeedRunContract {
  speedMetricSchemaVersion: 1
  speedDefinition: 'query-timeline-v1'
  datasetFingerprint: string
  executedQuestionIdsHash: string
  streaming: true
  llmCacheEnabled: false
  queryConcurrency: 1
  retryAttempts: number
  answerModelIdentity: string
  endpointIdentity: string
  generationSettingsHash: string
  executionEnvironmentFingerprint: string
}
```

- [ ] **Step 1: Write failing contract tests**

Assert stable ordered question-ID hashes; provider+model answer identity; credential-free normalized endpoint identity; generation hash sensitivity to temperature/max tokens/stop; and environment fingerprint sensitivity to platform/arch/Node/backend only. Require `BENCH_EXECUTION_BACKEND` for local/Ollama speed runs; use a fixed `remote` backend marker for remote providers.

- [ ] **Step 2: Write failing aggregation tests**

Pin nearest-rank P50/P95 using the existing `percentile` helper. Assert retrieval-mode aggregation uses only records with complete valid three-time speed data; `speedSampleCount` and completed ID hash match that cohort; token mean appears only when every cohort record has complete token accounting; partial/failed records remain excluded; zero completed records emit counts but no headline metrics. Also cover `aggregateSpeedMetrics(records, { evidenceRequired: false })` for full-context: its cohort requires TTFT plus Full Answer, emits no Evidence Ready fields, and retains the same token all-or-nothing rule.

- [ ] **Step 3: Run focused tests**

Run: `npx vitest run bench/src/tests/speedContract.test.ts bench/src/tests/speedMetrics.test.ts`

Expected: FAIL.

- [ ] **Step 4: Implement canonical SHA-256 identities**

Reuse `normalizeBaseUrl` from `evaluationContract.ts`; do not duplicate URL credential stripping. Hash canonical JSON objects with explicit keys. Export `speedContractMeta`, `aggregateSpeedMetrics`, and `speedComparisonIssues` separately from the existing retrieval contract/gates.

- [ ] **Step 5: Enforce token all-or-nothing behavior**

`aggregateSpeedMetrics` returns `avgOnlineTokensPerCompletedAnswer` only when `onlineTokenSampleCount === speedSampleCount`. It must never average the complete subset.

- [ ] **Step 6: Verify**

Run: `npx vitest run bench/src/tests/speedContract.test.ts bench/src/tests/speedMetrics.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add bench/src/speed/contract.ts bench/src/speed/metrics.ts bench/src/tests/speedContract.test.ts bench/src/tests/speedMetrics.test.ts
git commit -m "feat: add speed result contract and aggregation"
```

### Task 6: Add the Shared Streaming Generation Adapter and Finalizer Hook

**Files:**
- Create: `bench/src/speed/generate.ts`
- Create: `bench/src/tests/speedGenerate.test.ts`
- Modify: `bench/src/runner/support.ts`
- Create: `bench/src/tests/runnerSupport.test.ts`

**Runner option:**

```ts
export interface SpeedRunnerOptions {
  contract: SpeedRunContract
  now?: () => number
  streamAnswer?: StreamingLlmClient['chatStream']
}
```

- [ ] **Step 1: Write failing adapter tests**

Given a materialized context, question, prompt, timeline, and streaming client, assert the adapter uses `buildAnswerMessages`, forwards only visible callbacks to the timeline, returns exactly the streamed final content, completes the speed record before judge, and emits a partial record on stream failure.

- [ ] **Step 2: Write failing finalizer tests**

Start with an existing quality fixture and assert `finalizeQaResult` produces byte-for-byte equal pre-speed quality metrics when `speed` is absent. With a speed contract, assert it only merges Task 5 speed metrics/meta after the existing `aggregate`/MRR denominator path.

- [ ] **Step 3: Run focused tests**

Run: `npx vitest run bench/src/tests/speedGenerate.test.ts bench/src/tests/runnerSupport.test.ts`

Expected: FAIL.

- [ ] **Step 4: Implement the adapter and optional finalizer input**

Add `speed?: { contract: SpeedRunContract }` to `FinalizeQaArgs`. Do not edit `aggregate`, `renameQaRates`, `assertContextPageDenominator`, or the current timing collectors. Merge speed metrics/meta after those functions have produced their current values.

- [ ] **Step 5: Verify**

Run: `npx vitest run bench/src/tests/speedGenerate.test.ts bench/src/tests/runnerSupport.test.ts bench/src/tests/aggregate.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add bench/src/speed/generate.ts bench/src/runner/support.ts bench/src/tests/speedGenerate.test.ts bench/src/tests/runnerSupport.test.ts
git commit -m "feat: share speed generation and finalization"
```

### Task 7: Integrate PaperMind and Semantic-Tree Runners

**Files:**
- Modify: `bench/src/runner/qa.ts`
- Modify: `bench/src/runner/semanticTreeQa.ts` only if optional argument propagation requires it
- Modify: `bench/src/tests/qaRunner.test.ts`
- Modify: `bench/src/tests/semanticTreeQa.test.ts`

- [ ] **Step 1: Add failing speed-mode runner tests**

Assert index and semantic-tree build complete before the first timeline clock read/token snapshot; `t0` precedes rewrite/retrieval; `t1` occurs only after `retrieveRagContext` returns its final materialized context; final answer uses streaming; and judge starts after `t3`/the ending token snapshot.

Add retrieval failure, generation-before-first-token failure, and mid-stream failure cases. Assert partial `record.speed` fields and `errors[].stage` (`retrieve` or `stream`) without changing current retrieval metrics/status behavior.

- [ ] **Step 2: Run focused tests**

Run: `npx vitest run bench/src/tests/qaRunner.test.ts bench/src/tests/semanticTreeQa.test.ts`

Expected: FAIL.

- [ ] **Step 3: Add an optional speed branch around the existing stages**

Immediately before calling `retrieveContext`, take `client.tokenSnapshot()` and start the timeline. Immediately after the returned context is final, call `markEvidenceReady()`. In speed mode call the Task 6 adapter; otherwise execute the current `generateRagAnswer` block unchanged. Always preserve the current retrieval metrics, quality scoring, legacy `PipelineTiming`, and judge flow.

- [ ] **Step 4: Verify PaperMind and semantic-tree suites**

Run: `npx vitest run bench/src/tests/qaRunner.test.ts bench/src/tests/semanticTreeQa.test.ts src/tests/ragPipeline.test.ts src/tests/ragPipelineSemantic.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bench/src/runner/qa.ts bench/src/runner/semanticTreeQa.ts bench/src/tests/qaRunner.test.ts bench/src/tests/semanticTreeQa.test.ts
git commit -m "feat: measure PaperMind query timelines"
```

### Task 8: Integrate Traditional and Strong Baseline Runners

**Files:**
- Modify: `bench/src/runner/traditionalRagQa.ts`
- Modify: `bench/src/runner/strongBaselineQa.ts`
- Modify: `bench/src/runner/hybridRerankQa.ts` only if type propagation requires it
- Modify: `bench/src/runner/longSectionQa.ts` only if type propagation requires it
- Modify: `bench/src/tests/traditionalRagQa.test.ts`
- Modify: `bench/src/tests/strongRunners.test.ts`

- [ ] **Step 1: Add failing traditional-runner tests**

Assert tokenizer/embedding initialization and retriever construction are before `t0`; scoring plus common materialization are inside Evidence Ready; final messages match Task 2; and all existing Context Page MRR/evidence/answer/judge values remain unchanged.

- [ ] **Step 2: Add failing strong-runner tests**

Cover hybrid and long-section outcomes. Assert local model/index initialization before `t0`, retrieval plus materialization before `t1`, and shared streaming afterward. Add a hard failure for `speed` combined with `checkpointPath` or a resumed checkpoint entry; do not synthesize a timeline around saved `pendingContext`.

- [ ] **Step 3: Run focused tests**

Run: `npx vitest run bench/src/tests/traditionalRagQa.test.ts bench/src/tests/strongRunners.test.ts`

Expected: FAIL.

- [ ] **Step 4: Integrate the common timeline/streaming adapter**

Keep the current non-speed `generateAnswer` injection and checkpoint behavior exactly as-is. In speed mode, reject checkpoint usage before processing samples, start a fresh full query after the runtime is ready, mark Evidence Ready after `args.materialize`, and use Task 6 for generation.

- [ ] **Step 5: Verify all baseline tests**

Run: `npx vitest run bench/src/tests/traditionalRagQa.test.ts bench/src/tests/strongRunners.test.ts bench/src/tests/strongBaselines.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add bench/src/runner/traditionalRagQa.ts bench/src/runner/strongBaselineQa.ts bench/src/runner/hybridRerankQa.ts bench/src/runner/longSectionQa.ts bench/src/tests/traditionalRagQa.test.ts bench/src/tests/strongRunners.test.ts
git commit -m "feat: measure baseline query timelines"
```

### Task 9: Preserve Full-Context as a Separate Generation Ceiling

**Files:**
- Modify: `bench/src/runner/fullContextQa.ts`
- Modify: `bench/src/tests/qaRunner.test.ts` (existing full-context describe block)

- [ ] **Step 1: Add failing full-context speed tests**

Assert the run streams the same full-paper prompt, captures TTFT/Full Answer/token usage, never writes `evidenceReadyLatencyMs`, and retains `comparisonEligible: false` with `comparisonIneligibleReason: 'full-context-generation-ceiling'`. Assert answer F1, unanswerable accuracy, and judge values are unchanged.

- [ ] **Step 2: Run the focused test**

Run: `npx vitest run bench/src/tests/qaRunner.test.ts`

Expected: FAIL.

- [ ] **Step 3: Use a generation-only timeline completion**

Start `t0` after the paper string/prompt is ready, do not call `markEvidenceReady`, and call `complete(() => client.tokenSnapshot(), false)`. Aggregate only TTFT, Full Answer, and token mean for this ceiling; keep the existing full-context quality aggregation and legacy timing diagnostics.

- [ ] **Step 4: Verify**

Run: `npx vitest run bench/src/tests/qaRunner.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bench/src/runner/fullContextQa.ts bench/src/tests/qaRunner.test.ts
git commit -m "feat: stream full-context speed ceiling"
```

### Task 10: Wire the CLI and Freeze the Execution Environment

**Files:**
- Modify: `bench/src/args.ts`
- Modify: `bench/src/cli.ts`
- Create: `bench/src/speed/policy.ts`
- Modify: `bench/src/tests/args.test.ts`
- Create: `bench/src/tests/speedCli.test.ts`

- [ ] **Step 1: Add failing argument tests**

Add `speed: false` to defaults and parse `--speed`. Reject `--speed` with `--task summary` or `--task all`; speed is a QA protocol, so the caller must select `--task qa` explicitly. Keep all current flags and errors unchanged.

- [ ] **Step 2: Add failing CLI-policy tests**

Test `bench/src/speed/policy.ts` rather than importing side-effectful `cli.ts` or spawning real providers. Assert speed mode returns main-client overrides with `useCache: false`, records retry attempts and generation settings, uses `performance.now`, sets concurrency to one, omits strong-baseline `checkpointPath`, and requires a local backend/device descriptor for Ollama. Assert the judge client remains outside answer-client token snapshots.

- [ ] **Step 3: Run focused tests**

Run: `npx vitest run bench/src/tests/args.test.ts bench/src/tests/speedCli.test.ts`

Expected: FAIL.

- [ ] **Step 4: Implement opt-in CLI wiring**

Build `SpeedRunContract` once per dataset source/config from the current `EvaluationContract`, provider/model/base URL, effective generation settings (`temperature: 0`, max tokens, stop), retry attempts, and sanitized environment identity. Pass `speed` to the selected runner. In speed mode print a concise banner confirming streaming, cache off, concurrency 1, and checkpoint off.

Do not reinterpret `--no-cache` for ordinary quality runs. `--speed` itself forces `useCache: false`; direct runner/client combinations claiming speed while `cacheEnabled()` is true must throw before the first sample.

- [ ] **Step 5: Verify CLI tests and typecheck**

Run: `npx vitest run bench/src/tests/args.test.ts bench/src/tests/speedCli.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add bench/src/args.ts bench/src/cli.ts bench/src/speed/policy.ts bench/src/tests/args.test.ts bench/src/tests/speedCli.test.ts
git commit -m "feat: add controlled speed benchmark mode"
```

### Task 11: Render and Compare Only Valid Query-Timeline Results

**Files:**
- Modify: `bench/src/report.ts`
- Modify: `bench/src/tests/report.test.ts`

- [ ] **Step 1: Add failing main-table tests**

Assert retrieval methods with `speedDefinition: 'query-timeline-v1'` render exactly:

```text
| 方法 | Evidence Ready P50 | P95 | TTFT P50 | P95 | Full Answer P50 | P95 | Avg Online Tokens |
```

Assert missing token mean renders `—` plus an incomplete-accounting reason, speed/completed counts are visible outside the seven-value table, and retrieval/generation/stream/judge failure totals are shown.

- [ ] **Step 2: Add failing ceiling/legacy tests**

Assert full-context appears only in a separate generation-ceiling speed table with Evidence Ready `—`. Assert old JSON without the speed definition still renders current diagnostics and an explicit legacy label, but never enters the new speed table/delta.

- [ ] **Step 3: Add failing comparison-gate tests**

Allow speed delta only when dataset fingerprint, executed IDs, completed speed IDs, schema/definition, answer model, endpoint, generation settings, retry count, streaming/cache/concurrency, environment fingerprint, and `speedSampleCount` all agree. Same count with different completed IDs must fail. Incomplete token accounting suppresses only token delta; valid time deltas remain available. Existing `retrievalComparisonIssues` behavior must stay unchanged.

- [ ] **Step 4: Run report tests**

Run: `npx vitest run bench/src/tests/report.test.ts`

Expected: FAIL.

- [ ] **Step 5: Implement separate speed rendering/gating**

Add `renderSpeedSection` and use `speedComparisonIssues` independently of retrieval gates. Relabel the existing `renderTimingSection` as detailed diagnostics/legacy timing; do not delete its fields. Update comparison footnotes so the direction is explicit: all three speed times and online tokens are lower-is-better, quality metrics remain higher-is-better.

- [ ] **Step 6: Verify**

Run: `npx vitest run bench/src/tests/report.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add bench/src/report.ts bench/src/tests/report.test.ts
git commit -m "feat: report comparable query timeline speed"
```

### Task 12: Prove Main-Branch Quality Metrics Did Not Move

**Files:**
- Create: `bench/src/tests/speedQualityRegression.test.ts`
- Modify: `bench/src/tests/qaRunner.test.ts`, `bench/src/tests/semanticTreeQa.test.ts`, `bench/src/tests/traditionalRagQa.test.ts`, and `bench/src/tests/strongRunners.test.ts` only where their existing deterministic fixtures must be exported/reused; do not rewrite their quality expectations.

- [ ] **Step 1: Define the protected quality projection**

Use an explicit allowlist containing retrieval/answer/judge values and provenance, not a broad snapshot that can hide deletions:

```ts
const qualityMetricKeys = [
  'contextPageMrr', 'evidenceRecall', 'evidenceHitRate', 'contextPrecision',
  'answerF1', 'unanswerableAccuracy',
  'judgeFactuality', 'judgeCompleteness', 'judgeGroundedness',
] as const
```

Also compare per-sample `retrievalStatus`, `generationStatus`, `judgeStatus`, `retrievalQuery`, `contextPageOrder`, `contextTokenCount`, `contextTruncated`, `selectedPages`, `evidencePages`, and final `answer`.

- [ ] **Step 2: Write deterministic paired-run tests**

For PaperMind, semantic-tree, traditional, hybrid, long-section, and full-context fixtures, run once through the unchanged non-speed path and once through speed mode with a stream that yields the identical answer text. Remove only speed/meta identity and timing-diagnostic fields, then assert the protected projections are deeply equal. Pin current main-branch expected values so two equally wrong paths cannot pass by drifting together.

- [ ] **Step 3: Run the regression suite**

Run: `npx vitest run bench/src/tests/speedQualityRegression.test.ts`

Expected: PASS only when speed integration is quality-neutral.

- [ ] **Step 4: Run all benchmark and production RAG tests**

Run: `npx vitest run bench/src/tests src/tests/ragPipeline.test.ts src/tests/ragPipelineSemantic.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bench/src/tests/speedQualityRegression.test.ts bench/src/tests/qaRunner.test.ts bench/src/tests/semanticTreeQa.test.ts bench/src/tests/traditionalRagQa.test.ts bench/src/tests/strongRunners.test.ts
git commit -m "test: lock quality metrics across speed mode"
```

### Task 13: Document, Audit, and Run Final Verification

**Files:**
- Modify: `bench/README.md`
- Review: all files changed in Tasks 1-12

- [ ] **Step 1: Update benchmark documentation**

Document:

```bash
npm run bench -- --task qa --dataset qasper --config default --speed
npm run bench -- --task qa --dataset qasper --mode full-context --speed
```

Explain the seven values, the common completed cohort, provider-usage-only token accounting, cache/checkpoint restrictions, required Ollama backend/device identity, full-context ceiling status, and the distinction between the new speed table and retained legacy diagnostics.

- [ ] **Step 2: Audit protected quality code**

Run:

```bash
git diff 6bd4cbb -- bench/src/metrics/retrieval.ts bench/src/metrics/answerF1.ts bench/src/metrics/judge.ts bench/src/evaluationContract.ts bench/src/traditionalRag bench/src/baselines
```

Expected: no semantic change to quality metrics, prompts/rubrics, retrieval algorithms, candidates, or materialization. Any necessary type-only/import-only change must be reviewed line by line and called out in the commit message.

- [ ] **Step 3: Scan for forbidden token estimation and duplicated prompt/timeline logic**

Run:

```bash
rg -n "estimateTokens|/ 4|char.*token|markEvidenceReady|参考内容：" bench/src src/utils/ragPipeline.ts
```

Expected: speed accounting references only provider usage; runner calls to `markEvidenceReady` are intentional; final-answer prompt construction is centralized in `buildAnswerMessages`.

- [ ] **Step 4: Run the complete verification suite**

Run:

```bash
npm test
npm run typecheck
```

Expected: both PASS.

- [ ] **Step 5: Run one credential-free CLI policy smoke check**

Run:

```bash
npm run bench -- --task summary --dataset smoke --config default --speed
```

Expected: fails before loading data or making a request with a clear message that speed mode requires `--task qa`.

- [ ] **Step 6: Review result-schema compatibility**

Use report fixtures to confirm: schema-v2 quality results without speed fields still render; speed results contain the existing quality meta plus speed meta; full-context stays comparison-ineligible; no credential/path/machine-name data appears.

- [ ] **Step 7: Commit documentation and final audit**

```bash
git add bench/README.md
git commit -m "docs: explain query timeline speed benchmark"
```

## Completion Checklist

- [ ] Every spec acceptance criterion is covered by at least one named test above.
- [ ] The public speed table contains six time percentiles and one token mean, no more and no less.
- [ ] All six time fields share one completed-question cohort and hash.
- [ ] Token mean is absent when any completed query has incomplete usage.
- [ ] Speed mode uses a real stream, no response cache, concurrency one, and no query checkpoint resume.
- [ ] All five retrieval approaches mark Evidence Ready after final materialization and before final generation.
- [ ] Full-context reports only generation-ceiling speed and never receives a synthetic Evidence Ready value.
- [ ] Existing quality metrics and protected per-sample fields match current main in paired regression tests.
- [ ] Existing legacy timing remains diagnostic and readable, not a competing headline speed definition.
- [ ] `npm test` and `npm run typecheck` pass from a clean worktree apart from the known user-owned `.superpowers/` path.
