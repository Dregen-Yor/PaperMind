import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import { canonicalWebPageUrl } from '../../src/utils/webPageUrl'
import { archiveAppearanceHash } from './webArchiveHash'

type LegacySnapshot = {
  id: string
  final_url: string
  title: string
  html: string
  captured_at: number
  content_hash: string
  byte_length: number
}

export function migrateWebPageHistory(db: Database.Database): void {
  const backfillAppearance = () => {
    const ids = db.prepare(`SELECT id FROM web_snapshots
      WHERE archive_mhtml IS NOT NULL AND appearance_hash NOT LIKE 'v2:%'`).all() as Array<{ id: string }>
    const read = db.prepare('SELECT archive_mhtml FROM web_snapshots WHERE id=?')
    const update = db.prepare('UPDATE web_snapshots SET appearance_hash=? WHERE id=?')
    db.transaction(() => {
      for (const { id } of ids) {
        const row = read.get(id) as { archive_mhtml: Buffer }
        update.run(archiveAppearanceHash(row.archive_mhtml), id)
      }
    })()
  }
  const columns = (db.prepare('PRAGMA table_info(web_snapshots)').all() as Array<{ name: string }>).map(row => row.name)
  if (columns.includes('page_id')) {
    if (!columns.includes('archive_mhtml')) db.exec('ALTER TABLE web_snapshots ADD COLUMN archive_mhtml BLOB')
    if (!columns.includes('appearance_hash')) db.exec("ALTER TABLE web_snapshots ADD COLUMN appearance_hash TEXT NOT NULL DEFAULT ''")
    backfillAppearance()
    db.exec('CREATE INDEX IF NOT EXISTS idx_web_snapshots_page ON web_snapshots(page_id, last_seen_at DESC)')
    db.exec('CREATE INDEX IF NOT EXISTS idx_web_snapshots_appearance ON web_snapshots(page_id, content_hash, appearance_hash)')
    db.exec('CREATE INDEX IF NOT EXISTS idx_web_qa_sessions_snapshot ON web_qa_sessions(snapshot_id)')
    return
  }

  db.pragma('foreign_keys = OFF')
  try {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS web_pages (
          id TEXT PRIMARY KEY,
          canonical_url TEXT NOT NULL UNIQUE,
          title TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          last_opened_at INTEGER NOT NULL
        );
        CREATE TABLE web_snapshots_next (
          id TEXT PRIMARY KEY,
          page_id TEXT NOT NULL,
          final_url TEXT NOT NULL,
          title TEXT NOT NULL,
          html TEXT NOT NULL,
          captured_at INTEGER NOT NULL,
          content_hash TEXT NOT NULL,
          byte_length INTEGER NOT NULL,
          preview_json TEXT NOT NULL DEFAULT '',
          last_seen_at INTEGER NOT NULL,
          archive_mhtml BLOB,
          appearance_hash TEXT NOT NULL DEFAULT '',
          FOREIGN KEY (page_id) REFERENCES web_pages(id) ON DELETE CASCADE
        );
        CREATE TABLE web_qa_sessions_next (
          id TEXT PRIMARY KEY,
          snapshot_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (snapshot_id) REFERENCES web_snapshots(id) ON DELETE CASCADE
        );
      `)

      const rows = db.prepare('SELECT * FROM web_snapshots ORDER BY captured_at, id').all() as LegacySnapshot[]
      const pages = new Map<string, string>()
      const insertPage = db.prepare('INSERT INTO web_pages (id, canonical_url, title, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?)')
      const updatePage = db.prepare('UPDATE web_pages SET title=?, last_opened_at=? WHERE id=?')
      const insertSnapshot = db.prepare(`INSERT INTO web_snapshots_next
        (id, page_id, final_url, title, html, captured_at, content_hash, byte_length, preview_json, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?)`)
      for (const row of rows) {
        const canonical = canonicalWebPageUrl(row.final_url)
        let pageId = pages.get(canonical)
        if (!pageId) {
          pageId = randomUUID()
          pages.set(canonical, pageId)
          insertPage.run(pageId, canonical, row.title, row.captured_at, row.captured_at)
        } else {
          updatePage.run(row.title, row.captured_at, pageId)
        }
        insertSnapshot.run(row.id, pageId, row.final_url, row.title, row.html,
          row.captured_at, row.content_hash, row.byte_length, row.captured_at)
      }
      db.exec(`
        INSERT INTO web_qa_sessions_next (id, snapshot_id, created_at, updated_at)
        SELECT id, snapshot_id, created_at, updated_at FROM web_qa_sessions;
        DROP TABLE web_qa_sessions;
        DROP TABLE web_snapshots;
        ALTER TABLE web_snapshots_next RENAME TO web_snapshots;
        ALTER TABLE web_qa_sessions_next RENAME TO web_qa_sessions;
      `)
      const violations = db.pragma('foreign_key_check') as unknown[]
      if (violations.length) throw new Error('网页历史迁移后的关联检查失败')
    })()
  } finally {
    db.pragma('foreign_keys = ON')
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_web_snapshots_page ON web_snapshots(page_id, last_seen_at DESC)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_web_snapshots_appearance ON web_snapshots(page_id, content_hash, appearance_hash)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_web_qa_sessions_snapshot ON web_qa_sessions(snapshot_id)')
}
