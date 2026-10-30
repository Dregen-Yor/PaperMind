import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { pathToFileURL } from 'node:url'
import { isTrustedApplicationFrame } from './ipcSecurity'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { kbApi, paperApi, chatApi, highlightApi, settingsApi, indexApi, treeApi, getDoclingRepository, getAbstractCheckpointRepository, getPaperAbstractRepository, getWebQaRepository, exportAll, clearAll, importAll } from './db'
import { createDoclingFacade } from './docling'
import { getDocumentSummaryRepository } from './db'
import { captureWebSummaryPdf } from './webSummaryCapture'
import { testDoclingConnection } from './doclingClient'
import { DOCLING_SETTINGS_KEY } from '../src/utils/doclingDocument'
import { backupFileName } from '../src/utils/exportSanitize'
import { clearPreviewData, previewControllerForSender } from './webPreview'
import { paperContentUrl } from './paperProtocol'
import type { IpcHandlers } from '../src/types/ipcContract'

// Register all IPC handlers. Each channel maps to a db api call.
// Renderer invokes via window.db.* (see preload.ts).
export function registerIpc() {
  const docling = createDoclingFacade({
    repository: getDoclingRepository(),
    getSettings: () => settingsApi.get(DOCLING_SETTINGS_KEY),
    readPaper: id => {
      const data = paperApi.readFile(id)
      return data ? { bytes: Buffer.from(data, 'base64'), name: paperApi.get(id)?.fileName || 'paper.pdf' } : null
    },
  })
  const abstractCheckpoint = getAbstractCheckpointRepository()
  const paperAbstract = getPaperAbstractRepository()
  const webQa = getWebQaRepository()
  const documentSummary = getDocumentSummaryRepository()
  const handlers = {
    'documentSummary:get': (_e, kind, sourceId, slot) => documentSummary.get(kind, sourceId, slot),
    'documentSummary:save': (_e, record) => documentSummary.save(record),
    'documentSummary:saveAsset': (_e, kind, sourceId, data) => documentSummary.saveAsset(kind, sourceId, data),
    'documentSummary:readAsset': (_e, id) => documentSummary.readAsset(id),
    'webQa:listPages': () => webQa.listPages(),
    'webQa:archive': (_e, snapshot, openedAt) => webQa.archive(snapshot, openedAt),
    'webQa:getPreview': (_e, id) => webQa.getPreview(id),
    'webQa:findAppearance': (_e, pageId, contentHash) => webQa.findAppearance(pageId, contentHash),
    'webQa:getSnapshot': (_e, id) => webQa.getSnapshot(id),
    'webQa:listSessions': (_e, pageId) => webQa.listSessions(pageId),
    'webQa:getSession': (_e, id) => webQa.getSession(id),
    'webQa:createSession': (_e, input) => webQa.createSession(input),
    'webQa:appendTurn': (_e, input) => webQa.appendTurn(input),
    'webQa:ensureAssistantForLastUser': (_e, sessionId, assistantId, modelId) => webQa.ensureAssistantForLastUser(sessionId, assistantId, modelId),
    'webQa:removeSession': (_e, id) => { webQa.removeSession(id) },
    'webQa:removePage': (_e, id) => { webQa.removePage(id) },
    'webQa:list': () => webQa.list(),
    'webQa:get': (_e, id) => webQa.get(id),
    'webQa:create': (_e, input) => webQa.create(input),
    'webQa:addMessage': (_e, message) => { webQa.addMessage(message) },
    'webQa:updateMessage': (_e, id, patch) => { webQa.updateMessage(id, patch) },
    'webQa:remove': (_e, id) => { webQa.remove(id) },
    'docling:convert': (_e, id) => docling.convert(id),
    'docling:save': (_e, id, record) => docling.save(id, record),
    'docling:readAsset': (_e, id) => docling.readAsset(id),
    'docling:testConnection': (_e, settings) => testDoclingConnection(settings),
    'abstractCheckpoint:get': (_e, paperId, runKey, stage, position) => abstractCheckpoint.get(paperId, runKey, stage, position),
    'abstractCheckpoint:save': (_e, paperId, runKey, stage, position, content) => abstractCheckpoint.save(paperId, runKey, stage, position, content),
    'paperAbstract:get': (_e, paperId) => paperAbstract.get(paperId),
    'paperAbstract:save': (_e, report) => paperAbstract.save(report),
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
    'paper:contentUrl': (_e, id: string) => paperApi.filePath(id) ? paperContentUrl(id) : null,
    'paper:restoreFile': (_e, id, fileData) => paperApi.restoreFile(id, fileData),
    // isolated HTML preview; only the registered application renderer may control it
    'preview:open': (e, url, bounds) => previewControllerForSender(e.sender).open(url, bounds),
    'preview:openAndCapture': (e, url, bounds) => previewControllerForSender(e.sender).openAndCapture(url, bounds),
    'preview:setBounds': (e, bounds) => previewControllerForSender(e.sender).setBounds(bounds),
    'preview:showCached': async (e, snapshotId, bounds) => {
      const controller = previewControllerForSender(e.sender)
      const archive = webQa.getArchive(snapshotId)
      if (!archive) {
        controller.close()
        return false
      }
      await controller.showCached(archive, bounds)
      return true
    },
    'preview:back': e => previewControllerForSender(e.sender).back(),
    'preview:forward': e => previewControllerForSender(e.sender).forward(),
    'preview:reload': e => previewControllerForSender(e.sender).reload(),
    'preview:close': e => previewControllerForSender(e.sender).close(),
    'preview:openExternal': (e, url) => previewControllerForSender(e.sender).openExternal(url),
    'preview:captureSnapshot': e => previewControllerForSender(e.sender).captureSnapshot(),
    'preview:summaryPdf': (e, snapshotId) => {
      previewControllerForSender(e.sender)
      if (typeof snapshotId !== 'string' || !snapshotId || snapshotId.length > 200) throw new Error('网页快照 ID 无效')
      const snapshot = webQa.getSnapshot(snapshotId)
      if (!snapshot) throw new Error('网页快照已不存在')
      return captureWebSummaryPdf(snapshot)
    },
    // chat
    'chat:listConversations': () => chatApi.listConversations(),
    'chat:createConversation': (_e, conv) => chatApi.createConversation(conv),
    'chat:updateConversation': (_e, id, patch) => chatApi.updateConversation(id, patch),
    'chat:removeConversation': (_e, id) => { chatApi.removeConversation(id) },
    'chat:addMessage': (_e, msg) => chatApi.addMessage(msg),
    'chat:updateMessage': (_e, id, patch) => chatApi.updateMessage(id, patch),
    // highlights
    'highlight:listByPaper': (_e, paperId) => highlightApi.listByPaper(paperId),
    'highlight:create': (_e, h) => highlightApi.create(h),
    'highlight:remove': (_e, id) => { highlightApi.remove(id) },
    'highlight:update': (_e, id, patch) => highlightApi.update(id, patch),
    // settings
    'settings:get': (_e, key) => settingsApi.get(key),
    'settings:set': (_e, key, value) => settingsApi.set(key, value),
    // data management
    'data:export': () => exportAll(),
    'data:export-file': async (_e, opts?: { includeApiKey?: boolean }) => {
      const { canceled, filePath } = await dialog.showSaveDialog({
        title: '导出备份',
        defaultPath: join(app.getPath('downloads'), backupFileName(new Date())),
        filters: [{ name: 'JSON', extensions: ['json'] }],
      })
      if (canceled || !filePath) return { canceled: true }
      writeFileSync(filePath, JSON.stringify(exportAll({ includeApiKey: !!opts?.includeApiKey }), null, 2))
      return { canceled: false, filePath }
    },
    'data:clear': async () => {
      clearAll()
      await clearPreviewData()
    },
    'data:import': (_e, data) => importAll(data),
    // paper indexes (PageIndex RAG)
    'index:list': () => indexApi.list(),
    'index:get': (_e, paperId) => indexApi.get(paperId),
    'index:set': (_e, paperId, indexJson, pagesJson) => indexApi.set(paperId, indexJson, pagesJson),
    // paper semantic trees (lightweight semantic index)
    'tree:list': (_e, filter) => treeApi.list(filter),
    'tree:get': (_e, paperId) => treeApi.get(paperId),
    'tree:set': (_e, paperId, record) => treeApi.set(paperId, record),
    'tree:remove': (_e, paperId) => { treeApi.remove(paperId) },
  } satisfies IpcHandlers<Electron.IpcMainInvokeEvent>

  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      const expected = !app.isPackaged && process.env.VITE_DEV_SERVER_URL
        ? process.env.VITE_DEV_SERVER_URL
        : pathToFileURL(join(app.getAppPath(), 'dist/index.html')).href
      if (!isTrustedApplicationFrame(event, BrowserWindow.getAllWindows().map(window => window.webContents), expected)) {
        throw new Error('拒绝来自非应用主页面的 IPC 调用')
      }
      return (fn as (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown)(event, ...args)
    })
  }
}
