import { it, expect } from 'vitest'
import { mkdtemp, appendFile, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRun, readRun } from '../localPdf/artifacts'
import { headerFixture, recordFixture } from './localPdfFixtures'
import { buildTocTree, validateTocTree } from '../localPdf/tocTree'
import type { TocCandidate } from '../localPdf/tocCandidates'
import { E_METHOD_CONFIGS, prepareHeadingRetrieval } from '../localPdf/headingRetrieval'
it('exclusively creates directories, persists rows, and rejects duplicates and corrupt tails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pdf runs ')); const out = join(root, 'run')
  const h = headerFixture(); h.status = 'running'
  const w = await createRun(out, h)
  await w.append(recordFixture())
  await expect(w.append(recordFixture())).rejects.toThrow(/duplicate/)
  await expect(createRun(out, h)).rejects.toThrow()
  await symlink(out, join(root, 'link'))
  await expect(createRun(join(root, 'link'), h)).rejects.toThrow()
  expect((await readRun(out)).header.status).toBe('incomplete')
  await appendFile(join(out, 'records.jsonl'), '{bad')
  await expect(readRun(out)).rejects.toThrow(/corrupt/)
})

it('persists immutable auditable D trees and creates no tree directory for runs without D', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pdf trees '))
  const h = headerFixture(['D']); h.status = 'running'; h.identity.tocTreeSha256 = 'tree'; h.identity.tocRoutingSha256 = 'routing'
  const writer = await createRun(join(root, 'd-run'), h)
  const candidate = (title: string, page: number): TocCandidate => ({ title, page, numbering: null, indent: 0, fontSize: 20, bold: true, source: 'heading' })
  const tree = buildTocTree({ paperId: 'p', pageCount: 2, outline: [], tocCandidates: [], headingCandidates: [candidate('Introduction', 0), candidate('Methods', 1)] })
  await writer.writeTree('p', tree)
  await expect(writer.writeTree('p', tree)).rejects.toThrow(/duplicate/)
  const raw = await readFile(join(root, 'd-run/trees/p.json'), 'utf8')
  expect(validateTocTree(JSON.parse(raw), 2)).toEqual(tree)
  expect(raw).not.toContain('body text')
  expect((await readRun(join(root, 'd-run'))).header.status).toBe('incomplete')

  const plain = await createRun(join(root, 'a-run'), headerFixture(['A']))
  await plain.append(recordFixture('A'))
  await expect(stat(join(root, 'a-run/trees'))).rejects.toThrow()
})

async function headingFixture() {
  const root = await mkdtemp(join(tmpdir(), 'pdf heading audit '))
  const out = join(root, 'run')
  const method = 'E-hybrid-k1' as const
  const header = headerFixture([method])
  header.identity.tocTreeSha256 = 'tree'
  header.identity.headingRetrievalSha256 = 'heading'
  const writer = await createRun(out, header)
  const pages = ['intro body', 'method body']
  const tree = buildTocTree({ paperId: 'p', pageCount: 2, headingCandidates: [], tocCandidates: [], outline: [
    { id: 'i', title: '1 Introduction', page: 0, children: [] },
    { id: 'm', title: '2 Method', page: 1, children: [] },
  ] })
  const embedder = { id: 'fixture', embedPassages: async (texts: string[]) => texts.map(() => new Float32Array([1, 0])), embedQuery: async () => new Float32Array([1, 0]) }
  const prepared = await prepareHeadingRetrieval(tree, pages, { countTokens: s => s.length, embedder }, E_METHOD_CONFIGS[method])
  const result = await prepared.retrieve('unknown')
  const record = recordFixture(method, 'q', { context: result.text, trace: result.trace, heading: result.heading })
  return { out, method, writer, tree, index: prepared.index, record }
}

