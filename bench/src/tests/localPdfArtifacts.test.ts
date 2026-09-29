import { it, expect } from 'vitest'
import { mkdtemp, appendFile, readFile, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRun, readRun } from '../localPdf/artifacts'
import { headerFixture, recordFixture } from './localPdfFixtures'
import { buildTocTree, validateTocTree } from '../localPdf/tocTree'
import type { TocCandidate } from '../localPdf/tocCandidates'
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
