import type Database from 'better-sqlite3'

export function migrateChatRuns(db: Database.Database): void {
  const columns = (db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map(row => row.name)
  if (!columns.includes('run_id')) db.exec("ALTER TABLE messages ADD COLUMN run_id TEXT DEFAULT ''")
  if (!columns.includes('run_status')) db.exec("ALTER TABLE messages ADD COLUMN run_status TEXT DEFAULT ''")
  // The renderer owns the request. A run still active when the app starts
  // cannot be resumed from its saved ID, but its partial answer remains.
  db.prepare("UPDATE messages SET run_status = 'interrupted' WHERE run_status IN ('preparing', 'streaming')").run()
}
