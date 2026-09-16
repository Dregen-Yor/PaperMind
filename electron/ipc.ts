import { ipcMain } from 'electron'
import { kbApi, paperApi, chatApi, highlightApi, settingsApi, indexApi, treeApi, exportAll, clearAll, importAll } from './db'

// Register all IPC handlers. Each channel maps to a db api call.
// Renderer invokes via window.db.* (see preload.ts).
export function registerIpc() {
  const handlers: Record<string, (...args: any[]) => any> = {
    // knowledge bases
    'kb:list': () => kbApi.list(),
    'kb:create': (_e, kb) => kbApi.create(kb),
    'kb:remove': (_e, id) => kbApi.remove(id),
    // papers
    'paper:list': () => paperApi.list(),
    'paper:get': (_e, id) => paperApi.get(id),
    'paper:create': (_e, paper) => paperApi.create(paper),
    'paper:update': (_e, id, patch) => paperApi.update(id, patch),
    'paper:remove': (_e, id) => paperApi.remove(id),
    'paper:readFile': (_e, id) => paperApi.readFile(id),
    // chat
    'chat:listConversations': () => chatApi.listConversations(),
    'chat:createConversation': (_e, conv) => chatApi.createConversation(conv),
    'chat:updateConversation': (_e, id, patch) => chatApi.updateConversation(id, patch),
    'chat:removeConversation': (_e, id) => chatApi.removeConversation(id),
    'chat:addMessage': (_e, msg) => chatApi.addMessage(msg),
    // highlights
    'highlight:listByPaper': (_e, paperId) => highlightApi.listByPaper(paperId),
    'highlight:create': (_e, h) => highlightApi.create(h),
    'highlight:remove': (_e, id) => highlightApi.remove(id),
    'highlight:update': (_e, id, patch) => highlightApi.update(id, patch),
    // settings
    'settings:get': (_e, key) => settingsApi.get(key),
    'settings:set': (_e, key, value) => settingsApi.set(key, value),
    // data management
    'data:export': () => exportAll(),
    'data:clear': () => clearAll(),
    'data:import': (_e, data) => importAll(data),
    // paper indexes (PageIndex RAG)
    'index:list': () => indexApi.list(),
    'index:get': (_e, paperId) => indexApi.get(paperId),
    'index:set': (_e, paperId, indexJson, pagesJson) => indexApi.set(paperId, indexJson, pagesJson),
    // paper semantic trees (lightweight semantic index)
    'tree:list': (_e, filter) => treeApi.list(filter),
    'tree:get': (_e, paperId) => treeApi.get(paperId),
    'tree:set': (_e, paperId, record) => treeApi.set(paperId, record),
    'tree:remove': (_e, paperId) => treeApi.remove(paperId),
  }

  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.handle(channel, fn)
  }
}
