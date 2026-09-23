import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { qConfig, qFixture } from './qFixture'
import { aggregateSpeedMetrics } from '../speed/metrics'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function run(argv: string[]): string {
  return execFileSync(process.execPath, ['--import', 'tsx', 'bench/src/cli.ts', ...argv], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 30_000,
    env: {
      ...process.env,
      BENCH_LLM_PROVIDER: 'invalid-provider',
      BENCH_LLM_MODEL: '',
      BENCH_LLM_API_KEY: '',
      BENCH_LLM_BASE_URL: 'http://127.0.0.1:1',
      BENCH_JUDGE_MODEL: '',
      BENCH_QA_THINKING: 'invalid',
      BENCH_QA_REQUEST_TIMEOUT_MS: 'invalid',
      BENCH_EXECUTION_BACKEND: '',
    },
  })
}

describe('offline Q CLI', () => {
  it('compares without an API key, exports only on --out, and recalculates new weights from the same source bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'q-cli-')); dirs.push(dir)
    const ref = join(dir, 'ref.json')
    const cand = join(dir, 'cand.json')
    const cfg = join(dir, 'config.json')
    const out1 = join(dir, 'out1.json')
    const out2 = join(dir, 'out2.json')
    const reference = qFixture('reference', 'full-context')
    const candidate = qFixture('candidate')
    reference.perSample[1].answer = 'yes'
    reference.perSample[1].metrics.answerF1AllQuestions = 1
    reference.metrics.answerF1AllQuestions = 1
    candidate.perSample[0].speed!.timeToFirstTokenMs = 50
    candidate.perSample[1].speed!.timeToFirstTokenMs = 100
    candidate.perSample[0].speed!.fullAnswerLatencyMs = 100
    candidate.perSample[1].speed!.fullAnswerLatencyMs = 150
    Object.assign(candidate.metrics, aggregateSpeedMetrics(candidate.perSample))
    writeFileSync(ref, JSON.stringify(reference))
    writeFileSync(cand, JSON.stringify(candidate))
    writeFileSync(cfg, JSON.stringify(qConfig))
    const before = readdirSync(dir).sort()
    expect(run(['--compare', ref, cand, '--q-config', cfg])).toContain('Q')
    expect(readdirSync(dir).sort()).toEqual(before)
    expect(run(['--compare', ref, cand, '--q-config', cfg, '--out', out1])).toContain('Q')
    const artifact1 = JSON.parse(readFileSync(out1, 'utf8'))
    expect(artifact1.kind).toBe('papermind-q-comparison')
    expect(artifact1.inputs.reference.data).toEqual(reference)
    expect(artifact1.inputs.candidate.data).toEqual(candidate)
    expect(artifact1.comparison.score).toBeCloseTo(100 * 2 ** -0.2)
    const changed = { ...qConfig, weights: { answerF1: 0.8, ttftP50: 0.1, ttftP95: 0.1 } }
    writeFileSync(cfg, JSON.stringify(changed))
    run(['--compare', ref, cand, '--q-config', cfg, '--out', out2])
    const artifact2 = JSON.parse(readFileSync(out2, 'utf8'))
    expect(artifact2.comparison.config.weights).toEqual(changed.weights)
    expect(artifact2.comparison.score).toBeCloseTo(100 * 2 ** -0.6)
    expect(artifact2.inputs.reference.sha256).toBe(artifact1.inputs.reference.sha256)
    expect(artifact2.inputs.candidate.sha256).toBe(artifact1.inputs.candidate.sha256)
  })

  it('shows unavailable Q for a tampered numeric metric without a raw TypeError', () => {
    const dir = mkdtempSync(join(tmpdir(), 'q-cli-')); dirs.push(dir)
    const ref = join(dir, 'ref.json')
    const cand = join(dir, 'cand.json')
    const cfg = join(dir, 'config.json')
    writeFileSync(ref, JSON.stringify(qFixture('reference', 'full-context')))
    const bad = qFixture('candidate')
    ;(bad.metrics as Record<string, unknown>).answerF1AllQuestions = 'bad'
    writeFileSync(cand, JSON.stringify(bad))
    writeFileSync(cfg, JSON.stringify(qConfig))
    const output = run(['--compare', ref, cand, '--q-config', cfg])
    expect(output).toContain('Q 不可用')
    expect(output).toContain('answerF1AllQuestions')
  })
})
