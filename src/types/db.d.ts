// Renderer-side type declaration for the db API exposed via preload contextBridge.
export interface DbApi {
  kb: {
    list: () => Promise<any[]>
    create: (kb: any) => Promise<any>
    remove: (id: string) => Promise<void>
  }
  paper: {
    list: () => Promise<any[]>
    get: (id: string) => Promise<any | null>
    create: (paper: any) => Promise<any>
    update: (id: string, patch: any) => Promise<void>
    remove: (id: string) => Promise<void>
    readFile: (id: string) => Promise<string | null>
  }
  chat: {
    listConversations: () => Promise<any[]>
    createConversation: (conv: any) => Promise<any>
    updateConversation: (id: string, patch: any) => Promise<void>
    removeConversation: (id: string) => Promise<void>
    addMessage: (msg: any) => Promise<void>
    updateMessage: (id: string, patch: any) => Promise<void>
  }
  highlight: {
    listByPaper: (paperId: string) => Promise<any[]>
    create: (h: any) => Promise<any>
    remove: (id: string) => Promise<void>
    update: (id: string, patch: any) => Promise<void>
  }
  settings: {
    get: (key: string) => Promise<any | null>
    set: (key: string, value: any) => Promise<void>
  }
  data: {
    export: () => Promise<any>
    /** 主进程弹系统保存对话框写盘；默认不含明文 API Key（#5）。 */
    exportFile: (options: { includeApiKey?: boolean }) => Promise<{ canceled: boolean; filePath?: string }>
    clear: () => Promise<void>
    import: (data: any) => Promise<void>
  }
  index: {
    list: () => Promise<string[]>
    get: (paperId: string) => Promise<{ indexJson: string; pagesJson: string } | null>
    set: (paperId: string, indexJson: string, pagesJson: string) => Promise<void>
  }
  tree: {
    /** 传 filter 时只返回当前建树配置下可直接复用的论文 id（不拖 tree_json 过 IPC）。 */
    list: (filter?: { schemaVersion: number; buildConfigHash: string }) => Promise<string[]>
    get: (paperId: string) => Promise<PaperTreeRecord | null>
    set: (paperId: string, record: PaperTreeRecordInput) => Promise<void>
    remove: (paperId: string) => Promise<void>
  }
}

/** 轻量语义树的持久化记录（主进程 snake_case → 渲染层 camelCase）。 */
export interface PaperTreeRecord extends PaperTreeRecordInput {
  paperId: string
  /** 由主进程写入 */
  createdAt: number
}

export interface PaperTreeRecordInput {
  treeJson: string
  blocksJson: string
  schemaVersion: number
  promptVersion: string
  buildModel: string
  sourceHash: string
  /** 建树配置指纹（schema / 提示词 / 模型端点 / 分块与输入上限），见 `semanticTreeConfigHash` */
  buildConfigHash: string
  inputTokens: number
  outputTokens: number
  buildLatencyMs: number
}

declare global {
  interface Window {
    db: DbApi
  }
}

export {}
