import { describe, expect, it, vi } from 'vitest'
import { abstractRunKey, buildEvidenceChunks, generateDoclingAbstract, materializeAbstract } from '../utils/doclingAbstract'
import { normalizeDoclingDocument } from '../utils/doclingDocument'
import { renderMarkdown } from '../utils/markdown'
const document = () => {
  const doc = normalizeDoclingDocument({ texts: [{ text: 'Research evidence', prov: [{ page_no: 2 }] }], pictures: [{ captions: [], prov: [{ page_no: 2 }] }] })
  doc.items[1].caption = 'Figure 1. Results'
  doc.items[1].images = [{ assetId: 'a'.repeat(64), page: 1 }]
  return doc
}
const documentElement = (html: string) => {
  const element = globalThis.document.createElement('div')
  element.innerHTML = html
  return element
}
describe('illustrated abstract evidence and references', () => {
  it('changes the checkpoint identity when evidence, title, model settings, or continuation changes', async () => {
    const doc = document()
    const first = await abstractRunKey(doc, 'Title', 'model-a', '')
    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(await abstractRunKey(doc, 'Other title', 'model-a', '')).not.toBe(first)
    expect(await abstractRunKey(doc, 'Title', 'model-b', '')).not.toBe(first)
    expect(await abstractRunKey(doc, 'Title', 'model-a', 'earlier report')).not.toBe(first)
    doc.items[0].text = 'Changed evidence'
    expect(await abstractRunKey(doc, 'Title', 'model-a', '')).not.toBe(first)
  })
  it('reuses completed evidence chunks after a later chunk fails', async () => {
    const doc = document(); doc.items[0].text = 'Evidence '.repeat(4000)
    const saved = new Map<string, string>()
    const checkpoint = {
      load: vi.fn(async (stage: string, index: number) => saved.get(`${stage}:${index}`) ?? null),
      save: vi.fn(async (stage: string, index: number, content: string) => { saved.set(`${stage}:${index}`, content) }),
    }
    let mapCalls = 0
    const llm = vi.fn(async (messages: { role: string; content: string }[]) => {
      if (messages[1].content.includes('提炼这一部分')) {
        mapCalls++
        if (mapCalls === 2) throw new Error('temporary failure')
        return { content: `note-${mapCalls}`, truncated: false }
      }
      return { content: '# Complete report', truncated: false }
    })
    await expect(generateDoclingAbstract(doc, 'paper', 'Title', llm, () => {}, '', checkpoint)).rejects.toThrow('temporary failure')
    expect(saved.get('map:0')).toBe('note-1')
    await generateDoclingAbstract(doc, 'paper', 'Title', llm, () => {}, '', checkpoint)
    expect(mapCalls).toBe(buildEvidenceChunks(doc).length + 1)
    expect(checkpoint.load).toHaveBeenCalledWith('map', 0)
  })
  it('reports the failing evidence position and retries one transient model error', async () => {
    const doc = document(); doc.items[0].text = 'Evidence '.repeat(4000)
    const llm = vi.fn().mockRejectedValue(new Error('请求超时，请检查网络后重试'))
    await expect(generateDoclingAbstract(doc, 'paper', 'Title', llm)).rejects.toThrow('提炼论文内容（1/')
    expect(llm).toHaveBeenCalledTimes(2)
  })
  it('does not retry an authentication error', async () => {
    const llm = vi.fn().mockRejectedValue(new Error('LLM 请求失败 (401)：unauthorized'))
    await expect(generateDoclingAbstract(document(), 'paper', 'Title', llm)).rejects.toThrow('生成详细图文解读失败')
    expect(llm).toHaveBeenCalledTimes(1)
  })
  it('materializes only known assets and citations with accurate source pages', () => {
    const result = materializeAbstract('Result {{asset:picture-1}} {{cite:text-1}} {{cite:invented}} ![bad](https://example.com/bad.png)', document(), 'paper')
    expect(result.content).toContain('asset:' + 'a'.repeat(64))
    expect(result.content).toContain('paper-source:paper:1')
    expect(result.content).not.toContain('example.com')
    expect(result.content).not.toContain('invented')
    expect(result.sources).toContainEqual(expect.objectContaining({ paperId: 'paper', startPage: 1 }))
  })
  it('anchors distinct text sentences separately and treats each table as one source unit', () => {
    const doc = document()
    doc.items[0].text = 'The model improves reasoning accuracy by 12.5 points. Another claim follows.'
    doc.items[0].regions = [{ page: 1, x: 0.1, y: 0.2, width: 0.75, height: 0.08 }]
    doc.items.push({ id: 'table-1', kind: 'table', text: '[row 0, col 0] Model\n[row 0, col 1] 74.7', caption: '', pages: [1],
      regions: [{ page: 1, x: 0.2, y: 0.5, width: 0.6, height: 0.2 }], images: [] })
    const result = materializeAbstract('提升 {{cite:text-1-s1}}；后续 {{cite:text-1-s2}}；表中为 {{cite:table-1|74.7}}。', doc, 'paper')
    const html = documentElement(renderMarkdown(result.content))
    const links = Array.from(html.querySelectorAll<HTMLAnchorElement>('a.paper-source'))
    expect(links).toHaveLength(3)
    expect(links.map(link => link.textContent)).toEqual(['文1', '文2', '表1'])
    expect(links[0].dataset.region).toBe('0.1,0.2,0.75,0.08')
    expect(links[0].dataset.quote).toBe('The model improves reasoning accuracy by 12.5 points.')
    expect(links[1].dataset.quote).toBe('Another claim follows.')
    expect(links[2].dataset.region).toBe('0.2,0.5,0.6,0.2')
    expect(links[2].dataset.quote).toBeUndefined()
  })
  it('never trusts an invented quotation as a precise source anchor', () => {
    const doc = document()
    doc.items[0].regions = [{ page: 1, x: 0.1, y: 0.2, width: 0.6, height: 0.1 }]
    const result = materializeAbstract('{{cite:text-1|Invented sentence}}', doc, 'paper')
    const html = documentElement(renderMarkdown(result.content))
    expect(html.querySelector('a.paper-source')).toBeNull()
    expect(result.content).toContain('无法定位到唯一原文句子')
  })
  it('uses the whole table box and collapses repeated table references in a paragraph', () => {
    const doc = document()
    doc.items.push({ id: 'table-1', kind: 'table', text: '[row 1, col 2] 74.7', caption: '', pages: [1],
      regions: [{ page: 1, x: .1, y: .3, width: .8, height: .4 }], images: [],
      cells: [{ text: '74.7', region: { page: 1, x: .5, y: .4, width: .1, height: .05 } }] })
    const html = documentElement(renderMarkdown(materializeAbstract('得分 {{cite:table-1|74.7}}，另一个指标 {{cite:table-1|74.7}}。', doc, 'paper').content))
    expect(html.querySelectorAll('a.paper-source')).toHaveLength(1)
    expect(html.querySelector('a.paper-source')?.getAttribute('data-region')).toBe('0.1,0.3,0.8,0.4')
  })
  it('uses a stable unit label for a figure and repeated references to one sentence', () => {
    const doc = document()
    doc.items[0].text = 'First finding. Second finding.'
    doc.items[1].regions = [{ page: 1, x: .2, y: .3, width: .6, height: .3 }]
    const raw = '结果 {{cite:text-1-s2}} 和 {{cite:text-1-s2}}，见图 {{cite:picture-1}} 与 {{cite:picture-1}}。\n\n再次讨论 {{cite:text-1-s2}}。'
    const html = documentElement(renderMarkdown(materializeAbstract(raw, doc, 'paper').content))
    const links = Array.from(html.querySelectorAll<HTMLAnchorElement>('a.paper-source'))
    expect(links.map(link => link.textContent)).toEqual(['文2', '图1', '文2'])
    expect(links[1].dataset.region).toBe('0.2,0.3,0.6,0.3')
    expect(links[1].dataset.quote).toBeUndefined()
  })
  it('omits a repeated uncaptioned page header while keeping a substantive uncaptioned figure', () => {
    const doc = document()
    doc.items[1].caption = ''
    doc.items[1].regions = [{ page: 1, x: 0.15, y: 0.3, width: 0.7, height: 0.2 }]
    doc.items.push({ id: 'picture-2', kind: 'picture', text: '', caption: '', pages: [32],
      regions: [{ page: 32, x: 0.37, y: 0.03, width: 0.26, height: 0.014 }],
      images: [{ assetId: 'b'.repeat(64), page: 32 }] })
    const result = materializeAbstract('{{asset:picture-2}} {{asset:picture-1}} {{asset:picture-2}}', doc, 'paper')
    expect(result.content).not.toContain('asset:' + 'b'.repeat(64))
    expect(result.content).toContain('asset:' + 'a'.repeat(64))
    expect(result.content).toContain('paper-source:paper:32')
  })
  it('shows each original asset once and omits long figure and table captions', () => {
    const doc = document()
    doc.items[1].caption = 'Figure 14: A very long description of the evaluation procedure and all its details.'
    doc.items.push({ id: 'table-1', kind: 'table', text: '', caption: 'Table 1: A very long architectural comparison description.',
      pages: [2], regions: [], images: [{ assetId: 'b'.repeat(64), page: 2 }] })
    const result = materializeAbstract('{{asset:picture-1}} {{asset:picture-1}} {{asset:table-1}}', doc, 'paper')
    expect(result.content.match(/asset:/g)).toHaveLength(2)
    expect(result.content).not.toContain('A very long')
    expect(result.content).toContain('原文图片')
    expect(result.content).toContain('原文表格')
    expect(result.content).toContain('paper-source:paper:1')
    expect(result.content).toContain('paper-source:paper:2')
  })
  it('keeps an inline asset from splitting a sentence before its punctuation', () => {
    const result = materializeAbstract('分数提高 {{asset:picture-1}}；因此超过基线。', document(), 'paper')
    const container = documentElement(renderMarkdown(result.content))
    expect(container.querySelector('p')?.textContent).toBe('分数提高；因此超过基线。')
    expect(container.querySelector('figure.paper-evidence img')).not.toBeNull()
    expect(container.querySelector('p')?.nextElementSibling?.tagName).toBe('FIGURE')
  })
  it('keeps an inline formula from splitting the sentence that cites it', () => {
    const doc = document(); doc.items[1].kind = 'formula'; doc.items[1].id = 'formula-1'; doc.items[1].text = 'x = y'
    const result = materializeAbstract('关系为 {{asset:formula-1}}。随后讨论实验。', doc, 'paper')
    const container = documentElement(renderMarkdown(result.content))
    expect(container.querySelector('p')?.textContent).toBe('关系为。随后讨论实验。')
    expect(container.querySelector('figure.paper-evidence--formula .katex-display')).not.toBeNull()
  })
  it('rejects model-made application links before validating evidence IDs', () => {
    const result = materializeAbstract('![fake](asset:' + 'b'.repeat(64) + ') [fake](paper-source:other:999) ![remote][pic]\n[pic]: https://example.com/image.png', document(), 'paper')
    expect(result.content).not.toContain('paper-source:other')
    expect(result.content).not.toContain('asset:' + 'b'.repeat(64))
    expect(result.content).not.toContain('![remote]')
  })
  it('rejects encoded application destinations and reference links after Markdown decoding', () => {
    const raw = `[invented](paper-source&#58;other&#58;999) [escaped](paper-source\\:other\\:998) [reference][source]\n\n[source]: paper-source&#58;other&#58;997\n\n![invented](asset&#58;${'b'.repeat(64)})\n\n{{cite:text-1}}`
    const result = materializeAbstract(raw, document(), 'paper')
    const html = renderMarkdown(result.content)
    expect(html).not.toContain('data-paper-id="other"')
    expect(html).not.toContain('data-asset-id="' + 'b'.repeat(64))
    expect(html).toContain('data-paper-id="paper"')
    expect(result.sources).toEqual([{ label: '文1', paperId: 'paper', startPage: 1, endPage: 1 }])
  })
  it('never creates a page link for unlocated evidence', () => {
    const doc = document(); doc.items[0].pages = []
    const result = materializeAbstract('{{cite:text-1}}', doc, 'paper')
    expect(result.content).not.toContain('paper-source')
    expect(result.sources).toEqual([])
  })
  it('cannot synthesize a new source link by joining text around removed markup', () => {
    const doc = document(); doc.items[0].pages = []
    for (const middle of ['![remove](https://example.com/image.png)', '{{cite:unknown}}', '{{cite:text-1}}']) {
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
    expect(chunks.join('')).toContain('[text-1-s1; text; p2]')
    expect(chunks.join('')).toContain('[picture-1; picture; p2]')
    expect(chunks.join('')).not.toContain('data:image')
  })
  it('exposes sentence IDs to the model and keeps one text unit per sentence', () => {
    const doc = document()
    doc.items[0].text = 'The first result is strong. The second result is weaker.'
    const chunks = buildEvidenceChunks(doc)
    expect(chunks.join('\n')).toContain('[text-1-s1; text; p2]\nThe first result is strong.')
    expect(chunks.join('\n')).toContain('[text-1-s2; text; p2]\nThe second result is weaker.')
  })
  it('keeps a long source sentence intact for PDF sentence framing', () => {
    const doc = document()
    const sentence = `The method ${'improves reasoning across complex tasks '.repeat(9).trim()}.`
    doc.items[0].text = sentence
    const html = documentElement(renderMarkdown(materializeAbstract('{{cite:text-1-s1}}', doc, 'paper').content))
    expect(html.querySelector<HTMLAnchorElement>('a.paper-source')?.dataset.quote).toBe(sentence)
  })
  it('uses detailed Chinese instructions and preserves truncation for continuation', async () => {
    const llm = vi.fn().mockResolvedValue({ content: '# 解读\n{{asset:picture-1}} {{cite:text-1}}', truncated: true })
    const result = await generateDoclingAbstract(document(), 'paper', 'Title', llm)
    expect(llm.mock.calls[0][0][0].content).toContain('中文')
    expect(llm.mock.calls[0][0][0].content).toContain('{{asset:picture-1}}')
    expect(result.truncated).toBe(true)
    expect(result.content).toContain('原文图片')
    expect(result.content).not.toContain('Figure 1')
  })
  it('falls back to the original region when an extracted formula is invalid', () => {
    const doc = document(); doc.items[1].kind = 'formula'; doc.items[1].id = 'formula-1'; doc.items[1].text = '\\unknowncommand'
    const result = materializeAbstract('{{asset:formula-1}}', doc, 'paper')
    expect(result.content).toContain('asset:')
    expect(result.content).not.toContain('$$')
  })
  it('renders Docling alignment formulas with KaTeX instead of falling back to screenshots', () => {
    const doc = document(); doc.items[1].kind = 'formula'; doc.items[1].id = 'formula-1'
    doc.items[1].text = 'S_{t} & = (I - \\beta_{t} k_{t} k_{t}^{\\top}) S_{t-1} + \\beta_{t} k_{t} v_{t}^{\\top}, \\\\'
    const result = materializeAbstract('{{asset:formula-1}}', doc, 'paper')
    expect(result.content).toContain('\\begin{aligned}')
    expect(result.content).not.toContain('asset:')
    const html = renderMarkdown(result.content)
    expect(html).toContain('class="katex-display"')
    expect(html).not.toContain('katex-error')
  })
  it('uses the original screenshot when formula OCR has swallowed a prose sentence', () => {
    const doc = document(); doc.items[1].kind = 'formula'; doc.items[1].id = 'formula-1'
    doc.items[1].text = 'x = y \\\\ \\text{The attention weights follow a softmax kernel in every layer}'
    const result = materializeAbstract('{{asset:formula-1}}', doc, 'paper')
    expect(result.content).toContain('![原文公式](asset:')
    expect(result.content).not.toContain('\\begin{aligned}')
  })
  it('renders formulas whose Docling text contains inline dollar notation', () => {
    const doc = document(); doc.items[1].kind = 'formula'; doc.items[1].id = 'formula-1'
    doc.items[1].text = 'V = \\begin{cases} b_0 & \\text{if first block $n$} \\\\ b_1 & \\text{otherwise} \\end{cases}'
    const result = materializeAbstract('{{asset:formula-1}}', doc, 'paper')
    const html = renderMarkdown(result.content)
    expect(html).toContain('class="katex-display"')
    expect(html).not.toContain('<p>$$')
    expect(html).not.toContain('katex-error')
  })
  it('fails clearly when map output is truncated instead of silently losing evidence', async () => {
    const doc = document(); doc.items[0].text = 'Evidence '.repeat(4000)
    await expect(generateDoclingAbstract(doc, 'paper', 'Title', vi.fn().mockResolvedValue({ content: 'partial', truncated: true }))).rejects.toThrow('截断')
  })
  it('keeps every mapped evidence batch when a reduction does not shrink', async () => {
    const doc = document(); doc.items[0].text = 'Evidence '.repeat(4000)
    let mapped = 0
    const llm = vi.fn(async (messages: { role: string; content: string }[]) => {
      const prompt = messages[1].content
      if (prompt.includes('提炼这一部分')) return { content: `NOTE-${++mapped}\n` + 'x'.repeat(7000), truncated: false }
      if (prompt.includes('合并以下要点')) return { content: 'y'.repeat(19000), truncated: false }
      return { content: `# 解读\n${[...prompt.matchAll(/NOTE-\d+/g)].map(match => match[0]).join(' ')}`, truncated: false }
    })
    const result = await generateDoclingAbstract(doc, 'paper', 'Title', llm)
    expect(result.content).toContain('NOTE-1')
    expect(result.content).toContain('NOTE-2')
    expect(result.content).toContain('NOTE-3')
    expect(llm.mock.calls.length).toBeLessThan(10)
  })
})
