import Database from 'better-sqlite3'
import { createHash } from 'crypto'
import { describe, expect, it } from 'vitest'
import { SCHEMA } from '../../electron/db/schema'
import { createWebQaRepository } from '../../electron/db/webQa'
import { validateBackupInput } from '../../electron/db/backupValidation'

const html = '<!DOCTYPE html>\n<html><body>动态正文</body></html>'
const snapshot = {
  finalUrl: 'https://example.org/article', title: '测试文章', html,
  capturedAt: 10, byteLength: Buffer.byteLength(html, 'utf8'),
  contentHash: createHash('sha256').update(html).digest('hex'),
}

function setup() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
  return { db, repo: createWebQaRepository(db) }
}

describe('web QA repository', () => {
  it('archives a page before any dialogue, deduplicates its DOM, and versions changed content', () => {
    const { db, repo } = setup()
    const first = repo.archive({ ...snapshot, finalUrl: 'https://EXAMPLE.org/article#part' }, 100)
    expect(repo.listPages()).toHaveLength(1)
    expect(repo.listPages()[0]).not.toHaveProperty('html')
    expect(repo.listSessions(first.id)).toEqual([])
    const again = repo.archive({ ...snapshot, finalUrl: 'https://example.org/article' }, 200)
    expect(again.id).toBe(first.id)
    expect(again.latestSnapshotId).toBe(first.latestSnapshotId)
    expect(again.snapshotCount).toBe(1)
    const changedHtml = '<html><body><p>第二版正文</p></body></html>'
    const changed = repo.archive({ ...snapshot, html: changedHtml,
      byteLength: Buffer.byteLength(changedHtml, 'utf8'),
      contentHash: createHash('sha256').update(changedHtml).digest('hex') }, 300)
    expect(changed.snapshotCount).toBe(2)
    expect(changed.latestSnapshotId).not.toBe(first.latestSnapshotId)
    expect(repo.getPreview(first.latestSnapshotId)?.preview.blocks[0].text).toContain('动态正文')
    expect(repo.getSnapshot(first.latestSnapshotId)?.html).toBe(html)
    db.close()
  })

  it('shares one immutable snapshot across sessions and keeps it after deleting one session', () => {
    const { db, repo } = setup()
    const page = repo.archive(snapshot, 100)
    const first = repo.createSession({ sessionId: 's1', questionId: 'q1', assistantId: 'a1',
      snapshotId: page.latestSnapshotId, question: '第一问', createdAt: 110, modelId: 'model-a' })
    const second = repo.createSession({ sessionId: 's2', questionId: 'q2', assistantId: 'a2',
      snapshotId: page.latestSnapshotId, question: '第二问', createdAt: 120, modelId: 'model-a' })
    expect(first.snapshotId).toBe(second.snapshotId)
    expect(repo.listSessions(page.id).map(session => session.firstQuestion)).toEqual(['第二问', '第一问'])
    expect(repo.getSession('s1')?.messages.map(message => message.role)).toEqual(['user', 'assistant'])
    expect(repo.getSession('s1')).not.toHaveProperty('snapshot')
    repo.removeSession('s1')
    expect(repo.getSnapshot(page.latestSnapshotId)?.html).toBe(html)
    expect(repo.listSessions(page.id)).toHaveLength(1)
    repo.removePage(page.id)
    expect(repo.getSession('s2')).toBeNull()
    expect(repo.getSnapshot(page.latestSnapshotId)).toBeNull()
    db.close()
  })

  it('rolls back both rows when a later answer placeholder conflicts', () => {
    const { db, repo } = setup()
    const page = repo.archive(snapshot, 100)
    repo.createSession({ sessionId: 's1', questionId: 'q1', assistantId: 'a1',
      snapshotId: page.latestSnapshotId, question: '第一问', createdAt: 110, modelId: 'model-a' })
    expect(() => repo.appendTurn({ sessionId: 's1', questionId: 'q2', assistantId: 'a1',
      question: '第二问', createdAt: 120, modelId: 'model-a' })).toThrow()
    expect(repo.getSession('s1')?.messages.map(message => message.id)).toEqual(['q1', 'a1'])
    db.close()
  })

  it('legacy remove leaves sibling conversations on a shared snapshot intact', () => {
    const { db, repo } = setup()
    const page = repo.archive(snapshot, 100)
    for (const n of [1, 2]) repo.createSession({ sessionId: `s${n}`, questionId: `q${n}`,
      assistantId: `a${n}`, snapshotId: page.latestSnapshotId, question: `问题 ${n}`,
      createdAt: 110 + n, modelId: 'model-a' })
    repo.remove('s1')
    expect(repo.getSession('s2')?.messages[0].content).toBe('问题 2')
    expect(repo.getSnapshot(page.latestSnapshotId)).not.toBeNull()
    db.close()
  })
  it('creates one immutable snapshot with ordered messages and cascades removal', () => {
    const { db, repo } = setup()
    const session = repo.create({ sessionId: 's1', messageId: 'm1', snapshot, question: '结论？', createdAt: 20 })
    expect(session.snapshot.html).toBe(html)
    expect(repo.list()[0]).not.toHaveProperty('html')
    expect(repo.get('s1')?.messages.map(m => m.content)).toEqual(['结论？'])
    repo.addMessage({ id: 'm2', sessionId: 's1', role: 'assistant', content: '', status: 'streaming', error: '', modelId: '', createdAt: 21 })
    repo.updateMessage('m2', { content: '回答', status: 'completed', modelId: 'model-a' })
    expect(repo.get('s1')?.messages.map(m => m.content)).toEqual(['结论？', '回答'])
    expect(repo.get('s1')?.messages[1].modelId).toBe('model-a')
    expect(() => repo.create({ sessionId: 's2', messageId: 'm3', snapshot: { ...snapshot, html: '<html>变更</html>' }, question: '错？', createdAt: 22 })).toThrow()
    expect(repo.list()).toHaveLength(1)
    repo.remove('s1')
    expect(repo.list()).toEqual([])
    expect((db.prepare('SELECT COUNT(*) n FROM web_snapshots').get() as { n: number }).n).toBe(1)
    db.close()
  })

  it('exports and restores non-ASCII HTML and message status', () => {
    const source = setup()
    source.repo.create({ sessionId: 's1', messageId: 'm1', snapshot, question: '结论？', createdAt: 20 })
    source.repo.addMessage({ id: 'm2', sessionId: 's1', role: 'assistant', content: '', status: 'failed', error: '超出上下文', modelId: 'model-a', createdAt: 21 })
    const backup = source.repo.exportBackup()
    expect(backup.pages).toHaveLength(1)
    expect(backup.snapshots[0].pageId).toBe(backup.pages[0].id)
    const target = setup()
    target.repo.importBackup(backup)
    expect(target.repo.get('s1')?.snapshot.html).toBe(html)
    expect(target.repo.get('s1')?.messages[1].status).toBe('failed')
    source.db.close()
    target.db.close()
  })

  it('imports the old backup shape without page rows while keeping original IDs', () => {
    const source = setup()
    source.repo.create({ sessionId: 's1', messageId: 'm1', snapshot, question: '旧问题', createdAt: 20 })
    const old = source.repo.exportBackup() as any
    delete old.pages
    for (const row of old.snapshots) {
      delete row.pageId
      delete row.preview
      delete row.lastSeenAt
    }
    const target = setup()
    target.repo.importBackup(old)
    expect(target.repo.get('s1')?.messages[0].id).toBe('m1')
    expect(target.repo.listPages()[0].canonicalUrl).toBe(snapshot.finalUrl)
    source.db.close()
    target.db.close()
  })

  it('restores two cached versions with separate conversations under one page', () => {
    const source = setup()
    const first = source.repo.archive(snapshot, 100)
    source.repo.createSession({ sessionId: 's1', questionId: 'q1', assistantId: 'a1',
      snapshotId: first.latestSnapshotId, question: '初版？', createdAt: 110, modelId: 'model-a' })
    const nextHtml = '<html><body><main><p>修订后的内容</p></main></body></html>'
    const second = source.repo.archive({ ...snapshot, html: nextHtml,
      contentHash: createHash('sha256').update(nextHtml).digest('hex'),
      byteLength: Buffer.byteLength(nextHtml, 'utf8'), capturedAt: 200 }, 200)
    source.repo.createSession({ sessionId: 's2', questionId: 'q2', assistantId: 'a2',
      snapshotId: second.latestSnapshotId, question: '新版？', createdAt: 210, modelId: 'model-a' })
    const saved = source.repo.exportBackup()
    const target = setup()
    target.repo.importBackup(saved)
    expect(target.repo.listPages()).toHaveLength(1)
    expect(target.repo.listPages()[0].snapshotCount).toBe(2)
    expect(target.repo.listSessions(saved.pages[0].id).map(s => s.firstQuestion)).toEqual(['新版？', '初版？'])
    expect(target.repo.getSnapshot(saved.snapshots[0].id)?.html).toBe(html)
    expect(target.repo.getSnapshot(saved.snapshots[1].id)?.html).toBe(nextHtml)
    source.db.close()
    target.db.close()
  })

  it('rejects a malformed web-QA backup before existing data could be cleared', () => {
    const backup = {
      version: 1, knowledgeBases: [], papers: [], conversations: [], highlights: [],
      paperIndexes: [], paperTrees: [], paperAbstracts: [], settings: [],
      webQa: { snapshots: [], sessions: [{ id: 's1', snapshotId: 'missing', createdAt: 1, updatedAt: 1 }], messages: [] },
    }
    expect(() => validateBackupInput(backup)).toThrow('网页快照')
  })
})
