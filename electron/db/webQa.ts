import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'crypto'
import type { PreviewSnapshot } from '../../src/types/webPreview'
import { canonicalWebPageUrl } from '../../src/utils/webPageUrl'
import type { WebPageSummary, WebQaAppendInput, WebQaBackup, WebQaCreateInput, WebQaMessage, WebQaMessagePatch, WebQaNewSessionInput, WebQaPageSessionSummary, WebQaSavedSession, WebQaSessionDetail, WebQaSessionSummary, WebReadPreview, WebSnapshotPreview } from '../../src/types/webQa'
import { normalizeWebQaBackup } from './backupValidation'
import { extractWebReadPreview } from '../../src/utils/webReadPreview'
import { archiveAppearanceHash } from './webArchiveHash'

type SessionRow = { id: string; snapshot_id: string; final_url: string; title: string; captured_at: number; byte_length: number; created_at: number; updated_at: number }
type SnapshotRow = { id: string; final_url: string; title: string; html: string; captured_at: number; content_hash: string; byte_length: number }
type MessageRow = { id: string; session_id: string; role: 'user' | 'assistant'; content: string; status: WebQaMessage['status']; error: string; model_id: string; created_at: number }
type PageRow = { id: string; canonical_url: string; title: string; created_at: number; last_opened_at: number; latest_snapshot_id: string; snapshot_count: number; session_count: number; total_bytes: number }
type PageSessionRow = SessionRow & { page_id: string; first_question: string }
type PreviewRow = SnapshotRow & { page_id: string; preview_json: string; has_original_appearance: number }
type BackupSnapshotRow = SnapshotRow & { page_id: string; preview_json: string; last_seen_at: number; archive_mhtml: Buffer | null }
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
  if (s.archiveMhtml !== undefined) {
    if (typeof s.archiveMhtml !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(s.archiveMhtml)
      || s.archiveMhtml.length % 4 !== 0 || Buffer.byteLength(s.archiveMhtml, 'base64') > 32 * 1024 * 1024
      || Buffer.from(s.archiveMhtml, 'base64').toString('base64') !== s.archiveMhtml) throw new Error('网页原貌缓存无效')
  }
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
const mapPage = (r: PageRow): WebPageSummary => ({
  id: r.id, canonicalUrl: r.canonical_url, title: r.title, createdAt: r.created_at,
  lastOpenedAt: r.last_opened_at, latestSnapshotId: r.latest_snapshot_id,
  snapshotCount: r.snapshot_count, sessionCount: r.session_count, totalBytes: r.total_bytes,
})
const mapPageSession = (r: PageSessionRow): WebQaPageSessionSummary => ({
  ...mapSummary(r), pageId: r.page_id, firstQuestion: r.first_question,
})

