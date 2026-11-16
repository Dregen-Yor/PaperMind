[根目录](../../CLAUDE.md) > [electron](../CLAUDE.md) > **db/**

# electron/db/ — SQLite and Managed Files

## Initialization

`initDb()` in `index.ts` opens `userData/papermind.db`, enables WAL and foreign
keys, executes `schema.ts`, applies guarded column migrations, seeds the
default knowledge base, recovers interrupted paper-file transactions, and
merges eligible historical highlight fragments.

SQLite access is main-process only. APIs are synchronous internally and become
asynchronous to the renderer at the IPC boundary.

## Schema Snapshot

The current schema has 19 tables:

| Domain | Tables |
|---|---|
| Core | `knowledge_bases`, `papers`, `conversations`, `messages`, `highlights`, `settings` |
| File recovery | `paper_file_transactions` |
| Retrieval | `paper_indexes`, `paper_trees` |
| Legacy Docling/summary | `document_parses`, `document_assets`, `abstract_checkpoints`, `paper_abstracts` |
| Web archive/QA | `web_pages`, `web_snapshots`, `web_qa_sessions`, `web_qa_messages` |
| Unified summary | `document_summary_records`, `document_summary_assets` |

`schema.ts` is authoritative. Count tables from the schema rather than copying
old totals into new documents.

## Implementations

| Module | Responsibility |
|---|---|
| `index.ts` | Connection, core APIs, migrations, export/import orchestration |
| `chatRun.ts` | Message run-state validation and normalization |
| `paperFileTransactions.ts` | File staging, quarantine, rollback, recovery |
| `backupValidation.ts` | Runtime validation/normalization before import |
| `docling.ts` | Legacy Docling parse/image repository |
| `documentSummary.ts` | Unified materials/report/task records and assets |
| `paperAbstract.ts` | Compatibility paper-summary record |
| `abstractCheckpoint.ts` | Legacy checkpoint repository |
| `webQa.ts` | Web pages, snapshots, sessions, and messages |
| `webQaMigration.ts` | Legacy web-history migration |
| `webArchiveHash.ts` | Archive identity |
| `webVisualPdf.ts` | Saved visual-PDF validation |

`index.ts` still contains core knowledge-base, paper, chat, highlight, setting,
index, tree, and backup orchestration. The data layer is only partially split
into repositories.

## Managed PDF Consistency

PDF bytes live under `userData/papers/<paperId>.pdf`; SQLite stores the managed
path and metadata.

`paperFileTransactions.ts` coordinates selected restore, delete, clear, and
import operations:

1. stage replacements and quarantine originals;
2. record the operation;
3. run the SQLite mutation;
4. mark commit and finalize files;
5. roll back or recover on the next startup after failure.

This provides recoverability for implemented operations, not a true atomic
transaction spanning SQLite and the filesystem. New file-changing operations
must either use this mechanism or document and test their rollback behavior.

## Backup Contract

`exportAll()` includes:

- knowledge bases, papers and PDF bytes;
- conversations/messages and highlights;
- paper indexes and legacy trees;
- legacy Docling records/assets and paper summaries;
- unified summary records/assets;
- archived web pages/snapshots and web QA;
- settings.

Plaintext API keys are removed by default. `abstract_checkpoints` are not
exported. Do not say that every database row is included.

`importAll()` validates the full input before destructive writes, stages PDF
changes, replaces supported domain records, and imports repository-owned
backups. Version-1 compatibility remains intentional.
Legacy `docling_config` rows are normalized during import to keep only a
trimmed `apiKey`; deployment and parser fields are intentionally discarded.

## Serialization and Contracts

- SQLite columns use snake_case; IPC-facing objects use camelCase.
- JSON arrays/objects are stored as TEXT where the schema requires it.
- Source references are normalized for compatibility with old string arrays.
- Renderer-supplied data is untrusted at runtime even when it satisfies a
  TypeScript interface.

For a schema/API change, review:

1. `schema.ts` and migrations;
2. the owning repository or `index.ts`;
3. backup validation/export/import;
4. `src/types/ipcContract.ts`;
5. `electron/ipc.ts` and `electron/preload.ts`;
6. global declarations and `src/tests/setup.ts`;
7. scenario tests using real temporary SQLite/files.
