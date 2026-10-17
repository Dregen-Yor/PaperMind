import type { DbApi } from './ipcContract'

export type { DbApi, PaperTreeRecord, PaperTreeRecordInput } from './ipcContract'
export type { WebQaMessage, WebQaSessionDetail, WebQaSessionSummary } from './webQa'

declare global {
  interface Window {
    db: DbApi
  }
}

export {}
