// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { paperContentUrl, paperIdFromUrl, storedPaperFilePath, servePaperRequest } from '../../electron/paperProtocol'

describe('local paper protocol', () => {
  it('round trips an encoded paper ID and rejects unrelated URLs', () => {
    expect(paperIdFromUrl(paperContentUrl('paper:1'))).toBe('paper:1')
    for (const url of [
      'papermind-paper://other/paper:1',
      'papermind-paper://paper/a/b',
      'papermind-paper://paper/..%2Fsecret',
      'papermind-paper://paper/a?file=secret',
      'file:///tmp/secret.pdf',
    ]) expect(paperIdFromUrl(url)).toBeNull()
  })

  it('only serves an existing file stored at its expected paper path', () => {
    const root = mkdtempSync(join(tmpdir(), 'papermind-protocol-'))
    try {
      const papersDir = join(root, 'papers')
      mkdirSync(papersDir)
      const file = join(papersDir, 'a.pdf')
      writeFileSync(file, '%PDF-1.4')
      expect(storedPaperFilePath('a', file, papersDir)).toBe(realpathSync(file))
      expect(storedPaperFilePath('a', join(root, 'secret.pdf'), papersDir)).toBeNull()
      expect(storedPaperFilePath('../secret', file, papersDir)).toBeNull()
      expect(storedPaperFilePath('missing', join(papersDir, 'missing.pdf'), papersDir)).toBeNull()
      const external = join(root, 'secret.pdf')
      writeFileSync(external, 'secret')
      const link = join(papersDir, 'link.pdf')
      symlinkSync(external, link)
      expect(storedPaperFilePath('link', link, papersDir)).toBeNull()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('forwards a range request and returns a PDF response with renderer access', async () => {
    const fetchFile = async (_url: string, headers: Headers) => {
      expect(_url).toBe('file:///tmp/a.pdf')
      expect(headers.get('Range')).toBe('bytes=0-99')
      return new Response('pdf bytes', { status: 206, headers: { 'Content-Range': 'bytes 0-8/9' } })
    }
    const request = new Request(paperContentUrl('a'), { headers: { Range: 'bytes=0-99' } })
    const response = await servePaperRequest(request, id => id === 'a' ? '/tmp/a.pdf' : null, fetchFile)
    expect(response.status).toBe(206)
    expect(response.headers.get('Content-Type')).toBe('application/pdf')
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(response.headers.get('Content-Range')).toBe('bytes 0-8/9')
    expect(await response.text()).toBe('pdf bytes')
    const missing = await servePaperRequest(new Request(paperContentUrl('missing')), () => null, fetchFile)
    expect(missing.status).toBe(404)
  })
})
