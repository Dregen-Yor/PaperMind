import { it, expect } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareDataset } from '../localPdf/prepare'
import { runBenchmark, reportRun } from '../localPdf/run'
import { scoreOfficial } from '../localPdf/scoring'
import { goldFixture, headerFixture } from './localPdfFixtures'
import type { ExtractedPdfDocument } from '../../../src/utils/pdfDocument'
import type { StreamingLlmClient } from '../llmClient'
it('runs PDF questions and recomputes six metrics offline with mock generation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pdf end to end ')); await mkdir(join(root, 'qasper-pdfs'))
  await writeFile(join(root, 'qasper-pdfs/p.pdf'), 'synthetic')
  await writeFile(join(root, 'qasper-dev-v0.3.json'), JSON.stringify(goldFixture()))
  const manifest = join(root, 'manifest.json')
  const line = (page: number, text: string) => ({ page, text, x: 0, y: 700, fontSize: 18, bold: true })
  await prepareDataset({ root, split: 'dev', out: manifest }, { extract: async () => ({ pages: ['paragraph', 'method body'], outline: [], layoutLines: [[line(0, '1 Introduction')], [line(1, '2 Methods')]] }) as unknown as ExtractedPdfDocument })
  const client = {
    complete: async () => '{"reasoning":"intro","node_ids":["n0"]}',
    chatStream: async (_m: unknown, cb: (s:string)=>void) => { cb('Yes'); return { content: 'Yes' } },
  } as unknown as StreamingLlmClient
  let clock = 0
  const identity = { ...headerFixture().identity, tocTreeSha256: 'tree', tocRoutingSha256: 'routing' }
  const result = await runBenchmark(manifest, ['A', 'D', 'R'], join(root, 'run'), { runtime: { client, methodDeps: { countTokens: s => s.length, routeToc: prompt => client.complete(prompt) }, identity }, now: () => ++clock, score: scoreOfficial })
  expect(result.results[0].metrics.answerF1).toBe(1)
  expect(result.results[0].metrics.evidenceF1).toBeCloseTo(2 / 3)
  expect(result.results[1].metrics.evidenceF1).toBe(1)
  expect(result.results[2].metrics.evidenceF1).toBeNull()
  const tree = JSON.parse(await readFile(join(root, 'run/trees/p.json'), 'utf8'))
  expect(tree.roots.map((node: { title: string }) => node.title)).toEqual(['1 Introduction', '2 Methods'])
  const records = (await readFile(join(root, 'run/records.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(records.find(record => record.method === 'D').routing.selectedNodeIds).toEqual(['n0'])
  expect((await reportRun(join(root, 'run'))).results).toEqual(result.results)
})

it('keeps A and R running while invalid D trees receive fixed-denominator zero scores', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pdf invalid tree ')); await mkdir(join(root, 'qasper-pdfs'))
  await writeFile(join(root, 'qasper-pdfs/p.pdf'), 'synthetic')
  await writeFile(join(root, 'qasper-dev-v0.3.json'), JSON.stringify(goldFixture()))
  const manifest = join(root, 'manifest.json')
  await prepareDataset({ root, split: 'dev', out: manifest }, { extract: async () => ({ pages: ['paragraph'], outline: [], layoutLines: [[]] }) as unknown as ExtractedPdfDocument })
  const client = { complete: async () => 'invalid', chatStream: async (_m: unknown, cb: (s:string)=>void) => { cb('Yes'); return { content: 'Yes' } } } as unknown as StreamingLlmClient
  const identity = { ...headerFixture().identity, tocTreeSha256: 'tree', tocRoutingSha256: 'routing' }
  const result = await runBenchmark(manifest, ['A', 'D', 'R'], join(root, 'run'), { runtime: { client, methodDeps: { countTokens: s => s.length, routeToc: prompt => client.complete(prompt) }, identity }, now: (() => { let n = 0; return () => ++n })(), score: scoreOfficial })
  const records = (await readFile(join(root, 'run/records.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(records.find(record => record.method === 'D')).toMatchObject({ error: { stage: 'index' }, generationStatus: 'skipped' })
  expect(records.filter(record => record.method !== 'D').every(record => record.generationStatus === 'completed')).toBe(true)
  expect(result.results.find(row => row.method === 'D')?.metrics).toMatchObject({ answerF1: 0, evidenceF1: 0 })
})

it('persists E heading indices and scores all frozen questions offline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pdf heading run ')); await mkdir(join(root, 'qasper-pdfs'))
  await writeFile(join(root, 'qasper-pdfs/p.pdf'), 'synthetic')
  await writeFile(join(root, 'qasper-dev-v0.3.json'), JSON.stringify(goldFixture()))
  const manifest = join(root, 'manifest.json')
  await prepareDataset({ root, split: 'dev', out: manifest }, { extract: async () => ({ pages: ['paragraph', 'method body'], outline: [
    { id: 'i', title: '1 Introduction', page: 0, children: [] }, { id: 'm', title: '2 Method', page: 1, children: [] },
  ], layoutLines: [[], []] }) as unknown as ExtractedPdfDocument })
  const client = { chatStream: async (_m: unknown, cb: (s: string) => void) => { cb('Yes'); return { content: 'Yes' } } } as unknown as StreamingLlmClient
  const embedder = { id: 'fixture', embedPassages: async (texts: string[]) => texts.map(() => new Float32Array([1, 0])), embedQuery: async () => new Float32Array([1, 0]) }
  const identity = { ...headerFixture().identity, tocTreeSha256: 'tree', headingRetrievalSha256: 'heading' }
  const out = join(root, 'run')
  const result = await runBenchmark(manifest, ['E-bm25-k3', 'E-hybrid-k1', 'R'], out, { runtime: { client, methodDeps: { countTokens: s => s.length, embedder }, identity }, now: (() => { let n = 0; return () => ++n })(), score: scoreOfficial })
  expect(result.results).toHaveLength(3)
  expect(result.results.every(row => row.metrics.answerF1 === 1 && row.qualityQuestionIds.length === 1)).toBe(true)
  const index = JSON.parse(await readFile(join(out, 'headings/E-hybrid-k1/p.json'), 'utf8'))
  expect(index.nodes.map((n: { path: string }) => n.path)).toEqual(['Introduction', 'Method'])
  expect(index.vectors).toEqual([[1, 0], [1, 0]])
  const records = (await readFile(join(out, 'records.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(records.find(record => record.method === 'E-hybrid-k1').heading.selectedNodeIds).toEqual(['n0'])
  expect((await reportRun(out)).results).toEqual(result.results)
})
