// @vitest-environment node
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { SCHEMA } from '../../electron/db/schema'
import { createDocumentSummaryRepository, validateDocumentSummaryBackup } from '../../electron/db/documentSummary'
import { createSummaryParser } from '../../electron/summaryParsing'
import { parseHtmlSummary } from '../../electron/htmlSummary'
import { convertPdfForSummary } from '../../electron/doclingClient'
import { useVisualSummaryStore } from '../stores/visualSummary'
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0ioAAAAASUVORK5CYII='
const profile = { id: 'p', name: '', provider: 'openai' as const, model: 'summary-model', apiKey: 'test-key', baseUrl: 'https://llm.example/v1', temperature: 0.2, maxTokens: 0, topK: 0, systemPrompt: '' }
const originalDb = window.db
afterEach(() => { window.db = originalDb; vi.unstubAllGlobals() })

it.each(['paper', 'web'] as const)('parses %s, generates once, persists source-owned originals, and reloads after store recreation', async kind => {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON'); db.exec(SCHEMA)
  db.prepare('INSERT INTO knowledge_bases(id,name,created_at) VALUES (?,?,?)').run('kb', 'Library', 0)
  db.prepare('INSERT INTO papers(id,knowledge_base_id,file_name,file_path,added_at) VALUES (?,?,?,?,?)').run('source', 'kb', 'paper.pdf', '/tmp/paper.pdf', 0)
  db.prepare('INSERT INTO web_pages(id,canonical_url,title,created_at,last_opened_at) VALUES (?,?,?,?,?)').run('web', 'https://example.org/', 'Page', 0, 0)
  db.prepare('INSERT INTO web_snapshots(id,page_id,final_url,title,html,captured_at,content_hash,byte_length,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('source', 'web', 'https://example.org/', 'Page', '<p>Archived</p>', 1, 'web-hash', 12, 1)
  const repository = createDocumentSummaryRepository(db)
  let uploads = 0
  const doclingResponse = {
    status: 'success', document: { json_content: {
      pages: { '1': { size: { width: 100, height: 100 } } },
      body: { children: [{ $ref: '#/texts/0' }, { $ref: '#/pictures/0' }, { $ref: '#/tables/0' }] },
      texts: [{ label: 'section_header', text: 'Full archived evidence', level: 2, prov: [{ page_no: 1 }] }],
      pictures: [{ image: { uri: png }, prov: [{ page_no: 1 }] }],
      tables: [{ data: { num_rows: 1, num_cols: 1, table_cells: [{ text: '93.2%', start_row_offset_idx: 0, end_row_offset_idx: 1, start_col_offset_idx: 0, end_col_offset_idx: 1, column_header: false, row_header: false }] }, prov: [{ page_no: 1 }] }],
    } },
  }
  const parser = createSummaryParser({
    repository, getSettings: () => ({ baseUrl: 'http://127.0.0.1:5001' }),
    readPaper: () => ({ base64: Buffer.from('%PDF-test').toString('base64'), name: 'paper.pdf', title: 'Paper' }),
    getSnapshot: () => ({ html: `<article><h2 id="results">Full archived evidence</h2><table><tr><td>93.2%</td></tr></table><img alt="Result" src="${png}"></article>`, title: 'Page', finalUrl: 'https://example.org/', capturedAt: 1, contentHash: 'web-hash', byteLength: 100 }),
    parseHtml: parseHtmlSummary,
    convertPdf: (bytes, name, settings) => convertPdfForSummary(bytes, name, settings, async (_url, init) => {
      uploads++
      expect((init!.body as FormData).get('layout_preset')).toBe('layout_heron_default')
      return new Response(JSON.stringify(doclingResponse), { headers: { 'Content-Type': 'application/json' } })
    }),
  })
  window.db = { ...originalDb, documentSummary: {
    parse: parser.parse, get: async (...args) => repository.get(...args), save: async record => repository.save(record),
    saveAsset: async (...args) => repository.saveAsset(...args), readAsset: async id => repository.readAsset(id),
  } }
  const requests: any[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const body = JSON.parse(init!.body as string)
    requests.push(body)
    const parts = body.messages[1].content
    expect(parts[0].text).toContain('Full archived evidence')
    expect(parts[0].text).toContain('93.2%')
    expect(parts.filter((part: any) => part.type === 'image_url')).toHaveLength(1)
    const assetId = repository.exportBackup().assets[0].id
    return new Response(JSON.stringify({ choices: [{ message: { content: `结论为 93.2%。\n\n> \\[x^2\\]\n\n\`\\(literal\\)\`\n\n![原图](asset:${assetId})` }, finish_reason: 'stop' }] }), { headers: { 'Content-Type': 'application/json' } })
  }))
  try {
    setActivePinia(createPinia())
    const input = await parser.parse(kind, 'source')
    const result = await useVisualSummaryStore().generate(input, profile)
    expect(result.content).toContain('93.2%')
    expect(result.content).toContain('asset:')
    expect(result.content).toContain('> \\[x^2\\]')
    expect(result.content).toContain('`\\(literal\\)`')
    const backup = repository.exportBackup()
    expect(backup.assets[0]).toMatchObject({ kind, sourceId: 'source', data: png })
    expect(repository.get(kind, 'source', 'materials')!.payload).not.toContain('data:image')
    validateDocumentSummaryBackup(backup)
    setActivePinia(createPinia())
    const reloaded = await useVisualSummaryStore().generate(await parser.parse(kind, 'source'), profile)
    expect(reloaded.content).toBe(result.content)
    expect(requests).toHaveLength(1)
    expect(uploads).toBe(kind === 'paper' ? 1 : 0)
  } finally { db.close() }
})
