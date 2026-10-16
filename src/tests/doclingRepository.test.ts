// @vitest-environment node
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { SCHEMA } from '../../electron/db/schema'
import { createDoclingRepository } from '../../electron/db/docling'
import { normalizeDoclingDocument } from '../utils/doclingDocument'
const fixture = () => {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
  db.prepare('INSERT INTO knowledge_bases (id,name,created_at) VALUES (?,?,?)').run('kb', 'KB', 0)
  db.prepare('INSERT INTO papers (id,knowledge_base_id,file_name,file_path,added_at) VALUES (?,?,?,?,?)').run('paper', 'kb', 'p.pdf', '/p.pdf', 0)
  const repo = createDoclingRepository(db)
  const record = { document: normalizeDoclingDocument({
    body: { children: [{ $ref: '#/texts/0' }, { $ref: '#/pictures/0' }] },
    pages: { '1': { size: { width: 100, height: 100 } } },
    texts: [{ text: 'Evidence' }, { text: 'Figure 1: Evidence plot', label: 'caption', prov: [{ page_no: 1, bbox: { l: 10, r: 90, t: 60, b: 65, coord_origin: 'TOPLEFT' } }] }],
    pictures: [{ captions: [{ $ref: '#/texts/1' }], prov: [{ page_no: 1, bbox: { l: 10, r: 90, t: 10, b: 55, coord_origin: 'TOPLEFT' } }], image: { uri: 'data:image/png;base64,aGVsbG8=' } }],
  }), sourceHash: 'a'.repeat(64), configHash: 'b'.repeat(64), cached: false }
  return { db, repo, record }
}
describe('native Docling cache and asset persistence', () => {
  it('persists immutable bytes, restores from cache and keeps history assets across reparse', () => {
    const { db, repo, record } = fixture()
    try {
      const saved = repo.save('paper', record)
      const image = saved.document.items[1].images[0]
      expect(image.data).toBeUndefined()
      expect(repo.readAsset(image.assetId!)).toBe('data:image/png;base64,aGVsbG8=')
      expect(repo.get('paper', record.sourceHash, record.configHash)?.cached).toBe(true)
      expect(repo.get('paper', 'c'.repeat(64), record.configHash)).toBeNull()
      repo.save('paper', { ...record, document: normalizeDoclingDocument({ texts: [{ text: 'Replacement' }] }) })
      expect(repo.readAsset(image.assetId!)).toBe('data:image/png;base64,aGVsbG8=')
    } finally { db.close() }
  })
  it('round trips backup assets and cascades removal with the paper', () => {
    const { db, repo, record } = fixture()
    try {
      const saved = repo.save('paper', record)
      const id = saved.document.items[1].images[0].assetId!
      const backup = repo.exportBackup()
      db.exec('DELETE FROM document_parses; DELETE FROM document_assets')
      repo.importBackup(backup)
      expect(repo.readAsset(id)).toBe('data:image/png;base64,aGVsbG8=')
      expect(repo.get('paper', record.sourceHash, record.configHash)?.document.items[0].text).toBe('Evidence')
      db.prepare('DELETE FROM papers WHERE id = ?').run('paper')
      expect(repo.readAsset(id)).toBeNull()
    } finally { db.close() }
  })
  it('keeps asset identity stable when a service omits base64 padding', () => {
    const { db, repo, record } = fixture()
    try {
      record.document.items[1].images = [{ data: 'data:image/png;base64,aGVsbG8' }]
      const id = repo.save('paper', record).document.items[1].images[0].assetId!
      const backup = repo.exportBackup()
      db.exec('DELETE FROM document_parses; DELETE FROM document_assets')
      repo.importBackup(backup)
      expect(repo.readAsset(id)).toBe('data:image/png;base64,aGVsbG8=')
      record.document.items[1].images = [{ data: 'data:image/png;base64,aGVsbG8=' }]
      expect(repo.save('paper', record).document.items[1].images[0].assetId).toBe(id)
    } finally { db.close() }
  })
  it('upgrades legacy item numbers from an existing cache without reparsing the PDF', () => {
    const { db, repo, record } = fixture()
    try {
      const saved = repo.save('paper', record)
      const legacy = structuredClone(saved.document)
      legacy.items.forEach((item, index) => { item.id = `item-${index}` })
      db.prepare('UPDATE document_parses SET document_json = ? WHERE paper_id = ?').run(JSON.stringify(legacy), 'paper')
      expect(repo.get('paper', record.sourceHash, record.configHash)?.document.items.map(item => item.id)).toEqual(['text-1', 'picture-1'])
    } finally { db.close() }
  })
  it('rejects remote images or a manifest referring to nonexistent assets atomically', () => {
    const { db, repo, record } = fixture()
    try {
      record.document.items[1].images = [{ data: 'https://example.com/image' }]
      expect(() => repo.save('paper', record)).toThrow()
      record.document.items[1].images = [{ assetId: 'c'.repeat(64) }]
      expect(() => repo.save('paper', record)).toThrow('素材')
      expect(db.prepare('SELECT COUNT(*) AS n FROM document_parses').get()).toEqual({ n: 0 })
    } finally { db.close() }
  })
})
