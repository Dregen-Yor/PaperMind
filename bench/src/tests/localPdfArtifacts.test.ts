import { it, expect } from 'vitest'
import { mkdtemp, appendFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRun, readRun } from '../localPdf/artifacts'
import { headerFixture, recordFixture } from './localPdfFixtures'
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
