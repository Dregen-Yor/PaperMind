# IPC contract and backup boundary plan

**Goal:** Make PaperMind's renderer, preload, and main-process IPC agree on argument and result types, and reject malformed write/import payloads before filesystem or database changes.

**Approved scope:** The user approved item 3 after reviewing its logic and asked for the same real-task before/after comparison used for items 1 and 2. AlphaXiv's centralized API client is the design cue; its server typing and validation are not known.

## Repeatable task

Use one real SQLite database in a temporary application directory. Import a valid backup containing a paper and a cancelled chat run, then import an otherwise valid backup whose paper ID contains a parent-directory segment. Record whether the chat run survives the round trip, whether the second import is rejected, whether any PDF appears outside the paper directory, and whether the first import remains intact. Run the same scenario before and after changes. The scenario must use the production import/export path and avoid user data.

## Implementation

1. Add the scenario test and record the baseline output before changing product code. Add focused failing assertions for preserved run state and rejecting invalid paper IDs before writes.
2. Define shared IPC request/result contracts and a typed invoke wrapper. Make preload and the renderer's `window.db` declaration use that contract, and make main handler registration check each channel's arguments and result. Keep dynamic settings and raw backup input as `unknown` where runtime parsing is required.
3. Validate paper write and backup import payloads in the main process before touching files or SQLite. Validate nested IDs and shapes needed by the import, preserve chat run fields, and keep existing version-1 backup compatibility. Keep import atomic with respect to malformed input.
4. Add contract compile checks and runtime regression tests for valid and invalid inputs. Re-run the exact scenario, then `npm test`, `npm run typecheck`, and `npx vite build`.
5. Record the comparison and limitations, review the diff, and commit on `codex/ipc-contracts`.

## Same-task result

The test imports the same version-1 backup into real SQLite in a temporary application directory. It contains one paper and an assistant message with `runId=run-1`, `runStatus=cancelled`. It then imports a backup whose paper ID is `../escape`. The exact scenario command was run before and after the change:

`npx vitest run src/tests/ipcContract.scenario.test.ts --silent=false --reporter=verbose`

| Observed result | Before | After |
| --- | --- | --- |
| Chat run ID preserved by valid backup import | No | Yes |
| Chat run status preserved | No | Yes |
| Malformed second import rejected | No | Yes |
| PDF written outside the managed paper directory | Yes | No |
| First paper retained after rejected import | No | Yes |

The baseline raw output is `/tmp/papermind-ipc-contract-baseline.txt`; the final raw output is `/tmp/papermind-ipc-contract-final.txt`. The first test in `src/tests/ipcContract.scenario.test.ts` is unchanged between those runs apart from adding assertions for the expected after state. Additional tests exercise nested Docling import failure, incomplete paper creation, invalid chat status through a registered IPC handler, legacy empty display labels, stale database file paths, and blocked or symlinked PDF destinations. `src/tests/ipcContract.types.ts` verifies incorrect channel names and arguments fail TypeScript checking.

The comparison measures data integrity and rejection behavior, not IPC latency. Full filesystem/SQLite atomicity on a disk failure during a valid backup import remains a separate file transaction problem; the import now rejects malformed records and unsafe destinations before replacing rows or managed files.

Final verification: `npm test` passed 1570 Vitest cases and 18 branding checks (one environment-dependent check skipped); `npm run typecheck` passed, including the compile-only IPC contract assertions; `npx vite build` passed for renderer, Electron main, and preload. The build still reports a large-chunk advisory.
