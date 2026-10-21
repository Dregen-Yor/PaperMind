// @vitest-environment node
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { SCHEMA } from '../../electron/db/schema'
import { createDocumentSummaryRepository, validateDocumentSummaryBackup } from '../../electron/db/documentSummary'

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0ioAAAAASUVORK5CYII='
function setup() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
  db.prepare('INSERT INTO knowledge_bases(id,name,created_at) VALUES (?,?,?)').run('kb', 'Library', 0)
  db.prepare('INSERT INTO papers(id,knowledge_base_id,file_name,file_path,added_at) VALUES (?,?,?,?,?)').run('p', 'kb', 'p.pdf', '/tmp/p.pdf', 0)
  db.prepare('INSERT INTO web_pages(id,canonical_url,title,created_at,last_opened_at) VALUES (?,?,?,?,?)').run('web', 'https://example.org/', 'Page', 0, 0)
  db.prepare(`INSERT INTO web_snapshots(id,page_id,final_url,title,html,captured_at,content_hash,byte_length,last_seen_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run('snapshot', 'web', 'https://example.org/', 'Page', '<p>Hello</p>', 0, 'a'.repeat(64), 12, 0)
  return db
}

describe('source-owned visual summary persistence', () => {
  it('stores paper/web material versions and real image assets independently', () => {
    const db = setup()
    try {
      const repo = createDocumentSummaryRepository(db)
      const record = repo.save({ kind: 'paper', sourceId: 'p', slot: 'materials', sourceHash: 'a'.repeat(64), payload: '{"assets":[]}' })
      expect(repo.get('paper', 'p', 'materials')).toEqual(record)
      expect(repo.get('web', 'snapshot', 'materials')).toBeNull()
      const first = repo.saveAsset('paper', 'p', png)
      expect(repo.saveAsset('paper', 'p', png)).toBe(first)
      expect(repo.readAsset(first)).toBe(png)
      const second = repo.saveAsset('web', 'snapshot', png)
      expect(second).not.toBe(first)
      db.prepare('DELETE FROM papers WHERE id=?').run('p')
      expect(repo.readAsset(first)).toBeNull()
      expect(repo.get('paper', 'p', 'materials')).toBeNull()
      expect(repo.readAsset(second)).toBe(png)
      db.prepare('DELETE FROM web_pages WHERE id=?').run('web')
      expect(repo.readAsset(second)).toBeNull()
    } finally { db.close() }
  })

  it('rejects late writes to deleted sources, invalid JSON and disguised image payloads', () => {
    const db = setup()
    try {
      const repo = createDocumentSummaryRepository(db)
      expect(() => repo.save({ kind: 'paper', sourceId: 'missing', slot: 'report', sourceHash: 'x', payload: '{}' })).toThrow()
      expect(() => repo.save({ kind: 'paper', sourceId: 'p', slot: 'report', sourceHash: 'x', payload: 'not-json' })).toThrow()
      expect(() => repo.saveAsset('paper', 'p', 'data:image/png;base64,aGVsbG8=')).toThrow()
      expect(repo.readAsset('../../private-key')).toBeNull()
    } finally { db.close() }
  })

  it('roundtrips backups including web images and rejects tampered identities before import', () => {
    const db = setup()
    const restored = setup()
    try {
      const repo = createDocumentSummaryRepository(db)
      const id = repo.saveAsset('web', 'snapshot', png)
      repo.save({ kind: 'web', sourceId: 'snapshot', slot: 'report', sourceHash: 'v1', payload: JSON.stringify({ content: `![Original](asset:${id})` }) })
      const backup = repo.exportBackup()
      const target = createDocumentSummaryRepository(restored)
      target.importBackup(backup)
      expect(target.get('web', 'snapshot', 'report')?.payload).toContain(id)
      expect(target.readAsset(id)).toBe(png)
      const corrupted = structuredClone(backup)
      corrupted.assets[0].id = 'f'.repeat(64)
      expect(() => validateDocumentSummaryBackup(corrupted)).toThrow()
      expect(() => validateDocumentSummaryBackup({ ...backup, assets: [] })).toThrow('素材')
      expect(() => validateDocumentSummaryBackup(backup, new Set(['p']), new Set())).toThrow()
      expect(() => target.importBackup(corrupted)).toThrow()
      expect(target.readAsset(id)).toBe(png)
    } finally { db.close(); restored.close() }
  })
})
