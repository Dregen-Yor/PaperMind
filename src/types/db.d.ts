import type { DbApi } from './ipcContract'

export type { DbApi, PaperTreeRecord, PaperTreeRecordInput } from './ipcContract'
export type { WebPageSummary, WebSnapshotPreview, WebQaMessage, WebQaPageSessionSummary, WebQaSavedSession, WebQaSessionDetail, WebQaSessionSummary } from './webQa'

declare global {
  interface Window {
    db: DbApi
  }
}

export {}
