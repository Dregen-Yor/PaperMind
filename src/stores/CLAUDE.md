[根目录](../../CLAUDE.md) > [src](../CLAUDE.md) > **stores/**

# src/stores/ — Pinia State and Product Orchestration

The #14 baseline has six stores:

| Store | Responsibility |
|---|---|
| `paper.ts` | Knowledge bases, papers, managed-file access, shared highlights |
| `chat.ts` | Profiles, providers, conversations, run lifecycle, E-k5, `/abstract` |
| `chatDrafts.ts` | Conversation-keyed drafts and selected external context |
| `libraryImport.ts` | Batch-owned import queue and progress |
| `libraryWorkspace.ts` | Library selection, search, sort, move/delete UI state |
| `visualSummary.ts` | Cross-route paper/web summary preparation, generation, cache, cancel |

Components may call `window.db` for narrowly scoped domain APIs, especially
web composables; do not claim that every IPC call passes through a store.

## chat.ts

`chat.ts` remains a large orchestration module. It owns:

- named OpenAI, Anthropic, and Ollama profiles;
- provider request construction and stream parsing;
- persistent conversation/message runs with preparing, streaming, completed,
  failed, cancelled, and interrupted states;
- E-k5 indexing and retrieval;
- query rewriting and final RAG generation;
- the `/abstract` command and compatibility paper-summary API;
- legacy PageIndex/passage/semantic-tree maintenance functions.

### Production retrieval

`collectIndexedPapers` loads E-k5 indexes. `generateReply` calls
`runRagPipeline` with `retrievalMode: 'ek5'` and the local embedder.

- Query rewrite is conditional on sufficient multi-turn history.
- E-k5 ranks leaf heading groups with heading-path embeddings plus BM25 over
  path/text, fused by RRF.
- The top five original-text groups are used as context.
- Missing or invalid E-k5 state is an explicit error; it does not silently
  change algorithms.
- `treeEnabled` and semantic-tree methods are compatibility/experimental
  surfaces and do not participate in current product answers.

### Chat run lifecycle

Each conversation has at most one active run. An assistant placeholder is
created before generation, partial content is periodically persisted, and a
terminal status is always written when possible. Retry and continuation keep
the original conversation/question ownership instead of reading whichever
route is currently visible.

### Providers

- OpenAI-compatible chat requests use bearer auth and model-aware generation
  parameters.
- Anthropic uses its native headers and required token limit.
- Ollama uses `/api/chat` and optional local generation parameters.
- `maxTokens = 0` means no explicit cap where the provider permits it.
- Stream terminal/error/EOF behavior is centralized in `providerStreams.ts`.

Provider credentials are renderer-visible by design because requests are sent
directly from the renderer.

## visualSummary.ts

The unified summary store:

1. asks `documentSummary:parse` for paper/web materials;
2. binds work to source hash and parser identity;
3. serializes model requests per source;
4. calls `requestParsedSummary`;
5. filters `asset:ID` references against supplied assets;
6. persists `materials`, `task`, and `report` slots;
7. ignores cancelled or stale results.

This path currently requires an OpenAI-compatible API. It does not use
`abstractCheckpoint` or the legacy Hugging Face reducer.

## State Ownership Rules

- Drafts and selected context are keyed by conversation ID.
- Import batches capture their target knowledge base and file list.
- Highlight state has one store-owned copy per paper.
- Route changes must not reassign in-flight work.
- Async results require revision/generation checks before mutating state.

Longer term, provider, run, retrieval, and summary services may be extracted
from `chat.ts`. Those services are not implemented today.
