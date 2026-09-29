import { it, expect } from 'vitest'
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareDataset, verifyManifest } from '../localPdf/prepare'
import { goldFixture } from './localPdfFixtures'
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
