import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import type { DocumentSummaryRecord, DocumentSummaryWrite, SummaryRecordSlot, SummarySourceKind } from '../../src/types/documentSummary'

const MAX_PAYLOAD_BYTES = 96 * 1024 * 1024
const MAX_IMAGE_BYTES = 12 * 1024 * 1024
const idPattern = /^[a-f0-9]{64}$/
const kinds = ['paper', 'web']
const slots = ['materials', 'report', 'task']

function source(kind: unknown, sourceId: unknown): asserts kind is SummarySourceKind {
  if (!kinds.includes(String(kind)) || typeof sourceId !== 'string' || !sourceId || sourceId.length > 200) {
    throw new Error('摘要来源无效')
  }
}
function validateRecord(value: unknown): asserts value is DocumentSummaryWrite {
  const record = value as DocumentSummaryWrite | null
  if (!record || typeof record !== 'object') throw new Error('摘要缓存无效')
  source(record.kind, record.sourceId)
  if (!slots.includes(record.slot) || typeof record.sourceHash !== 'string' || !record.sourceHash || record.sourceHash.length > 256
    || typeof record.payload !== 'string' || Buffer.byteLength(record.payload) > MAX_PAYLOAD_BYTES) throw new Error('摘要缓存格式无效或超过限制')
  let payload: unknown
  try { payload = JSON.parse(record.payload) } catch { throw new Error('摘要缓存必须是有效 JSON') }
  if (!payload || typeof payload !== 'object') throw new Error('摘要缓存必须是 JSON 对象或数组')
}

function decodeImage(value: unknown) {
  if (typeof value !== 'string') throw new Error('摘要素材图片无效')
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value)
  if (!match || match[2].length > MAX_IMAGE_BYTES * 1.4) throw new Error('摘要素材必须是嵌入的 PNG/JPEG/WebP 图片')
  const bytes = Buffer.from(match[2], 'base64')
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== match[2]) throw new Error('摘要素材数据无效或超过 12 MB')
  const mime = match[1]
  const valid = mime === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : mime === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
  if (!valid) throw new Error('摘要素材内容与图片格式不匹配')
  return { mime, bytes }
}

function assetIdentity(kind: SummarySourceKind, sourceId: string, data: string) {
  const { mime, bytes } = decodeImage(data)
  return createHash('sha256').update(kind).update('\0').update(sourceId).update('\0').update(mime).update('\0').update(bytes).digest('hex')
}

export interface DocumentSummaryBackup {
  records: DocumentSummaryRecord[]
  assets: Array<{ id: string; kind: SummarySourceKind; sourceId: string; data: string }>
}

export function validateDocumentSummaryBackup(value: unknown, paperIds?: Set<string>, snapshotIds?: Set<string>): asserts value is DocumentSummaryBackup | undefined {
  if (value === undefined) return
  const backup = value as DocumentSummaryBackup | null
  if (!backup || !Array.isArray(backup.records) || !Array.isArray(backup.assets)) throw new Error('摘要备份格式无效')
  const exists = (kind: SummarySourceKind, sourceId: string) => {
    source(kind, sourceId)
    const ids = kind === 'paper' ? paperIds : snapshotIds
    if (ids && !ids.has(sourceId)) throw new Error('摘要备份来源不存在')
  }
  const records = new Set<string>()
  for (const record of backup.records) {
    validateRecord(record)
    exists(record.kind, record.sourceId)
    if (!Number.isSafeInteger(record.updatedAt) || record.updatedAt < 0) throw new Error('摘要备份时间无效')
    const key = `${record.kind}:${record.sourceId}:${record.slot}`
    if (records.has(key)) throw new Error('摘要备份记录重复')
    records.add(key)
  }
  const assets = new Set<string>()
  const assetOwners = new Map<string, string>()
  for (const asset of backup.assets) {
    exists(asset.kind, asset.sourceId)
    if (!idPattern.test(asset.id) || asset.id !== assetIdentity(asset.kind, asset.sourceId, asset.data) || assets.has(asset.id)) throw new Error('摘要备份素材身份无效')
    assets.add(asset.id)
    assetOwners.set(asset.id, `${asset.kind}:${asset.sourceId}`)
  }
  for (const record of backup.records) {
    const owner = `${record.kind}:${record.sourceId}`
    const pending: unknown[] = [JSON.parse(record.payload)]
    const checkAsset = (id: string) => {
      if (assetOwners.get(id) !== owner) throw new Error('摘要备份缺少对应来源的原文素材')
    }
    while (pending.length) {
      const value = pending.pop()
      if (!value || typeof value !== 'object') continue
      for (const [key, child] of Object.entries(value)) {
        if (key === 'assetId' && typeof child === 'string') checkAsset(child)
        else if (key === 'content' && typeof child === 'string') {
          for (const match of child.matchAll(/asset:([a-f0-9]{64})/g)) checkAsset(match[1])
        } else if (child && typeof child === 'object') pending.push(child)
      }
    }
  }
}

