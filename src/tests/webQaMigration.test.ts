import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { migrateWebPageHistory } from '../../electron/db/webQaMigration'
import { SCHEMA } from '../../electron/db/schema'

function legacyDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE web_snapshots (
      id TEXT PRIMARY KEY, final_url TEXT NOT NULL, title TEXT NOT NULL, html TEXT NOT NULL,
      captured_at INTEGER NOT NULL, content_hash TEXT NOT NULL, byte_length INTEGER NOT NULL
    );
    CREATE TABLE web_qa_sessions (
      id TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (snapshot_id) REFERENCES web_snapshots(id) ON DELETE CASCADE
    );
    CREATE TABLE web_qa_messages (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
      status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', model_id TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES web_qa_sessions(id) ON DELETE CASCADE
    );
  `)
  db.prepare('INSERT INTO web_snapshots VALUES (?,?,?,?,?,?,?)')
    .run('old-snapshot-1', 'https://EXAMPLE.org/a#top', '旧页', '<html>旧一</html>', 10, 'hash-1', 18)
  db.prepare('INSERT INTO web_snapshots VALUES (?,?,?,?,?,?,?)')
    .run('old-snapshot-2', 'https://example.org/a', '旧页', '<html>旧二</html>', 20, 'hash-2', 18)
  db.prepare('INSERT INTO web_qa_sessions VALUES (?,?,?,?)').run('old-session-1', 'old-snapshot-1', 11, 12)
  db.prepare('INSERT INTO web_qa_sessions VALUES (?,?,?,?)').run('old-session-2', 'old-snapshot-2', 21, 22)
  db.prepare('INSERT INTO web_qa_messages VALUES (?,?,?,?,?,?,?,?)')
    .run('old-question', 'old-session-1', 'user', '旧问题', 'completed', '', '', 11)
  db.prepare('INSERT INTO web_qa_messages VALUES (?,?,?,?,?,?,?,?)')
    .run('failed-answer', 'old-session-1', 'assistant', '半句', 'failed', '超时', 'model-a', 12)
  return db
}

describe('webpage history migration', () => {
  it('groups legacy pages and preserves snapshots, messages and many sessions per snapshot', () => {
    const db = legacyDb()
    migrateWebPageHistory(db)
    migrateWebPageHistory(db)
    expect(db.prepare('SELECT COUNT(*) n FROM web_pages').get()).toMatchObject({ n: 1 })
    expect(db.prepare('SELECT canonical_url FROM web_pages').get()).toMatchObject({ canonical_url: 'https://example.org/a' })
    expect(db.prepare('SELECT id, html, preview_json, last_seen_at FROM web_snapshots WHERE id=?').get('old-snapshot-1'))
      .toMatchObject({ id: 'old-snapshot-1', html: '<html>旧一</html>', preview_json: '', last_seen_at: 10 })
    expect(db.prepare('SELECT status, error, model_id FROM web_qa_messages WHERE id=?').get('failed-answer'))
      .toMatchObject({ status: 'failed', error: '超时', model_id: 'model-a' })
    expect(db.prepare('SELECT snapshot_id FROM web_qa_sessions WHERE id=?').get('old-session-2'))
      .toMatchObject({ snapshot_id: 'old-snapshot-2' })
    db.prepare('INSERT INTO web_qa_sessions (id,snapshot_id,created_at,updated_at) VALUES (?,?,?,?)')
      .run('third-session', 'old-snapshot-1', 30, 30)
    expect(db.pragma('foreign_key_check')).toEqual([])
    db.close()
  })

  it('accepts fresh schema and leaves it unchanged on repeat calls', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    db.exec(SCHEMA)
    migrateWebPageHistory(db)
    migrateWebPageHistory(db)
    expect(db.pragma('foreign_key_check')).toEqual([])
    expect((db.prepare('PRAGMA table_info(web_snapshots)').all() as Array<{ name: string }>).map(row => row.name))
      .toContain('page_id')
    expect((db.prepare('PRAGMA table_info(web_snapshots)').all() as Array<{ name: string }>).map(row => row.name))
      .toContain('archive_mhtml')
    expect((db.prepare('PRAGMA table_info(web_snapshots)').all() as Array<{ name: string }>).map(row => row.name))
      .toContain('appearance_hash')
    db.close()
  })

  it('adds the archive column to existing page history without losing conversations', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    db.exec(SCHEMA.replace('  archive_mhtml BLOB,\n', ''))
    db.prepare('INSERT INTO web_pages VALUES (?,?,?,?,?)')
      .run('p1', 'https://example.org/a', '旧页', 1, 1)
    db.prepare(`INSERT INTO web_snapshots
      (id,page_id,final_url,title,html,captured_at,content_hash,byte_length,preview_json,last_seen_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run('v1', 'p1', 'https://example.org/a', '旧页', '<html></html>', 1, 'hash', 13, '', 1)
    db.prepare('INSERT INTO web_qa_sessions VALUES (?,?,?,?)').run('s1', 'v1', 1, 1)
    migrateWebPageHistory(db)
    expect(db.prepare('SELECT archive_mhtml FROM web_snapshots WHERE id=?').get('v1'))
      .toMatchObject({ archive_mhtml: null })
    expect(db.prepare('SELECT snapshot_id FROM web_qa_sessions WHERE id=?').get('s1'))
      .toMatchObject({ snapshot_id: 'v1' })
    db.close()
  })

  it('backfills the appearance fingerprint for an existing MHTML archive', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    db.exec(SCHEMA.replace("  appearance_hash TEXT NOT NULL DEFAULT '',\n", ''))
    db.prepare('INSERT INTO web_pages VALUES (?,?,?,?,?)').run('p1', 'https://example.org/a', '页', 1, 1)
    const archive = Buffer.from('MIME-Version: 1.0\nContent-Type: multipart/related\n')
    db.prepare(`INSERT INTO web_snapshots
      (id,page_id,final_url,title,html,captured_at,content_hash,byte_length,preview_json,archive_mhtml,last_seen_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run('v1', 'p1', 'https://example.org/a', '页', '<html></html>', 1, 'hash', 13, '', archive, 1)
    migrateWebPageHistory(db)
    expect(db.prepare('SELECT appearance_hash FROM web_snapshots WHERE id=?').get('v1'))
      .toMatchObject({ appearance_hash: expect.stringMatching(/^v2:[a-f0-9]{64}$/) })
    db.close()
  })

  it('recomputes fingerprints made before resource references were preserved', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    db.exec(SCHEMA)
    db.prepare('INSERT INTO web_pages VALUES (?,?,?,?,?)').run('p1', 'https://example.org/a', '页', 1, 1)
    const archive = Buffer.from('MIME-Version: 1.0\nContent-Type: multipart/related\n')
    db.prepare(`INSERT INTO web_snapshots
      (id,page_id,final_url,title,html,captured_at,content_hash,byte_length,preview_json,archive_mhtml,appearance_hash,last_seen_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('v1', 'p1', 'https://example.org/a', '页', '<html></html>', 1, 'hash', 13, '', archive,
        'old-fingerprint', 1)
    migrateWebPageHistory(db)
    const fingerprint = (db.prepare('SELECT appearance_hash FROM web_snapshots WHERE id=?').get('v1') as { appearance_hash: string }).appearance_hash
    expect(fingerprint).toMatch(/^v2:[a-f0-9]{64}$/)
    migrateWebPageHistory(db)
    expect(db.prepare('SELECT appearance_hash FROM web_snapshots WHERE id=?').get('v1'))
      .toMatchObject({ appearance_hash: fingerprint })
    db.close()
  })
})
