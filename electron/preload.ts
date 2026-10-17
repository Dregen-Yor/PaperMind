import { contextBridge, ipcRenderer } from 'electron'
import type { PreviewBounds, PreviewState } from '../src/types/webPreview'
import type { DbApi, PreviewInvokeApi, TypedInvoke } from '../src/types/ipcContract'

const invoke: TypedInvoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args)

// Typed wrapper around ipcRenderer.invoke. Each method maps to a handler in ipc.ts.
const db: DbApi = {
  webQa: {
    listPages: () => invoke('webQa:listPages'),
    archive: (snapshot, openedAt) => invoke('webQa:archive', snapshot, openedAt),
    getPreview: id => invoke('webQa:getPreview', id),
    getSnapshot: id => invoke('webQa:getSnapshot', id),
    listSessions: pageId => invoke('webQa:listSessions', pageId),
    getSession: id => invoke('webQa:getSession', id),
    createSession: input => invoke('webQa:createSession', input),
    appendTurn: input => invoke('webQa:appendTurn', input),
    ensureAssistantForLastUser: (sessionId, assistantId, modelId) => invoke('webQa:ensureAssistantForLastUser', sessionId, assistantId, modelId),
    removeSession: id => invoke('webQa:removeSession', id),
    removePage: id => invoke('webQa:removePage', id),
    list: () => invoke('webQa:list'),
    get: id => invoke('webQa:get', id),
    create: input => invoke('webQa:create', input),
    addMessage: message => invoke('webQa:addMessage', message),
    updateMessage: (id, patch) => invoke('webQa:updateMessage', id, patch),
    remove: id => invoke('webQa:remove', id),
  },
  docling: {
    convert: (paperId: string) => invoke('docling:convert', paperId),
    save: (paperId, record) => invoke('docling:save', paperId, record),
    readAsset: (id: string) => invoke('docling:readAsset', id),
    testConnection: settings => invoke('docling:testConnection', settings),
  },
  abstractCheckpoint: {
    get: (paperId: string, runKey: string, stage: string, position: number) => invoke('abstractCheckpoint:get', paperId, runKey, stage, position),
    save: (paperId: string, runKey: string, stage: string, position: number, content: string) => invoke('abstractCheckpoint:save', paperId, runKey, stage, position, content),
  },
  paperAbstract: {
    get: (paperId: string) => invoke('paperAbstract:get', paperId),
    save: report => invoke('paperAbstract:save', report),
  },
  kb: {
    list: () => invoke('kb:list'),
    create: kb => invoke('kb:create', kb),
    remove: (id: string) => invoke('kb:remove', id),
  },
  paper: {
    list: () => invoke('paper:list'),
    get: (id: string) => invoke('paper:get', id),
    create: paper => invoke('paper:create', paper),
    update: (id, patch) => invoke('paper:update', id, patch),
    remove: (id: string) => invoke('paper:remove', id),
    readFile: (id: string) => invoke('paper:readFile', id),
    contentUrl: (id: string) => invoke('paper:contentUrl', id),
  },
  chat: {
    listConversations: () => invoke('chat:listConversations'),
    createConversation: conv => invoke('chat:createConversation', conv),
    updateConversation: (id, patch) => invoke('chat:updateConversation', id, patch),
    removeConversation: (id: string) => invoke('chat:removeConversation', id),
    addMessage: msg => invoke('chat:addMessage', msg),
    updateMessage: (id, patch) => invoke('chat:updateMessage', id, patch),
  },
  highlight: {
    listByPaper: (paperId: string) => invoke('highlight:listByPaper', paperId),
    create: h => invoke('highlight:create', h),
    remove: (id: string) => invoke('highlight:remove', id),
    update: (id, patch) => invoke('highlight:update', id, patch),
  },
  settings: {
    get: (key: string) => invoke('settings:get', key),
    set: (key: string, value: unknown) => invoke('settings:set', key, value),
  },
  data: {
    export: () => invoke('data:export'),
    exportFile: options => invoke('data:export-file', options),
    clear: () => invoke('data:clear'),
    import: (data: unknown) => invoke('data:import', data),
  },
  index: {
    list: () => invoke('index:list'),
    get: (paperId: string) => invoke('index:get', paperId),
    set: (paperId: string, indexJson: string, pagesJson: string) => invoke('index:set', paperId, indexJson, pagesJson),
  },
  tree: {
    list: filter => invoke('tree:list', filter),
    get: (paperId: string) => invoke('tree:get', paperId),
    set: (paperId, record) => invoke('tree:set', paperId, record),
    remove: (paperId: string) => invoke('tree:remove', paperId),
  },
}

contextBridge.exposeInMainWorld('db', db)

const preview: PreviewInvokeApi & { onState: (callback: (state: PreviewState) => void) => () => void } = {
  open: (url: string, bounds: PreviewBounds) => invoke('preview:open', url, bounds),
  openAndCapture: (url: string, bounds: PreviewBounds) => invoke('preview:openAndCapture', url, bounds),
  setBounds: (bounds: PreviewBounds) => invoke('preview:setBounds', bounds),
  back: () => invoke('preview:back'),
  forward: () => invoke('preview:forward'),
  reload: () => invoke('preview:reload'),
  close: () => invoke('preview:close'),
  openExternal: (url: string) => invoke('preview:openExternal', url),
  captureSnapshot: () => invoke('preview:captureSnapshot'),
  onState: (callback: (state: PreviewState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: PreviewState) => callback(state)
    ipcRenderer.on('preview:state', listener)
    return () => ipcRenderer.removeListener('preview:state', listener)
  },
}

contextBridge.exposeInMainWorld('preview', preview)
