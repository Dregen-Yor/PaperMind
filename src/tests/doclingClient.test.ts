import { describe, expect, it, vi } from 'vitest'
import { convertPdf, testDoclingConnection } from '../../electron/doclingClient'
import { DEFAULT_DOCLING_SETTINGS } from '../utils/doclingDocument'
const settings = { ...DEFAULT_DOCLING_SETTINGS, baseUrl: 'http://localhost:5001/prefix', apiKey: 'test-key' }
const response = (status = 'success') => new Response(JSON.stringify({ status, document: { json_content: { texts: [{ text: 'Evidence' }] } } }))
describe('Docling HTTP boundary', () => {
  it('opens the managed server connection before uploading and stops on connection failure', async () => {
    const order: string[] = []
    const connect = vi.fn(async () => { order.push('connect') })
    const request = vi.fn(async () => { order.push('upload'); return response() })
    await convertPdf(new Uint8Array([37, 80, 68, 70]), 'paper.pdf', DEFAULT_DOCLING_SETTINGS, request, connect)
    expect(order).toEqual(['connect', 'upload'])
    expect(connect).toHaveBeenCalledWith(DEFAULT_DOCLING_SETTINGS.baseUrl)

    connect.mockRejectedValueOnce(new Error('SSH unavailable'))
    await expect(convertPdf(new Uint8Array(), 'paper.pdf', DEFAULT_DOCLING_SETTINGS, request, connect)).rejects.toThrow('SSH unavailable')
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('also opens the tunnel for a previously saved localhost address', async () => {
    const connect = vi.fn().mockResolvedValue(undefined)
    const request = vi.fn().mockResolvedValue(response())
    await convertPdf(new Uint8Array(), 'paper.pdf', { ...DEFAULT_DOCLING_SETTINGS, baseUrl: 'http://localhost:5001' }, request, connect)
    expect(connect).toHaveBeenCalledWith(DEFAULT_DOCLING_SETTINGS.baseUrl)
    expect(request.mock.calls[0][0]).toBe(`${DEFAULT_DOCLING_SETTINGS.baseUrl}/v1/convert/file`)
  })
  it('uploads local PDF with embedded JSON and optional authentication', async () => {
    const request = vi.fn().mockResolvedValue(response())
    const result = await convertPdf(new Uint8Array([37, 80, 68, 70]), 'paper.pdf', settings, request)
    const [url, init] = request.mock.calls[0]
    expect(url).toBe('http://localhost:5001/prefix/v1/convert/file')
    expect(init.headers['X-Api-Key']).toBe('test-key')
    expect(init.body.get('to_formats')).toBe('json')
    expect(init.body.get('target_type')).toBe('inbody')
    expect(init.body.get('image_export_mode')).toBe('embedded')
    expect(init.body.get('do_formula_enrichment')).toBe('true')
    expect(init.body.get('files').name).toBe('paper.pdf')
    expect(result.items[0].text).toBe('Evidence')
  })
  it('preserves partial extraction warnings and rejects failed conversion', async () => {
    expect((await convertPdf(new Uint8Array(), 'p.pdf', settings, vi.fn().mockResolvedValue(response('partial_success')))).warnings.join()).toContain('部分')
    await expect(convertPdf(new Uint8Array(), 'p.pdf', settings, vi.fn().mockResolvedValue(response('failure')))).rejects.toThrow('解析失败')
  })
  it('reports HTTP authentication and malformed responses', async () => {
    await expect(convertPdf(new Uint8Array(), 'p.pdf', settings, vi.fn().mockResolvedValue(new Response('', { status: 401 })))).rejects.toThrow('认证')
    await expect(convertPdf(new Uint8Array(), 'p.pdf', settings, vi.fn().mockResolvedValue(new Response('invalid')))).rejects.toThrow('JSON')
  })
  it('only accepts an OpenAPI service with the actual conversion endpoint', async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ paths: { '/v1/convert/file': { post: {} } } })))
    await expect(testDoclingConnection(settings, request)).resolves.toContain('连接成功')
    await expect(testDoclingConnection(settings, vi.fn().mockResolvedValue(new Response('{}')))).rejects.toThrow('转换接口')
  })
  it('aborts requests at the configured deadline', async () => {
    vi.useFakeTimers()
    try {
      const request = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))))
      const result = convertPdf(new Uint8Array(), 'p.pdf', { ...settings, timeoutSeconds: 30 }, request)
      const check = expect(result).rejects.toThrow('超时')
      await vi.advanceTimersByTimeAsync(30_001)
      await check
    } finally { vi.useRealTimers() }
  })
})
