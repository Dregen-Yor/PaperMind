import { describe, expect, it, vi, afterEach } from 'vitest'
import { renderMarkdown } from '../utils/markdown'
import { parseMaterialLocations, replaceSummaryAssets, requestVisualCompletion, SUMMARY_PROMPT, splitVisualPages, normalizeVisualSummaryMath, getVisualCropGeometry } from '../utils/visualSummary'
const page = { page: 0, width: 100, height: 200, data: 'data:image/jpeg;base64,YQ==' }
afterEach(() => vi.unstubAllGlobals())
describe('visual summary boundary', () => {
  it('rejects unsafe coordinates without clamping and preserves valid formula metadata', () => {
    const result = parseMaterialLocations(JSON.stringify({ materials: [
      { page: 1, kind: 'equation', identifier: '(1)', latex: 'x^2', bbox: [0.1, 0.2, 0.9, 0.4] },
      { page: 1, kind: 'figure', bbox: [-0.1, 0, 1, 1] },
    ] }), [page])
    expect(result[0]).toMatchObject({ page: 0, latex: 'x^2', valid: true })
    expect(result[1]).toMatchObject({ page: 0, valid: false })
    expect(() => parseMaterialLocations('{"materials":[{"page":9,"kind":"figure","bbox":[0,0,1,1]}]}', [page])).toThrow(/页/)
  })
  it('adds safe context around figure regions and uses full-width equation strips', () => {
    const material = { page: 0, kind: 'equation' as const, identifier: '(2)', caption: '', latex: '', valid: true, bbox: [0.36, 0.81, 0.87, 0.839] }
    const geometry = getVisualCropGeometry({ ...page, width: 1000, height: 1600 }, material)
    expect(geometry.x).toBe(0)
    expect(geometry.width).toBe(1000)
    expect(geometry.y).toBeLessThanOrEqual(0.79 * 1600)
    expect(geometry.y + geometry.height).toBeGreaterThanOrEqual(0.859 * 1600)
    expect(material.bbox).toEqual([0.36, 0.81, 0.87, 0.839])
    const figure = getVisualCropGeometry({ ...page, width: 1000, height: 1600 }, { ...material, kind: 'figure', bbox: [0.12, 0.1, 0.93, 0.57] })
    expect(figure.x).toBeLessThanOrEqual(100)
    expect(figure.y).toBeLessThanOrEqual(128)
    expect(figure.x + figure.width).toBeGreaterThanOrEqual(950)
    expect(figure.y + figure.height).toBeGreaterThanOrEqual(944)
    const edge = getVisualCropGeometry({ ...page, width: 1000, height: 1600 }, { ...material, kind: 'figure', bbox: [0.01, 0.01, 0.99, 0.99] })
    expect(edge).toMatchObject({ x: 0, y: 0, width: 1000, height: 1600, bbox: [0, 0, 1, 1] })
    expect(() => getVisualCropGeometry(page, { ...material, bbox: [-0.1, 0, 1, 1] })).toThrow(/区域/)
  })
  it('permits only known hash assets and removes arbitrary image URLs', () => {
    const id = 'a'.repeat(64)
    expect(replaceSummaryAssets(`![ok](asset:${id}) ![bad](file:///etc/passwd) ![remote](https://evil/x.png)`, new Set([id])))
      .toBe(`![ok](asset:${id}) [图片不可用：bad] [图片不可用：remote]`)
  })
  it('normalizes full, collapsed and shortcut reference images through the same asset allowlist', () => {
    const id = 'a'.repeat(64), foreign = 'b'.repeat(64)
    const raw = `Text $x^2$

![remote][r] ![collapse][] ![shortcut] ![foreign][f] ![allowed][a]

[r]: https://evil.example/tracker.png
[collapse]: https://evil.example/c.png
[shortcut]: https://evil.example/s.png
[f]: asset:${foreign}
[a]: asset:${id}`
    const safe = replaceSummaryAssets(raw, new Set([id]))
    const html = renderMarkdown(safe)
    expect(html).not.toContain('src="https://evil.example')
    expect(html).not.toContain(`data-asset-id="${foreign}"`)
    expect(html).toContain(`data-asset-id="${id}"`)
    expect(safe).toContain('Text $x^2$')
  })
  it('batches all pages and refuses excessive summary input rather than dropping pages', () => {
    expect(splitVisualPages(Array.from({ length: 17 }, (_, pageNo) => ({ ...page, page: pageNo })), 8).map(x => x.length)).toEqual([8, 8, 1])
  })
  it('normalizes real model math delimiters while preserving notation and literal code', () => {
    const raw = 'For \\(h_i\\), use:\n\n\\[h_i = \\operatorname{RMSNorm}(x_i)\\]\n\n`\\(literal\\)`\n\n```tex\n\\[code\\]\n```'
    const normalized = normalizeVisualSummaryMath(raw)
    expect(normalized).toContain('$h_i$')
    expect(normalized).toContain('$$\nh_i = \\operatorname{RMSNorm}(x_i)\n$$')
    expect(normalized).toContain('`\\(literal\\)`')
    expect(normalized).toContain('```tex\n\\[code\\]\n```')
    expect(renderMarkdown(normalized)).toContain('class="katex-display"')
  })
  it('rejects unconfigured cloud credentials before a network request', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    await expect(requestVisualCompletion([page], SUMMARY_PROMPT, {
      id: 'p', name: '', provider: 'openai', model: 'deepseek-flash', apiKey: '', baseUrl: 'https://example.test', temperature: 1, maxTokens: 0, topK: 0, systemPrompt: '',
    })).rejects.toThrow(/API Key/)
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('sends real pages and exact user prompt to vision transport; records usage', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '# Summary' }, finish_reason: 'stop' }], usage: { total_tokens: 10 } })))
    vi.stubGlobal('fetch', fetcher)
    const profile = { id: 'p', name: 'p', provider: 'openai' as const, model: 'deepseek-flash', apiKey: 'key', baseUrl: 'https://example.test/v1', temperature: 0.5, maxTokens: 0, topK: 0, systemPrompt: '' }
    const result = await requestVisualCompletion([page], SUMMARY_PROMPT, profile)
    const body = JSON.parse(fetcher.mock.calls[0][1].body)
    expect(body.messages[1].content).toContainEqual({ type: 'text', text: SUMMARY_PROMPT })
    expect(body.messages[1].content).toContainEqual({ type: 'image_url', image_url: { url: page.data } })
    expect(result).toMatchObject({ content: '# Summary', truncated: false, usage: { total_tokens: 10 } })
  })
})
