import { contextBridge, ipcRenderer } from 'electron'

// Typed wrapper around ipcRenderer.invoke. Each method maps to a handler in ipc.ts.
const db = {
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
  },
  chat: {
    listConversations: () => ipcRenderer.invoke('chat:listConversations'),
    createConversation: (conv: unknown) => ipcRenderer.invoke('chat:createConversation', conv),
    updateConversation: (id: string, patch: unknown) => ipcRenderer.invoke('chat:updateConversation', id, patch),
    removeConversation: (id: string) => ipcRenderer.invoke('chat:removeConversation', id),
    addMessage: (msg: unknown) => ipcRenderer.invoke('chat:addMessage', msg),
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

export type DbApi = typeof db