export function createWebQaRepository(db: Database.Database) {
  const pageSummaryQuery = `SELECT p.*,
    (SELECT id FROM web_snapshots WHERE page_id=p.id ORDER BY last_seen_at DESC, captured_at DESC, id DESC LIMIT 1) AS latest_snapshot_id,
    (SELECT COUNT(*) FROM web_snapshots WHERE page_id=p.id) AS snapshot_count,
    (SELECT COUNT(*) FROM web_qa_sessions s JOIN web_snapshots v ON v.id=s.snapshot_id WHERE v.page_id=p.id) AS session_count,
    (SELECT COALESCE(SUM(byte_length + COALESCE(length(archive_mhtml),0)),0) FROM web_snapshots WHERE page_id=p.id) AS total_bytes
    FROM web_pages p`
  const listPages = (): WebPageSummary[] => (db.prepare(`${pageSummaryQuery} ORDER BY p.last_opened_at DESC, p.id DESC`).all() as PageRow[]).map(mapPage)
  const getPage = (id: string): WebPageSummary | null => {
    const row = db.prepare(`${pageSummaryQuery} WHERE p.id=?`).get(id) as PageRow | undefined
    return row ? mapPage(row) : null
  }

  const archive = (snapshot: PreviewSnapshot, openedAt: number): WebPageSummary => {
    checkSnapshot(snapshot)
    if (!validTime(openedAt)) throw new Error('网页归档时间无效')
    const preview = extractWebReadPreview(snapshot.html)
    const canonical = canonicalWebPageUrl(snapshot.finalUrl)
    const pageId = db.transaction(() => {
      const current = db.prepare('SELECT id FROM web_pages WHERE canonical_url=?').get(canonical) as { id: string } | undefined
      const id = current?.id ?? randomUUID()
      if (current) {
        db.prepare('UPDATE web_pages SET title=?, last_opened_at=? WHERE id=?').run(snapshot.title, openedAt, id)
      } else {
        db.prepare('INSERT INTO web_pages (id, canonical_url, title, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?)')
          .run(id, canonical, snapshot.title, openedAt, openedAt)
      }
      const archiveBytes = snapshot.archiveMhtml ? Buffer.from(snapshot.archiveMhtml, 'base64') : null
      const appearanceHash = archiveBytes ? archiveAppearanceHash(archiveBytes) : ''
      const existing = db.prepare(`SELECT id FROM web_snapshots
        WHERE page_id=? AND content_hash=? AND appearance_hash=? ORDER BY captured_at DESC LIMIT 1`)
        .get(id, snapshot.contentHash, appearanceHash) as { id: string } | undefined
      if (existing) {
        db.prepare('UPDATE web_snapshots SET last_seen_at=? WHERE id=?').run(openedAt, existing.id)
      } else {
        db.prepare(`INSERT INTO web_snapshots
          (id, page_id, final_url, title, html, captured_at, content_hash, byte_length, preview_json, last_seen_at, archive_mhtml, appearance_hash)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), id, snapshot.finalUrl,
            snapshot.title, snapshot.html, snapshot.capturedAt, snapshot.contentHash,
            snapshot.byteLength, JSON.stringify(preview), openedAt,
            archiveBytes, appearanceHash)
      }
      return id
    })()
    return getPage(pageId)!
  }

  const getPreview = (snapshotId: string): WebSnapshotPreview | null => {
    const row = db.prepare(`SELECT id, page_id, final_url, title, captured_at,
      content_hash, byte_length, preview_json, archive_mhtml IS NOT NULL AS has_original_appearance
      FROM web_snapshots WHERE id=?`).get(snapshotId) as PreviewRow | undefined
    if (!row) return null
    let preview: WebReadPreview
    if (row.preview_json) {
      preview = JSON.parse(row.preview_json) as WebReadPreview
    } else {
      const html = (db.prepare('SELECT html FROM web_snapshots WHERE id=?').get(snapshotId) as { html: string }).html
      try { preview = extractWebReadPreview(html) }
      catch { preview = { blocks: [], truncated: false } }
      db.prepare('UPDATE web_snapshots SET preview_json=? WHERE id=?').run(JSON.stringify(preview), snapshotId)
    }
    return { id: row.id, pageId: row.page_id, finalUrl: row.final_url, title: row.title,
      capturedAt: row.captured_at, byteLength: row.byte_length, contentHash: row.content_hash,
      hasOriginalAppearance: !!row.has_original_appearance, preview }
  }

  const findAppearance = (pageId: string, contentHash: string): WebSnapshotPreview | null => {
    const row = db.prepare(`SELECT id FROM web_snapshots WHERE page_id=? AND content_hash=?
      AND archive_mhtml IS NOT NULL ORDER BY last_seen_at DESC, captured_at DESC, id DESC LIMIT 1`)
      .get(pageId, contentHash) as { id: string } | undefined
    return row ? getPreview(row.id) : null
  }

  const getArchive = (snapshotId: string): Buffer | null => {
    const row = db.prepare('SELECT archive_mhtml FROM web_snapshots WHERE id=?').get(snapshotId) as { archive_mhtml: Buffer | null } | undefined
    return row?.archive_mhtml ?? null
  }

  const getSnapshot = (snapshotId: string): PreviewSnapshot | null => {
    const row = db.prepare('SELECT * FROM web_snapshots WHERE id=?').get(snapshotId) as SnapshotRow | undefined
    return row ? { finalUrl: row.final_url, title: row.title, html: row.html,
      capturedAt: row.captured_at, contentHash: row.content_hash, byteLength: row.byte_length } : null
  }

  const pageSessionQuery = `SELECT s.*, v.page_id, v.final_url, v.title, v.captured_at, v.byte_length,
    COALESCE((SELECT content FROM web_qa_messages m WHERE m.session_id=s.id AND m.role='user'
      ORDER BY m.created_at, m.rowid LIMIT 1),'') AS first_question
    FROM web_qa_sessions s JOIN web_snapshots v ON v.id=s.snapshot_id`
  const listSessions = (pageId: string): WebQaPageSessionSummary[] =>
    (db.prepare(`${pageSessionQuery} WHERE v.page_id=? ORDER BY s.updated_at DESC, s.id DESC`).all(pageId) as PageSessionRow[])
      .map(mapPageSession)
  const getSession = (id: string): WebQaSavedSession | null => {
    const row = db.prepare(`${pageSessionQuery} WHERE s.id=?`).get(id) as PageSessionRow | undefined
    if (!row) return null
    const messages = db.prepare('SELECT * FROM web_qa_messages WHERE session_id=? ORDER BY created_at, rowid').all(id) as MessageRow[]
    return { ...mapPageSession(row), messages: messages.map(mapMessage) }
  }

  const insertTurn = (sessionId: string, questionId: string, assistantId: string,
    question: string, createdAt: number, modelId: string) => {
    if (!validId(sessionId) || !validId(questionId) || !validId(assistantId) || !validTime(createdAt)
      || typeof question !== 'string' || !question.trim() || typeof modelId !== 'string') {
      throw new Error('网页问答会话无效')
    }
    db.prepare('INSERT INTO web_qa_messages (id,session_id,role,content,status,error,model_id,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(questionId, sessionId, 'user', question.trim(), 'completed', '', '', createdAt)
    db.prepare('INSERT INTO web_qa_messages (id,session_id,role,content,status,error,model_id,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(assistantId, sessionId, 'assistant', '', 'streaming', '', modelId, createdAt + 1)
    db.prepare('UPDATE web_qa_sessions SET updated_at=? WHERE id=?').run(createdAt, sessionId)
  }

  const createSession = (input: WebQaNewSessionInput): WebQaSavedSession => {
    if (!validId(input.sessionId) || !validId(input.snapshotId)) throw new Error('网页问答会话无效')
    db.transaction(() => {
      db.prepare('INSERT INTO web_qa_sessions (id,snapshot_id,created_at,updated_at) VALUES (?,?,?,?)')
        .run(input.sessionId, input.snapshotId, input.createdAt, input.createdAt)
      insertTurn(input.sessionId, input.questionId, input.assistantId, input.question,
        input.createdAt, input.modelId)
    })()
    return getSession(input.sessionId)!
  }

  const appendTurn = (input: WebQaAppendInput): WebQaSavedSession => {
    db.transaction(() => {
      insertTurn(input.sessionId, input.questionId, input.assistantId, input.question,
        input.createdAt, input.modelId)
    })()
    return getSession(input.sessionId)!
  }

  const ensureAssistantForLastUser = (sessionId: string, assistantId: string, modelId: string): WebQaSavedSession => {
    if (!validId(sessionId) || !validId(assistantId) || typeof modelId !== 'string') throw new Error('网页问答会话无效')
    db.transaction(() => {
      const last = db.prepare('SELECT * FROM web_qa_messages WHERE session_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1')
        .get(sessionId) as MessageRow | undefined
      if (!last || last.role !== 'user') throw new Error('没有可重试的问题')
      db.prepare('INSERT INTO web_qa_messages (id,session_id,role,content,status,error,model_id,created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(assistantId, sessionId, 'assistant', '', 'interrupted', '上次回答未开始，请重试。', modelId, last.created_at + 1)
    })()
    return getSession(sessionId)!
  }

  const removeSession = (id: string): void => { db.prepare('DELETE FROM web_qa_sessions WHERE id=?').run(id) }
  const removePage = (id: string): void => { db.prepare('DELETE FROM web_pages WHERE id=?').run(id) }

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
        (id, page_id, final_url, title, html, captured_at, content_hash, byte_length, preview_json, last_seen_at, archive_mhtml, appearance_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)`)
        .run(input.sessionId, pageId, s.finalUrl, s.title, s.html, s.capturedAt, s.contentHash,
          s.byteLength, s.capturedAt, s.archiveMhtml ? Buffer.from(s.archiveMhtml, 'base64') : null,
          s.archiveMhtml ? archiveAppearanceHash(Buffer.from(s.archiveMhtml, 'base64')) : '')
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

  const remove = (id: string): void => { removeSession(id) }

  const exportBackup = (): WebQaBackup => ({
    pages: (db.prepare('SELECT * FROM web_pages').all() as PageRow[]).map(r => ({
      id: r.id, canonicalUrl: r.canonical_url, title: r.title,
      createdAt: r.created_at, lastOpenedAt: r.last_opened_at,
    })),
    snapshots: (db.prepare('SELECT * FROM web_snapshots').all() as BackupSnapshotRow[]).map(r => ({
      id: r.id, finalUrl: r.final_url, title: r.title, html: r.html, capturedAt: r.captured_at,
      contentHash: r.content_hash, byteLength: r.byte_length, pageId: r.page_id,
      archiveMhtml: r.archive_mhtml?.toString('base64'),
      lastSeenAt: r.last_seen_at,
      preview: r.preview_json ? JSON.parse(r.preview_json) as WebReadPreview : { blocks: [], truncated: false },
    })),
    sessions: (db.prepare('SELECT * FROM web_qa_sessions').all() as Array<{ id: string; snapshot_id: string; created_at: number; updated_at: number }>).map(r => ({
      id: r.id, snapshotId: r.snapshot_id, createdAt: r.created_at, updatedAt: r.updated_at,
    })),
    messages: (db.prepare('SELECT * FROM web_qa_messages').all() as MessageRow[]).map(mapMessage),
  })

  const importBackup = (input: unknown): void => {
    const backup = normalizeWebQaBackup(input)
    db.transaction(() => {
      db.exec('DELETE FROM web_qa_messages; DELETE FROM web_qa_sessions; DELETE FROM web_snapshots; DELETE FROM web_pages;')
      for (const p of backup.pages) db.prepare(`INSERT INTO web_pages
        (id, canonical_url, title, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?)`)
        .run(p.id, p.canonicalUrl, p.title, p.createdAt, p.lastOpenedAt)
      for (const s of backup.snapshots) {
        let preview: WebReadPreview
        try { preview = extractWebReadPreview(s.html) }
        catch { preview = { blocks: [], truncated: false } }
        db.prepare(`INSERT INTO web_snapshots
          (id, page_id, final_url, title, html, captured_at, content_hash, byte_length, preview_json, last_seen_at, archive_mhtml, appearance_hash)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(s.id, s.pageId, s.finalUrl, s.title, s.html, s.capturedAt, s.contentHash,
            s.byteLength, JSON.stringify(preview), s.lastSeenAt,
            s.archiveMhtml ? Buffer.from(s.archiveMhtml, 'base64') : null,
            s.archiveMhtml ? archiveAppearanceHash(Buffer.from(s.archiveMhtml, 'base64')) : '')
      }
      for (const s of backup.sessions) db.prepare('INSERT INTO web_qa_sessions VALUES (?, ?, ?, ?)')
        .run(s.id, s.snapshotId, s.createdAt, s.updatedAt)
      for (const m of backup.messages) db.prepare('INSERT INTO web_qa_messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(m.id, m.sessionId, m.role, m.content, m.status, m.error, m.modelId, m.createdAt)
    })()
  }
  return { listPages, archive, getPreview, findAppearance, getSnapshot, getArchive, listSessions, getSession,
    createSession, appendTurn, ensureAssistantForLastUser, removeSession, removePage,
    list, get, create, addMessage, updateMessage, remove, exportBackup, importBackup }
}
