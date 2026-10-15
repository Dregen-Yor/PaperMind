import { describe, expect, it } from 'vitest'
import { DEFAULT_DOCLING_SETTINGS, isParsedDocument, normalizeDoclingDocument, normalizeDoclingSettings } from '../utils/doclingDocument'

const prov = (page = 2, origin = 'BOTTOMLEFT') => [{ page_no: page, bbox: { l: 10, r: 90, t: origin === 'BOTTOMLEFT' ? 80 : 20, b: origin === 'BOTTOMLEFT' ? 20 : 80, coord_origin: origin } }]
const fixture = () => ({
  body: { children: [{ $ref: '#/pictures/0' }, { $ref: '#/texts/0' }, { $ref: '#/tables/0' }, { $ref: '#/texts/2' }] },
  pictures: [{ self_ref: '#/pictures/0', captions: [{ $ref: '#/texts/1' }], prov: prov(), image: { uri: 'data:image/png;base64,aGVsbG8=' } }],
  texts: [{ self_ref: '#/texts/0', label: 'section_header', text: 'Method', prov: prov() }, { self_ref: '#/texts/1', label: 'caption', text: 'Figure 1. Original caption' }, { self_ref: '#/texts/2', label: 'formula', text: 'x^2', prov: prov(2, 'TOPLEFT') }],
  tables: [{ self_ref: '#/tables/0', prov: prov(), data: { table_cells: [{ text: '95.2', start_row_offset_idx: 1, start_col_offset_idx: 0 }] } }],
  pages: { '2': { size: { width: 100, height: 100 } } },
})

describe('Docling document boundary', () => {
  it('follows body order and resolves captions without duplicating them', () => {
    const document = normalizeDoclingDocument(fixture())
    expect(document.items.map(i => i.kind)).toEqual(['picture', 'heading', 'table', 'formula'])
    expect(document.items.map(i => i.id)).toEqual(['picture-1', 'heading-1', 'table-1', 'formula-1'])
    expect(document.items[0].caption).toBe('Figure 1. Original caption')
    expect(document.items[2].text).toContain('95.2')
    expect(document.items[0].images[0].data).toBe('data:image/png;base64,aGVsbG8=')
  })
  it('normalizes pages and both coordinate origins', () => {
    const document = normalizeDoclingDocument(fixture())
    expect(document.items[0].pages).toEqual([1])
    expect(document.items[0].regions[0]).toMatchObject({ page: 1, x: .1, y: .2, width: .8 })
    expect(document.items[0].regions[0].height).toBeCloseTo(.6)
    expect(document.items[3].regions).toEqual(document.items[0].regions)
  })
  it('retains table-cell boxes for precise source links when Docling provides them', () => {
    const input = fixture()
    Object.assign(input.tables[0].data.table_cells[0], { bbox: { l: 30, r: 50, t: 55, b: 45, coord_origin: 'TOPLEFT' } })
    const document = normalizeDoclingDocument(input)
    expect(document.items[2].cells).toMatchObject([{ text: '95.2', region: { page: 1, x: .3, y: .45, width: .2 } }])
    expect(document.items[2].cells?.[0].region.height).toBeCloseTo(.1)
    expect(isParsedDocument(document)).toBe(true)
  })
  it('keeps unlocated text but never creates fake pages or fetches remote images', () => {
    const document = normalizeDoclingDocument({ texts: [{ text: 'Evidence' }], pictures: [{ image: { uri: 'https://example.com/image.png' } }] })
    expect(document.items.map(i => i.id)).toEqual(['text-1', 'picture-1'])
    expect(document.items[0].pages).toEqual([])
    expect(document.items[1].images).toEqual([])
  })
  it('guards cyclic groups and duplicate body references', () => {
    const input = { ...fixture(), groups: [{ children: [{ $ref: '#/groups/0' }, { $ref: '#/texts/0' }] }], body: { children: [{ $ref: '#/groups/0' }, { $ref: '#/texts/0' }] } }
    expect(normalizeDoclingDocument(input).items.filter(i => i.kind === 'heading')).toHaveLength(1)
  })
  it('numbers each kind independently in reading order and validates its type prefix', () => {
    const input = { ...fixture(), texts: [...fixture().texts, { text: 'Second paragraph', prov: prov() }], body: { children: [
      { $ref: '#/texts/0' }, { $ref: '#/pictures/0' }, { $ref: '#/texts/3' }, { $ref: '#/texts/2' }, { $ref: '#/tables/0' },
    ] } }
    const document = normalizeDoclingDocument(input)
    expect(document.items.map(i => i.id)).toEqual(['heading-1', 'picture-1', 'text-1', 'formula-1', 'table-1'])
    expect(isParsedDocument(document)).toBe(true)
    document.items[0].id = 'picture-2'
    expect(isParsedDocument(document)).toBe(false)
  })
  it('defaults unset deployment settings to the managed Docling endpoint and rejects invalid URLs', () => {
    expect(DEFAULT_DOCLING_SETTINGS.baseUrl).toBe('http://127.0.0.1:5001')
    expect(normalizeDoclingSettings(null).baseUrl).toBe(DEFAULT_DOCLING_SETTINGS.baseUrl)
    expect(normalizeDoclingSettings({ baseUrl: '' }).baseUrl).toBe(DEFAULT_DOCLING_SETTINGS.baseUrl)
    expect(() => normalizeDoclingSettings({ baseUrl: 'file:///tmp/model' })).toThrow('HTTP')
    expect(() => normalizeDoclingSettings({ timeoutSeconds: 2 })).toThrow('超时')
    expect(() => normalizeDoclingSettings({ baseUrl: 'https://user:secret@host' })).toThrow('凭据')
  })
})
