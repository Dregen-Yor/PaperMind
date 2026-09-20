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

CREATE INDEX IF NOT EXISTS idx_papers_kb ON papers(knowledge_base_id);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_highlights_paper ON highlights(paper_id);
`
