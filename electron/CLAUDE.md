[根目录](../CLAUDE.md) > **electron/**

# electron/ — Main Process and Preload

## Responsibilities

`electron/` owns OS and privileged capabilities:

- application lifecycle, single-instance behavior, and BrowserWindow creation;
- typed IPC registration and preload wrappers;
- SQLite and managed PDF files;
- `papermind-paper://` local PDF delivery;
- Docling networking and the #14 managed SSH tunnel;
- isolated web preview, snapshot capture, and cached replay;
- HTML/PDF material parsing for the unified summary pipeline.

Selected types and pure validators come from `src/types/` and `src/utils/`.
Those imports are a current shared-code boundary, not renderer execution.

## Startup

`electron/main.ts` performs:

1. privileged protocol declaration and product identity setup;
2. single-instance lock;
3. after `app.whenReady()`: `initDb()`;
4. register `papermind-paper` with the managed file lookup;
5. `registerIpc()`;
6. create the main window and register its preview controller.

The window uses `sandbox: true`, `contextIsolation: true`,
`nodeIntegration: false`, and `webSecurity: true`. New-window and navigation
requests are denied in-app; valid HTTP(S) targets are handed to the system
browser.

## IPC Surface

`electron/preload.ts` exposes:

- `window.db`: `documentSummary`, `webQa`, `docling`,
  `abstractCheckpoint`, `paperAbstract`, `kb`, `paper`, `chat`,
  `highlight`, `settings`, `data`, `index`, and `tree`;
- `window.preview`: live/cached preview control and state subscription.

All invoke channels are registered in `electron/ipc.ts`. Preview channels are
registered there too, then delegated to controllers from `webPreview.ts`.

`ipcSecurity.ts` only validates that a call came from the registered
application main frame at the expected URL. Runtime argument validation is
distributed across handlers, `backupValidation.ts`, repositories, URL/service
validators, and preview controllers.

When changing a channel, synchronize `src/types/ipcContract.ts`,
`electron/ipc.ts`, `electron/preload.ts`, global declarations, and test mocks.

## Main-Process Modules

| Module | Responsibility |
|---|---|
| `main.ts` | Lifecycle, window, single-instance lock, local PDF protocol |
| `ipc.ts` | Typed channel registration and trusted-frame gate |
| `preload.ts` | Context-bridge wrappers |
| `ipcSecurity.ts` | Application-frame identity check |
| `paperProtocol.ts` | Safe managed-PDF URL mapping and range responses |
| `docling.ts` | Legacy Docling facade/repository integration |
| `doclingClient.ts` | Docling HTTP requests and summary conversion |
| `doclingTunnel.ts` | #14 SSH forwarding to `ubuntu@101.76.222.224` |
| `summaryParsing.ts` | Unified paper/web material parsing and cache identity |
| `htmlSummary.ts` | Parse saved HTML/MHTML into `ParsedDocument` |
| `webPreview.ts` | Isolated live/cached preview controller |
| `webSummaryCapture.ts` | Snapshot-time DOM/MHTML/visual-PDF capture |
| `db/` | SQLite, repositories, backup, and file recovery |

At #14, `DEFAULT_DOCLING_SETTINGS.baseUrl` is `http://127.0.0.1:5001`.
Using that default starts the managed SSH tunnel. The Settings help text still
mentions an older host; `doclingTunnel.ts` is authoritative.

## Summary Boundary

`documentSummary:parse` reads a managed paper or saved web snapshot. PDF
conversion calls `convertPdfForSummary`; HTML conversion calls
`parseHtmlSummary`. The result and images are stored in
`document_summary_records` / `document_summary_assets`.

`document_parses` / `document_assets` and `abstract_checkpoints` are legacy
surfaces. Do not describe them as the active parsed-summary storage path.

## Security Notes

- Remote service URLs must pass `serviceSecurity` rules.
- Redirects are disabled for provider and Docling requests.
- The renderer never receives an arbitrary filesystem path for PDF reads.
- API keys are locally stored settings; default backup export strips them.
- Main-process synchronous database and full-backup work can block the event
  loop at scale; measure before claiming performance characteristics.
