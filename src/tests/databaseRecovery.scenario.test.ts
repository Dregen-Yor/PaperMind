// @vitest-environment node
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import Database from 'better-sqlite3'

const environment = vi.hoisted(() => ({
  userData: '',
  failWriteAt: 0,
  writes: 0,
  failMoveAt: 0,
  moves: 0,
  recoveryFailureStage: 'idle' as 'idle' | 'install' | 'rollback',
}))

vi.mock('electron', () => ({ app: { getPath: () => environment.userData } }))
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  const beforeMove = (source: unknown) => {
    if (!environment.failMoveAt || !/[/\\]papers[/\\]original-[ab]\.pdf$/.test(String(source))) return
    environment.moves++
    if (environment.moves === environment.failMoveAt) {
      environment.failMoveAt = 0
      throw new Error('injected PDF move failure')
    }
  }
  const wrapped = {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (environment.failWriteAt && String(args[1]).includes('replacement PDF')) {
        environment.writes++
        if (environment.writes === environment.failWriteAt) {
          environment.failWriteAt = 0
          throw new Error('injected PDF write failure')
        }
      }
      return actual.writeFileSync(...args)
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      const source = String(args[0])
      if (environment.recoveryFailureStage === 'install' && /[/\\]new[/\\]original-a\.pdf$/.test(source)) {
        environment.recoveryFailureStage = 'rollback'
        throw new Error('injected replacement install failure')
      }
      if (environment.recoveryFailureStage === 'rollback' && /[/\\]old[/\\]original-a\.pdf$/.test(source)) {
        environment.recoveryFailureStage = 'idle'
        throw new Error('injected original restore failure')
      }
      beforeMove(args[0])
      return actual.renameSync(...args)
    },
    unlinkSync: (...args: Parameters<typeof actual.unlinkSync>) => {
      beforeMove(args[0])
      return actual.unlinkSync(...args)
    },
  }
  return { ...wrapped, default: wrapped }
})

import { chatApi, clearAll, exportAll, importAll, initDb, kbApi, paperApi, settingsApi } from '../../electron/db'

const taskRoot = mkdtempSync(join(tmpdir(), 'papermind-database-recovery-'))
let direct: Database.Database
let before: ReturnType<typeof exportAll>

const pdfData = (text: string) => Buffer.from(`%PDF-1.7\n${text}`).toString('base64')
const paperPath = (id: string) => join(environment.userData, 'papers', `${id}.pdf`)

function paper(id: string, text = 'replacement PDF') {
  return {
    id, knowledgeBaseId: 'library', title: `Title ${id}`, authors: ['Author'], abstract: '',
    year: 2026, tags: [], status: 'unread' as const, fileName: `${id}.pdf`, addedAt: 1,
    fileData: pdfData(text),
  }
}

function replacementBackup() {
  return {
    version: 1,
    knowledgeBases: [{ id: 'library', name: 'Restored library', description: '', color: '#3db8a0', createdAt: 4 }],
    papers: [paper('original-a'), paper('new-paper')],
    conversations: [{ id: 'restored-chat', title: 'Restored chat', paperIds: ['original-a'], createdAt: 4,
      messages: [{ id: 'restored-message', role: 'assistant', content: 'Restored answer', sources: [], timestamp: 5 }] }],
    settings: [{ key: 'huggingface_token', value: JSON.stringify('restored-token') }],
  }
}

function assertOriginalState() {
  expect(paperApi.list().map(row => row.id).sort()).toEqual(['original-a', 'original-b'])
  expect(existsSync(paperPath('original-a'))).toBe(true)
  expect(existsSync(paperPath('original-b'))).toBe(true)
  expect(readFileSync(paperPath('original-a'), 'utf8')).toBe('%PDF-1.7\noriginal PDF A')
  expect(readFileSync(paperPath('original-b'), 'utf8')).toBe('%PDF-1.7\noriginal PDF B')
  expect(existsSync(paperPath('new-paper'))).toBe(false)
  expect(kbApi.list()).toEqual(before.knowledgeBases)
  expect(chatApi.listConversations()).toEqual(before.conversations)
  expect(settingsApi.get('huggingface_token')).toBe('original-token')
  expect(exportAll({ includeApiKey: true }).settings).toEqual(before.settings)
}

function rejectDeletes(table: 'papers' | 'knowledge_bases' | 'settings', condition = '1') {
  direct.exec(`CREATE TRIGGER reject_delete BEFORE DELETE ON ${table}
    WHEN ${condition} BEGIN SELECT RAISE(ABORT, 'injected SQL failure'); END`)
}

beforeEach(() => {
  environment.failWriteAt = 0
  environment.writes = 0
  environment.failMoveAt = 0
  environment.moves = 0
  environment.recoveryFailureStage = 'idle'
  environment.userData = mkdtempSync(join(taskRoot, 'user-data-'))
  initDb()
  direct = new Database(join(environment.userData, 'papermind.db'))
  kbApi.create({ id: 'library', name: 'Original library', description: 'Keep this library', color: '#123456', createdAt: 1 })
  paperApi.create(paper('original-a', 'original PDF A'))
  paperApi.create(paper('original-b', 'original PDF B'))
  chatApi.createConversation({ id: 'original-chat', title: 'Keep this chat', paperIds: ['original-a'], createdAt: 2 })
  chatApi.addMessage({ id: 'original-message', conversationId: 'original-chat', role: 'assistant', content: 'Keep this answer', sources: [], timestamp: 3 })
  settingsApi.set('huggingface_token', 'original-token')
  before = exportAll({ includeApiKey: true })
})

