// @vitest-environment node
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createHash } from 'crypto'
import Database from 'better-sqlite3'

const environment = vi.hoisted(() => ({ userData: '', frame: { url: 'file:///app/dist/index.html' }, handlers: new Map<string, (...args: unknown[]) => unknown>() }))
vi.mock('electron', () => ({ app: { getPath: () => environment.userData, getAppPath: () => '/app', isPackaged: true },
  BrowserWindow: { getAllWindows: () => [{ webContents: trustedSender }] },
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => environment.handlers.set(channel, handler) },
}))
import { chatApi, highlightApi, importAll, initDb, paperApi } from '../../electron/db'
import { registerIpc } from '../../electron/ipc'

const trustedSender = { mainFrame: environment.frame }
const trustedEvent = { sender: trustedSender, senderFrame: environment.frame }

const root = mkdtempSync(join(tmpdir(), 'papermind-repair-'))
const bytes = Buffer.from('%PDF-1.7\noriginal PDF')
const fileData = bytes.toString('base64')
const fileHash = createHash('sha256').update(bytes).digest('hex')
const paper = {
  id: 'saved-paper', knowledgeBaseId: 'default', title: 'Edited title', authors: ['Author'],
  abstract: 'Keep abstract', year: 2026, tags: ['keep'], status: 'done', fileName: 'original.pdf', addedAt: 5, fileHash,
}
let direct: Database.Database
const filePath = () => join(environment.userData, 'papers', 'saved-paper.pdf')

