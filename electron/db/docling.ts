import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { ASSET_ID_PATTERN, IMAGE_DATA_PATTERN, MAX_IMAGE_BYTES, assignTypedDocumentIds, isParsedDocument, type DoclingRecord } from '../../src/utils/doclingDocument'

export function imageIdentity(paperId: string, data: string): string {
  const { mime, bytes } = decodeImage(data)
  return createHash('sha256').update(paperId).update('\0').update(`data:${mime};base64,${bytes.toString('base64')}`).digest('hex')
}
function decodeImage(data: string) {
  if (!IMAGE_DATA_PATTERN.test(data)) throw new Error('Docling 图片必须是嵌入的 PNG/JPEG/WebP')
  const [header, encoded] = data.split(',')
  const bytes = Buffer.from(encoded!, 'base64')
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('Docling 图片为空或超过 12 MB')
  return { mime: header!.slice(5, header!.indexOf(';')), bytes }
}

export function createDoclingRepository(db: Database.Database) {
  const readAsset = (id: string): string | null => {
    if (!ASSET_ID_PATTERN.test(id)) return null
    const row = db.prepare('SELECT mime, bytes FROM document_assets WHERE id = ?').get(id) as { mime: string; bytes: Buffer } | undefined
    if (!row || !['image/png', 'image/jpeg', 'image/webp'].includes(row.mime) || row.bytes.length > MAX_IMAGE_BYTES) return null
    return `data:${row.mime};base64,${row.bytes.toString('base64')}`
  }
  const get = (paperId: string, sourceHash: string, configHash: string): DoclingRecord | null => {
    const row = db.prepare('SELECT document_json FROM document_parses WHERE paper_id = ? AND source_hash = ? AND config_hash = ?').get(paperId, sourceHash, configHash) as { document_json: string } | undefined
    if (!row) return null
    try {
      const document: unknown = JSON.parse(row.document_json)
      if (!isParsedDocument(document)) return null
      for (const item of document.items) for (const image of item.images) {
        if (!image.assetId || image.data || !db.prepare('SELECT id FROM document_assets WHERE id = ? AND paper_id = ?').get(image.assetId, paperId)) return null
      }
      return { document: assignTypedDocumentIds(document), sourceHash, configHash, cached: true }
    } catch { return null }
  }
  const save = (paperId: string, record: DoclingRecord): DoclingRecord => {
    if (!record || !ASSET_ID_PATTERN.test(record.sourceHash) || !ASSET_ID_PATTERN.test(record.configHash) || !isParsedDocument(record.document)) throw new Error('Docling 解析缓存格式无效')
    const document = JSON.parse(JSON.stringify(record.document)) as DoclingRecord['document']
    if (new Set(document.items.map(i => i.id)).size !== document.items.length) throw new Error('Docling 素材编号重复')
    assignTypedDocumentIds(document)
    db.transaction(() => {
      for (const item of document.items) for (const image of item.images) {
        if (image.data) {
          const { mime, bytes } = decodeImage(image.data)
          const id = imageIdentity(paperId, image.data)
          db.prepare('INSERT OR IGNORE INTO document_assets (id, paper_id, mime, bytes) VALUES (?, ?, ?, ?)').run(id, paperId, mime, bytes)
          image.assetId = id
          delete image.data
        } else if (!image.assetId || !db.prepare('SELECT id FROM document_assets WHERE id = ? AND paper_id = ?').get(image.assetId, paperId)) {
          throw new Error('Docling 原文素材不存在，请重新解析')
        }
      }
      db.prepare(`INSERT INTO document_parses (paper_id, source_hash, config_hash, document_json, created_at)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(paper_id) DO UPDATE SET
        source_hash=excluded.source_hash, config_hash=excluded.config_hash,
        document_json=excluded.document_json, created_at=excluded.created_at`)
        .run(paperId, record.sourceHash, record.configHash, JSON.stringify(document), Date.now())
    })()
    return { ...record, document, cached: true }
  }
  const exportBackup = () => ({
    parses: db.prepare('SELECT * FROM document_parses').all(),
    assets: (db.prepare('SELECT * FROM document_assets').all() as Array<{ id: string; paper_id: string; mime: string; bytes: Buffer }>).map(row => ({ id: row.id, paper_id: row.paper_id, data: `data:${row.mime};base64,${row.bytes.toString('base64')}` })),
  })
  const importBackup = (value: unknown) => {
    const backup = value as { parses?: any[]; assets?: any[] } | undefined
    const parses = Array.isArray(backup?.parses) ? backup.parses : []
    const assets = Array.isArray(backup?.assets) ? backup.assets : []
    db.transaction(() => {
      for (const asset of assets) {
        if (typeof asset?.paper_id !== 'string' || typeof asset?.data !== 'string' || asset.id !== imageIdentity(asset.paper_id, asset.data)) throw new Error('备份中的 Docling 素材身份无效')
        const { mime, bytes } = decodeImage(asset.data)
        db.prepare('INSERT INTO document_assets (id, paper_id, mime, bytes) VALUES (?, ?, ?, ?)').run(asset.id, asset.paper_id, mime, bytes)
      }
      for (const row of parses) {
        if (!ASSET_ID_PATTERN.test(row?.source_hash ?? '') || !ASSET_ID_PATTERN.test(row?.config_hash ?? '') || !isParsedDocument(JSON.parse(row.document_json))) throw new Error('备份中的 Docling 解析缓存无效')
        db.prepare('INSERT INTO document_parses (paper_id, source_hash, config_hash, document_json, created_at) VALUES (?, ?, ?, ?, ?)').run(row.paper_id, row.source_hash, row.config_hash, row.document_json, row.created_at ?? Date.now())
        if (!get(row.paper_id, row.source_hash, row.config_hash)) throw new Error('备份缺少 Docling 原文素材')
      }
    })()
  }
  return { get, save, readAsset, exportBackup, importBackup }
}
export type DoclingRepository = ReturnType<typeof createDoclingRepository>
