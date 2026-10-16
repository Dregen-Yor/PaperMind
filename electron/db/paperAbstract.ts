import type Database from 'better-sqlite3'
import { normalizeSourceList } from '../../src/utils/sourceRef'
import type { PaperAbstractReport } from '../../src/utils/paperAbstract'

/** Increment when report generation or evidence rules make older cached output unsafe to show. */
export const PAPER_ABSTRACT_PIPELINE_VERSION = 2

export function createPaperAbstractRepository(db: Database.Database) {
  return {
    get(paperId: string): PaperAbstractReport | null {
      const row = db.prepare('SELECT * FROM paper_abstracts WHERE paper_id = ?').get(paperId) as {
        paper_id: string; content: string; sources_json: string; truncated: number; updated_at: number; pipeline_version: number
      } | undefined
      if (!row || row.pipeline_version !== PAPER_ABSTRACT_PIPELINE_VERSION) return null
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
