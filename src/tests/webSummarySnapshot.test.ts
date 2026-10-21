// @vitest-environment node
import Database from 'better-sqlite3'
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { SCHEMA } from '../../electron/db/schema'
import { createWebQaRepository } from '../../electron/db/webQa'

describe('immutable original webpage visuals', () => {
  it('stores a live visual PDF without MHTML and roundtrips it with the exact snapshot version', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys=ON'); db.exec(SCHEMA)
    const repo = createWebQaRepository(db)
    const html = '<h1>Original page</h1>'
    const visualPdf = Buffer.from('%PDF-1.7\noriginal visual').toString('base64')
    const snapshot = { finalUrl: 'https://example.org/visual', title: 'Visual', html,
      contentHash: createHash('sha256').update(html).digest('hex'), capturedAt: 1,
      byteLength: Buffer.byteLength(html), visualPdf }
    try {
      const first = repo.archive(snapshot, 2)
      expect(repo.getPreview(first.latestSnapshotId)).toMatchObject({ hasSummaryVisual: true, hasOriginalAppearance: false })
      expect(repo.getSnapshot(first.latestSnapshotId)?.visualPdf).toBe(visualPdf)
      expect(repo.archive(snapshot, 3).latestSnapshotId).toBe(first.latestSnapshotId)
      const changed = repo.archive({ ...snapshot, visualPdf: Buffer.from('%PDF-1.7\nupdated visual').toString('base64') }, 4)
      expect(changed.latestSnapshotId).not.toBe(first.latestSnapshotId)
      const backup = repo.exportBackup()
      repo.importBackup(backup)
      expect(repo.getSnapshot(first.latestSnapshotId)?.visualPdf).toBe(visualPdf)
      expect(repo.archive({ ...snapshot, visualPdf: Buffer.from('%PDF-1.7\nupdated visual').toString('base64') }, 5).latestSnapshotId).toBe(changed.latestSnapshotId)
      expect(() => repo.archive({ ...snapshot, visualPdf: Buffer.from('not a pdf').toString('base64') }, 5)).toThrow()
    } finally { db.close() }
  })

  it('includes archived original bytes in the stored snapshot returned for offline capture', () => {
    const db = new Database(':memory:'); db.exec(SCHEMA)
    try {
      const repo = createWebQaRepository(db), html = '<p>Legacy archive</p>'
      const archiveMhtml = Buffer.from('MIME-Version: 1.0\nOriginal archive').toString('base64')
      const page = repo.archive({ html, finalUrl: 'https://example.org/legacy', title: 'Legacy', capturedAt: 1,
        byteLength: Buffer.byteLength(html), contentHash: createHash('sha256').update(html).digest('hex'), archiveMhtml }, 1)
      expect(repo.getSnapshot(page.latestSnapshotId)?.archiveMhtml).toBe(archiveMhtml)
    } finally { db.close() }
  })
})
