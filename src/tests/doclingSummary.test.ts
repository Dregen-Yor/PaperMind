import { describe, expect, it, vi } from 'vitest'
import { convertPdf, convertPdfForSummary } from '../../electron/doclingClient'
import { MAX_IMAGE_BYTES, isParsedDocument, normalizeDoclingDocument } from '../utils/doclingDocument'

const image = 'data:image/png;base64,aGVsbG8='
const source = () => ({
  body: { children: [{ $ref: '#/texts/0' }, { $ref: '#/pictures/0' }, { $ref: '#/tables/0' }] },
  texts: [{ self_ref: '#/texts/0', label: 'section_header', text: '方法', level: 2 }],
  pictures: [
    { self_ref: '#/pictures/0', caption: '图一：工作流程', image: { uri: image } },
    { self_ref: '#/pictures/1', content_layer: 'furniture', image: { uri: image } },
    { self_ref: '#/pictures/2', image: { uri: image } },
  ],
  tables: [{
    self_ref: '#/tables/0',
    data: {
      num_rows: 3, num_cols: 2,
      table_cells: [
        { text: '组别', start_row_offset_idx: 0, start_col_offset_idx: 0, end_row_offset_idx: 1, end_col_offset_idx: 2, column_header: true, row_header: false },
        { text: '实验', start_row_offset_idx: 1, start_col_offset_idx: 0, row_span: 2, col_span: 1, column_header: false, row_header: true },
        { text: '0.95', start_row_offset_idx: 1, start_col_offset_idx: 1, row_span: 1, col_span: 1, column_header: false, row_header: false },
        { text: '', start_row_offset_idx: 2, start_col_offset_idx: 1, row_span: 1, col_span: 1, column_header: false, row_header: false },
      ],
    },
  }],
})

describe('Docling materials for document summaries', () => {
  it('keeps all pictures, including Chinese captions, uncaptioned images and non-body images', () => {
    const document = normalizeDoclingDocument(source(), { preserveAllPictures: true })
    expect(document.items.filter(item => item.kind === 'picture').map(item => ({ id: item.id, caption: item.caption, data: item.images[0]?.data }))).toEqual([
      { id: 'picture-1', caption: '图一：工作流程', data: image },
      { id: 'picture-2', caption: '', data: image },
      { id: 'picture-3', caption: '', data: image },
    ])
    expect(normalizeDoclingDocument(source()).items.some(item => item.kind === 'picture')).toBe(false)
    expect(isParsedDocument(document)).toBe(true)
  })

  it('preserves unlinked captions that explain table units and error bars', () => {
    const raw = source()
    raw.texts.push({ self_ref: '#/texts/1', label: 'caption', text: 'Accuracy in percent; parentheses denote stddev; same test split', level: 0 })
    raw.body.children.push({ $ref: '#/texts/1' })
    const summary = normalizeDoclingDocument(raw, { preserveAllPictures: true })
    expect(summary.items.some(item => item.text.includes('parentheses denote stddev'))).toBe(true)
    expect(normalizeDoclingDocument(raw).items.some(item => item.text.includes('parentheses denote stddev'))).toBe(false)
  })

  it('retains heading levels and the complete table grid, merged cells and header flags', () => {
    const document = normalizeDoclingDocument(source(), { preserveAllPictures: true })
    expect(document.items[0]).toMatchObject({ kind: 'heading', level: 2 })
    expect(document.items.find(item => item.kind === 'table')?.table).toEqual({
      numRows: 3, numCols: 2,
      cells: [
        { text: '组别', row: 0, column: 0, rowSpan: 1, colSpan: 2, columnHeader: true, rowHeader: false },
        { text: '实验', row: 1, column: 0, rowSpan: 2, colSpan: 1, columnHeader: false, rowHeader: true },
        { text: '0.95', row: 1, column: 1, rowSpan: 1, colSpan: 1, columnHeader: false, rowHeader: false },
        { text: '', row: 2, column: 1, rowSpan: 1, colSpan: 1, columnHeader: false, rowHeader: false },
      ],
    })
  })

  it('keeps unavailable pictures as source items with an explicit warning', () => {
    const document = normalizeDoclingDocument({ pictures: [{ image: { uri: 'https://example.test/figure.png' } }] }, { preserveAllPictures: true })
    expect(document.items).toMatchObject([{ id: 'picture-1', kind: 'picture', images: [] }])
    expect(document.warnings.join()).toMatch(/picture-1.*图片/)
    expect(isParsedDocument(document)).toBe(true)
  })

  it('rejects oversized embedded images instead of silently dropping summary evidence', () => {
    const input = { pictures: [{ image: { uri: `data:image/png;base64,${'A'.repeat(Math.ceil(MAX_IMAGE_BYTES * 1.4))}` } }] }
    expect(() => normalizeDoclingDocument(input, { preserveAllPictures: true })).toThrow(/图片.*上限/)
  })

  it('rejects malformed table coordinates instead of losing cells in summary mode', () => {
    const input = source()
    input.tables[0].data.table_cells[0].start_col_offset_idx = -1
    expect(() => normalizeDoclingDocument(input, { preserveAllPictures: true })).toThrow(/表格.*结构/)
  })

  it('accepts legacy cached documents and validates the optional structured fields', () => {
    const document = normalizeDoclingDocument({ texts: [{ text: 'Legacy paragraph' }] })
    expect(isParsedDocument(document)).toBe(true)
    const table = {
      id: 'table-1', kind: 'table', text: '', caption: '', pages: [], regions: [], images: [], anchor: 'table-original',
      table: { numRows: 1, numCols: 1, cells: [{ text: '1', row: 0, column: 0, rowSpan: 1, colSpan: 1, columnHeader: false, rowHeader: false }] },
    }
    expect(isParsedDocument({ version: 1, items: [table], warnings: [] })).toBe(true)
    for (const invalid of [
      { ...table, anchor: 12 },
      { ...table, level: 2 },
      { ...table, table: { ...table.table, numRows: -1 } },
      { ...table, table: { ...table.table, cells: [{ ...table.table.cells[0], rowSpan: 2 }] } },
      { ...table, table: { ...table.table, cells: [{ ...table.table.cells[0], columnHeader: 'yes' }] } },
      { ...table, table: null },
    ]) expect(isParsedDocument({ version: 1, items: [invalid], warnings: [] })).toBe(false)
    expect(isParsedDocument({ version: 1, items: [{ ...table, id: 'heading-1', kind: 'heading', table: undefined, level: 0 }], warnings: [] })).toBe(false)
  })
})

