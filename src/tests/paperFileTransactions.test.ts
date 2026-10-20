// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'fs'
import { basename, dirname, join, sep } from 'path'
import { tmpdir } from 'os'
import { createPaperFileTransactions } from '../../electron/db/paperFileTransactions'

describe('paper file transactions', () => {
  let root: string
  let papers: string
  let journalRoot: string
  let db: Database.Database
  let transactions: ReturnType<typeof createPaperFileTransactions>
  const bytes = (value: string) => Buffer.from(value)
  const pdf = (id: string) => join(papers, `${id}.pdf`)
  const read = (id: string) => fs.readFileSync(pdf(id), 'utf8')
  const rows = () => db.prepare('SELECT id FROM papers ORDER BY id').all()
  const markers = () => db.prepare('SELECT id FROM paper_file_transactions').all()
  const insert = (id: string) => db.prepare('INSERT INTO papers VALUES (?)').run(id)

  beforeEach(() => {
    root = fs.mkdtempSync(join(tmpdir(), 'paper-transactions-'))
    papers = join(root, 'papers')
    journalRoot = join(root, '.paper-file-transactions')
    fs.mkdirSync(papers)
    db = new Database(':memory:')
    db.exec('CREATE TABLE papers(id TEXT PRIMARY KEY); CREATE TABLE paper_file_transactions(id TEXT PRIMARY KEY)')
    transactions = createPaperFileTransactions(db, papers)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })

  function interrupted(
    entries: Array<{ id: string; hadOriginal: boolean; hasReplacement: boolean }>,
    committed = false,
  ) {
    const id = '00000000-0000-4000-8000-000000000001'
    const dir = join(journalRoot, id)
    fs.mkdirSync(join(dir, 'old'), { recursive: true })
    fs.mkdirSync(join(dir, 'new'))
    fs.writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version: 1, id, entries }))
    if (committed) db.prepare('INSERT INTO paper_file_transactions VALUES (?)').run(id)
    return dir
  }

  function simulateCaseInsensitiveFiles(scope = root) {
    const fold = (path: fs.PathLike) => typeof path === 'string' && path.startsWith(`${scope}${sep}`)
      ? join(dirname(path), basename(path).toLowerCase())
      : path
    const lstat = fs.lstatSync
    const rename = fs.renameSync
    const unlink = fs.unlinkSync
    // Keep real files and rename/overwrite behavior; only resolve differently
    // cased basenames as the same path, as a case-insensitive volume does.
    vi.spyOn(fs, 'lstatSync').mockImplementation(((path: fs.PathLike) => lstat(fold(path))) as typeof fs.lstatSync)
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => rename(fold(from), fold(to)))
    vi.spyOn(fs, 'unlinkSync').mockImplementation(path => unlink(fold(path)))
  }

  it('commits new, replaced and deleted PDFs with SQL and returns the mutation result', () => {
    fs.writeFileSync(pdf('replace'), 'old')
    fs.writeFileSync(pdf('delete'), 'delete')
    insert('delete')
    const result = transactions.run([
      { id: 'new', data: bytes('new') },
      { id: 'replace', data: bytes('replacement') },
      { id: 'delete', data: null },
    ], () => {
      insert('new')
      db.prepare('DELETE FROM papers WHERE id = ?').run('delete')
      return 42
    })
    expect(result).toBe(42)
    expect(rows()).toEqual([{ id: 'new' }])
    expect(read('replace')).toBe('replacement')
    expect(read('new')).toBe('new')
    expect(fs.existsSync(pdf('delete'))).toBe(false)
    expect(markers()).toEqual([])
    expect(fs.readdirSync(journalRoot)).toEqual([])
  })

  it('leaves SQL and original files unchanged when staging fails', () => {
    fs.writeFileSync(pdf('replace'), 'old')
    const write = fs.writeFileSync
    vi.spyOn(fs, 'writeFileSync').mockImplementation((...args: Parameters<typeof write>) => {
      if (String(args[0]).endsWith('replace.pdf')) throw new Error('disk full')
      return write(...args)
    })
    expect(() => transactions.run([{ id: 'replace', data: bytes('new') }], () => insert('new'))).toThrow('disk full')
    expect(rows()).toEqual([])
    expect(read('replace')).toBe('old')
  })

  it('checks SQL constraints before changing any original file', () => {
    fs.writeFileSync(pdf('replace'), 'old')
    insert('existing')
    expect(() => transactions.run([{ id: 'replace', data: bytes('new') }], () => {
      expect(read('replace')).toBe('old')
      insert('existing')
    })).toThrow(/UNIQUE/)
    expect(read('replace')).toBe('old')
    expect(rows()).toEqual([{ id: 'existing' }])
  })

  it('reverses earlier file changes and SQL after a later rename fails', () => {
    fs.writeFileSync(pdf('first'), 'old first')
    fs.writeFileSync(pdf('second'), 'old second')
    const rename = fs.renameSync
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from).includes(`${sep}new${sep}`) && String(to) === pdf('second')) throw new Error('rename denied')
      rename(from, to)
    })
    expect(() => transactions.run([
      { id: 'first', data: bytes('new first') },
      { id: 'second', data: bytes('new second') },
    ], () => insert('new'))).toThrow('rename denied')
    expect(rows()).toEqual([])
    expect(read('first')).toBe('old first')
    expect(read('second')).toBe('old second')
  })

  it('rolls files back if the final SQL marker cannot be inserted', () => {
    fs.writeFileSync(pdf('replace'), 'old')
    db.exec("CREATE TRIGGER reject_marker BEFORE INSERT ON paper_file_transactions BEGIN SELECT RAISE(ABORT, 'marker rejected'); END")
    expect(() => transactions.run([{ id: 'replace', data: bytes('new') }], () => insert('new'))).toThrow('marker rejected')
    expect(rows()).toEqual([])
    expect(read('replace')).toBe('old')
  })

  it('preserves a failed rollback and recovers it before allowing a later mutation', () => {
    fs.writeFileSync(pdf('replace'), 'old')
    const rename = fs.renameSync
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from).includes(`${sep}new${sep}`) || String(from).includes(`${sep}old${sep}`)) throw new Error('rename denied')
      rename(from, to)
    })
    expect(() => transactions.run([{ id: 'replace', data: bytes('new') }], () => insert('new'))).toThrow(/恢复|recover/i)
    expect(rows()).toEqual([])
    expect(fs.readdirSync(journalRoot)).toHaveLength(1)
    expect(() => transactions.run([], () => insert('blocked'))).toThrow(/恢复|recover/i)
    expect(rows()).toEqual([])
    vi.restoreAllMocks()
    transactions.run([], () => {
      expect(read('replace')).toBe('old')
      insert('after')
    })
    expect(rows()).toEqual([{ id: 'after' }])
  })

  it('does not report a committed operation as failed when journal cleanup fails', () => {
    fs.writeFileSync(pdf('replace'), 'old')
    const remove = fs.rmSync
    vi.spyOn(fs, 'rmSync').mockImplementation((path, options) => {
      if (String(path).startsWith(journalRoot)) throw new Error('cleanup denied')
      remove(path, options)
    })
    expect(transactions.run([{ id: 'replace', data: bytes('new') }], () => {
      insert('new')
      return 'committed'
    })).toBe('committed')
    expect(rows()).toEqual([{ id: 'new' }])
    expect(read('replace')).toBe('new')
    expect(markers()).toHaveLength(1)
    vi.restoreAllMocks()
    transactions.recover()
    transactions.recover()
    expect(read('replace')).toBe('new')
    expect(markers()).toEqual([])
    expect(fs.readdirSync(journalRoot)).toEqual([])
  })

  it('recovers an interrupted uncommitted replacement, deletion and creation idempotently', () => {
    const dir = interrupted([
      { id: 'replace', hadOriginal: true, hasReplacement: true },
      { id: 'delete', hadOriginal: true, hasReplacement: false },
      { id: 'create', hadOriginal: false, hasReplacement: true },
    ])
    fs.writeFileSync(join(dir, 'old', 'replace.pdf'), 'original')
    fs.writeFileSync(join(dir, 'old', 'delete.pdf'), 'deleted original')
    fs.writeFileSync(pdf('replace'), 'new')
    fs.writeFileSync(pdf('create'), 'created')
    transactions.recover()
    transactions.recover()
    expect(read('replace')).toBe('original')
    expect(read('delete')).toBe('deleted original')
    expect(fs.existsSync(pdf('create'))).toBe(false)
  })

  it('can retry a recovery interrupted after an original was already restored', () => {
    const dir = interrupted([
      { id: 'first', hadOriginal: true, hasReplacement: true },
      { id: 'second', hadOriginal: true, hasReplacement: true },
    ])
    fs.writeFileSync(join(dir, 'old', 'first.pdf'), 'original first')
    fs.writeFileSync(pdf('second'), 'already restored second')
    fs.writeFileSync(pdf('first'), 'new first')
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('recovery interrupted') })
    expect(() => transactions.recover()).toThrow(/恢复|recover/i)
    expect(read('second')).toBe('already restored second')
    vi.restoreAllMocks()
    transactions.recover()
    expect(read('first')).toBe('original first')
    expect(read('second')).toBe('already restored second')
  })

  it('preserves committed files and completes cleanup after a crash', () => {
    const dir = interrupted([{ id: 'replace', hadOriginal: true, hasReplacement: true }], true)
    fs.writeFileSync(join(dir, 'old', 'replace.pdf'), 'old')
    fs.writeFileSync(pdf('replace'), 'committed')
    insert('replace')
    transactions.recover()
    transactions.recover()
    expect(read('replace')).toBe('committed')
    expect(rows()).toEqual([{ id: 'replace' }])
    expect(markers()).toEqual([])
  })

  it('cleans staging without a manifest and stale markers without altering PDFs', () => {
    const dir = join(journalRoot, '00000000-0000-4000-8000-000000000001')
    fs.mkdirSync(join(dir, 'new'), { recursive: true })
    fs.writeFileSync(join(dir, 'new', 'staged.pdf'), 'staged')
    fs.writeFileSync(pdf('existing'), 'original')
    db.prepare('INSERT INTO paper_file_transactions VALUES (?)').run('00000000-0000-4000-8000-000000000002')
    transactions.recover()
    expect(read('existing')).toBe('original')
    expect(markers()).toEqual([])
    expect(fs.readdirSync(journalRoot)).toEqual([])
  })

  it.each(['../escape', '/absolute', '', 'a/b'])('rejects unsafe paper id %j before mutating SQL', (id) => {
    expect(() => transactions.run([{ id, data: bytes('new') }], () => insert('bad'))).toThrow()
    expect(rows()).toEqual([])
    expect(fs.existsSync(join(root, 'escape.pdf'))).toBe(false)
  })

  it.each(['symlink', 'directory'])('rejects a %s PDF target', (kind) => {
    const outside = join(root, 'outside.pdf')
    fs.writeFileSync(outside, 'outside')
    if (kind === 'symlink') fs.symlinkSync(outside, pdf('unsafe'))
    else fs.mkdirSync(pdf('unsafe'))
    expect(() => transactions.run([{ id: 'unsafe', data: null }], () => insert('bad'))).toThrow()
    expect(rows()).toEqual([])
    expect(fs.readFileSync(outside, 'utf8')).toBe('outside')
  })

  it('refuses a corrupt manifest and preserves its recovery material', () => {
    const dir = interrupted([{ id: '../outside', hadOriginal: true, hasReplacement: false }])
    fs.writeFileSync(join(root, 'outside.pdf'), 'outside')
    expect(() => transactions.recover()).toThrow(/恢复|recover/i)
    expect(fs.readFileSync(join(root, 'outside.pdf'), 'utf8')).toBe('outside')
    expect(fs.existsSync(join(dir, 'manifest.json'))).toBe(true)
  })

  it('can finish cleanup interrupted after rollback removed its empty subdirectories', () => {
    const dir = interrupted([{ id: 'replace', hadOriginal: true, hasReplacement: true }])
    fs.writeFileSync(join(dir, 'old', 'replace.pdf'), 'original')
    fs.writeFileSync(pdf('replace'), 'new')
    const remove = fs.rmSync
    vi.spyOn(fs, 'rmSync').mockImplementation((path, options) => {
      if (String(path) === dir) {
        remove(join(dir, 'old'), { recursive: true, force: true })
        remove(join(dir, 'new'), { recursive: true, force: true })
        throw new Error('cleanup interrupted')
      }
      remove(path, options)
    })
    expect(() => transactions.recover()).toThrow(/恢复|recover/i)
    expect(read('replace')).toBe('original')
    vi.restoreAllMocks()
    transactions.recover()
    expect(read('replace')).toBe('original')
    expect(fs.readdirSync(journalRoot)).toEqual([])
  })

  it('preserves original files omitted from a damaged manifest', () => {
    const dir = interrupted([])
    fs.writeFileSync(join(dir, 'old', 'omitted.pdf'), 'original')
    expect(() => transactions.recover()).toThrow(/恢复|recover/i)
    expect(fs.readFileSync(join(dir, 'old', 'omitted.pdf'), 'utf8')).toBe('original')
  })

  it('preserves quarantined originals when their manifest is missing', () => {
    const dir = interrupted([])
    fs.unlinkSync(join(dir, 'manifest.json'))
    fs.writeFileSync(join(dir, 'old', 'orphan.pdf'), 'original')
    expect(() => transactions.recover()).toThrow(/恢复|recover/i)
    expect(fs.readFileSync(join(dir, 'old', 'orphan.pdf'), 'utf8')).toBe('original')
  })

  it('rejects nested SQL transactions before touching files', () => {
    fs.writeFileSync(pdf('replace'), 'original')
    expect(() => db.transaction(() => {
      transactions.run([{ id: 'replace', data: bytes('new') }], () => insert('new'))
    })()).toThrow(/独立事务/)
    expect(rows()).toEqual([])
    expect(read('replace')).toBe('original')
  })

  it('rolls back an asynchronous callback instead of committing its synchronous changes', () => {
    fs.writeFileSync(pdf('replace'), 'original')
    expect(() => transactions.run([{ id: 'replace', data: bytes('new') }], () => {
      insert('new')
      return Promise.resolve('unsupported')
    })).toThrow(/异步/)
    expect(rows()).toEqual([])
    expect(read('replace')).toBe('original')
  })

  it('rejects duplicate file changes without changing SQL or files', () => {
    fs.writeFileSync(pdf('replace'), 'original')
    expect(() => transactions.run([
      { id: 'replace', data: bytes('new') },
      { id: 'replace', data: null },
    ], () => insert('new'))).toThrow(/重复/)
    expect(rows()).toEqual([])
    expect(read('replace')).toBe('original')
  })

  it('restores files when deferred SQL constraints fail at COMMIT', () => {
    db.pragma('foreign_keys = ON')
    db.exec('CREATE TABLE children(parent_id TEXT REFERENCES papers(id) DEFERRABLE INITIALLY DEFERRED)')
    fs.writeFileSync(pdf('replace'), 'original')
    expect(() => transactions.run([{ id: 'replace', data: bytes('new') }], () => {
      db.prepare('INSERT INTO children VALUES (?)').run('missing')
    })).toThrow(/FOREIGN KEY/)
    expect(db.prepare('SELECT * FROM children').all()).toEqual([])
    expect(read('replace')).toBe('original')
    expect(markers()).toEqual([])
  })

  it('does not move files or mutate SQL if publishing the manifest fails', () => {
    fs.writeFileSync(pdf('replace'), 'original')
    const rename = fs.renameSync
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to).endsWith('manifest.json')) throw new Error('manifest denied')
      rename(from, to)
    })
    expect(() => transactions.run([{ id: 'replace', data: bytes('new') }], () => insert('new'))).toThrow('manifest denied')
    expect(rows()).toEqual([])
    expect(read('replace')).toBe('original')
    expect(fs.readdirSync(journalRoot)).toEqual([])
  })

  it('retains a stale committed marker when deleting it fails and retries later', () => {
    db.exec("CREATE TRIGGER reject_marker_delete BEFORE DELETE ON paper_file_transactions BEGIN SELECT RAISE(ABORT, 'marker delete denied'); END")
    transactions.run([{ id: 'new', data: bytes('committed') }], () => insert('new'))
    expect(rows()).toEqual([{ id: 'new' }])
    expect(read('new')).toBe('committed')
    expect(markers()).toHaveLength(1)
    expect(fs.readdirSync(journalRoot)).toEqual([])
    db.exec('DROP TRIGGER reject_marker_delete')
    transactions.recover()
    expect(markers()).toEqual([])
    expect(read('new')).toBe('committed')
  })

  it('preserves a committed quarantine if its replacement has unexpectedly disappeared', () => {
    const dir = interrupted([{ id: 'replace', hadOriginal: true, hasReplacement: true }], true)
    fs.writeFileSync(join(dir, 'old', 'replace.pdf'), 'original')
    expect(() => transactions.recover()).toThrow(/恢复|recover/i)
    expect(fs.readFileSync(join(dir, 'old', 'replace.pdf'), 'utf8')).toBe('original')
    expect(markers()).toHaveLength(1)
  })

  it('commits PDFs when the platform requires writable descriptors for fsync', () => {
    const open = fs.openSync
    const sync = fs.fsyncSync
    const close = fs.closeSync
    const readOnly = new Set<number>()
    vi.spyOn(fs, 'openSync').mockImplementation((path, flags, mode) => {
      const fd = open(path, flags, mode)
      const writable = typeof flags === 'number'
        ? !!(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR))
        : /[wa+]/.test(flags)
      if (!writable) readOnly.add(fd)
      return fd
    })
    vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
      if (readOnly.has(fd)) throw new Error('Windows FlushFileBuffers requires a writable handle')
      sync(fd)
    })
    vi.spyOn(fs, 'closeSync').mockImplementation((fd) => {
      close(fd)
      readOnly.delete(fd)
    })
    transactions.run([{ id: 'new', data: bytes('committed') }], () => insert('new'))
    expect(rows()).toEqual([{ id: 'new' }])
    expect(read('new')).toBe('committed')
    expect(markers()).toEqual([])
    expect(fs.readdirSync(journalRoot)).toEqual([])
  })

  it('rejects case aliases before mutation so rollback cannot overwrite the original quarantine', () => {
    fs.writeFileSync(pdf('foo'), 'ORIGINAL')
    simulateCaseInsensitiveFiles()
    db.exec("CREATE TRIGGER reject_marker BEFORE INSERT ON paper_file_transactions BEGIN SELECT RAISE(ABORT, 'commit rejected'); END")
    let mutated = false
    expect(() => transactions.run([
      { id: 'foo', data: bytes('REPLACEMENT') },
      { id: 'FOO', data: null },
    ], () => {
      mutated = true
      insert('new')
    })).toThrow(/重复|别名/)
    expect(mutated).toBe(false)
    expect(rows()).toEqual([])
    expect(read('foo')).toBe('ORIGINAL')
    expect(fs.readdirSync(journalRoot)).toEqual([])
  })

  it('rejects case aliases for destinations that do not exist yet', () => {
    simulateCaseInsensitiveFiles()
    expect(() => transactions.run([
      { id: 'foo', data: bytes('first') },
      { id: 'FOO', data: bytes('second') },
    ], () => insert('new'))).toThrow(/重复|别名/)
    expect(rows()).toEqual([])
    expect(fs.readdirSync(papers)).toEqual([])
  })

  it('rejects aliases when the quarantine directory alone folds case', () => {
    fs.writeFileSync(pdf('foo'), 'ORIGINAL')
    simulateCaseInsensitiveFiles(journalRoot)
    expect(() => transactions.run([
      { id: 'foo', data: null },
      { id: 'FOO', data: null },
    ], () => insert('new'))).toThrow(/重复|别名/)
    expect(rows()).toEqual([])
    expect(read('foo')).toBe('ORIGINAL')
  })

  it('keeps SQL and originals unchanged if checking filesystem case behavior fails', () => {
    fs.writeFileSync(pdf('foo'), 'ORIGINAL')
    const write = fs.writeFileSync
    vi.spyOn(fs, 'writeFileSync').mockImplementation((...args: Parameters<typeof write>) => {
      if (typeof args[0] === 'string' && basename(args[0]).startsWith('.papermind-case-')) {
        throw new Error('probe denied')
      }
      return write(...args)
    })
    expect(() => transactions.run([{ id: 'foo', data: null }], () => insert('new'))).toThrow('probe denied')
    expect(rows()).toEqual([])
    expect(read('foo')).toBe('ORIGINAL')
    vi.restoreAllMocks()
    transactions.run([{ id: 'foo', data: bytes('replaced') }], () => insert('new'))
    expect(read('foo')).toBe('replaced')
    expect(rows()).toEqual([{ id: 'new' }])
  })

  it.each([false, true])('preserves originals when a %s committed manifest contains case aliases', (committed) => {
    const dir = interrupted([
      { id: 'foo', hadOriginal: true, hasReplacement: true },
      { id: 'FOO', hadOriginal: true, hasReplacement: false },
    ], committed)
    fs.writeFileSync(join(dir, 'old', 'foo.pdf'), 'ORIGINAL')
    fs.writeFileSync(pdf('foo'), 'REPLACEMENT')
    simulateCaseInsensitiveFiles()
    expect(() => transactions.recover()).toThrow(/恢复/)
    expect(fs.readFileSync(join(dir, 'old', 'foo.pdf'), 'utf8')).toBe('ORIGINAL')
    expect(read('foo')).toBe('REPLACEMENT')
    expect(fs.existsSync(join(dir, 'manifest.json'))).toBe(true)
  })

  it('preserves distinct-case IDs when the actual paper directory supports them', () => {
    fs.writeFileSync(pdf('foo'), 'lowercase')
    const caseInsensitive = fs.existsSync(pdf('FOO'))
    const run = () => transactions.run([
      { id: 'foo', data: bytes('new lowercase') },
      { id: 'FOO', data: bytes('new uppercase') },
    ], () => {
      insert('foo')
      insert('FOO')
    })
    if (caseInsensitive) {
      expect(run).toThrow(/重复|别名/)
      expect(read('foo')).toBe('lowercase')
      expect(rows()).toEqual([])
    } else {
      run()
      expect(read('foo')).toBe('new lowercase')
      expect(read('FOO')).toBe('new uppercase')
      expect(rows()).toEqual([{ id: 'FOO' }, { id: 'foo' }])
    }
  })

  it('recovers after a journal probe could not be removed once', () => {
    fs.writeFileSync(pdf('foo'), 'ORIGINAL')
    const unlink = fs.unlinkSync
    let failed = false
    vi.spyOn(fs, 'unlinkSync').mockImplementation((path) => {
      if (!failed && typeof path === 'string' && dirname(path) === journalRoot
        && basename(path).startsWith('.papermind-case-')) {
        failed = true
        throw new Error('probe cleanup denied')
      }
      unlink(path)
    })
    expect(() => transactions.recover()).toThrow('probe cleanup denied')
    expect(fs.readdirSync(journalRoot)).toHaveLength(1)
    vi.restoreAllMocks()
    transactions.recover()
    expect(fs.readdirSync(journalRoot)).toEqual([])
    expect(read('foo')).toBe('ORIGINAL')
  })

  it.each(['papers', 'journal'])('cleans an empty UUID probe left by a crash in %s', (area) => {
    fs.mkdirSync(journalRoot)
    fs.writeFileSync(pdf('foo'), 'ORIGINAL')
    const probe = join(area === 'papers' ? papers : journalRoot, '.papermind-case-00000000-0000-4000-8000-000000000001')
    fs.writeFileSync(probe, '')
    transactions.recover()
    expect(fs.existsSync(probe)).toBe(false)
    expect(read('foo')).toBe('ORIGINAL')
    expect(fs.readdirSync(journalRoot)).toEqual([])
  })

  it.each(['content', 'directory', 'symlink', 'invalid-name'])('preserves a probe-like %s instead of deleting it', (kind) => {
    fs.mkdirSync(journalRoot)
    const name = kind === 'invalid-name'
      ? '.papermind-case-not-a-uuid'
      : '.papermind-case-00000000-0000-4000-8000-000000000001'
    const probe = join(journalRoot, name)
    const outside = join(root, 'outside')
    fs.writeFileSync(outside, 'PRESERVED')
    if (kind === 'directory') fs.mkdirSync(probe)
    else if (kind === 'symlink') fs.symlinkSync(outside, probe)
    else fs.writeFileSync(probe, kind === 'content' ? 'PRESERVED' : '')
    expect(() => transactions.recover()).toThrow(/恢复/)
    expect(fs.lstatSync(probe)).toBeDefined()
    if (kind === 'content') expect(fs.readFileSync(probe, 'utf8')).toBe('PRESERVED')
    expect(fs.readFileSync(outside, 'utf8')).toBe('PRESERVED')
  })
})
