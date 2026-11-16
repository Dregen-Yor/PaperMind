[根目录](../../CLAUDE.md) > [src](../CLAUDE.md) > **router/**

# src/router/ — Route Table

`src/router/index.ts` uses `createWebHashHistory` so packaged `file://` loading
does not require server-side route fallback.

| Route | Component | Purpose |
|---|---|---|
| `/` | redirect | Redirect to `/library` |
| `/library` | `LibraryView` | Knowledge bases and paper import |
| `/reading-map` | `ReadingMapView` | PDF/web reading history map |
| `/library/:id` | `ReaderView` | PDF reader, notes, chat, summary |
| `/web-preview` | `WebPreviewView` | Live/cached web reading, QA, summary |
| `/chat` | `ChatView` | Multi-paper conversations |
| `/settings` | `SettingsView` | Providers, retrieval, Docling, backup |

`LibraryView` is statically imported for the default screen; the other route
components are lazy-loaded. When adding a route, update `App.vue` navigation
when appropriate, `docs/architecture/`, and route/view tests.
