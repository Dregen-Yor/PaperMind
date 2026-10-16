// @vitest-environment node
import { afterAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import Database from 'better-sqlite3'

const appPath = vi.hoisted(() => ({
  userData: '',
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}))
vi.mock('electron', () => ({
  app: { getPath: () => appPath.userData },
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => appPath.handlers.set(channel, handler) },
}))

import { exportAll, importAll, initDb, paperApi } from '../../electron/db'
import { registerIpc } from '../../electron/ipc'

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
    expect(() => add({}, {
      id: 'invalid-message', conversationId: 'conversation-1', role: 'assistant',
      content: 'partial', sources: [], timestamp: 4, runId: 'run-2', runStatus: 'unknown-state',
    })).toThrow()
    expect(exportAll().conversations[0].messages.some(message => message.id === 'invalid-message')).toBe(false)
  })

  it('rejects a bad chat run state when updating an existing message', () => {
    const update = appPath.handlers.get('chat:updateMessage')!
    expect(() => update({}, 'message-1', { runStatus: 'unknown-state' })).toThrow()
    expect(exportAll().conversations[0].messages[0].runStatus).toBe('cancelled')
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
})
