import { describe, expect, it, vi } from 'vitest'
import { buildEvidenceChunks, generateDoclingAbstract, materializeAbstract } from '../utils/doclingAbstract'
import { normalizeDoclingDocument } from '../utils/doclingDocument'
import { renderMarkdown } from '../utils/markdown'
const document = () => {
  const doc = normalizeDoclingDocument({ texts: [{ text: 'Research evidence', prov: [{ page_no: 2 }] }], pictures: [{ captions: [], prov: [{ page_no: 2 }] }] })
  doc.items[1].caption = 'Figure 1. Results'
  doc.items[1].images = [{ assetId: 'a'.repeat(64), page: 1 }]
  return doc
}
describe('illustrated abstract evidence and references', () => {
  it('materializes only known assets and citations with accurate source pages', () => {
    const result = materializeAbstract('Result {{asset:item-1}} {{cite:item-0}} {{cite:invented}} ![bad](https://example.com/bad.png)', document(), 'paper')
    expect(result.content).toContain('asset:' + 'a'.repeat(64))
    expect(result.content).toContain('paper-source:paper:1')
    expect(result.content).not.toContain('example.com')
    expect(result.content).not.toContain('invented')
    expect(result.sources).toContainEqual(expect.objectContaining({ paperId: 'paper', startPage: 1 }))
  })
  it('rejects model-made application links before validating evidence IDs', () => {
    const result = materializeAbstract('![fake](asset:' + 'b'.repeat(64) + ') [fake](paper-source:other:999) ![remote][pic]\n[pic]: https://example.com/image.png', document(), 'paper')
    expect(result.content).not.toContain('paper-source:other')
    expect(result.content).not.toContain('asset:' + 'b'.repeat(64))
    expect(result.content).not.toContain('![remote]')
  })
  it('rejects encoded application destinations and reference links after Markdown decoding', () => {
    const raw = `[invented](paper-source&#58;other&#58;999) [escaped](paper-source\\:other\\:998) [reference][source]\n\n[source]: paper-source&#58;other&#58;997\n\n![invented](asset&#58;${'b'.repeat(64)})\n\n{{cite:item-0}}`
    const result = materializeAbstract(raw, document(), 'paper')
    const html = renderMarkdown(result.content)
    expect(html).not.toContain('data-paper-id="other"')
    expect(html).not.toContain('data-asset-id="' + 'b'.repeat(64))
    expect(html).toContain('data-paper-id="paper"')
    expect(result.sources).toEqual([{ label: 'p2', paperId: 'paper', startPage: 1, endPage: 1 }])
  })
  it('never creates a page link for unlocated evidence', () => {
    const doc = document(); doc.items[0].pages = []
    const result = materializeAbstract('{{cite:item-0}}', doc, 'paper')
    expect(result.content).not.toContain('paper-source')
    expect(result.sources).toEqual([])
  })
  it('cannot synthesize a new source link by joining text around removed markup', () => {
    const doc = document(); doc.items[0].pages = []
    for (const middle of ['![remove](https://example.com/image.png)', '{{cite:unknown}}', '{{cite:item-0}}']) {
      const result = materializeAbstract(`[invented]${middle}(paper-source:other:999)`, doc, 'paper')
      expect(renderMarkdown(result.content)).not.toContain('data-paper-id="other"')
      expect(result.sources).toEqual([])
    }
  })
  it('carries all text through bounded chunks without passing image bytes to the model', () => {
    const doc = document(); doc.items[0].text = 'x'.repeat(1000) + 'TAIL'
    const chunks = buildEvidenceChunks(doc, 300)
    expect(chunks.every(c => c.length <= 300)).toBe(true)
    expect(chunks.join('')).toContain('TAIL')
    expect(chunks.join('')).not.toContain('data:image')
  })
  it('uses detailed Chinese instructions and preserves truncation for continuation', async () => {
    const llm = vi.fn().mockResolvedValue({ content: '# 解读\n{{asset:item-1}} {{cite:item-0}}', truncated: true })
    const result = await generateDoclingAbstract(document(), 'paper', 'Title', llm)
    expect(llm.mock.calls[0][0][0].content).toContain('中文')
    expect(result.truncated).toBe(true)
    expect(result.content).toContain('Figure 1')
  })
  it('falls back to the original region when an extracted formula is invalid', () => {
    const doc = document(); doc.items[1].kind = 'formula'; doc.items[1].text = '\\unknowncommand'
    const result = materializeAbstract('{{asset:item-1}}', doc, 'paper')
    expect(result.content).toContain('asset:')
    expect(result.content).not.toContain('$$')
  })
  it('fails clearly when map output is truncated instead of silently losing evidence', async () => {
    const doc = document(); doc.items[0].text = 'Evidence '.repeat(4000)
    await expect(generateDoclingAbstract(doc, 'paper', 'Title', vi.fn().mockResolvedValue({ content: 'partial', truncated: true }))).rejects.toThrow('截断')
  })
  it('stops bounded reduction when the model fails to shrink the evidence', async () => {
    const doc = document(); doc.items[0].text = 'Evidence '.repeat(4000)
    const llm = vi.fn().mockResolvedValue({ content: 'x'.repeat(19000), truncated: false })
    await expect(generateDoclingAbstract(doc, 'paper', 'Title', llm)).rejects.toThrow('未能压缩')
    expect(llm.mock.calls.length).toBeLessThan(10)
  })
})
