import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'crypto'
import type { PreviewSnapshot } from '../../src/types/webPreview'
import { canonicalWebPageUrl } from '../../src/utils/webPageUrl'
import type { WebQaBackup, WebQaCreateInput, WebQaMessage, WebQaMessagePatch, WebQaSessionDetail, WebQaSessionSummary } from '../../src/types/webQa'
import { validateWebQaBackup } from './backupValidation'

type SessionRow = { id: string; snapshot_id: string; final_url: string; title: string; captured_at: number; byte_length: number; created_at: number; updated_at: number }
type SnapshotRow = { id: string; final_url: string; title: string; html: string; captured_at: number; content_hash: string; byte_length: number }
type MessageRow = { id: string; session_id: string; role: 'user' | 'assistant'; content: string; status: WebQaMessage['status']; error: string; model_id: string; created_at: number }
const statuses = new Set(['completed', 'streaming', 'failed', 'cancelled', 'interrupted'])
const validId = (v: unknown): v is string => typeof v === 'string' && /^[\w-]{1,128}$/.test(v)
const validTime = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0

function checkSnapshot(s: PreviewSnapshot) {
  if (!s || typeof s.title !== 'string' || typeof s.html !== 'string' || !validTime(s.capturedAt)) throw new Error('网页快照无效')
  try {
    const url = new URL(s.finalUrl)
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error()
  } catch { throw new Error('网页快照地址无效') }
  if (Buffer.byteLength(s.html, 'utf8') !== s.byteLength || s.byteLength > 8 * 1024 * 1024) throw new Error('网页快照大小无效')
  if (createHash('sha256').update(s.html, 'utf8').digest('hex') !== s.contentHash) throw new Error('网页快照指纹无效')
}

function checkMessage(m: WebQaMessage) {
  if (!validId(m.id) || !validId(m.sessionId) || (m.role !== 'user' && m.role !== 'assistant')
    || typeof m.content !== 'string' || !statuses.has(m.status)
    || typeof m.error !== 'string' || typeof m.modelId !== 'string' || !validTime(m.createdAt)) throw new Error('网页问答消息无效')
}

const mapSummary = (r: SessionRow): WebQaSessionSummary => ({
  id: r.id, snapshotId: r.snapshot_id, finalUrl: r.final_url, title: r.title,
  capturedAt: r.captured_at, byteLength: r.byte_length, createdAt: r.created_at, updatedAt: r.updated_at,
})
const mapMessage = (r: MessageRow): WebQaMessage => ({
  id: r.id, sessionId: r.session_id, role: r.role, content: r.content, status: r.status,
  error: r.error, modelId: r.model_id, createdAt: r.created_at,
})

