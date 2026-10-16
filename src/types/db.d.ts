import type { DbApi } from './ipcContract'

export type { DbApi, PaperTreeRecord, PaperTreeRecordInput } from './ipcContract'

declare global {
  interface Window {
    db: DbApi
  }
}

export {}
