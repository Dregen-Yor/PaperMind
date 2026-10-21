export const SCHEMA = `
CREATE TABLE IF NOT EXISTS knowledge_bases (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT DEFAULT '',
  color       TEXT DEFAULT '#3db8a0',
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS papers (
  id                TEXT PRIMARY KEY,
  knowledge_base_id TEXT NOT NULL,
  title             TEXT DEFAULT '',
  authors           TEXT DEFAULT '[]',   -- JSON array
  abstract          TEXT DEFAULT '',
  year              INTEGER DEFAULT 0,
  tags              TEXT DEFAULT '[]',   -- JSON array
  status            TEXT DEFAULT 'unread',
  file_name         TEXT NOT NULL,
  file_path         TEXT NOT NULL,       -- absolute path on disk
  file_hash         TEXT DEFAULT '',    -- 文件内容 SHA-256，重复导入检测（#10）
  added_at          INTEGER NOT NULL,
  FOREIGN KEY (knowledge_base_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS conversations (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  paper_ids   TEXT DEFAULT '[]',         -- JSON array
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  sources         TEXT DEFAULT '[]',     -- JSON array
  error       TEXT DEFAULT '',          -- 失败态标记：非空即渲染失败卡（#2）
  truncated   INTEGER DEFAULT 0,        -- finish_reason=length 截断标记（#3）
  context     TEXT DEFAULT '',          -- 用户划选原文：重试时按原上下文重放（#2）
  run_id      TEXT DEFAULT '',          -- 最近一次生成运行的身份
  run_status  TEXT DEFAULT '',          -- preparing/streaming/terminal；旧消息留空
  timestamp       INTEGER NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS highlights (
  id          TEXT PRIMARY KEY,
  paper_id    TEXT NOT NULL,
  text        TEXT NOT NULL,
  page_num    INTEGER DEFAULT 0,
  color       TEXT DEFAULT '#c9a84c',
  note        TEXT DEFAULT '',
  start_offset INTEGER DEFAULT 0,
  end_offset   INTEGER DEFAULT 0,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Private commit markers coordinate SQLite with the reversible PDF journal.
-- Recovery removes these after the matching file operation has been finalized.
CREATE TABLE IF NOT EXISTS paper_file_transactions (
  id TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS paper_indexes (
  paper_id   TEXT PRIMARY KEY,
  index_json TEXT NOT NULL,
  pages_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE
);

-- 轻量语义树索引（方案 2026-09-15 §10.3）：与 paper_indexes 分离存放。
-- 树的导航元数据与原文证据块分区保存，树可以重建而原文不受影响（§4）。
CREATE TABLE IF NOT EXISTS paper_trees (
  paper_id         TEXT PRIMARY KEY,
  tree_json        TEXT NOT NULL,
  blocks_json      TEXT NOT NULL,
  schema_version   INTEGER NOT NULL,
  prompt_version   TEXT NOT NULL,
  build_model      TEXT NOT NULL,
  source_hash      TEXT NOT NULL,   -- pages_json 指纹：内容未变时复用已有树
  build_config_hash TEXT DEFAULT '', -- 建树配置指纹（schema/提示词/模型/分块）：配置变了旧树必须失效
  input_tokens     INTEGER DEFAULT 0,
  output_tokens    INTEGER DEFAULT 0,
  build_latency_ms INTEGER DEFAULT 0,
  created_at       INTEGER NOT NULL,
  FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE
);

-- Immutable source image bytes survive reparse while their paper exists.
CREATE TABLE IF NOT EXISTS document_parses (
  paper_id TEXT PRIMARY KEY,
  source_hash TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  document_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS document_assets (
  id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes BLOB NOT NULL,
  FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_document_assets_paper ON document_assets(paper_id);

CREATE TABLE IF NOT EXISTS abstract_checkpoints (
  paper_id TEXT NOT NULL,
  run_key TEXT NOT NULL,
  stage TEXT NOT NULL,
  position INTEGER NOT NULL,
  content TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (paper_id, run_key, stage, position),
  FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS paper_abstracts (
  paper_id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  sources_json TEXT NOT NULL DEFAULT '[]',
  truncated INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  pipeline_version INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_papers_kb ON papers(knowledge_base_id);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_highlights_paper ON highlights(paper_id);

CREATE TABLE IF NOT EXISTS web_pages (
  id TEXT PRIMARY KEY,
  canonical_url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_opened_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS web_snapshots (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL,
  final_url TEXT NOT NULL,
  title TEXT NOT NULL,
  html TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  preview_json TEXT NOT NULL DEFAULT '',
  archive_mhtml BLOB,
  visual_pdf BLOB,
  appearance_hash TEXT NOT NULL DEFAULT '',
  last_seen_at INTEGER NOT NULL,
  FOREIGN KEY (page_id) REFERENCES web_pages(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS web_qa_sessions (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (snapshot_id) REFERENCES web_snapshots(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS web_qa_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT NOT NULL DEFAULT '',
  model_id TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES web_qa_sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_web_qa_messages_session ON web_qa_messages(session_id, created_at);

CREATE TABLE IF NOT EXISTS document_summary_records (
  kind TEXT NOT NULL CHECK(kind IN ('paper','web')),
  source_id TEXT NOT NULL,
  slot TEXT NOT NULL CHECK(slot IN ('materials','report','task')),
  source_hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  paper_id TEXT REFERENCES papers(id) ON DELETE CASCADE,
  snapshot_id TEXT REFERENCES web_snapshots(id) ON DELETE CASCADE,
  PRIMARY KEY(kind,source_id,slot),
  CHECK((kind='paper' AND paper_id=source_id AND snapshot_id IS NULL)
    OR (kind='web' AND snapshot_id=source_id AND paper_id IS NULL))
);
CREATE TABLE IF NOT EXISTS document_summary_assets (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('paper','web')),
  source_id TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes BLOB NOT NULL,
  paper_id TEXT REFERENCES papers(id) ON DELETE CASCADE,
  snapshot_id TEXT REFERENCES web_snapshots(id) ON DELETE CASCADE,
  CHECK((kind='paper' AND paper_id=source_id AND snapshot_id IS NULL)
    OR (kind='web' AND snapshot_id=source_id AND paper_id IS NULL))
);
`