export function createWebQaRepository(db: Database.Database) {
  const pageForSnapshot = (snapshot: PreviewSnapshot): string => {
    const canonical = canonicalWebPageUrl(snapshot.finalUrl)
    const found = db.prepare('SELECT id FROM web_pages WHERE canonical_url=?').get(canonical) as { id: string } | undefined
    if (found) return found.id
    const id = randomUUID()
    db.prepare('INSERT INTO web_pages (id, canonical_url, title, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, canonical, snapshot.title, snapshot.capturedAt, snapshot.capturedAt)
    return id
  }

  const list = (): WebQaSessionSummary[] => (db.prepare(`
    SELECT s.*, p.final_url, p.title, p.captured_at, p.byte_length
    FROM web_qa_sessions s JOIN web_snapshots p ON p.id=s.snapshot_id
    ORDER BY s.updated_at DESC, s.id DESC
  `).all() as SessionRow[]).map(mapSummary)

  const get = (id: string): WebQaSessionDetail | null => {
    const row = db.prepare(`SELECT s.*, p.final_url, p.title, p.captured_at, p.byte_length
      FROM web_qa_sessions s JOIN web_snapshots p ON p.id=s.snapshot_id WHERE s.id=?`).get(id) as SessionRow | undefined
    if (!row) return null
    const source = db.prepare('SELECT * FROM web_snapshots WHERE id=?').get(row.snapshot_id) as SnapshotRow
    const messages = db.prepare('SELECT * FROM web_qa_messages WHERE session_id=? ORDER BY created_at, rowid').all(id) as MessageRow[]
    return { ...mapSummary(row), snapshot: {
      finalUrl: source.final_url, title: source.title, html: source.html,
      capturedAt: source.captured_at, contentHash: source.content_hash, byteLength: source.byte_length,
    }, messages: messages.map(mapMessage) }
  }

  const create = (input: WebQaCreateInput): WebQaSessionDetail => {
    if (!validId(input.sessionId) || !validId(input.messageId) || !validTime(input.createdAt)
      || typeof input.question !== 'string' || !input.question.trim()) throw new Error('网页问答会话无效')
    checkSnapshot(input.snapshot)
    db.transaction(() => {
      const s = input.snapshot
      const pageId = pageForSnapshot(s)
      db.prepare(`INSERT INTO web_snapshots
        (id, page_id, final_url, title, html, captured_at, content_hash, byte_length, preview_json, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?)`)
        .run(input.sessionId, pageId, s.finalUrl, s.title, s.html, s.capturedAt, s.contentHash, s.byteLength, s.capturedAt)
      db.prepare('INSERT INTO web_qa_sessions VALUES (?, ?, ?, ?)').run(input.sessionId, input.sessionId, input.createdAt, input.createdAt)
      db.prepare('INSERT INTO web_qa_messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(input.messageId, input.sessionId, 'user', input.question, 'completed', '', '', input.createdAt)
    })()
    return get(input.sessionId)!
  }

  const addMessage = (m: WebQaMessage): void => {
    checkMessage(m)
    db.prepare('INSERT INTO web_qa_messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(m.id, m.sessionId, m.role, m.content, m.status, m.error, m.modelId, m.createdAt)
    db.prepare('UPDATE web_qa_sessions SET updated_at=? WHERE id=?').run(m.createdAt, m.sessionId)
  }

  const updateMessage = (id: string, patch: WebQaMessagePatch): void => {
    const row = db.prepare('SELECT * FROM web_qa_messages WHERE id=?').get(id) as MessageRow | undefined
    if (!row) throw new Error('网页问答消息不存在')
    const merged = { ...mapMessage(row), ...patch }
    checkMessage(merged)
    db.prepare('UPDATE web_qa_messages SET content=?, status=?, error=?, model_id=? WHERE id=?')
      .run(merged.content, merged.status, merged.error, merged.modelId, id)
    db.prepare('UPDATE web_qa_sessions SET updated_at=? WHERE id=?').run(Date.now(), row.session_id)
  }

  const remove = (id: string): void => {
    db.transaction(() => {
      const row = db.prepare(`SELECT s.snapshot_id, p.page_id FROM web_qa_sessions s
        JOIN web_snapshots p ON p.id=s.snapshot_id WHERE s.id=?`).get(id) as { snapshot_id: string; page_id: string } | undefined
      if (!row) return
      db.prepare('DELETE FROM web_qa_sessions WHERE id=?').run(id)
      db.prepare('DELETE FROM web_snapshots WHERE id=?').run(row.snapshot_id)
      db.prepare('DELETE FROM web_pages WHERE id=? AND NOT EXISTS (SELECT 1 FROM web_snapshots WHERE page_id=?)')
        .run(row.page_id, row.page_id)
    })()
  }

  const exportBackup = (): WebQaBackup => ({
    snapshots: (db.prepare('SELECT * FROM web_snapshots').all() as SnapshotRow[]).map(r => ({
      id: r.id, finalUrl: r.final_url, title: r.title, html: r.html, capturedAt: r.captured_at,
      contentHash: r.content_hash, byteLength: r.byte_length,
    })),
    sessions: (db.prepare('SELECT * FROM web_qa_sessions').all() as Array<{ id: string; snapshot_id: string; created_at: number; updated_at: number }>).map(r => ({
      id: r.id, snapshotId: r.snapshot_id, createdAt: r.created_at, updatedAt: r.updated_at,
    })),
    messages: (db.prepare('SELECT * FROM web_qa_messages').all() as MessageRow[]).map(mapMessage),
  })

  const importBackup = (backup: WebQaBackup): void => {
    validateWebQaBackup(backup)
    db.transaction(() => {
      db.exec('DELETE FROM web_qa_messages; DELETE FROM web_qa_sessions; DELETE FROM web_snapshots;')
      for (const s of backup.snapshots) {
        const pageId = pageForSnapshot(s)
        db.prepare(`INSERT INTO web_snapshots
          (id, page_id, final_url, title, html, captured_at, content_hash, byte_length, preview_json, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?)`)
          .run(s.id, pageId, s.finalUrl, s.title, s.html, s.capturedAt, s.contentHash, s.byteLength, s.capturedAt)
      }
      for (const s of backup.sessions) db.prepare('INSERT INTO web_qa_sessions VALUES (?, ?, ?, ?)')
        .run(s.id, s.snapshotId, s.createdAt, s.updatedAt)
      for (const m of backup.messages) db.prepare('INSERT INTO web_qa_messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(m.id, m.sessionId, m.role, m.content, m.status, m.error, m.modelId, m.createdAt)
    })()
  }
  return { list, get, create, addMessage, updateMessage, remove, exportBackup, importBackup }
}
