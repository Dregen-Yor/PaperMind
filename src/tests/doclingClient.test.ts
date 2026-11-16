import { describe, expect, it, vi } from 'vitest'
import { convertPdf, testDoclingConnection } from '../../electron/doclingClient'
const credentials = { apiKey: 'official-key' }
const response = (status = 'success') => new Response(JSON.stringify({ status, document: { json_content: { texts: [{ text: 'Evidence' }] } } }))
describe('Docling HTTP boundary', () => {
  it('uploads PDFs to the official service with the fixed conversion contract', async () => {
    const request = vi.fn().mockResolvedValue(response())
    const result = await convertPdf(new Uint8Array([37, 80, 68, 70]), 'paper.pdf', credentials, request)
    const [url, init] = request.mock.calls[0]
    expect(url).toBe('https://docling.example.com/v1/convert/file')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    expect(new Headers(init.headers).get('X-Api-Key')).toBe('official-key')
    expect(Object.fromEntries(init.body.entries())).toMatchObject({
      from_formats: 'pdf',
      to_formats: 'json',
      target_type: 'inbody',
      image_export_mode: 'embedded',
      include_images: 'true',
      images_scale: '2',
      do_ocr: 'true',
      ocr_engine: 'rapidocr',
      ocr_preset: 'rapidocr',
      do_formula_enrichment: 'true',
      code_formula_preset: 'codeformulav2',
      do_table_structure: 'true',
      table_mode: 'accurate',
      table_structure_preset: 'tableformer_v1_accurate',
      layout_preset: 'layout_heron_default',
      document_timeout: '60',
    })
    expect(init.body.get('files').name).toBe('paper.pdf')
    expect(result.items[0].text).toBe('Evidence')
  })
  it('preserves partial extraction warnings and rejects failed conversion', async () => {
    expect((await convertPdf(new Uint8Array(), 'p.pdf', credentials, vi.fn().mockResolvedValue(response('partial_success')))).warnings.join()).toContain('部分')
    await expect(convertPdf(new Uint8Array(), 'p.pdf', credentials, vi.fn().mockResolvedValue(response('failure')))).rejects.toThrow('解析失败')
  })
  it('reports HTTP authentication and malformed responses', async () => {
    await expect(convertPdf(new Uint8Array(), 'p.pdf', credentials, vi.fn().mockResolvedValue(new Response('', { status: 401 })))).rejects.toThrow('认证')
    await expect(convertPdf(new Uint8Array(), 'p.pdf', credentials, vi.fn().mockResolvedValue(new Response('invalid')))).rejects.toThrow('JSON')
  })
  it('only accepts an OpenAPI service with the actual conversion endpoint', async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ paths: { '/v1/convert/file': { post: {} } } })))
    await expect(testDoclingConnection(credentials, request)).resolves.toContain('连接成功')
    expect(request.mock.calls[0][0]).toBe('https://docling.example.com/openapi.json')
    await expect(testDoclingConnection(credentials, vi.fn().mockResolvedValue(new Response('{}')))).rejects.toThrow('转换接口')
  })
  it('aborts requests at the configured deadline', async () => {
    vi.useFakeTimers()
    try {
      const request = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))))
      const result = convertPdf(new Uint8Array(), 'p.pdf', credentials, request)
      const check = expect(result).rejects.toThrow('超时')
      await vi.advanceTimersByTimeAsync(60_001)
      await check
    } finally { vi.useRealTimers() }
  })
  it('rejects oversized uploads before any request is sent', async () => {
    const request = vi.fn()
    await expect(convertPdf(new Uint8Array(64 * 1024 * 1024 + 1), 'large.pdf', credentials, request)).rejects.toThrow('上传大小上限')
    expect(request).not.toHaveBeenCalled()
  })
  it('caps in-flight parsing requests and releases capacity after failures', async () => {
    let reject!: (error: Error) => void
    const pending = new Promise<Response>((_resolve, fail) => { reject = fail })
    const request = vi.fn(() => pending)
    const first = convertPdf(new Uint8Array(), 'a.pdf', credentials, request)
    const second = convertPdf(new Uint8Array(), 'b.pdf', credentials, request)
    await expect(convertPdf(new Uint8Array(), 'c.pdf', credentials, request)).rejects.toThrow('请求过多')
    const settled = Promise.allSettled([first, second])
    reject(new Error('connection closed'))
    await settled
    await expect(convertPdf(new Uint8Array(), 'd.pdf', credentials, vi.fn().mockResolvedValue(response()))).resolves.toBeDefined()
  })
})