describe('Docling summary conversion', () => {
  const credentials = { apiKey: 'official-key' }
  const response = (status = 'success') => new Response(JSON.stringify({ status, document: { json_content: source() } }))

  it('uploads PDFs using the same official parsing contract', async () => {
    const request = vi.fn().mockResolvedValue(response())
    const document = await convertPdfForSummary(new Uint8Array([37, 80, 68, 70]), 'study.pdf', credentials, request)
    const [url, init] = request.mock.calls[0]
    expect(url).toBe('https://docling.example.com/v1/convert/file')
    expect(Object.fromEntries(init.body.entries())).toMatchObject({
      layout_preset: 'layout_heron_default', ocr_engine: 'rapidocr', ocr_preset: 'rapidocr',
      table_structure_preset: 'tableformer_v1_accurate', code_formula_preset: 'codeformulav2',
      do_ocr: 'true', do_formula_enrichment: 'true', do_table_structure: 'true',
      include_images: 'true', image_export_mode: 'embedded',
      from_formats: 'pdf', to_formats: 'json', target_type: 'inbody',
      images_scale: '2', table_mode: 'accurate', document_timeout: '60',
    })
    expect(init.body.get('files').name).toBe('study.pdf')
    expect(document.items.filter(item => item.kind === 'picture')).toHaveLength(3)
  })

  it('rejects partial conversions instead of generating a purportedly complete summary', async () => {
    await expect(convertPdfForSummary(new Uint8Array(), 'study.pdf', credentials, vi.fn().mockResolvedValue(response('partial_success')))).rejects.toThrow(/部分.*完整摘要/)
    expect((await convertPdf(new Uint8Array(), 'study.pdf', credentials, vi.fn().mockResolvedValue(response('partial_success')))).warnings.join()).toContain('部分')
  })

  it('rejects oversized uploads and failed summary conversions', async () => {
    const request = vi.fn().mockResolvedValue(response('failure'))
    await expect(convertPdfForSummary(new Uint8Array(64 * 1024 * 1024 + 1), 'large.pdf', credentials, request)).rejects.toThrow('上传大小上限')
    expect(request).not.toHaveBeenCalled()
    await expect(convertPdfForSummary(new Uint8Array(), 'study.pdf', credentials, request)).rejects.toThrow('解析失败')
  })
})