afterEach(() => {
  environment.failWriteAt = 0
  environment.failMoveAt = 0
  environment.recoveryFailureStage = 'idle'
  direct?.close()
})

afterAll(() => rmSync(taskRoot, { recursive: true, force: true }))

describe('database and PDF recovery consistency', () => {
  it.each([1, 2])('preserves the original library, PDFs, chat and settings when imported PDF write %s fails', writeNumber => {
    environment.failWriteAt = writeNumber
    expect(() => importAll(replacementBackup())).toThrow('injected PDF write failure')
    assertOriginalState()
  })

  it('restores the first original PDF if moving the second PDF during import fails', () => {
    environment.failMoveAt = 2
    expect(() => importAll(replacementBackup())).toThrow('injected PDF move failure')
    assertOriginalState()
  })

  it('rolls back files and all rows when replacement import fails inside SQLite', () => {
    rejectDeletes('settings')
    expect(() => importAll(replacementBackup())).toThrow('injected SQL failure')
    assertOriginalState()
  })

  it('recovers quarantined originals before planning a subsequent clear without restarting the app', () => {
    environment.recoveryFailureStage = 'install'
    expect(() => importAll(replacementBackup())).toThrow('injected original restore failure')

    // SQLite rolled back, but the failed rollback deliberately leaves the
    // original PDF in its journal until the next operation can restore it.
    expect(paperApi.list().map(row => row.id).sort()).toEqual(['original-a', 'original-b'])
    expect(chatApi.listConversations()).toEqual(before.conversations)
    expect(settingsApi.get('huggingface_token')).toBe('original-token')
    expect(existsSync(paperPath('original-a'))).toBe(false)
    const journalRoot = join(environment.userData, '.paper-file-transactions')
    const journals = readdirSync(journalRoot)
    expect(journals).toHaveLength(1)
    expect(readFileSync(join(journalRoot, journals[0], 'old', 'original-a.pdf'), 'utf8')).toBe('%PDF-1.7\noriginal PDF A')

    environment.recoveryFailureStage = 'idle'
    clearAll()
    expect(paperApi.list()).toEqual([])
    expect(chatApi.listConversations()).toEqual([])
    expect(settingsApi.get('huggingface_token')).toBeNull()
    expect(existsSync(paperPath('original-a'))).toBe(false)
    expect(existsSync(paperPath('original-b'))).toBe(false)
    expect(readdirSync(journalRoot)).toEqual([])
  })

  it('recovers a quarantined original before exporting its PDF bytes without restarting the app', () => {
    environment.recoveryFailureStage = 'install'
    expect(() => importAll(replacementBackup())).toThrow('injected original restore failure')
    expect(existsSync(paperPath('original-a'))).toBe(false)

    environment.recoveryFailureStage = 'idle'
    const backup = exportAll({ includeApiKey: true })

    expect(backup.papers.find(row => row.id === 'original-a')?.fileData).toBe(pdfData('original PDF A'))
    expect(backup.papers.find(row => row.id === 'original-b')?.fileData).toBe(pdfData('original PDF B'))
    expect(backup.conversations).toEqual(before.conversations)
    expect(backup.settings).toEqual(before.settings)
    expect(readdirSync(join(environment.userData, '.paper-file-transactions'))).toEqual([])
  })

  it.each([false, true])('recovers a persisted file journal on initDb with SQL commit marker %s', committed => {
    const transactionId = '12345678-1234-4234-8234-123456789abc'
    const journalRoot = join(environment.userData, '.paper-file-transactions')
    const transactionDir = join(journalRoot, transactionId)
    mkdirSync(join(transactionDir, 'old'), { recursive: true })
    mkdirSync(join(transactionDir, 'new'))
    renameSync(paperPath('original-a'), join(transactionDir, 'old', 'original-a.pdf'))
    writeFileSync(paperPath('original-a'), '%PDF-1.7\ncommitted replacement PDF')
    writeFileSync(join(transactionDir, 'manifest.json'), JSON.stringify({
      version: 1,
      id: transactionId,
      entries: [{ id: 'original-a', hadOriginal: true, hasReplacement: true }],
    }))
    if (committed) {
      direct.transaction(() => {
        direct.prepare('UPDATE papers SET title = ? WHERE id = ?').run('Committed title', 'original-a')
        direct.prepare('INSERT INTO paper_file_transactions (id) VALUES (?)').run(transactionId)
      })()
    }

    initDb()

    expect(readFileSync(paperPath('original-a'), 'utf8')).toBe(committed
      ? '%PDF-1.7\ncommitted replacement PDF'
      : '%PDF-1.7\noriginal PDF A')
    expect(paperApi.get('original-a')?.title).toBe(committed ? 'Committed title' : 'Title original-a')
    expect(readFileSync(paperPath('original-b'), 'utf8')).toBe('%PDF-1.7\noriginal PDF B')
    expect(chatApi.listConversations()).toEqual(before.conversations)
    expect(settingsApi.get('huggingface_token')).toBe('original-token')
    expect(readdirSync(journalRoot)).toEqual([])
    expect(direct.prepare('SELECT id FROM paper_file_transactions').all()).toEqual([])
  })

  it.each([null, undefined])('does not reuse the old PDF when same-ID backup fileData is %s', fileData => {
    const backup = replacementBackup()
    const missingPaper = { ...paper('original-a'), fileData }
    importAll({ ...backup, papers: [missingPaper] })
    expect(paperApi.get('original-a')?.title).toBe('Title original-a')
    expect(paperApi.readFile('original-a')).toBeNull()
    expect(paperApi.filePath('original-a')).toBeNull()
    expect(existsSync(paperPath('original-a'))).toBe(false)
    expect(existsSync(paperPath('original-b'))).toBe(false)
  })

  it.each([null, undefined])('restores a new-ID paper without a PDF when fileData is %s', fileData => {
    importAll({ ...replacementBackup(), papers: [{ ...paper('new-paper'), fileData }] })
    expect(paperApi.get('new-paper')?.title).toBe('Title new-paper')
    expect(paperApi.readFile('new-paper')).toBeNull()
    expect(paperApi.filePath('new-paper')).toBeNull()
    expect(existsSync(paperPath('new-paper'))).toBe(false)
  })

  it.each([
    ['invalid JSON', 'huggingface_token', '{'],
    ['invalid profile structure', 'llm_profiles', JSON.stringify({ profiles: 'broken' })],
    ['invalid profile element', 'llm_profiles', JSON.stringify([null])],
    ['invalid model config', 'llm_config', JSON.stringify({ model: 42 })],
  ])('rejects settings with %s before overwriting the original library', (_label, key, value) => {
    expect(() => importAll({ ...replacementBackup(), settings: [{ key, value }] })).toThrow()
    assertOriginalState()
  })

  it.each(['knowledge base', 'all data'])('restores every PDF and row if deleting %s fails on its second file', operation => {
    environment.failMoveAt = 2
    expect(() => operation === 'knowledge base' ? kbApi.remove('library') : clearAll()).toThrow('injected PDF move failure')
    assertOriginalState()
  })

  it.each(['paper', 'knowledge base', 'all data'])('restores PDFs and dependent rows if deleting %s fails in SQLite', operation => {
    if (operation === 'knowledge base') rejectDeletes('knowledge_bases', "OLD.id = 'library'")
    else if (operation === 'all data') rejectDeletes('settings')
    else rejectDeletes('papers', "OLD.id = 'original-a'")
    expect(() => {
      if (operation === 'knowledge base') kbApi.remove('library')
      else if (operation === 'all data') clearAll()
      else paperApi.remove('original-a')
    }).toThrow('injected SQL failure')
    assertOriginalState()
  })

  it('restores backup bytes, chat and settings successfully and removes obsolete and orphan PDFs', () => {
    writeFileSync(paperPath('orphan'), '%PDF-1.7\norphan')
    const backup = replacementBackup()
    importAll(backup)
    expect(paperApi.list().map(row => row.id).sort()).toEqual(['new-paper', 'original-a'])
    expect(readFileSync(paperPath('original-a'), 'utf8')).toBe('%PDF-1.7\nreplacement PDF')
    expect(readFileSync(paperPath('new-paper'), 'utf8')).toBe('%PDF-1.7\nreplacement PDF')
    expect(existsSync(paperPath('original-b'))).toBe(false)
    expect(existsSync(paperPath('orphan'))).toBe(false)
    expect(chatApi.listConversations()[0]?.messages[0]?.content).toBe('Restored answer')
    expect(settingsApi.get('huggingface_token')).toBe('restored-token')
    expect(backup.papers[0].fileData).toBe(pdfData('replacement PDF'))
  })

  it('successfully removes a knowledge base and its PDFs while preserving unrelated chat and settings', () => {
    kbApi.remove('library')
    expect(paperApi.list()).toEqual([])
    expect(kbApi.list().map(row => row.id)).toEqual(['default'])
    expect(existsSync(paperPath('original-a'))).toBe(false)
    expect(existsSync(paperPath('original-b'))).toBe(false)
    expect(chatApi.listConversations()).toEqual(before.conversations)
    expect(settingsApi.get('huggingface_token')).toBe('original-token')
  })

  it('successfully clears all data and creates a fresh default knowledge base', () => {
    clearAll()
    expect(paperApi.list()).toEqual([])
    expect(chatApi.listConversations()).toEqual([])
    expect(settingsApi.get('huggingface_token')).toBeNull()
    expect(kbApi.list().map(row => row.id)).toEqual(['default'])
    expect(existsSync(paperPath('original-a'))).toBe(false)
    expect(existsSync(paperPath('original-b'))).toBe(false)
  })
})
