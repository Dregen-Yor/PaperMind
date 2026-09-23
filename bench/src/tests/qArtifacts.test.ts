import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, symlinkSync, linkSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { buildQComparison } from '../scoring/qComparison'
import { readBenchResult, readQSource, writeQArtifact } from '../scoring/qArtifacts'
import { qConfig, qFixture } from './qFixture'

const dirs: string[] = []
function tempDir(): string { const path = mkdtempSync(join(tmpdir(), 'q-artifact-')); dirs.push(path); return path }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('Q artifacts', () => {
  it('reads exact byte hash and retains arbitrary source data', () => {
    const dir = tempDir()
    const source = qFixture('reference', 'full-context') as unknown as Record<string, unknown>
    source.extra = { futureField: ['keep'] }
    const bytes = Buffer.from(JSON.stringify(source) + '\n')
    const input = join(dir, 'reference.json')
    writeFileSync(input, bytes)
    const loaded = readQSource(input)
    expect(loaded.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(loaded.name).toBe('reference.json')
    expect((loaded.data as Record<string, unknown>).extra).toEqual(source.extra)
    expect(readBenchResult(loaded.data)).toEqual(source)
  })

  it('writes all original inputs and full precision score for offline recalculation', () => {
    const dir = tempDir()
    const ref = qFixture('ref', 'full-context')
    const cand = qFixture('cand')
    const comparison = buildQComparison(ref, cand, qConfig)
    const artifact = { schemaVersion: 1, kind: 'papermind-q-comparison', comparison, inputs: {
      reference: { name: 'ref.json', sha256: 'a', data: ref },
      candidate: { name: 'cand.json', sha256: 'b', data: cand },
      config: { name: 'q.json', sha256: 'c', data: qConfig },
    } }
    const path = join(dir, 'q.json')
    writeQArtifact(path, artifact)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(artifact)
    const different = { ...qConfig, weights: { answerF1: 0.8, ttftP50: 0.1, ttftP95: 0.1 } }
    const recomputed = buildQComparison(ref, cand, different)
    expect(recomputed.config.weights).toEqual(different.weights)
    expect(artifact.inputs.reference.data).toEqual(ref)
    expect(artifact.inputs.candidate.data).toEqual(cand)
  })

  it.each(['api_key', 'apiKey', 'api-key', 'Authorization', 'accessToken', 'access_token', 'secret', 'password'])('rejects nested credential key %s without writing', key => {
    const path = join(tempDir(), 'blocked.json')
    expect(() => writeQArtifact(path, { nested: [{ [key]: 'sensitive' }] })).toThrow(/credential/i)
    expect(() => readFileSync(path)).toThrow()
  })

  it('never overwrites an existing file, symlink, or hard link', () => {
    const dir = tempDir()
    const target = join(dir, 'target.json')
    writeFileSync(target, 'original')
    for (const path of [target, join(dir, 'symlink.json'), join(dir, 'hardlink.json')]) {
      if (path.includes('symlink')) symlinkSync(target, path)
      if (path.includes('hardlink')) linkSync(target, path)
      expect(() => writeQArtifact(path, { safe: true })).toThrow(/exists|new path/i)
      expect(readFileSync(target, 'utf8')).toBe('original')
    }
  })

  it('reports missing parent and invalid JSON without echoing content', () => {
    const dir = tempDir()
    expect(() => writeQArtifact(join(dir, 'missing', 'q.json'), {})).toThrow(/parent|directory/i)
    const path = join(dir, 'bad.json')
    writeFileSync(path, '{sensitive-text')
    expect(() => readQSource(path)).toThrow(/JSON/)
    expect(() => readQSource(path)).not.toThrow(/sensitive-text/)
  })

  it('rejects malformed result envelope explicitly', () => {
    expect(() => readBenchResult({ meta: {}, config: {}, metrics: {}, perSample: [], errors: [], task: 'qa' })).toThrow(/config.name/)
    expect(() => readBenchResult({ ...qFixture('valid'), perSample: [{ id: 'x', metrics: null }] })).toThrow(/perSample/)
  })
})
