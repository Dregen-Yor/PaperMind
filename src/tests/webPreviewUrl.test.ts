import { describe, expect, it } from 'vitest'
import { isAllowedExternalUrl, isAllowedPreviewUrl, normalizePreviewUrl } from '../utils/webPreviewUrl'

describe('HTML preview URL policy', () => {
  it('normalizes a pasted domain while preserving its path and fragment', () => {
    expect(normalizePreviewUrl('  example.org/article  ')).toBe('https://example.org/article')
    expect(normalizePreviewUrl('https://example.org/#section')).toBe('https://example.org/#section')
    expect(normalizePreviewUrl('example.org:8443/article')).toBe('https://example.org:8443/article')
  })

  it('rejects insecure and credential-bearing input', () => {
    expect(() => normalizePreviewUrl('http://example.org')).toThrow('仅支持 HTTPS 链接')
    expect(() => normalizePreviewUrl('https://user:pass@example.org')).toThrow()
    expect(() => normalizePreviewUrl('javascript:alert(1)')).toThrow()
    expect(() => normalizePreviewUrl('   ')).toThrow('请输入网页链接')
  })

  it('allows only credential-free absolute HTTPS navigation', () => {
    expect(isAllowedPreviewUrl('https://example.org/next')).toBe(true)
    expect(isAllowedPreviewUrl('file:///tmp/test.html')).toBe(false)
    expect(isAllowedPreviewUrl('https://user@example.org')).toBe(false)
    expect(isAllowedPreviewUrl('http://example.org')).toBe(false)
    expect(isAllowedPreviewUrl('/relative')).toBe(false)
  })

  it('limits explicit external open to web URLs', () => {
    expect(isAllowedExternalUrl('http://example.org')).toBe(true)
    expect(isAllowedExternalUrl('https://example.org')).toBe(true)
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isAllowedExternalUrl('https://user@example.org')).toBe(false)
  })
})
