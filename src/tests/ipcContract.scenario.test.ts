// @vitest-environment node
import { afterAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import Database from 'better-sqlite3'
import { createHash } from 'crypto'

const appPath = vi.hoisted(() => ({
  userData: '',
  frame: { url: 'file:///app/dist/index.html#/reader/a' },
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  browserData: new Map<string, { cache: string[]; storage: string[]; codeCache: string[] }>(),
}))
vi.mock('electron', () => ({
  app: { getPath: () => appPath.userData, getAppPath: () => '/app', isPackaged: true },
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => appPath.handlers.set(channel, handler) },
  BrowserWindow: { getAllWindows: () => [{ webContents: trustedSender }] },
  session: {
    fromPartition: (partition: string) => ({
      clearCache: async () => { appPath.browserData.get(partition)!.cache = [] },
      clearStorageData: async () => { appPath.browserData.get(partition)!.storage = [] },
      clearCodeCaches: async () => { appPath.browserData.get(partition)!.codeCache = [] },
    }),
  },
}))

import { clearAll, exportAll, getWebQaRepository, getDocumentSummaryRepository, importAll, initDb, paperApi } from '../../electron/db'
import { registerIpc } from '../../electron/ipc'

const trustedSender = { mainFrame: appPath.frame }
const trustedEvent = { sender: trustedSender, senderFrame: appPath.frame }

const taskRoot = mkdtempSync(join(tmpdir(), 'papermind-ipc-contract-'))
appPath.userData = join(taskRoot, 'user-data')
mkdirSync(appPath.userData, { recursive: true })
afterAll(() => rmSync(taskRoot, { recursive: true, force: true }))

function backup(paperId: string) {
  return {
    version: 1,
    knowledgeBases: [{ id: 'default', name: '默认知识库', description: '', color: '#409EFF', created_at: 1 }],
    papers: [{
      id: paperId, knowledgeBaseId: 'default', title: 'A paper', authors: [], abstract: '',
      year: 2026, tags: [], status: 'unread', fileName: 'paper.pdf', addedAt: 1,
      fileData: Buffer.from('%PDF-1.7\nscenario').toString('base64'),
    }],
    conversations: [{
      id: 'conversation-1', title: 'Scenario', paperIds: [paperId], createdAt: 2,
      messages: [{
        id: 'message-1', role: 'assistant', content: '已经生成的前半段。', sources: [], timestamp: 3,
        runId: 'run-1', runStatus: 'cancelled',
      }],
    }],
    highlights: [], paperIndexes: [], paperTrees: [], docling: null, paperAbstracts: [], settings: [],
  }
}

