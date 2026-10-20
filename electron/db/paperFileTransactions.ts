import type Database from 'better-sqlite3'
import fs from 'fs'
import { randomUUID } from 'crypto'
import { dirname, join, resolve } from 'path'
import { isSafePaperId } from '../paperProtocol'

export interface PaperFileChange {
  id: string
  data: Uint8Array | null
}

interface ManifestEntry {
  id: string
  hadOriginal: boolean
  hasReplacement: boolean
}

interface Manifest {
  version: 1
  id: string
  entries: ManifestEntry[]
}

const transactionId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const caseProbePrefix = '.papermind-case-'

function stat(path: string) {
  try {
    return fs.lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function fileExists(path: string): boolean {
  const value = stat(path)
  if (value && !value.isFile()) throw new Error(`论文文件路径无效: ${path}`)
  return !!value
}

function directory(path: string, create = false) {
  if (create && !stat(path)) fs.mkdirSync(path)
  const value = stat(path)
  if (!value?.isDirectory()) throw new Error(`论文事务目录无效: ${path}`)
}

function writeDurable(path: string, data: Uint8Array | string) {
  fs.writeFileSync(path, data, { flag: 'wx' })
  // Windows FlushFileBuffers requires a handle opened with write access.
  const fd = fs.openSync(path, 'r+')
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

function readManifest(path: string, id: string, fileKey: (id: string) => string): Manifest {
  const value = JSON.parse(fs.readFileSync(path, 'utf8'))
  if (!value || value.version !== 1 || value.id !== id || !Array.isArray(value.entries)) {
    throw new Error('论文事务清单损坏')
  }
  const seen = new Set<string>()
  for (const entry of value.entries) {
    if (!entry || !isSafePaperId(entry.id) || seen.has(fileKey(entry.id))
      || typeof entry.hadOriginal !== 'boolean' || typeof entry.hasReplacement !== 'boolean') {
      throw new Error('论文事务清单损坏')
    }
    seen.add(fileKey(entry.id))
  }
  return value as Manifest
}

/**
 * A synchronous coordinator for the app's single SQLite/file writer.
 * The SQL marker is committed with the mutation; manifests contain IDs only.
 * Call recover at startup before exposing DB APIs. Do not wrap run in a SQL
 * transaction: a savepoint release is not a durable commit.
 */
export function createPaperFileTransactions(db: Database.Database, papersDir: string) {
  const paperRoot = resolve(papersDir)
  const journalRoot = join(dirname(paperRoot), '.paper-file-transactions')
  let running = false
  let caseInsensitive: boolean | undefined
  const fileKey = (id: string) => caseInsensitive ? id.toLowerCase() : id
  const target = (id: string) => join(paperRoot, `${id}.pdf`)
  const staged = (dir: string, area: 'old' | 'new', id: string) => join(dir, area, `${id}.pdf`)
  const marker = (id: string) => db.prepare('SELECT id FROM paper_file_transactions WHERE id = ?').get(id)

  function foldsCase(path: string): boolean {
    const name = `${caseProbePrefix}${randomUUID()}`
    const probe = join(path, name)
    // Exclusively create a unique probe; never overwrite a user file. The
    // result applies even when none of the requested PDFs exist yet.
    fs.writeFileSync(probe, '', { flag: 'wx' })
    try {
      return !!stat(join(path, name.toUpperCase()))
    } finally {
      fs.unlinkSync(probe)
    }
  }

  function cleanupCaseProbes(path: string) {
    for (const name of fs.readdirSync(path)) {
      if (!name.startsWith(caseProbePrefix) || !transactionId.test(name.slice(caseProbePrefix.length))) continue
      const probe = join(path, name)
      const value = stat(probe)
      if (!value?.isFile() || value.size !== 0) throw new Error(`大小写探测文件异常，已保留: ${probe}`)
      fs.unlinkSync(probe)
    }
  }

  function recoveryError(error: unknown): Error {
    return new Error(`论文文件恢复失败，恢复资料已保留在 ${journalRoot}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }

  function validateFiles(dir: string, manifest: Manifest, committed = false) {
    for (const area of ['old', 'new'] as const) {
      const path = join(dir, area)
      if (committed && !stat(path)) continue
      directory(path)
      const allowed = new Set(manifest.entries
        .filter(entry => area === 'old' ? entry.hadOriginal : entry.hasReplacement)
        .map(entry => fileKey(`${entry.id}.pdf`)))
      for (const name of fs.readdirSync(path)) {
        if (!allowed.has(fileKey(name))) throw new Error('论文事务清单与恢复文件不匹配')
        fileExists(join(path, name))
      }
    }
    // Validate the entire manifest before the first recovery mutation.
    for (const entry of manifest.entries) {
      fileExists(target(entry.id))
      fileExists(staged(dir, 'old', entry.id))
      fileExists(staged(dir, 'new', entry.id))
    }
  }

  function rollback(dir: string, manifest: Manifest) {
    validateFiles(dir, manifest)
    for (const entry of [...manifest.entries].reverse()) {
      const old = staged(dir, 'old', entry.id)
      const dest = target(entry.id)
      if (entry.hadOriginal) {
        if (fileExists(old)) {
          if (fileExists(dest)) fs.unlinkSync(dest)
          fs.renameSync(old, dest)
        } else if (!fileExists(dest)) {
          // Neither an untouched/restored original nor its quarantine remains.
          throw new Error(`原论文文件缺失: ${entry.id}`)
        }
      } else if (entry.hasReplacement && !fileExists(staged(dir, 'new', entry.id))) {
        if (fileExists(dest)) fs.unlinkSync(dest)
      }
    }
  }

  function cleanup(dir: string, id: string) {
    // Remove the manifest first, only after rollback has restored every
    // original (or SQL has committed). Otherwise partial directory cleanup
    // could leave a rollback manifest whose old/new folders no longer exist.
    const manifest = join(dir, 'manifest.json')
    if (fileExists(manifest)) fs.unlinkSync(manifest)
    // Keep the marker until all quarantine files are removed. If cleanup dies
    // midway, even a missing manifest still means the new files are committed.
    fs.rmSync(dir, { recursive: true, force: true })
    db.prepare('DELETE FROM paper_file_transactions WHERE id = ?').run(id)
  }

  function recover() {
    if (running || db.inTransaction) throw new Error('论文文件恢复必须在独立事务外执行')
    try {
      directory(paperRoot)
      directory(journalRoot, true)
      // A process can stop after creating a probe and before its finally block.
      // Only our exact UUID names with empty regular files are safe to remove.
      cleanupCaseProbes(paperRoot)
      cleanupCaseProbes(journalRoot)
      // Check both locations: per-directory filesystem settings can differ,
      // and quarantine aliases are just as dangerous as destination aliases.
      if (caseInsensitive === undefined) {
        const papersFoldCase = foldsCase(paperRoot)
        const journalFoldsCase = foldsCase(journalRoot)
        caseInsensitive = papersFoldCase || journalFoldsCase
      }
      for (const id of fs.readdirSync(journalRoot)) {
        if (!transactionId.test(id)) throw new Error('论文事务目录名称无效')
        const dir = join(journalRoot, id)
        directory(dir)
        const committed = !!marker(id)
        const manifestPath = join(dir, 'manifest.json')
        if (fileExists(manifestPath)) {
          const manifest = readManifest(manifestPath, id, fileKey)
          if (committed) {
            validateFiles(dir, manifest, true)
            // Cleanup may already have removed old/new directories, so only
            // validate the surviving committed destination files here.
            for (const entry of manifest.entries) {
              const exists = fileExists(target(entry.id))
              if (entry.hasReplacement && !exists) throw new Error(`已提交的论文文件缺失: ${entry.id}`)
            }
          } else {
            rollback(dir, manifest)
          }
        } else if (!committed) {
          const old = join(dir, 'old')
          if (stat(old)) {
            directory(old)
            if (fs.readdirSync(old).length) throw new Error('缺少清单但仍有原论文文件')
          }
        }
        cleanup(dir, id)
      }
      // A crash between deleting the directory and deleting its marker is safe.
      for (const row of db.prepare('SELECT id FROM paper_file_transactions').all() as Array<{ id: string }>) {
        if (!transactionId.test(row.id)) throw new Error('论文事务标记无效')
        if (!stat(join(journalRoot, row.id))) {
          db.prepare('DELETE FROM paper_file_transactions WHERE id = ?').run(row.id)
        }
      }
    } catch (error) {
      throw recoveryError(error)
    }
  }

  function run<T>(changes: PaperFileChange[], mutate: () => T): T {
    recover()
    const seen = new Set<string>()
    const entries = changes.map(change => {
      if (!isSafePaperId(change.id) || seen.has(fileKey(change.id))) throw new Error('论文 ID 无效或重复（文件路径别名）')
      if (change.data !== null && !(change.data instanceof Uint8Array)) throw new Error('论文文件数据无效')
      seen.add(fileKey(change.id))
      return { id: change.id, hadOriginal: fileExists(target(change.id)), hasReplacement: change.data !== null }
    })
    const id = randomUUID()
    const dir = join(journalRoot, id)
    const manifest: Manifest = { version: 1, id, entries }
    let prepared = false
    running = true
    let result: T
    try {
      fs.mkdirSync(dir)
      fs.mkdirSync(join(dir, 'new'))
      fs.mkdirSync(join(dir, 'old'))
      for (const change of changes) {
        if (change.data !== null) writeDurable(staged(dir, 'new', change.id), change.data)
      }
      // Publish the complete manifest atomically; no managed file has moved yet.
      writeDurable(join(dir, 'manifest.tmp'), JSON.stringify(manifest))
      fs.renameSync(join(dir, 'manifest.tmp'), join(dir, 'manifest.json'))
      prepared = true
      result = db.transaction(() => {
        const value = mutate()
        if (value && typeof (value as { then?: unknown }).then === 'function') {
          throw new Error('论文文件事务不支持异步操作')
        }
        for (const entry of entries) {
          if (fileExists(target(entry.id)) !== entry.hadOriginal) throw new Error('论文文件在事务期间发生变化')
          if (entry.hadOriginal) fs.renameSync(target(entry.id), staged(dir, 'old', entry.id))
          if (entry.hasReplacement) fs.renameSync(staged(dir, 'new', entry.id), target(entry.id))
        }
        db.prepare('INSERT INTO paper_file_transactions (id) VALUES (?)').run(id)
        return value
      })()
    } catch (error) {
      try {
        if (prepared) rollback(dir, manifest)
        cleanup(dir, id)
      } catch (rollbackError) {
        throw recoveryError(new AggregateError([error, rollbackError], `${String(error)}; ${String(rollbackError)}`))
      }
      throw error
    } finally {
      running = false
    }
    // The operation has succeeded. Cleanup failure must not invite callers to
    // retry an already committed mutation; the next recover will finish it.
    try {
      cleanup(dir, id)
    } catch {
      // Leave the journal and/or marker intact for a later recovery attempt.
    }
    return result
  }

  return { run, recover }
}
