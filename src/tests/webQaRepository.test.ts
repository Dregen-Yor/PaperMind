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
    expect((db.prepare('SELECT COUNT(*) n FROM web_snapshots').get() as { n: number }).n).toBe(0)
    db.close()
  })

  it('exports and restores non-ASCII HTML and message status', () => {
    const source = setup()
    source.repo.create({ sessionId: 's1', messageId: 'm1', snapshot, question: '结论？', createdAt: 20 })
    source.repo.addMessage({ id: 'm2', sessionId: 's1', role: 'assistant', content: '', status: 'failed', error: '超出上下文', modelId: 'model-a', createdAt: 21 })
    const backup = source.repo.exportBackup()
    const target = setup()
    target.repo.importBackup(backup)
    expect(target.repo.get('s1')?.snapshot.html).toBe(html)
    expect(target.repo.get('s1')?.messages[1].status).toBe('failed')
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
