import type { DoclingRecord, DoclingSettings } from '../utils/doclingDocument'
import type { PaperAbstractReport } from '../utils/paperAbstract'
import type { ChatMessageWrite, ChatMessagePatch } from './chatRun'
import type { PreviewBounds, PreviewSnapshot } from './webPreview'
import type { Conversation } from './chat'
import type { WebPageSummary, WebQaAppendInput, WebQaCreateInput, WebQaMessage, WebQaMessagePatch, WebQaNewSessionInput, WebQaPageSessionSummary, WebQaSavedSession, WebQaSessionDetail, WebQaSessionSummary, WebSnapshotPreview } from './webQa'
import type { Paper, KnowledgeBase, Highlight } from './paper'

export type PaperCreateInput = Paper & { fileData: string }
export type ChatConversationWrite = Omit<Conversation, 'messages'>

// One contract for renderer callers, preload wrappers, and main handlers.
export interface DbApi {
  webQa: {
    listPages: () => Promise<WebPageSummary[]>
    archive: (snapshot: PreviewSnapshot, openedAt: number) => Promise<WebPageSummary>
    getPreview: (snapshotId: string) => Promise<WebSnapshotPreview | null>
    getSnapshot: (snapshotId: string) => Promise<PreviewSnapshot | null>
    listSessions: (pageId: string) => Promise<WebQaPageSessionSummary[]>
    getSession: (id: string) => Promise<WebQaSavedSession | null>
    createSession: (input: WebQaNewSessionInput) => Promise<WebQaSavedSession>
    appendTurn: (input: WebQaAppendInput) => Promise<WebQaSavedSession>
    ensureAssistantForLastUser: (sessionId: string, assistantId: string, modelId: string) => Promise<WebQaSavedSession>
    removeSession: (id: string) => Promise<void>
    removePage: (id: string) => Promise<void>
    list: () => Promise<WebQaSessionSummary[]>
    get: (id: string) => Promise<WebQaSessionDetail | null>
    create: (input: WebQaCreateInput) => Promise<WebQaSessionDetail>
    addMessage: (message: WebQaMessage) => Promise<void>
    updateMessage: (id: string, patch: WebQaMessagePatch) => Promise<void>
    remove: (id: string) => Promise<void>
  }
  docling: {
    convert: (paperId: string) => Promise<DoclingRecord>
    save: (paperId: string, record: DoclingRecord) => Promise<DoclingRecord>
    readAsset: (id: string) => Promise<string | null>
    testConnection: (settings: DoclingSettings) => Promise<string>
  }
  abstractCheckpoint: {
    get: (paperId: string, runKey: string, stage: string, position: number) => Promise<string | null>
    save: (paperId: string, runKey: string, stage: string, position: number, content: string) => Promise<void>
  }
  paperAbstract: {
    get: (paperId: string) => Promise<PaperAbstractReport | null>
    save: (report: Omit<PaperAbstractReport, 'updatedAt'>) => Promise<PaperAbstractReport>
  }
  kb: {
    list: () => Promise<KnowledgeBase[]>
    create: (kb: KnowledgeBase) => Promise<KnowledgeBase>
    remove: (id: string) => Promise<void>
  }
  paper: {
    list: () => Promise<Paper[]>
    get: (id: string) => Promise<Paper | null>
    create: (paper: PaperCreateInput) => Promise<PaperCreateInput & { filePath: string }>
    update: (id: string, patch: Partial<Paper>) => Promise<void>
    remove: (id: string) => Promise<void>
    readFile: (id: string) => Promise<string | null>
    contentUrl: (id: string) => Promise<string | null>
  }
  chat: {
    listConversations: () => Promise<Conversation[]>
    createConversation: (conv: ChatConversationWrite) => Promise<Conversation>
    updateConversation: (id: string, patch: Partial<Pick<Conversation, 'title' | 'paperIds'>>) => Promise<void>
    removeConversation: (id: string) => Promise<void>
    addMessage: (msg: ChatMessageWrite) => Promise<void>
    updateMessage: (id: string, patch: ChatMessagePatch) => Promise<void>
  }
  highlight: {
    listByPaper: (paperId: string) => Promise<Highlight[]>
    create: (h: Highlight) => Promise<Highlight>
    remove: (id: string) => Promise<void>
    update: (id: string, patch: Partial<Pick<Highlight, 'note'>>) => Promise<void>
  }
  settings: {
    get: (key: string) => Promise<any | null>
    set: (key: string, value: unknown) => Promise<void>
  }
  data: {
    export: () => Promise<unknown>
    /** 主进程弹系统保存对话框写盘；默认不含明文 API Key（#5）。 */
    exportFile: (options: { includeApiKey?: boolean }) => Promise<{ canceled: boolean; filePath?: string }>
    clear: () => Promise<void>
    import: (data: unknown) => Promise<void>
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

export interface PreviewInvokeApi {
  open: (url: string, bounds: PreviewBounds) => Promise<void>
  setBounds: (bounds: PreviewBounds) => Promise<void>
  back: () => Promise<void>
  forward: () => Promise<void>
  reload: () => Promise<void>
  close: () => Promise<void>
  openExternal: (url: string) => Promise<void>
  captureSnapshot: () => Promise<PreviewSnapshot>
}

type IpcSurface = DbApi & { preview: PreviewInvokeApi }
type Namespace = keyof IpcSurface & string
type Method<N extends Namespace> = keyof IpcSurface[N] & string
type ChannelName<N extends Namespace, M extends Method<N>> = `${N}:${M extends 'exportFile' ? 'export-file' : M}`

export type IpcChannel = {
  [N in Namespace]: { [M in Method<N>]: ChannelName<N, M> }[Method<N>]
}[Namespace]

type ChannelFunction<C extends IpcChannel> = C extends `${infer N}:${infer M}`
  ? N extends Namespace
    ? (M extends 'export-file' ? 'exportFile' : M) extends infer K
      ? K extends Method<N> ? IpcSurface[N][K] : never
      : never
    : never
  : never

export type IpcArgs<C extends IpcChannel> = ChannelFunction<C> extends (...args: infer A) => Promise<unknown> ? A : never
export type IpcResult<C extends IpcChannel> = ChannelFunction<C> extends (...args: never[]) => Promise<infer R> ? R : never
export type TypedInvoke = <C extends IpcChannel>(channel: C, ...args: IpcArgs<C>) => Promise<IpcResult<C>>
export type IpcHandlers<Event> = {
  [C in IpcChannel]: (event: Event, ...args: IpcArgs<C>) => IpcResult<C> | Promise<IpcResult<C>>
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
