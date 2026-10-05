import { readFile } from 'node:fs/promises'
import type { RawQasperDataset } from './types'
import { requireThat, uniqueIds } from './contract'
export async function readQasper(path: string): Promise<RawQasperDataset> {
  const data = JSON.parse(await readFile(path, 'utf8')) as RawQasperDataset
  requireThat(data && typeof data === 'object' && !Array.isArray(data), 'invalid QASPER object')
  const ids: string[] = []
  for (const [id, p] of Object.entries(data)) {
    requireThat(/^[\w.-]+$/.test(id) && !id.includes('..'), 'invalid paper ID')
    requireThat(typeof p.title === 'string' && Array.isArray(p.full_text) && Array.isArray(p.figures_and_tables) && Array.isArray(p.qas), 'invalid QASPER paper')
    for (const q of p.qas) {
      requireThat(typeof q.question === 'string' && Array.isArray(q.answers) && q.answers.length > 0, 'invalid QASPER question')
      ids.push(q.question_id)
    }
  }
  uniqueIds(ids)
  return data
}
