[根目录](../CLAUDE.md) > **src/**

# src/ — Renderer Application and Shared Logic

`src/` contains the Vue renderer, but it is not a process-pure directory.
Electron and benchmark code import shared types and pure utilities from here.

## Structure

| Path | Responsibility |
|---|---|
| `main.ts` | Create Vue app; register Pinia, Router, Element Plus |
| `App.vue` | Navigation shell and initial store loading |
| `router/` | Six hash-mode routes |
| `views/` | Six route-level screens |
| `components/` | Thirteen reusable UI components |
| `stores/` | Six Pinia stores and product orchestration |
| `composables/` | Web-history, web-QA, and web-summary orchestration |
| `utils/` | E-k5/RAG, PDF, summary, Markdown, provider, security logic |
| `types/` | IPC and cross-domain contracts |
| `styles/` | Global and Markdown styles |
| `tests/` | Renderer, shared logic, main-process and scenario Vitest suites |

## Renderer Entry

`main.ts` creates the Vue application, registers Element Plus/icons, Pinia,
and Router, then mounts `App.vue`. `App.vue` loads the paper and chat stores
and renders the navigation shell plus `router-view`.

## Shared Code Boundary

These modules are intentionally imported outside the renderer:

- `types/ipcContract.ts` and domain types;
- Docling official configuration, credentials, summary structures, and validators;
- URL/service security helpers;
- source-reference and backup sanitization helpers;
- web archive/read-preview helpers;
- E-k5/RAG primitives reused by `bench/`.

They must remain free of browser-only side effects unless the consumer is
explicitly renderer-only. A future `shared/` package may make this boundary
clearer; it does not exist today.

## Product Paths

- Paper QA is orchestrated by `stores/chat.ts` and uses E-k5.
- Parsed paper/web summaries are orchestrated by `stores/visualSummary.ts`.
- Web history/QA/summary use the three `composables/` modules.
- PDF reading position is stored in renderer `localStorage`.
- Persistent domain data is accessed through `window.db`; preview control uses
  `window.preview`.

## Types

`types/ipcContract.ts` defines `DbApi`, `PreviewInvokeApi`, channel names,
argument tuples, result types, and main-handler types. `types/db.d.ts`
re-exports the database API and declares `window.db`.
`types/webPreview.d.ts` declares `window.preview` including the state event.

Compile-time contracts do not replace runtime validation in Electron.

`utils/doclingConfig.ts` separates project-owned service configuration from
the user-owned API key. Renderer code may display the official address but
must not expose deployment or parser controls.

## Tests

`src/tests/setup.ts` installs shared mocks. Focused suites cover stores,
components, IPC contracts/security, database recovery, PDF parsing/rendering,
E-k5 and legacy retrieval, summaries, web archive/QA, and release/runtime
boundaries.

Do not maintain a hand-written list of every test or test count here; both
change frequently. Use `rg --files src/tests` and the fresh test output.
