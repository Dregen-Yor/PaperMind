[根目录](../../CLAUDE.md) > [src](../CLAUDE.md) > **utils/**

# src/utils/ — Shared Domain Logic

This directory mixes renderer utilities with pure modules reused by Electron
and `bench/`. Check consumers before adding browser or Node-only side effects.

## Current Product Modules

### E-k5 paper retrieval

`ek5/` is the production retrieval implementation:

- `tocCandidates.ts` extracts heading candidates;
- `tocTree.ts` builds and validates the section tree;
- `headingGroups.ts` materializes leaf groups with source ranges;
- `index.ts` builds heading-path vectors and retrieves with dense + BM25 + RRF;
- `store.ts` loads/builds/persists E-k5 data.

`ragPipeline.ts` orchestrates optional query rewrite, per-paper retrieval,
context assembly, and answer generation. Product callers pass
`retrievalMode: 'ek5'`, which rejects missing E-k5 indexes instead of using a
different algorithm.

Known limitation: E-k5 currently emits each multi-page group as one
`ContextPiece` labeled with its first page. Do not use that field as exact
per-page provenance until it is fixed.

### Parsed summaries

- `doclingDocument.ts` defines the shared parsed-document model.
- `parsedSummary.ts` serializes complete materials/images and calls an
  OpenAI-compatible multimodal endpoint.
- `visualSummary.ts` defines report types and asset filtering.
- `markdownParser.ts` and `markdownAssets.ts` normalize Markdown and local
  summary-asset references.
- `paperAbstract.ts` remains a compatibility report shape.

`abstractSummarizer.ts`, `doclingAbstract.ts`, `doclingPdf.ts`, and parts of
`visualSummaryPdf.ts` are legacy/compatibility or benchmark code, not the
active unified summary request path.

### PDF and reading

`pdfDocument.ts`, `pdfOutline.ts`, `pdfHighlight.ts`, `pdfEvidence.ts`, and
`pdfUtils.ts` handle PDF extraction/rendering support and source mapping.
`readingPosition.ts` persists page/offset to renderer `localStorage`.

### Provider, Markdown, and security

- `providerStreams.ts` parses OpenAI/Anthropic SSE and Ollama NDJSON.
- `answerMessages.ts` constructs final answer messages.
- `markdown.ts` renders sanitized Markdown/KaTeX.
- `serviceSecurity.ts` validates service URLs and bounded JSON responses.
- `webPreviewUrl.ts` / `webPageUrl.ts` enforce web URL policy.
- `sourceRef.ts` normalizes source chips and evidence links.
- `exportSanitize.ts` strips configured secrets from default backups.

## Compatibility and Experimental Retrieval

The following modules remain useful for tests, benchmarks, migrations, or
historical results, but are not the current product retrieval path:

- `pageIndex.ts` scoring/tree functions;
- `passages.ts`, `passageIndex*.ts`, `passageRetrieval.ts`;
- `semanticTree.ts`, `semanticRoute.ts`, `evidenceBlock.ts`;
- `structureCards.ts` and related materializers.

Do not delete them without checking benchmark configs, stored data
compatibility, and tests. Do not document them as a production fallback.

## Shared-Module Rules

- Keep deterministic transforms pure and dependency-injected.
- Preserve explicit source hashes, parser/config identities, and provenance.
- Never turn missing evidence into a fabricated page or source.
- Validate untrusted JSON and URLs at runtime.
- Keep final context text and page-order metadata derived from one operation.
- Add focused tests beside the relevant domain suite; do not maintain test
  counts in this document.
