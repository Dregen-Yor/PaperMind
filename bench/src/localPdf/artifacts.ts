import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { QueryRecord, RunHeader, RunSummary } from './types'
import { requireThat, validateHeader, validateQueryRecord, validateRunSummary } from './contract'
import { safeError } from './errors'
import { validateTocTree, type TocTreeArtifact } from './tocTree'
import { isHeadingMethod, type HeadingIndexArtifact, type HeadingMethod } from './headingRetrieval'
export interface RunWriter {
  append(record: QueryRecord): Promise<void>
  writeTree(paperId: string, tree: TocTreeArtifact): Promise<void>
  writeHeadingIndex(method: HeadingMethod, paperId: string, index: HeadingIndexArtifact): Promise<void>
  finish(summary: RunSummary): Promise<void>
}
async function atomicJson(path: string, value: unknown) {
  const temp = `${path}.tmp`
  const f = await open(temp, 'wx')
  try { await f.writeFile(JSON.stringify(value, null, 2) + '\n'); await f.sync() } finally { await f.close() }
  await rename(temp, path)
}
export async function createRun(out: string, header: RunHeader): Promise<RunWriter> {
  validateHeader(header); out = resolve(out)
  await mkdir(out)
  await writeFile(join(out, 'header.json'), JSON.stringify(header, null, 2) + '\n', { flag: 'wx' })
  await writeFile(join(out, 'records.jsonl'), '', { flag: 'wx' })
  const seen = new Set<string>()
  const seenTrees = new Set<string>()
  return {
    append: async record => {
      validateQueryRecord(record)
      requireThat(header.methods.includes(record.method) && header.expectedQuestionIds.includes(record.questionId), 'unexpected record')
      const key = `${record.method}:${record.questionId}`
      requireThat(!seen.has(key), 'duplicate record')
      const safe = { ...record, ...(record.error ? { error: { ...record.error, message: safeError(record.error.message) } } : {}) }
      const f = await open(join(out, 'records.jsonl'), 'a')
      try { await f.writeFile(JSON.stringify(safe) + '\n'); await f.sync() } finally { await f.close() }
      seen.add(key)
    },
    writeTree: async (paperId, tree) => {
      requireThat(header.methods.includes('D') || header.methods.some(isHeadingMethod), 'trees require D or E')
      requireThat(typeof paperId === 'string' && paperId.length > 0
        && !paperId.includes('/') && !paperId.includes('\\') && paperId !== '.' && paperId !== '..', 'invalid tree paper ID')
      requireThat(tree.paperId === paperId && !seenTrees.has(paperId), 'duplicate or mismatched paper tree')
      const nodes = tree.roots.flatMap(function flatten(node): TocTreeArtifact['roots'] { return [node, ...node.children.flatMap(flatten)] })
      const pageCount = Math.max(...nodes.map(node => node.endPage)) + 1
      validateTocTree(tree, pageCount)
      await mkdir(join(out, 'trees'), { recursive: true })
      const path = join(out, 'trees', `${paperId}.json`)
      const file = await open(path, 'wx')
      try { await file.writeFile(JSON.stringify(tree, null, 2) + '\n'); await file.sync() } finally { await file.close() }
      seenTrees.add(paperId)
    },
    writeHeadingIndex: async (method, paperId, index) => {
      requireThat(isHeadingMethod(method) && header.methods.includes(method), 'unknown heading method')
      requireThat(paperId.length > 0 && !paperId.includes('/') && !paperId.includes('\\') && paperId !== '.' && paperId !== '..', 'invalid heading paper ID')
      const dir = join(out, 'headings', method)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, `${paperId}.json`), JSON.stringify(index, null, 2) + '\n', { flag: 'wx' })
    },
    finish: async summary => {
      validateRunSummary(summary)
      requireThat(summary.header.runId === header.runId, 'run identity mismatch')
      await atomicJson(join(out, 'summary.json'), summary)
      await atomicJson(join(out, 'header.json'), summary.header)
    },
  }
}
export async function readRun(out: string): Promise<{ header: RunHeader; records: QueryRecord[] }> {
  const header = JSON.parse(await readFile(join(out, 'header.json'), 'utf8')) as RunHeader
  validateHeader(header)
  const text = await readFile(join(out, 'records.jsonl'), 'utf8')
  requireThat(!text || text.endsWith('\n'), 'corrupt records.jsonl: incomplete last line')
  let records: QueryRecord[]
  try { records = text.split('\n').filter(Boolean).map(line => validateQueryRecord(JSON.parse(line))) }
  catch { throw new Error('corrupt records.jsonl') }
  const seen = new Set<string>()
  for (const r of records) {
    requireThat(header.methods.includes(r.method) && header.expectedQuestionIds.includes(r.questionId), 'unexpected record')
    const key = `${r.method}:${r.questionId}`; requireThat(!seen.has(key), 'duplicate record'); seen.add(key)
  }
  if (header.status === 'running' || records.length < header.expectedQuestionIds.length * header.methods.length) header.status = 'incomplete'
  return { header, records }
}
