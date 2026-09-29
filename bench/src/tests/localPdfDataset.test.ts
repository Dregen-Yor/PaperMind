import { it, expect } from 'vitest'
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareDataset, verifyManifest } from '../localPdf/prepare'
import { goldFixture } from './localPdfFixtures'
import type { ExtractedPdfDocument } from '../../../src/utils/pdfDocument'
it('freezes original IDs, missing PDFs and parse failures without losing questions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pdf dataset '))
  await mkdir(join(root, 'qasper-pdfs'))
  const g = goldFixture(); g.missing = { ...g.p, qas: [{ ...g.p.qas[0], question_id: 'missing' }] }
  await writeFile(join(root, 'qasper-dev-v0.3.json'), JSON.stringify(g))
  await writeFile(join(root, 'qasper-pdfs/p.pdf'), 'not a PDF')
  const out = join(root, 'manifest.json')
  const m = await prepareDataset({ root, split: 'dev', out }, { extract: async () => { throw new Error('parse failed') } })
  expect(m.parserVersion).toMatch(/^pdfjs:.*:sources:[a-f0-9]{64}$/)
  expect(m.questions.map(q => q.id)).toEqual(['q'])
  expect(m.papers[0].parseStatus).toBe('failed')
  expect(m.excluded[0].questionIds).toEqual(['missing'])
  expect(await verifyManifest(out)).toEqual(m)
  await expect(prepareDataset({ root, split: 'dev', out })).rejects.toThrow()
  await writeFile(join(root, 'qasper-pdfs/p.pdf'), 'changed')
  await expect(verifyManifest(out)).rejects.toThrow(/hash/)
  expect(JSON.parse(await readFile(out, 'utf8')).questions).toHaveLength(1)
})

it('freezes layout lines and rejects a page-count mismatch', async () => {
  const makeRoot = async () => {
    const root = await mkdtemp(join(tmpdir(), 'pdf layout dataset '))
    await mkdir(join(root, 'qasper-pdfs'))
    await writeFile(join(root, 'qasper-dev-v0.3.json'), JSON.stringify(goldFixture()))
    await writeFile(join(root, 'qasper-pdfs/p.pdf'), 'synthetic')
    return root
  }
  const line = { page: 0, text: 'Introduction', x: 20, y: 700, fontSize: 18, bold: true }
  const firstRoot = await makeRoot(); const firstOut = join(firstRoot, 'manifest.json')
  const first = await prepareDataset({ root: firstRoot, split: 'dev', out: firstOut }, {
    extract: async () => ({ pages: ['Introduction'], outline: [], layoutLines: [[line]] }),
  })
  const firstFiles = JSON.parse(await readFile(first.papers[0].prepared.path, 'utf8'))
  const firstCorpus = JSON.parse(await readFile(firstFiles.corpus.path, 'utf8'))
  expect(firstCorpus.layoutLines).toEqual([[line]])

  const secondRoot = await makeRoot(); const secondOut = join(secondRoot, 'manifest.json')
  const second = await prepareDataset({ root: secondRoot, split: 'dev', out: secondOut }, {
    extract: async () => ({ pages: ['Introduction'], outline: [], layoutLines: [[{ ...line, fontSize: 19 }]] }),
  })
  const secondFiles = JSON.parse(await readFile(second.papers[0].prepared.path, 'utf8'))
  expect(secondFiles.corpus.sha256).not.toBe(firstFiles.corpus.sha256)
  expect(second.fingerprint).not.toBe(first.fingerprint)

  const mismatchRoot = await makeRoot(); const mismatchOut = join(mismatchRoot, 'manifest.json')
  const mismatch = await prepareDataset({ root: mismatchRoot, split: 'dev', out: mismatchOut }, {
    extract: async () => ({ pages: ['Introduction'], outline: [], layoutLines: [[line], []] }) as ExtractedPdfDocument,
  })
  expect(mismatch.papers[0]).toMatchObject({ parseStatus: 'failed', parseError: expect.stringMatching(/layout/i) })
})
