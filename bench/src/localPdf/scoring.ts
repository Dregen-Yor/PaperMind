import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import type { Method, QualityScores, QueryRecord, RawQasperDataset } from './types'
import { requireThat, uniqueIds, validateQueryRecord } from './contract'
import { benchPath } from '../paths'
const vendor = () => benchPath(import.meta.url, '../../vendor/qasper/')
export function evaluatorHash(): string {
  const expected = JSON.parse(readFileSync(resolve(vendor(), 'source.json'), 'utf8')).sha256 as string
  const actual = createHash('sha256').update(readFileSync(resolve(vendor(), 'evaluator.py'))).digest('hex')
  requireThat(actual === expected, 'official evaluator hash mismatch')
  return actual
}
export async function scoreOfficial(gold: RawQasperDataset, records: QueryRecord[], questionIds: string[], method: Method, python = process.env.BENCH_PYTHON ?? 'python3'): Promise<QualityScores> {
  evaluatorHash(); uniqueIds(questionIds)
  requireThat(questionIds.length > 0, 'empty scoring set')
  const selected = records.filter(r => r.method === method)
  uniqueIds(selected.map(r => r.questionId))
  const predictions: Record<string, { answer: string; evidence: string[] }> = {}
  for (const r of selected) {
    validateQueryRecord(r)
    requireThat(questionIds.includes(r.questionId), 'unexpected question ID')
    if (method !== 'R' && r.retrievalStatus !== 'completed') continue
    if (method === 'R' && r.generationStatus !== 'completed') continue
    requireThat(method === 'R' || r.evidence !== null, 'completed retrieval missing evidence')
    predictions[r.questionId] = { answer: r.generationStatus === 'completed' ? r.answer : '', evidence: r.evidence ?? [] }
  }
  const result = await new Promise<QualityScores>((resolveResult, reject) => {
    const child = spawn(python, ['-B', benchPath(import.meta.url, './score.py')], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('error', () => reject(new Error('Python 3 is required: set BENCH_PYTHON to its executable')))
    child.stdin.on('error', reject)
    child.on('close', code => {
      if (code !== 0) { reject(new Error(`Official scoring failed: ${stderr.slice(-2000)}`)); return }
      try { resolveResult(JSON.parse(stdout) as QualityScores) } catch { reject(new Error('Invalid official evaluator output')) }
    })
    child.stdin.end(JSON.stringify({ gold, ids: questionIds, predictions, method }))
  })
  requireThat(JSON.stringify(result.perQuestion.map(q => q.id)) === JSON.stringify(questionIds), 'scoring question mismatch')
  for (const r of [result, ...result.perQuestion]) {
    requireThat(Number.isFinite(r.answerF1) && r.answerF1 >= 0 && r.answerF1 <= 1, 'invalid Answer F1')
    requireThat(method === 'R' ? r.evidenceF1 === null : typeof r.evidenceF1 === 'number' && Number.isFinite(r.evidenceF1) && r.evidenceF1 >= 0 && r.evidenceF1 <= 1, 'invalid Evidence F1')
  }
  return result
}
