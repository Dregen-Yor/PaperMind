// @vitest-environment node
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { SCHEMA } from '../../electron/db/schema'
import { createPaperAbstractRepository } from '../../electron/db/paperAbstract'

describe('saved paper abstracts', () => {
  it('stores one report per paper, updates it and deletes it with the paper', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    db.exec(SCHEMA)
    db.prepare('INSERT INTO knowledge_bases (id,name,created_at) VALUES (?,?,?)').run('kb', 'Library', 0)
    db.prepare('INSERT INTO papers (id,knowledge_base_id,file_name,file_path,added_at) VALUES (?,?,?,?,?)').run('paper', 'kb', 'p.pdf', '/tmp/p.pdf', 0)
    try {
      const repo = createPaperAbstractRepository(db)
      expect(repo.get('paper')).toBeNull()
      const first = repo.save({ paperId: 'paper', content: '# Initial', sources: [{ label: '图1', paperId: 'paper', startPage: 2 }], truncated: true })
      expect(repo.get('paper')).toEqual(first)
      const final = repo.save({ paperId: 'paper', content: '# Complete', sources: first.sources, truncated: false })
      expect(repo.get('paper')).toEqual(final)
      expect(db.prepare('SELECT COUNT(*) AS count FROM paper_abstracts').get()).toEqual({ count: 1 })
      db.prepare('DELETE FROM papers WHERE id = ?').run('paper')
      expect(repo.get('paper')).toBeNull()
    } finally { db.close() }
  })

  it('shows an existing single-paper /abstract answer when no dedicated report exists', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    db.exec(SCHEMA)
    db.prepare('INSERT INTO knowledge_bases (id,name,created_at) VALUES (?,?,?)').run('kb', 'Library', 0)
    db.prepare('INSERT INTO papers (id,knowledge_base_id,file_name,file_path,added_at) VALUES (?,?,?,?,?)').run('paper', 'kb', 'p.pdf', '/tmp/p.pdf', 0)
    db.prepare('INSERT INTO conversations (id,title,paper_ids,created_at) VALUES (?,?,?,?)').run('conv', '问答', '["paper"]', 0)
    const addMessage = db.prepare('INSERT INTO messages (id,conversation_id,role,content,sources,error,timestamp) VALUES (?,?,?,?,?,?,?)')
    addMessage.run('user', 'conv', 'user', '/abstract', '[]', '', 1)
    addMessage.run('answer', 'conv', 'assistant', '# Existing report', JSON.stringify([{ label: '文1', paperId: 'paper', startPage: 0 }]), '', 2)
    addMessage.run('question', 'conv', 'user', '普通问题', '[]', '', 3)
    addMessage.run('ordinary-answer', 'conv', 'assistant', '普通回答', '[]', '', 4)
    try {
      expect(createPaperAbstractRepository(db).get('paper')).toEqual({
        paperId: 'paper', content: '# Existing report',
        sources: [{ label: '文1', paperId: 'paper', startPage: 0 }],
        truncated: false, updatedAt: 2,
      })
      expect(db.prepare('SELECT COUNT(*) AS count FROM paper_abstracts').get()).toEqual({ count: 0 })
    } finally { db.close() }
  })

  it('hides an unversioned cached report until a current report replaces it', () => {
    const db = new Database(':memory:')
    db.exec(SCHEMA)
    if (!(db.prepare('PRAGMA table_info(paper_abstracts)').all() as Array<{ name: string }>).some(column => column.name === 'pipeline_version'))
      db.exec('ALTER TABLE paper_abstracts ADD COLUMN pipeline_version INTEGER NOT NULL DEFAULT 0')
    db.prepare('INSERT INTO knowledge_bases (id,name,created_at) VALUES (?,?,?)').run('kb', 'Library', 0)
    db.prepare('INSERT INTO papers (id,knowledge_base_id,file_name,file_path,added_at) VALUES (?,?,?,?,?)').run('paper', 'kb', 'p.pdf', '/tmp/p.pdf', 0)
    db.prepare('INSERT INTO paper_abstracts (paper_id,content,sources_json,truncated,updated_at) VALUES (?,?,?,?,?)')
      .run('paper', '# Old report with icons', '[]', 0, 1)
    try {
      const repo = createPaperAbstractRepository(db)
      expect(repo.get('paper')).toBeNull()
      const fresh = repo.save({ paperId: 'paper', content: '# New filtered report', sources: [], truncated: false })
      expect(repo.get('paper')).toEqual(fresh)
    } finally { db.close() }
  })

  it('does not treat a multi-paper or failed /abstract answer as this paper’s cache', () => {
    const db = new Database(':memory:')
    db.exec(SCHEMA)
    db.prepare('INSERT INTO knowledge_bases (id,name,created_at) VALUES (?,?,?)').run('kb', 'Library', 0)
    db.prepare('INSERT INTO papers (id,knowledge_base_id,file_name,file_path,added_at) VALUES (?,?,?,?,?)').run('paper', 'kb', 'p.pdf', '/tmp/p.pdf', 0)
    db.prepare('INSERT INTO conversations (id,title,paper_ids,created_at) VALUES (?,?,?,?)').run('multi', '问答', '["paper","other"]', 0)
    db.prepare('INSERT INTO conversations (id,title,paper_ids,created_at) VALUES (?,?,?,?)').run('failed', '问答', '["paper"]', 0)
    const addMessage = db.prepare('INSERT INTO messages (id,conversation_id,role,content,sources,error,timestamp) VALUES (?,?,?,?,?,?,?)')
    addMessage.run('u1', 'multi', 'user', '/abstract', '[]', '', 1)
    addMessage.run('a1', 'multi', 'assistant', '# Combined', JSON.stringify([
      { label: '文1', paperId: 'paper' }, { label: '文2' },
    ]), '', 2)
    addMessage.run('u2', 'failed', 'user', '/abstract', '[]', '', 3)
    addMessage.run('a2', 'failed', 'assistant', '# Failure', '[]', 'request failed', 4)
    try { expect(createPaperAbstractRepository(db).get('paper')).toBeNull() } finally { db.close() }
  })
})
