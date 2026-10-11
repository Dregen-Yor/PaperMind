// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { loadPeerQaDataset } from '../datasets/peerqa'
import { answerSha256, finalizePeerQaQuality } from '../metrics/peerqaQuality'
import type { BenchResult, PerSampleRecord } from '../types'

const invoke = (script: string, args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', script, ...args], { encoding: 'utf8', timeout: 15_000 })

describe('native PeerQA CLI artifacts', () => {
  it('imports official-format input through paths with spaces and reloads a validated frozen dataset', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'peerqa import '))
    try {
      const qa = join(dir, 'qa.jsonl')
      const papers = join(dir, 'papers.jsonl')
      const out = join(dir, 'normalized.jsonl')
      writeFileSync(qa, JSON.stringify({ paper_id: 'p', question_id: 'q', question: 'What?', answerable: true, answer_free_form: 'Result.', answer_evidence_mapped: [{ idx: [0] }] }) + '\n')
      writeFileSync(papers, JSON.stringify({ paper_id: 'p', idx: 0, pidx: 0, sidx: 0, type: 'sentence', content: 'Result.' }) + '\n')
      const imported = invoke('bench/datasets/peerqa/import.ts', ['--qa', qa, '--papers', papers, '--out', out])
      expect(imported.status, imported.stderr).toBe(0)
      expect((await loadPeerQaDataset(out))[0].questions[0].evidenceSentenceIds).toEqual(['p/0/0'])
      expect(JSON.parse(readFileSync(`${out}.metadata.json`, 'utf8')).datasetSha256).toBe(answerSha256(readFileSync(out, 'utf8')))
      expect(invoke('bench/datasets/peerqa/import.ts', ['--qa', qa, '--papers', papers, '--out', qa]).status).toBe(1)
      expect(readFileSync(qa, 'utf8')).toContain('answerable')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('scores only the exact serialized result and writes a new artifact without changing the source', () => {
    const dir = mkdtempSync(join(tmpdir(), 'peerqa scores '))
    try {
      const row: PerSampleRecord = { id: 'q', source: 'peerqa', paperId: 'p', metrics: {}, generationStatus: 'completed', answer: 'Result.' }
      const quality = finalizePeerQaQuality([row], [{ id: 'q', question: 'What?', answers: ['Result.'], evidencePages: [], unanswerable: false }])
      const result: BenchResult = { task: 'qa', config: { name: 'test' }, meta: { model: 'mock', gitSha: 'test', timestamp: 'now', completed: 1, total: 1, ...quality.meta }, metrics: quality.metrics, perSample: [row], errors: [] }
      const serialized = JSON.stringify(result, null, 2) + '\n'
      const source = join(dir, 'result.json')
      const scores = join(dir, 'scores.json')
      const out = join(dir, 'scored.json')
      writeFileSync(source, serialized)
      writeFileSync(scores, JSON.stringify({ schemaVersion: 1, sourceResultSha256: answerSha256(serialized), alignScoreModel: 'AlignScore-large', scores: [{ questionId: 'q', answerSha256: answerSha256(row.answer!), alignScore: 0.9 }] }))
      const scored = invoke('bench/datasets/peerqa/score.ts', ['--result', source, '--scores', scores, '--out', out])
      expect(scored.status, scored.stderr).toBe(0)
      expect(JSON.parse(readFileSync(out, 'utf8')).metrics.peerqaAlignScore).toBe(0.9)
      expect(invoke('bench/datasets/peerqa/score.ts', ['--result', source, '--scores', scores, '--out', source]).status).toBe(1)
      expect(readFileSync(source, 'utf8')).toBe(serialized)
      const compared = invoke('bench/src/cli.ts', ['--compare', source, out])
      expect(compared.status, compared.stderr).toBe(0)
      expect(compared.stdout).toContain('PeerQA 对比')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
