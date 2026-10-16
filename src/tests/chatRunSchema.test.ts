// @vitest-environment node
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { SCHEMA } from '../../electron/db/schema'
import { migrateChatRuns } from '../../electron/db/chatRun'

describe('chat run storage', () => {
  it('stores the identity and state of the current assistant run', () => {
    const db = new Database(':memory:')
    try {
      db.exec(SCHEMA)
      const columns = (db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map(row => row.name)
      expect(columns).toContain('run_id')
      expect(columns).toContain('run_status')
    } finally { db.close() }
  })

  it('migrates an old messages table and marks a stranded run interrupted', () => {
    const db = new Database(':memory:')
    try {
      db.exec(`CREATE TABLE messages (id TEXT PRIMARY KEY, content TEXT NOT NULL);
        INSERT INTO messages (id, content) VALUES ('old', 'old answer');`)
      migrateChatRuns(db)
      db.prepare("INSERT INTO messages (id, content, run_id, run_status) VALUES ('active', 'partial', 'run-1', 'streaming')").run()
      migrateChatRuns(db)
      const rows = db.prepare('SELECT id, content, run_id, run_status FROM messages ORDER BY id').all() as Array<Record<string, string>>
      expect(rows).toEqual([
        { id: 'active', content: 'partial', run_id: 'run-1', run_status: 'interrupted' },
        { id: 'old', content: 'old answer', run_id: '', run_status: '' },
      ])
    } finally { db.close() }
  })
})
