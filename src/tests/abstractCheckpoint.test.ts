// @vitest-environment node
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { SCHEMA } from '../../electron/db/schema'
import { createAbstractCheckpointRepository } from '../../electron/db/abstractCheckpoint'

describe('Docling abstract checkpoints', () => {
  it('saves individual stages, replaces one stage, and removes checkpoints with the paper', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    db.exec(SCHEMA)
    db.prepare('INSERT INTO knowledge_bases (id,name,created_at) VALUES (?,?,?)').run('kb', 'KB', 0)
    db.prepare('INSERT INTO papers (id,knowledge_base_id,file_name,file_path,added_at) VALUES (?,?,?,?,?)').run('paper', 'kb', 'p.pdf', '/p.pdf', 0)
    const repo = createAbstractCheckpointRepository(db)
    const key = 'a'.repeat(64)
    try {
      expect(repo.get('paper', key, 'map', 0)).toBeNull()
      repo.save('paper', key, 'map', 0, 'first note')
      repo.save('paper', key, 'map', 1, 'second note')
      repo.save('paper', key, 'map', 0, 'revised note')
      expect(repo.get('paper', key, 'map', 0)).toBe('revised note')
      expect(repo.get('paper', key, 'map', 1)).toBe('second note')
      expect(repo.get('paper', 'b'.repeat(64), 'map', 0)).toBeNull()
      db.prepare('DELETE FROM papers WHERE id = ?').run('paper')
      expect(repo.get('paper', key, 'map', 0)).toBeNull()
    } finally { db.close() }
  })
  it('rejects invalid keys, stages, positions, and empty output', () => {
    const db = new Database(':memory:')
    db.exec(SCHEMA)
    const repo = createAbstractCheckpointRepository(db)
    try {
      expect(() => repo.save('paper', 'bad', 'map', 0, 'note')).toThrow()
      expect(() => repo.save('paper', 'a'.repeat(64), 'unknown', 0, 'note')).toThrow()
      expect(() => repo.save('paper', 'a'.repeat(64), 'map', -1, 'note')).toThrow()
      expect(() => repo.save('paper', 'a'.repeat(64), 'map', 0, '')).toThrow()
    } finally { db.close() }
  })
})
