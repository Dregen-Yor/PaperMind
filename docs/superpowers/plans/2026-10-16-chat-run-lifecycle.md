# Chat Run Lifecycle Plan

**Goal:** Make normal chat generation stoppable and keep partial text after cancellation, network failure, or app restart. Compare the same scripted user task before and after.

**Scope:** Normal chat send, retry, and continue. The separate Docling abstract checkpoint pipeline remains independent. Closing the app interrupts a renderer-owned run; it does not keep generating in the background.

**Baseline:** `npx vitest run src/tests/chatLifecycle.scenario.test.ts --silent=false --reporter=verbose` with the same prompt and scripted SSE. Before changes, network failure discards `已经生成的前半段。`; a stop action is unavailable and the remaining text continues to arrive. Raw output is saved in `/tmp/papermind-chat-lifecycle-baseline.txt`.

## Work

1. Add a persisted `run_id` and `run_status` to assistant messages, migrate old databases, and mark active runs interrupted at startup. Keep schema, database API, preload, and renderer declarations aligned.
2. Add a per-conversation `AbortController` and distinguish user cancellation from timeout. Thread its signal through preparation, retrieval LLM calls, answer fetch, and stream readers. Guard against late results from cancelled runs.
3. Persist the assistant message when a run starts, save streaming text at a bounded cadence, and flush the final partial text and status on every terminal path. Retry and continue use a new run ID and preserve the existing message identity.
4. Show run state in `ChatPanel` and offer Stop while active. Preserve partial text and show a clear action after failure, cancellation, or interruption.
5. Add focused red-green tests for failure, stop, timeout, restart, retry, and concurrent runs. Re-run the exact scenario harness, compare outcome fields, and run `npm test`, `npm run typecheck`, and production bundling.

## Same-task comparison

The scenario runs the real chat store with the prompt `请概括这篇论文的贡献` and a controlled provider stream. In both versions it first delivers `已经生成的前半段。`, then either raises `network down` or requests Stop. The baseline was recorded before the implementation; the final run uses the same test file and command. This measures observable lifecycle behavior, not model speed or a live provider's latency.

| Action | Before | After |
| --- | --- | --- |
| Provider fails after the first chunk | Visible content empty; partial text absent from persisted message; no run state | First chunk remains visible and persisted; state `failed` |
| User stops after the first chunk | Stop unavailable; second chunk continues; request not aborted | Request aborted; only first chunk remains visible and persisted; state `cancelled` |

Both cases keep one assistant message. Baseline output: `/tmp/papermind-chat-lifecycle-baseline.txt`. Final output: `/tmp/papermind-chat-lifecycle-final.txt`. The scenario itself is `src/tests/chatLifecycle.scenario.test.ts` and now asserts the expected after state on every test run.

Final verification: `npm test` passed 1561 Vitest cases and 18 branding checks (one environment-dependent branding check skipped); `npm run typecheck` passed; `npx vite build` passed for renderer, Electron main, and preload. The build reported existing large-chunk and third-party pure-annotation warnings.
