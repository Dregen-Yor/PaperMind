import { describe, expect, it } from 'vitest'
import { validateServiceUrl, readBoundedJson } from '../utils/serviceSecurity'

describe('service connection security', () => {
  it.each(['http://api.example.org/v1', 'https://user:secret@example.org', 'https://１２７.０.０.１/v1', 'http://127.1:5001', 'https://0x7f000001', 'https://example.org\u0000.evil'])('rejects unsafe endpoint %s before URL normalization', url => {
    expect(() => validateServiceUrl(url)).toThrow()
  })
  it.each(['https://api.example.org/v1', 'http://localhost:11434/api/chat', 'http://127.0.0.1:5001/prefix', 'http://[::1]:5001'])('preserves secure and explicit loopback endpoints %s', url => {
    expect(validateServiceUrl(url)).toBe(url)
  })
  it('bounds decoded JSON bytes even without a content length', async () => {
    const response = new Response(JSON.stringify({ text: 'x'.repeat(100) }))
    await expect(readBoundedJson(response, 32)).rejects.toThrow('上限')
    await expect(readBoundedJson(new Response('{"ok":true}'), 32)).resolves.toEqual({ ok: true })
  })
})