describe('same backup import task before and after IPC boundary changes', () => {
  it('records the result of a valid import and a malformed follow-up import', () => {
    initDb()
    importAll(backup('paper-1'))
    const first = exportAll()
    const importedMessage = first.conversations[0]?.messages[0]
    expect(first.knowledgeBases[0].createdAt).toBe(1)

    let malformedRejected = false
    try { importAll(backup('../escape')) }
    catch { malformedRejected = true }
    const second = exportAll()
    const result = {
      runIdPreserved: importedMessage?.runId === 'run-1',
      runStatusPreserved: importedMessage?.runStatus === 'cancelled',
      malformedRejected,
      outsideWrite: existsSync(join(appPath.userData, 'escape.pdf')),
      previousPaperRetained: second.papers.some((paper: { id: string }) => paper.id === 'paper-1'),
    }
    console.log(`IPC_CONTRACT_RESULT=${JSON.stringify(result)}`)
    expect(result).toEqual({
      runIdPreserved: true,
      runStatusPreserved: true,
      malformedRejected: true,
      outsideWrite: false,
      previousPaperRetained: true,
    })
  })

  it('round-trips web QA through the global backup and rejects broken snapshot references before clearing data', () => {
    const html = '<!DOCTYPE html><html>动态正文</html>'
    getWebQaRepository().create({
      sessionId: 'web-s1', messageId: 'web-m1', question: '文章结论？', createdAt: 10,
      snapshot: { finalUrl: 'https://example.org/article', title: '文章', html,
        capturedAt: 9, byteLength: Buffer.byteLength(html, 'utf8'),
        contentHash: createHash('sha256').update(html).digest('hex') },
    })
    const saved = exportAll()
    expect(saved.webQa.pages).toHaveLength(1)
    expect(saved.webQa.snapshots[0].pageId).toBe(saved.webQa.pages[0].id)
    clearAll()
    expect(getWebQaRepository().list()).toHaveLength(0)
    expect(getWebQaRepository().listPages()).toHaveLength(0)
    importAll(saved)
    expect(getWebQaRepository().get('web-s1')?.snapshot.html).toBe(html)

    const invalidPage = structuredClone(saved)
    invalidPage.webQa.snapshots[0].pageId = 'missing'
    expect(() => importAll(invalidPage)).toThrow('网页')
    expect(getWebQaRepository().get('web-s1')?.messages[0].content).toBe('文章结论？')

    const invalid = structuredClone(saved)
    invalid.webQa.sessions[0].snapshotId = 'missing'
    expect(() => importAll(invalid)).toThrow('网页快照')
    expect(getWebQaRepository().get('web-s1')?.snapshot.html).toBe(html)
  })

  it('keeps files untouched when a nested Docling record makes import fail', () => {
    const bad = { ...backup('docling-paper'), docling: {
      assets: [{ paper_id: 'docling-paper', id: 'wrong', data: 'data:image/png;base64,AAAA' }],
    } }
    expect(() => importAll(bad)).toThrow()
    expect(existsSync(join(appPath.userData, 'papers', 'docling-paper.pdf'))).toBe(false)
    expect(exportAll().papers.some((paper: { id: string }) => paper.id === 'paper-1')).toBe(true)
  })

  it('rejects an incomplete paper before writing its PDF', () => {
    expect(() => paperApi.create({
      id: 'incomplete-paper', knowledgeBaseId: 'default', fileName: 'paper.pdf',
      fileData: Buffer.from('%PDF-1.7').toString('base64'), addedAt: 1,
    } as never)).toThrow()
    expect(existsSync(join(appPath.userData, 'papers', 'incomplete-paper.pdf'))).toBe(false)
  })

  it('rejects a bad chat run state at the IPC handler before writing a message', () => {
    registerIpc()
    const add = appPath.handlers.get('chat:addMessage')!
    expect(() => add(trustedEvent, {
      id: 'invalid-message', conversationId: 'conversation-1', role: 'assistant',
      content: 'partial', sources: [], timestamp: 4, runId: 'run-2', runStatus: 'unknown-state',
    })).toThrow()
    expect(exportAll().conversations[0].messages.some(message => message.id === 'invalid-message')).toBe(false)
  })

  it('rejects a bad chat run state when updating an existing message', () => {
    const update = appPath.handlers.get('chat:updateMessage')!
    expect(() => update(trustedEvent, 'message-1', { runStatus: 'unknown-state' })).toThrow()
    expect(exportAll().conversations[0].messages[0].runStatus).toBe('cancelled')
  })

  it('rejects every registered privileged channel before dispatch for unknown windows or child frames', () => {
    for (const handler of appPath.handlers.values()) {
      expect(() => handler({ sender: { mainFrame: appPath.frame }, senderFrame: appPath.frame })).toThrow('IPC')
      expect(() => handler({ sender: trustedSender, senderFrame: { ...appPath.frame } })).toThrow('IPC')
    }
  })

  it('accepts empty display labels from an older version-1 backup', () => {
    const legacy = backup('paper-empty-label')
    legacy.knowledgeBases[0].name = ''
    legacy.conversations[0].title = ''
    expect(() => importAll(legacy)).not.toThrow()
    expect(exportAll().knowledgeBases[0].name).toBe('')
  })

  it('does not delete a file outside the managed paper directory from a stale database row', () => {
    const protectedFile = join(appPath.userData, 'protected.pdf')
    writeFileSync(protectedFile, 'keep me')
    const direct = new Database(join(appPath.userData, 'papermind.db'))
    try {
      direct.prepare('UPDATE papers SET file_path = ? WHERE id = ?').run(protectedFile, 'paper-empty-label')
    } finally { direct.close() }
    paperApi.remove('paper-empty-label')
    expect(existsSync(protectedFile)).toBe(true)
  })

  it('rejects a symlinked PDF destination before touching its target', () => {
    const protectedFile = join(appPath.userData, 'protected.pdf')
    const link = join(appPath.userData, 'papers', 'symlink-paper.pdf')
    symlinkSync(protectedFile, link)
    expect(() => importAll(backup('symlink-paper'))).toThrow()
    expect(readFileSync(protectedFile, 'utf8')).toBe('keep me')
  })

  it('rejects a blocked PDF destination before replacing database rows', () => {
    const before = exportAll().papers.map((paper: { id: string }) => paper.id)
    mkdirSync(join(appPath.userData, 'papers', 'blocked-paper.pdf'))
    expect(() => importAll(backup('blocked-paper'))).toThrow()
    const direct = new Database(join(appPath.userData, 'papermind.db'))
    try {
      expect((direct.prepare('SELECT id FROM papers ORDER BY id').all() as Array<{ id: string }>).map(row => row.id)).toEqual(before)
    } finally { direct.close() }
  })

  it('clears persistent webpage resources and site storage with application data without touching other sessions', async () => {
    appPath.browserData.set('persist:papermind-preview', { cache: ['article.css'], storage: ['site-cookie'], codeCache: ['article.js'] })
    appPath.browserData.set('unrelated', { cache: ['keep.css'], storage: ['keep-cookie'], codeCache: ['keep.js'] })
    await appPath.handlers.get('data:clear')!(trustedEvent)
    expect(appPath.browserData.get('persist:papermind-preview')).toEqual({ cache: [], storage: [], codeCache: [] })
    expect(appPath.browserData.get('unrelated')).toEqual({ cache: ['keep.css'], storage: ['keep-cookie'], codeCache: ['keep.js'] })
    expect(getWebQaRepository().listPages()).toEqual([])
  })

  it('roundtrips native summary assets and rejects an orphan backup before replacing existing data', () => {
    importAll(backup('native-paper'))
    const repo = getDocumentSummaryRepository()
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0ioAAAAASUVORK5CYII='
    const image = repo.saveAsset('paper', 'native-paper', png)
    repo.save({ kind: 'paper', sourceId: 'native-paper', slot: 'report', sourceHash: 'native-v1',
      payload: JSON.stringify({ content: `![Original](asset:${image})` }) })
    const saved = exportAll()
    const bad = structuredClone(saved)
    bad.documentSummary.records[0].sourceId = 'missing-paper'
    expect(() => importAll(bad)).toThrow('摘要备份来源不存在')
    expect(repo.readAsset(image)).toBe(png)
    clearAll()
    expect(repo.readAsset(image)).toBeNull()
    importAll(saved)
    expect(repo.readAsset(image)).toBe(png)
    expect(repo.get('paper', 'native-paper', 'report')?.payload).toContain(image)
  })
})
