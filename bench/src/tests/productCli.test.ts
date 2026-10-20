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

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syntheticPdf } from '../../product-fixtures/smoke'

it('runs the real PDF and convertPdf entry against local fixture HTTP services with no SSH or paid calls', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'product-cli-'))
  const pdf = join(folder, 'synthetic.pdf')
  writeFileSync(pdf, syntheticPdf())
  const seen: Array<{ path: string; body: string }> = []
  const server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      seen.push({ path: req.url ?? '', body })
      res.setHeader('content-type', 'application/json')
      if (req.url === '/v1/convert/file') res.end(JSON.stringify({ status: 'success', document: { json_content: {
        texts: [{ self_ref: '#/texts/0', label: 'text', text: 'Our method uses lasers.', prov: [{ page_no: 1 }] }], body: { children: [{ $ref: '#/texts/0' }] },
      } } }))
      else if (req.url === '/v1/chat/completions') res.end(JSON.stringify({ choices: [{ message: { content: '摘要 {{cite:text-1-s1}}' }, finish_reason: 'stop' }] }))
      else { res.statusCode = 404; res.end('{}') }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing fixture server port')
    const baseUrl = `http://127.0.0.1:${address.port}`
    const run = await promisify(execFile)(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'bench/src/productCli.ts', '--task', 'summary', '--pdf', pdf, '--docling-url', baseUrl], {
      timeout: 30000, env: { ...process.env, BENCH_LLM_PROVIDER: 'openai', BENCH_LLM_MODEL: 'local-fixture-model', BENCH_LLM_REVISION: 'fixture-v1', BENCH_LLM_BASE_URL: baseUrl + '/v1', BENCH_LLM_API_KEY: 'local-test-key' },
    })
    const result = JSON.parse(run.stdout)
    expect(result.errors).toEqual([])
    expect(result.source.extraction).toBe('shared-pdfjs-extraction')
    expect(result.source.docling).toBe('remote-convertPdf-no-ssh')
    expect(result.source.pageCount).toBe(2)
    expect(result.summary.content).toContain('paper-source:')
    expect(result.identity.embedder).toBe('not-used-summary-only')
    expect(seen.map(item => item.path)).toEqual(['/v1/convert/file', '/v1/chat/completions'])
    expect(seen[0].body).toContain('%PDF-1.4')
    expect(JSON.parse(seen[1].body).messages[0].role).toBe('system')
    expect(run.stdout).not.toContain('local-test-key')
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    rmSync(folder, { recursive: true, force: true })
  }
}, 30000)

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
