// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('product pipeline executable smoke', () => {
  it('runs the shared E-k5 and Docling algorithms fully offline and labels synthetic outputs', () => {
    const run = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'bench/src/productCli.ts', '--smoke'], { encoding: 'utf8', timeout: 30000 })
    expect(run.status, run.stderr).toBe(0)
    const result = JSON.parse(run.stdout)
    expect(result.schema).toBe('product-pipeline-bench-v1')
    expect(result.synthetic).toBe(true)
    expect(result.identity.retrieval).toBe('ek5-product-v1')
    expect(result.identity.budget).toEqual({ unit: 'characters', max: 120000 })
    expect(result.identity.summary).toBe('docling-abstract-v6')
    expect(result.qa[0].retrieval.hitPages.length).toBeGreaterThan(0)
    expect(result.qa[0].retrieval.selectedLeaves.length).toBeGreaterThan(0)
    expect(result.summary.content).toContain('paper-source:')
    expect(result.source.pdfSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(result.limitations.join(' ')).toContain('synthetic')
  })
})

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syntheticPdf } from '../../product-fixtures/smoke'

it('rejects the retired custom Docling endpoint option', () => {
  const folder = mkdtempSync(join(tmpdir(), 'product-cli-'))
  const pdf = join(folder, 'synthetic.pdf')
  writeFileSync(pdf, syntheticPdf())
  try {
    const run = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'bench/src/productCli.ts', '--task', 'summary', '--pdf', pdf, '--docling-url', 'http://127.0.0.1:5001'], { encoding: 'utf8', timeout: 30000 })
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('未知参数：--docling-url')
    expect(run.stdout).toBe('')
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})

it('rejects mismatched JSON before requiring models or making any requests', () => {
  const folder = mkdtempSync(join(tmpdir(), 'product-cli-hash-'))
  try {
    const pdf = join(folder, 'synthetic.pdf')
    const docling = join(folder, 'wrong.json')
    writeFileSync(pdf, syntheticPdf())
    writeFileSync(docling, JSON.stringify({ sourceSha256: 'wrong', document: {} }))
    const run = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'bench/src/productCli.ts', '--pdf', pdf, '--question', 'test', '--docling-json', docling], { encoding: 'utf8', timeout: 30000 })
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('sourceSha256')
    expect(run.stdout).toBe('')
  } finally { rmSync(folder, { recursive: true, force: true }) }
})