it('validates E index provenance, method config, node ranges, and complete finite vectors before writing', async () => {
  const { out, method, writer, tree, index } = await headingFixture()
  await expect(writer.writeHeadingIndex(method, 'p', index)).rejects.toThrow()
  await writer.writeTree('p', tree)
  const corruptions = [
    { version: 'invalid' },
    { treeInputSha256: 'a'.repeat(64) },
    { config: { ...index.config, topK: 3 } },
    { configSha256: 'a'.repeat(64) },
    { embedderId: null },
    { nodes: index.nodes.map(n => ({ ...n, endPage: 9999 })) },
    { vectors: [[NaN, 0], [1, 0]] },
    { vectors: [[0, 0], [1, 0]] },
    { vectors: [[1, 0]] },
    { vectors: [[1, 0], [1]] },
    { vectors: new Array(2) },
  ]
  for (const change of corruptions) {
    await expect(writer.writeHeadingIndex(method, 'p', { ...index, ...change } as typeof index)).rejects.toThrow()
  }
  await writer.writeHeadingIndex(method, 'p', index)
  expect(JSON.parse(await readFile(join(out, 'headings', method, 'p.json'), 'utf8'))).toEqual(index)
  await expect(writer.writeHeadingIndex(method, 'p', index)).rejects.toThrow()
})

it('rejects completed E records without valid saved artifacts but retains failed index records', async () => {
  const { out, method, writer, tree, index, record } = await headingFixture()
  await expect(writer.append(record)).rejects.toThrow()
  await writeFile(join(out, 'records.jsonl'), JSON.stringify(record) + '\n')
  await expect(readRun(out)).rejects.toThrow()
  await writer.writeTree('p', tree)
  await expect(readRun(out)).rejects.toThrow()
  await writer.writeHeadingIndex(method, 'p', index)
  expect((await readRun(out)).records).toEqual([record])
  await writeFile(join(out, 'headings', method, 'p.json'), JSON.stringify({ ...index, vectors: [[null], [null]] }))
  await expect(readRun(out)).rejects.toThrow(/heading/)
  await rm(join(out, 'trees', 'p.json'))
  const failed = recordFixture(method, 'q', { retrievalStatus: 'failed', generationStatus: 'skipped', answer: '', heading: undefined, error: { stage: 'index', message: 'invalid heading vectors' } })
  await writeFile(join(out, 'records.jsonl'), JSON.stringify(failed) + '\n')
  expect((await readRun(out)).records).toEqual([JSON.parse(JSON.stringify(failed))])
})

it('binds completed E diagnostics to saved config, ranking, top-k selections, and tree ranges', async () => {
  const { out, method, writer, tree, index, record } = await headingFixture()
  await writer.writeTree('p', tree)
  await writer.writeHeadingIndex(method, 'p', index)
  const heading = record.heading!
  const corruptions = [
    { configSha256: 'a'.repeat(64) },
    { ranking: heading.ranking.map((n, i) => ({ ...n, nodeId: i === 0 ? 'n999' : n.nodeId })), selectedNodeIds: ['n999'], selectedRanges: [{ nodeId: 'n999', startPage: 0, endPage: 0 }] },
    { ranking: [...heading.ranking].reverse() },
    { ranking: heading.ranking.map(n => ({ ...n, score: n.score + 1 })) },
    { ranking: heading.ranking.map(n => ({ ...n, denseScore: null })) },
    { selectedNodeIds: ['n0', 'n1'], selectedRanges: [{ nodeId: 'n0', startPage: 0, endPage: 0 }, { nodeId: 'n1', startPage: 1, endPage: 1 }] },
    { selectedRanges: [{ nodeId: 'n0', startPage: 0, endPage: 9999 }] },
  ]
  for (const change of corruptions) {
    const invalid = { ...record, heading: { ...heading, ...change } }
    await expect(writer.append(invalid)).rejects.toThrow()
    await writeFile(join(out, 'records.jsonl'), JSON.stringify(invalid) + '\n')
    await expect(readRun(out)).rejects.toThrow()
  }
  await writeFile(join(out, 'records.jsonl'), '')
  await writer.append(record)
  expect((await readRun(out)).records).toEqual([record])
})
