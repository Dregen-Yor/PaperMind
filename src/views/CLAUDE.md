[根目录](../../CLAUDE.md) > [src](../CLAUDE.md) > **views/**

# src/views/ — Route-Level Screens

The #14 baseline has six route views:

| View | Route | Responsibility |
|---|---|---|
| `LibraryView.vue` | `/library` | Knowledge bases, filtering, metadata, batch import |
| `ReaderView.vue` | `/library/:id` | PDF, notes/highlights, paper chat, paper summary |
| `ChatView.vue` | `/chat` | Multi-paper conversations and profile parameters |
| `ReadingMapView.vue` | `/reading-map` | PDF/web history aggregation and navigation |
| `WebPreviewView.vue` | `/web-preview` | Live/cached web reading, archive, QA, summary |
| `SettingsView.vue` | `/settings` | LLM profiles, E-k5, Docling, backup/restore |

## Ownership

- Views own route parameters, layout, and page-level selection.
- Persistent domain state belongs to stores, composables, or main-process
  repositories.
- Long-running work must retain the source/conversation ID captured before the
  first await; route changes must not retarget it.
- Library import is owned by `libraryImport`, not a view-local loop.
- Web history/QA/summary are owned by composables and source-keyed stores.
- Reading position is saved by `PdfViewer` to `localStorage`.

## Screen Notes

### Library

Batch imports capture the target knowledge base. Duplicate hashes can restore a
missing managed PDF or open/skip the existing paper. Import success schedules
E-k5 indexing and summary preparation independently.

### Reader

The reader combines `PdfViewer`, `NotesPanel`, `PaperAbstractPanel`, and a
paper conversation. Source links can jump to exact paper pages. Empty
conversation cleanup and stale async guards must remain paper-scoped.

### Chat

The multi-paper screen selects papers and a conversation, while `ChatPanel`
and `ParamPanel` delegate generation to `chatStore`. Displayed “indexed” state
refers to current E-k5 readiness.

### Web preview

Explicit open/save actions capture a snapshot and then archive it through
`webQa`. Site navigation alone is not archived. Cached preview, QA, and
summary all remain bound to the selected snapshot.

### Settings

At #14 the settings page manages:

- OpenAI, Anthropic, and Ollama profiles;
- active chat/index profiles and E-k5 context budget/rebuild;
- the official Docling service address as read-only context and an API Key field;
- default-redacted backup export, restore preview, and clear-data actions.

It does not expose the legacy semantic-tree controls or Hugging Face summary
token described by older documentation.

When changing visible behavior, update the corresponding component/store tests
and architecture documentation. Include screenshots for material UI changes.
