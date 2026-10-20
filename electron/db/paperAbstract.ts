import type Database from 'better-sqlite3'
import { normalizeSourceList } from '../../src/utils/sourceRef'
import type { PaperAbstractReport } from '../../src/utils/paperAbstract'

/** Increment when report generation or evidence rules make older cached output unsafe to show. */
export const PAPER_ABSTRACT_PIPELINE_VERSION = 2

export function createPaperAbstractRepository(db: Database.Database) {
  const historicalAnswers = db.prepare(`
    SELECT m.content, m.sources, m.truncated, m.timestamp
    FROM messages m
    WHERE m.role = 'assistant' AND trim(m.content) <> '' AND coalesce(m.error, '') = ''
      AND (SELECT lower(trim(previous.content)) FROM messages previous
           WHERE previous.conversation_id = m.conversation_id AND previous.rowid < m.rowid
           ORDER BY previous.rowid DESC LIMIT 1) = '/abstract'
    ORDER BY m.timestamp DESC, m.rowid DESC
  `)

  return {
    get(paperId: string): PaperAbstractReport | null {
      const row = db.prepare('SELECT * FROM paper_abstracts WHERE paper_id = ?').get(paperId) as {
        paper_id: string; content: string; sources_json: string; truncated: number; updated_at: number; pipeline_version: number
      } | undefined
      if (!row) {
        if (!db.prepare('SELECT 1 FROM papers WHERE id = ?').get(paperId)) return null
        for (const answer of historicalAnswers.all() as Array<{ content: string; sources: string; truncated: number; timestamp: number }>) {
          let sources: ReturnType<typeof normalizeSourceList>
          try { sources = normalizeSourceList(JSON.parse(answer.sources)) } catch { continue }
          if (!sources.length || !sources.every(source => source.paperId === paperId)) continue
          return { paperId, content: answer.content, sources, truncated: !!answer.truncated, updatedAt: answer.timestamp }
        }
        return null
      }
      if (row.pipeline_version !== PAPER_ABSTRACT_PIPELINE_VERSION) return null
      let sources: unknown
      try { sources = JSON.parse(row.sources_json) } catch { sources = [] }
      return { paperId: row.paper_id, content: row.content, sources: normalizeSourceList(sources),
        truncated: !!row.truncated, updatedAt: row.updated_at }
    },
    save(report: Omit<PaperAbstractReport, 'updatedAt'>, pipelineVersion = PAPER_ABSTRACT_PIPELINE_VERSION): PaperAbstractReport {
      if (!report || typeof report.paperId !== 'string' || !report.paperId
        || typeof report.content !== 'string' || !report.content.trim() || report.content.length > 2_000_000
        || typeof report.truncated !== 'boolean' || !Array.isArray(report.sources)
        || ![0, PAPER_ABSTRACT_PIPELINE_VERSION].includes(pipelineVersion)) throw new Error('论文摘要内容无效')
      const sources = normalizeSourceList(report.sources)
      const updatedAt = Date.now()
      db.prepare(`INSERT INTO paper_abstracts (paper_id, content, sources_json, truncated, updated_at, pipeline_version)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(paper_id) DO UPDATE SET
        content=excluded.content, sources_json=excluded.sources_json,
        truncated=excluded.truncated, updated_at=excluded.updated_at, pipeline_version=excluded.pipeline_version`)
        .run(report.paperId, report.content, JSON.stringify(sources), report.truncated ? 1 : 0, updatedAt, pipelineVersion)
      return { ...report, sources, updatedAt }
    },
  }
}
