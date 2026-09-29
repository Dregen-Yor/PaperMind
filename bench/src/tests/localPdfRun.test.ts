import { it, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
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
  await prepareDataset({ root, split: 'dev', out: manifest }, { extract: async () => ({ pages: ['paragraph'], outline: [], layoutLines: [[]] }) as unknown as ExtractedPdfDocument })
  const client = { chatStream: async (_m: unknown, cb: (s:string)=>void) => { cb('Yes'); return { content: 'Yes' } } } as unknown as StreamingLlmClient
  let clock = 0
  const result = await runBenchmark(manifest, ['A', 'R'], join(root, 'run'), { runtime: { client, methodDeps: { countTokens: s => s.length }, identity: headerFixture().identity }, now: () => ++clock, score: scoreOfficial })
  expect(result.results[0].metrics.answerF1).toBe(1)
  expect(result.results[0].metrics.evidenceF1).toBe(1)
  expect(result.results[1].metrics.evidenceF1).toBeNull()
  expect((await reportRun(join(root, 'run'))).results).toEqual(result.results)
})