export function createDocumentSummaryRepository(db: Database.Database) {
  const checkOwner = (kind: SummarySourceKind, sourceId: string) => {
    source(kind, sourceId)
    const table = kind === 'paper' ? 'papers' : 'web_snapshots'
    if (!db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(sourceId)) throw new Error('摘要来源已不存在')
  }
  const get = (kind: SummarySourceKind, sourceId: string, slot: SummaryRecordSlot): DocumentSummaryRecord | null => {
    source(kind, sourceId)
    if (!slots.includes(slot)) throw new Error('摘要缓存类型无效')
    const row = db.prepare(`SELECT kind, source_id AS sourceId, slot, source_hash AS sourceHash,
      payload, updated_at AS updatedAt FROM document_summary_records WHERE kind=? AND source_id=? AND slot=?`)
      .get(kind, sourceId, slot) as DocumentSummaryRecord | undefined
    return row ?? null
  }
  const save = (record: DocumentSummaryWrite): DocumentSummaryRecord => {
    validateRecord(record)
    checkOwner(record.kind, record.sourceId)
    const updatedAt = Date.now()
    db.prepare(`INSERT INTO document_summary_records(kind,source_id,slot,source_hash,payload,updated_at,paper_id,snapshot_id)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(kind,source_id,slot) DO UPDATE SET
      source_hash=excluded.source_hash,payload=excluded.payload,updated_at=excluded.updated_at`)
      .run(record.kind, record.sourceId, record.slot, record.sourceHash, record.payload, updatedAt,
        record.kind === 'paper' ? record.sourceId : null, record.kind === 'web' ? record.sourceId : null)
    return { ...record, updatedAt }
  }
  const saveAsset = (kind: SummarySourceKind, sourceId: string, data: string): string => {
    checkOwner(kind, sourceId)
    const { mime, bytes } = decodeImage(data)
    const id = assetIdentity(kind, sourceId, data)
    db.prepare(`INSERT OR IGNORE INTO document_summary_assets(id,kind,source_id,mime,bytes,paper_id,snapshot_id)
      VALUES (?,?,?,?,?,?,?)`).run(id, kind, sourceId, mime, bytes, kind === 'paper' ? sourceId : null, kind === 'web' ? sourceId : null)
    return id
  }
  const readAsset = (id: string): string | null => {
    if (typeof id !== 'string' || !idPattern.test(id)) return null
    const row = db.prepare('SELECT mime,bytes FROM document_summary_assets WHERE id=?').get(id) as { mime: string; bytes: Buffer } | undefined
    if (!row || row.bytes.length > MAX_IMAGE_BYTES) return null
    return `data:${row.mime};base64,${row.bytes.toString('base64')}`
  }
  const exportBackup = (): DocumentSummaryBackup => ({
    records: db.prepare(`SELECT kind,source_id AS sourceId,slot,source_hash AS sourceHash,payload,updated_at AS updatedAt
      FROM document_summary_records`).all() as DocumentSummaryRecord[],
    assets: (db.prepare('SELECT id,kind,source_id AS sourceId,mime,bytes FROM document_summary_assets').all() as
      Array<{ id: string; kind: SummarySourceKind; sourceId: string; mime: string; bytes: Buffer }>).map(({ id, kind, sourceId, mime, bytes }) =>
      ({ id, kind, sourceId, data: `data:${mime};base64,${bytes.toString('base64')}` })),
  })
  const importBackup = (value: unknown) => {
    validateDocumentSummaryBackup(value)
    if (!value) return
    db.transaction(() => {
      for (const asset of value.assets) saveAsset(asset.kind, asset.sourceId, asset.data)
      for (const record of value.records) {
        save(record)
        db.prepare('UPDATE document_summary_records SET updated_at=? WHERE kind=? AND source_id=? AND slot=?')
          .run(record.updatedAt, record.kind, record.sourceId, record.slot)
      }
    })()
  }
  return { get, save, saveAsset, readAsset, exportBackup, importBackup }
}
