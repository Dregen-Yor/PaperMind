import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { normalizePeerQa, PEERQA_DATASET_VERSION } from '../../src/datasets/peerqa'

const options = new Map<string, string>()
for (let i = 2; i < process.argv.length; i += 2) {
  const flag = process.argv[i]
  const value = process.argv[i + 1]
  if (!['--qa', '--papers', '--out', '--limit'].includes(flag) || !value || value.startsWith('--') || options.has(flag)) {
    throw new Error('Usage: npm run bench:peerqa:import -- --qa qa.jsonl --papers papers.jsonl [--out peerqa.jsonl] [--limit papers]')
  }
  options.set(flag, value)
}
if (!options.has('--qa') || !options.has('--papers')) throw new Error('--qa and --papers are required')
const limit = options.has('--limit') ? Number(options.get('--limit')) : undefined
if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) throw new Error('--limit must be a positive paper count')
const readRows = async (path: string): Promise<unknown[]> => (await readFile(path, 'utf8'))
  .split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as unknown)
const [qa, papers] = await Promise.all([readRows(options.get('--qa')!), readRows(options.get('--papers')!)])
const normalized = normalizePeerQa(qa, papers)
const samples = limit === undefined ? normalized.samples : normalized.samples.slice(0, limit)
if (samples.length === 0) throw new Error('No matching PeerQA paper texts; prepare the official papers.jsonl first')
const out = resolve(options.get('--out') ?? fileURLToPath(new URL('./peerqa.jsonl', import.meta.url)))
if ([options.get('--qa'), options.get('--papers')].some(path => resolve(path!) === out)) throw new Error('--out cannot overwrite the official inputs')
await mkdir(dirname(out), { recursive: true })
const temporary = `${out}.${process.pid}.tmp`
const serialized = samples.map(sample => JSON.stringify({ schemaVersion: PEERQA_DATASET_VERSION, sample })).join('\n') + '\n'
await writeFile(temporary, serialized, 'utf8')
await rename(temporary, out)
const metadata = { schemaVersion: PEERQA_DATASET_VERSION, ...normalized.preparation, importedPapers: samples.length,
  importedQuestions: samples.reduce((n, sample) => n + sample.questions.length, 0), datasetSha256: createHash('sha256').update(serialized).digest('hex') }
await writeFile(`${temporary}.metadata.json`, JSON.stringify(metadata, null, 2) + '\n', 'utf8')
await rename(`${temporary}.metadata.json`, `${out}.metadata.json`)
process.stdout.write(JSON.stringify({ ...metadata, output: out }, null, 2) + '\n')
