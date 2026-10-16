import { contextBridge, ipcRenderer } from 'electron'
import type { PreviewBounds, PreviewState } from '../src/types/webPreview'

// Typed wrapper around ipcRenderer.invoke. Each method maps to a handler in ipc.ts.
const db = {
  docling: {
    convert: (paperId: string) => ipcRenderer.invoke('docling:convert', paperId),
    save: (paperId: string, record: unknown) => ipcRenderer.invoke('docling:save', paperId, record),
    readAsset: (id: string) => ipcRenderer.invoke('docling:readAsset', id),
    testConnection: (settings: unknown) => ipcRenderer.invoke('docling:testConnection', settings),
  },
  abstractCheckpoint: {
    get: (paperId: string, runKey: string, stage: string, position: number) => ipcRenderer.invoke('abstractCheckpoint:get', paperId, runKey, stage, position),
    save: (paperId: string, runKey: string, stage: string, position: number, content: string) => ipcRenderer.invoke('abstractCheckpoint:save', paperId, runKey, stage, position, content),
  },
  paperAbstract: {
    get: (paperId: string) => ipcRenderer.invoke('paperAbstract:get', paperId),
    save: (report: unknown) => ipcRenderer.invoke('paperAbstract:save', report),
  },
  kb: {
    list: () => ipcRenderer.invoke('kb:list'),
    create: (kb: unknown) => ipcRenderer.invoke('kb:create', kb),
    remove: (id: string) => ipcRenderer.invoke('kb:remove', id),
  },
  paper: {
    list: () => ipcRenderer.invoke('paper:list'),
    get: (id: string) => ipcRenderer.invoke('paper:get', id),
    create: (paper: unknown) => ipcRenderer.invoke('paper:create', paper),
    update: (id: string, patch: unknown) => ipcRenderer.invoke('paper:update', id, patch),
    remove: (id: string) => ipcRenderer.invoke('paper:remove', id),
    readFile: (id: string) => ipcRenderer.invoke('paper:readFile', id),
    contentUrl: (id: string) => ipcRenderer.invoke('paper:contentUrl', id),
  },
  chat: {
    listConversations: () => ipcRenderer.invoke('chat:listConversations'),
    createConversation: (conv: unknown) => ipcRenderer.invoke('chat:createConversation', conv),
    updateConversation: (id: string, patch: unknown) => ipcRenderer.invoke('chat:updateConversation', id, patch),
    removeConversation: (id: string) => ipcRenderer.invoke('chat:removeConversation', id),
    addMessage: (msg: unknown) => ipcRenderer.invoke('chat:addMessage', msg),
    updateMessage: (id: string, patch: unknown) => ipcRenderer.invoke('chat:updateMessage', id, patch),
  },
  highlight: {
    listByPaper: (paperId: string) => ipcRenderer.invoke('highlight:listByPaper', paperId),
    create: (h: unknown) => ipcRenderer.invoke('highlight:create', h),
    remove: (id: string) => ipcRenderer.invoke('highlight:remove', id),
    update: (id: string, patch: unknown) => ipcRenderer.invoke('highlight:update', id, patch),
  },
  settings: {
    get: (key: string) => ipcRenderer.invoke('settings:get', key),
    set: (key: string, value: unknown) => ipcRenderer.invoke('settings:set', key, value),
  },
  data: {
    export: () => ipcRenderer.invoke('data:export'),
    exportFile: (options: unknown) => ipcRenderer.invoke('data:export-file', options),
    clear: () => ipcRenderer.invoke('data:clear'),
    import: (data: unknown) => ipcRenderer.invoke('data:import', data),
  },
  index: {
    list: () => ipcRenderer.invoke('index:list'),
    get: (paperId: string) => ipcRenderer.invoke('index:get', paperId),
    set: (paperId: string, indexJson: string, pagesJson: string) => ipcRenderer.invoke('index:set', paperId, indexJson, pagesJson),
  },
  tree: {
    list: (filter?: unknown) => ipcRenderer.invoke('tree:list', filter),
    get: (paperId: string) => ipcRenderer.invoke('tree:get', paperId),
    set: (paperId: string, record: unknown) => ipcRenderer.invoke('tree:set', paperId, record),
    remove: (paperId: string) => ipcRenderer.invoke('tree:remove', paperId),
  },
}

contextBridge.exposeInMainWorld('db', db)

const preview = {
  open: (url: string, bounds: PreviewBounds) => ipcRenderer.invoke('preview:open', url, bounds),
  setBounds: (bounds: PreviewBounds) => ipcRenderer.invoke('preview:setBounds', bounds),
  back: () => ipcRenderer.invoke('preview:back'),
  forward: () => ipcRenderer.invoke('preview:forward'),
  reload: () => ipcRenderer.invoke('preview:reload'),
  close: () => ipcRenderer.invoke('preview:close'),
  openExternal: (url: string) => ipcRenderer.invoke('preview:openExternal', url),
  onState: (callback: (state: PreviewState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: PreviewState) => callback(state)
    ipcRenderer.on('preview:state', listener)
    return () => ipcRenderer.removeListener('preview:state', listener)
  },
}

contextBridge.exposeInMainWorld('preview', preview)

export type DbApi = typeof db
