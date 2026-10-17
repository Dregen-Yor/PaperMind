import { describe, expect, it } from 'vitest'
import { canonicalWebPageUrl } from '../utils/webPageUrl'

describe('canonical webpage identity', () => {
  it('groups fragments, host case and default HTTPS ports while preserving queries', () => {
    expect(canonicalWebPageUrl('https://EXAMPLE.org:443/a?x=1#section')).toBe('https://example.org/a?x=1')
    expect(canonicalWebPageUrl('https://example.org/a?x=2')).not.toBe('https://example.org/a?x=1')
  })

  it('rejects insecure and credential-bearing addresses', () => {
    expect(() => canonicalWebPageUrl('http://example.org/a')).toThrow()
    expect(() => canonicalWebPageUrl('https://user:secret@example.org/a')).toThrow()
  })
})
