import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, open, lstat } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import type { ExtractedPdfDocument } from '../../../src/utils/pdfDocument'
import type { FileIdentity, Manifest, RawQasperDataset, Split } from './types'
import { SCHEMA, hashCanonical, requireThat, validateManifest } from './contract'
import { readQasper } from './dataset'
import { alignCanonical } from './alignment'
async function parserIdentity(): Promise<string> {
  const require = createRequire(import.meta.url)
  const version = (JSON.parse(await readFile(require.resolve('pdfjs-dist/package.json'), 'utf8')) as { version: string }).version
  const sources = await Promise.all(['pdfDocument.ts', 'pdfOutline.ts'].map(name => readFile(require.resolve(`../../../src/utils/${name}`), 'utf8')))
  return `pdfjs:${version}:sources:${hashCanonical(sources)}`
}
export interface PreparedFiles { corpus: FileIdentity | null; alignment: FileIdentity | null; parseError?: string }
export async function fileIdentity(path: string): Promise<FileIdentity> {
  return { path: resolve(path), sha256: createHash('sha256').update(await readFile(path)).digest('hex') }
}
export async function verifyFile(file: FileIdentity): Promise<void> {
  requireThat((await fileIdentity(file.path)).sha256 === file.sha256, `file hash mismatch: ${file.path}`)
}
export async function writeJson(path: string, value: unknown): Promise<FileIdentity> {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
  return fileIdentity(path)
}
export async function verifyManifest(path: string): Promise<Manifest> {
  const m = validateManifest(JSON.parse(await readFile(path, 'utf8')))
  const { fingerprint, ...content } = m
  requireThat(hashCanonical(content) === fingerprint, 'manifest hash mismatch')
  for (const f of [m.dataset, m.gold, ...m.papers.flatMap(p => [p.pdf, p.prepared])]) await verifyFile(f)
  for (const p of m.papers) {
    const files = JSON.parse(await readFile(p.prepared.path, 'utf8')) as PreparedFiles
    if (p.parseStatus === 'completed') requireThat(files.corpus && files.alignment, 'missing prepared data')
    for (const f of [files.corpus, files.alignment]) if (f) await verifyFile(f)
  }
  return m
}
export async function prepareDataset(opts: { root: string; split: Split; out: string; limitPapers?: number }, deps?: { extract: (base64: string) => Promise<ExtractedPdfDocument> }): Promise<Manifest> {
  requireThat(['train', 'dev'].includes(opts.split), 'invalid split')
  requireThat(opts.limitPapers === undefined || Number.isInteger(opts.limitPapers) && opts.limitPapers > 0, 'invalid limit')
  const root = resolve(opts.root); const out = resolve(opts.out); const assets = `${out}.assets`
  const dataset = await fileIdentity(join(root, `qasper-${opts.split}-v0.3.json`))
  const data = await readQasper(dataset.path)
  await mkdir(dirname(out), { recursive: true })
  const reservation = await open(out, 'wx'); await reservation.close()
  await mkdir(assets)
  const extract = deps?.extract ?? (await import('../../../src/utils/pdfDocument')).extractPdfDocument
  const papers: Manifest['papers'] = []; const questions: Manifest['questions'] = []; const excluded: Manifest['excluded'] = []
  const gold: RawQasperDataset = {}
  for (const id of Object.keys(data).sort()) {
    const p = data[id]; const pdfPath = join(root, 'qasper-pdfs', `${id}.pdf`)
    const stat = await lstat(pdfPath).catch(e => { if (e.code === 'ENOENT') return null; throw e })
    if (!stat || opts.limitPapers !== undefined && papers.length >= opts.limitPapers) {
      excluded.push({ paperId: id, questionIds: p.qas.map(q => q.question_id), reason: !stat ? 'missing-pdf' : 'development-limit' }); continue
    }
    const pdf = await fileIdentity(pdfPath); const dir = join(assets, id); await mkdir(dir)
    gold[id] = p
    questions.push(...p.qas.map(q => ({ id: q.question_id, paperId: id, question: q.question })))
    let doc: ExtractedPdfDocument | undefined; let parseError: string | undefined
    try {
      doc = await extract((await readFile(pdfPath)).toString('base64'))
      requireThat(doc.pages.some(page => page.trim().length > 0), 'PDF has no extractable text')
    } catch (error) { parseError = error instanceof Error ? error.message : String(error) }
    const files: PreparedFiles = { corpus: null, alignment: null }
    if (doc && !parseError) {
      files.corpus = await writeJson(join(dir, 'corpus.json'), { paperId: id, pages: doc.pages, outline: doc.outline })
      files.alignment = await writeJson(join(dir, 'alignment.json'), alignCanonical(doc.pages, { full_text: p.full_text, figures_and_tables: p.figures_and_tables }))
    } else files.parseError = parseError
    papers.push({ id, pdf, questionIds: p.qas.map(q => q.question_id), prepared: await writeJson(join(dir, 'paper.json'), files), parseStatus: parseError ? 'failed' : 'completed', ...(parseError ? { parseError } : {}) })
  }
  const content = { schema: SCHEMA, split: opts.split, subset: opts.limitPapers !== undefined, dataset, gold: await writeJson(join(assets, 'gold.json'), gold), papers, questions, excluded, parserVersion: await parserIdentity(), alignmentVersion: 'canonical-pdf-v1' }
  const m: Manifest = { ...content, fingerprint: hashCanonical(content) }
  validateManifest(m)
  await writeFile(out, JSON.stringify(m, null, 2) + '\n')
  return m
}
