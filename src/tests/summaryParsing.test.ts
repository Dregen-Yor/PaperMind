import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { createSummaryParser } from '../../electron/summaryParsing'
import { parseHtmlSummary } from '../../electron/htmlSummary'
import { OFFICIAL_DOCLING_CONFIG } from '../utils/doclingConfig'
import type { ParsedDocument } from '../utils/doclingDocument'

const document = (): ParsedDocument => ({ version: 1, warnings: [], items: [
  { id: 'text-1', kind: 'text', text: '完整的正文材料', caption: '', pages: [0], regions: [], images: [] },
] })
function fixture() {
  const records = new Map<string, any>()
  const assets = new Map<string, string>()
  const repository = {
    get: vi.fn((kind, id, slot) => records.get(`${kind}:${id}:${slot}`) ?? null),
    save: vi.fn(row => { records.set(`${row.kind}:${row.sourceId}:${row.slot}`, row); return row }),
    saveAsset: vi.fn((_kind, _id, data) => { const id = 'a'.repeat(64); assets.set(id, data); return id }),
    readAsset: vi.fn(id => assets.get(id) ?? null),
  }
  const deps = {
    repository, getCredentials: vi.fn(() => ({ apiKey: 'key' })),
    getOfficialConfig: vi.fn(() => OFFICIAL_DOCLING_CONFIG),
    readPaper: vi.fn(() => ({ base64: 'YQ==', title: '论文', name: 'paper.pdf' })),
    getSnapshot: vi.fn(() => ({ html: '<article><p>完整的正文材料</p></article>', title: '网页', finalUrl: 'https://example.org', capturedAt: 1, contentHash: 'html-hash', byteLength: 50 })),
    convertPdf: vi.fn(async () => document()), parseHtml: vi.fn(async () => document()),
  }
  return { ...deps, deps, parser: createSummaryParser(deps), records, assets }
}
describe('summary parsing boundary', () => {
  it('routes immutable HTML to native parsing and PDF to Docling', async () => {
    const f = fixture()
    const web = await f.parser.parse('web', 'snapshot')
    expect(web).toMatchObject({ kind: 'web', sourceId: 'snapshot', sourceHash: 'snapshot:html-hash:1', title: '网页' })
    expect(web.document.items[0].text).toBe('完整的正文材料')
    expect(f.convertPdf).not.toHaveBeenCalled()
    expect(f.parseHtml).toHaveBeenCalledWith(expect.objectContaining({ html: expect.stringContaining('<article>') }))
    const paper = await f.parser.parse('paper', 'paper')
    expect(paper.document.items[0].text).toBe('完整的正文材料')
    expect(f.convertPdf).toHaveBeenCalledWith(new Uint8Array([97]), 'paper.pdf', { apiKey: 'key' })
  })
  it('deduplicates parsing, persists source-owned images and hydrates cached assets', async () => {
    const f = fixture()
    const doc = document()
    doc.items.push({ id: 'picture-1', kind: 'picture', text: '', caption: '原图', pages: [0], regions: [], images: [{ data: 'data:image/png;base64,YQ==' }] })
    f.convertPdf.mockResolvedValue(doc)
    const [first, second] = await Promise.all([f.parser.parse('paper', 'p'), f.parser.parse('paper', 'p')])
    expect(f.convertPdf).toHaveBeenCalledTimes(1)
    expect(first).toEqual(second)
    expect(first.document.items[1].images[0]).toMatchObject({ data: 'data:image/png;base64,YQ==', assetId: 'a'.repeat(64) })
    expect(f.repository.save.mock.calls[0][0].payload).not.toContain('data:image')
    const cached = await f.parser.parse('paper', 'p')
    expect(cached.document.items[1].images[0].data).toBe('data:image/png;base64,YQ==')
    expect(f.convertPdf).toHaveBeenCalledTimes(1)
  })
  it('ignores legacy visual cache and invalidates changed official parser configuration', async () => {
    const f = fixture()
    f.records.set('paper:p:materials', { sourceHash: 'old', payload: JSON.stringify({ protocol: 'visual-materials-v2-padded-crops', items: [] }) })
    await f.parser.parse('paper', 'p')
    f.getOfficialConfig.mockReturnValue({ ...structuredClone(OFFICIAL_DOCLING_CONFIG), schemaVersion: 2 } as never)
    await f.parser.parse('paper', 'p')
    expect(f.convertPdf).toHaveBeenCalledTimes(2)
  })
  it('rebuilds webpage materials cached before Chrome archive images were supported', async () => {
    const f = fixture()
    const oldParserKey = createHash('sha256').update(JSON.stringify({ protocol: 'parsed-materials-v1', kind: 'web' })).digest('hex')
    f.records.set('web:snapshot:materials', {
      sourceHash: 'snapshot:html-hash:1',
      payload: JSON.stringify({ protocol: 'parsed-materials-v1', input: {
        kind: 'web', sourceId: 'snapshot', sourceHash: 'snapshot:html-hash:1',
        parserKey: oldParserKey, title: '网页', document: document(),
      } }),
    })
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
    const mime = [
      'MIME-Version: 1.0', 'Content-Type: multipart/related; boundary="ChromeBoundary--"', '',
      '--ChromeBoundary--', 'Content-Type: image/png', 'Content-Transfer-Encoding: base64',
      'Content-Location: https://example.org/chart.png', '', png, '--ChromeBoundary----', '',
    ].join('\r\n')
    const parser = createSummaryParser({
      ...f.deps,
      getSnapshot: () => ({ ...f.getSnapshot(), html: '<article><img src="/chart.png" alt="Original chart"></article>', archiveMhtml: Buffer.from(mime).toString('base64') }),
      parseHtml: parseHtmlSummary,
    })
    const result = await parser.parse('web', 'snapshot')
    const picture = result.document.items.find(item => item.kind === 'picture')
    expect(picture?.text).toBe('Original chart')
    expect(picture?.images[0]?.data).toMatch(/^data:image\/png;base64,/)
    expect(result.document.warnings).toEqual([])
  })
  it('rejects a replaced source before saving late parsing results', async () => {
    const f = fixture()
    f.convertPdf.mockImplementation(async () => {
      f.readPaper.mockReturnValue({ base64: 'Yg==', title: '新版', name: 'paper.pdf' })
      return document()
    })
    await expect(f.parser.parse('paper', 'p')).rejects.toThrow(/变化/)
    expect(f.repository.save).not.toHaveBeenCalled()
  })
  it('surfaces missing cached images instead of silently losing source material', async () => {
    const f = fixture()
    const doc = document()
    doc.items[0].images = [{ data: 'data:image/png;base64,YQ==' }]
    f.convertPdf.mockResolvedValue(doc)
    await f.parser.parse('paper', 'p')
    f.assets.clear()
    await f.parser.parse('paper', 'p')
    expect(f.convertPdf).toHaveBeenCalledTimes(2)
  })
})
