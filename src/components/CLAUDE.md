[根目录](../../CLAUDE.md) > [src](../CLAUDE.md) > **components/**

# src/components/ — Reusable UI

The #14 baseline has 13 reusable Vue components:

| Component | Responsibility |
|---|---|
| `PdfViewer.vue` | Incremental pdfjs rendering, selection, highlights, reading position, source navigation |
| `ChatPanel.vue` | Conversation input/output, streaming state, retry/continue, command entry |
| `ChatProfileSelect.vue` | Compact active-profile switcher |
| `ChatSources.vue` | Structured source chips and jump events |
| `ParamPanel.vue` | Chat generation parameters |
| `MarkdownContent.vue` | Sanitized Markdown/KaTeX and local summary assets |
| `NotesPanel.vue` | Notes and shared highlight state |
| `PaperMetadataEditor.vue` | Paper metadata editing |
| `PaperAbstractPanel.vue` | Parsed PDF summary lifecycle |
| `WebAbstractPanel.vue` | Parsed web summary lifecycle |
| `WebQaPanel.vue` | Archived-page QA sessions |
| `WebCachedPreview.vue` | Offline cached-page rendering |
| `ReadingStarMap.vue` | Star-map canvas and list representation |

## Important Boundaries

- `PdfViewer` reads/writes reading position through `localStorage` utilities.
  Highlights come from `paperStore` and persist through `window.db.highlight`.
- `ChatPanel` does not own conversation persistence; it calls `chatStore`.
  Draft text belongs to `chatDrafts` and is keyed by conversation.
- `MarkdownContent` resolves only allow-listed local summary assets through
  `documentSummary:readAsset`. It must not render arbitrary filesystem paths.
- Source links use `SourceRef`. Jumpability requires a paper ID and numeric
  start page; pure labels remain non-interactive.
- Paper and web abstract panels share `visualSummary` behavior but keep
  source-specific preparation and presentation.

## Editing Guidance

- Keep route-level data loading and layout in `views/`.
- Keep persistent business state in stores/composables, not component-local
  copies.
- Preserve keyboard, focus, reduced-motion, and screen-reader behavior.
- Add component tests for state ownership, stale async responses, failure
  feedback, and source navigation when changing interactions.