beforeEach(() => {
  environment.userData = mkdtempSync(join(root, 'user-data-'))
  initDb()
  importAll({ version: 1, knowledgeBases: [{ id: 'default', name: 'Library', description: '', color: '#123456', createdAt: 1 }],
    papers: [paper], conversations: [{ id: 'chat', title: 'Keep chat', paperIds: ['saved-paper'], createdAt: 2, messages: [] }],
    highlights: [{ id: 'note', paperId: 'saved-paper', text: 'Marked text', pageNum: 1, color: '#123456', note: 'Keep note', startOffset: 1, endOffset: 4, createdAt: 3 }],
  })
  direct = new Database(join(environment.userData, 'papermind.db'))
})
afterEach(() => direct.close())
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('repairing a restored paper PDF', () => {
  it.each([
    { label: 'newline', prefix: '\n' },
    { label: 'BOM and newline', prefix: '\uFEFF\n' },
    { label: 'header ending at byte 1024', prefix: ' '.repeat(1019) },
  ])('repairs the exact trusted imported PDF with $label', ({ prefix }) => {
    const original = Buffer.concat([Buffer.from(prefix), readFileSync(new URL('../../bench/datasets/smoke/papers/semantic-headings.pdf', import.meta.url))])
    const originalData = original.toString('base64')
    const originalHash = createHash('sha256').update(original).digest('hex')
    const imported = { ...paper, id: 'leading-paper', fileHash: originalHash }
    paperApi.create({ ...imported, status: 'done', fileData: originalData })
    const destination = paperApi.filePath('leading-paper')!
    unlinkSync(destination)

    paperApi.restoreFile('leading-paper', originalData)

    expect(readFileSync(destination).equals(original)).toBe(true)
    expect(paperApi.get('leading-paper')).toEqual(imported)
  })

  it('repairs a PDF larger than 5 MB without recursive base64 validation', () => {
    const largePdf = Buffer.alloc(6 * 1024 * 1024, 32)
    largePdf.write('%PDF-1.7\n')
    direct.prepare('UPDATE papers SET file_hash = ? WHERE id = ?').run(createHash('sha256').update(largePdf).digest('hex'), 'saved-paper')
    paperApi.restoreFile('saved-paper', largePdf.toString('base64'))
    expect(readFileSync(filePath()).equals(largePdf)).toBe(true)
  })
  it('reattaches verified bytes to the same paper while preserving metadata, notes and chat associations', () => {
    const notes = highlightApi.listByPaper('saved-paper')
    const conversations = chatApi.listConversations()
    expect(paperApi.filePath('saved-paper')).toBeNull()
    paperApi.restoreFile('saved-paper', fileData)
    expect(readFileSync(filePath())).toEqual(bytes)
    expect(paperApi.filePath('saved-paper')).toBe(filePath())
    expect(paperApi.list()).toEqual([paper])
    expect(highlightApi.listByPaper('saved-paper')).toEqual(notes)
    expect(chatApi.listConversations()).toEqual(conversations)
    expect(readdirSync(join(environment.userData, '.paper-file-transactions'))).toEqual([])
  })

  it('computes the actual file hash and rejects different PDF bytes without creating a file', () => {
    expect(() => paperApi.restoreFile('saved-paper', Buffer.from('%PDF-1.7\nwrong PDF').toString('base64'))).toThrow('不匹配')
    expect(existsSync(filePath())).toBe(false)
    expect(paperApi.get('saved-paper')).toEqual(paper)
  })

  it.each([null, 42, '', '%%%invalid', Buffer.from('not PDF').toString('base64')])('rejects invalid runtime bytes %s', data => {
    expect(() => paperApi.restoreFile('saved-paper', data as never)).toThrow()
    expect(existsSync(filePath())).toBe(false)
  })

  it.each(['../escape', '', 42, 'missing-paper'])('rejects invalid or missing paper %s', id => {
    expect(() => paperApi.restoreFile(id as never, fileData)).toThrow()
    expect(existsSync(filePath())).toBe(false)
  })

  it('rejects legacy records without a trusted hash instead of guessing by filename', () => {
    direct.prepare('UPDATE papers SET file_hash = ? WHERE id = ?').run('', 'saved-paper')
    expect(() => paperApi.restoreFile('saved-paper', fileData)).toThrow('哈希')
    expect(existsSync(filePath())).toBe(false)
  })

  it('refuses to replace an existing original even when the submitted bytes match', () => {
    paperApi.restoreFile('saved-paper', fileData)
    expect(() => paperApi.restoreFile('saved-paper', fileData)).toThrow()
    expect(readFileSync(filePath())).toEqual(bytes)
  })

  it.each(['directory', 'dangling symlink'])('refuses an occupied %s destination', kind => {
    if (kind === 'directory') mkdirSync(filePath())
    else symlinkSync(join(environment.userData, 'does-not-exist'), filePath())
    expect(() => paperApi.restoreFile('saved-paper', fileData)).toThrow()
  })

  it('rejects an unsafe stored path instead of repairing a stale row into another location', () => {
    direct.prepare('UPDATE papers SET file_path = ? WHERE id = ?').run(join(environment.userData, 'outside.pdf'), 'saved-paper')
    expect(() => paperApi.restoreFile('saved-paper', fileData)).toThrow()
    expect(existsSync(filePath())).toBe(false)
  })

  it('rolls back the installed PDF if SQLite fails after the file switch and allows retry', () => {
    direct.exec("CREATE TRIGGER reject_marker BEFORE INSERT ON paper_file_transactions BEGIN SELECT RAISE(ABORT, 'injected SQL failure'); END")
    expect(() => paperApi.restoreFile('saved-paper', fileData)).toThrow('injected SQL failure')
    expect(existsSync(filePath())).toBe(false)
    expect(paperApi.get('saved-paper')).toEqual(paper)
    expect(readdirSync(join(environment.userData, '.paper-file-transactions'))).toEqual([])
    direct.exec('DROP TRIGGER reject_marker')
    paperApi.restoreFile('saved-paper', fileData)
    expect(readFileSync(filePath())).toEqual(bytes)
  })

  it('recovers an interrupted uncommitted repair before checking whether a PDF already exists', () => {
    const transactionId = '12345678-1234-4234-8234-123456789abc'
    const dir = join(environment.userData, '.paper-file-transactions', transactionId)
    mkdirSync(join(dir, 'old'), { recursive: true })
    mkdirSync(join(dir, 'new'))
    writeFileSync(filePath(), bytes)
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version: 1, id: transactionId,
      entries: [{ id: 'saved-paper', hadOriginal: false, hasReplacement: true }],
    }))
    paperApi.restoreFile('saved-paper', fileData)
    expect(readFileSync(filePath())).toEqual(bytes)
    expect(readdirSync(join(environment.userData, '.paper-file-transactions'))).toEqual([])
  })

  it('validates untrusted runtime inputs at the registered repair IPC boundary', () => {
    registerIpc()
    const restore = environment.handlers.get('paper:restoreFile')!
    expect(restore).toBeTypeOf('function')
    expect(() => restore({}, 'saved-paper', fileData)).toThrow('IPC')
    expect(() => restore(trustedEvent, '../escape', fileData)).toThrow('ID')
    expect(() => restore(trustedEvent, 'saved-paper', { fileData })).toThrow('数据无效')
    expect(existsSync(filePath())).toBe(false)
    restore(trustedEvent, 'saved-paper', fileData)
    expect(readFileSync(filePath())).toEqual(bytes)
  })
})
