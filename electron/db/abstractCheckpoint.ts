import type Database from 'better-sqlite3'

const RUN_KEY = /^[a-f0-9]{64}$/
const STAGE = /^(map|reduce-\d+|batch)$/
const MAX_CONTENT_CHARS = 100_000

function validate(paperId: string, runKey: string, stage: string, position: number) {
  if (typeof paperId !== 'string' || !paperId || !RUN_KEY.test(runKey) || !STAGE.test(stage)
    || !Number.isSafeInteger(position) || position < 0 || position > 10_000) throw new Error('摘要检查点参数无效')
}

export function createAbstractCheckpointRepository(db: Database.Database) {
  return {
    get(paperId: string, runKey: string, stage: string, position: number): string | null {
      validate(paperId, runKey, stage, position)
      const row = db.prepare('SELECT content FROM abstract_checkpoints WHERE paper_id = ? AND run_key = ? AND stage = ? AND position = ?')
        .get(paperId, runKey, stage, position) as { content: string } | undefined
      return row?.content ?? null
    },
    save(paperId: string, runKey: string, stage: string, position: number, content: string): void {
      validate(paperId, runKey, stage, position)
      if (typeof content !== 'string' || !content.trim() || content.length > MAX_CONTENT_CHARS) throw new Error('摘要检查点内容无效')
      db.prepare(`INSERT INTO abstract_checkpoints (paper_id, run_key, stage, position, content, updated_at)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(paper_id, run_key, stage, position)
        DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`)
        .run(paperId, runKey, stage, position, content, Date.now())
    },
  }
}
