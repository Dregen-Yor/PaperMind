import { describe, expect, it, vi } from 'vitest'
import { extractWebReadPreview } from '../utils/webReadPreview'

describe('cached webpage reading preview', () => {
  it('keeps article structure as text without executing or loading site resources', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const preview = extractWebReadPreview(`<html><body><nav>菜单</nav><article>
      <h1>标题</h1><p onclick="fetch('https://bad.invalid/run')">正文</p>
      <ul><li>条目</li></ul><blockquote>引用</blockquote><pre>let x = 1</pre>
      <script>fetch('https://bad.invalid/script')</script><img src="https://bad.invalid/img">
    </article></body></html>`)
    expect(preview.blocks).toEqual([
      { kind: 'heading', level: 1, text: '标题' },
      { kind: 'paragraph', text: '正文' },
      { kind: 'list', text: '条目' },
      { kind: 'quote', text: '引用' },
      { kind: 'code', text: 'let x = 1' },
    ])
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('falls back to body text and rejects a textless page', () => {
    expect(extractWebReadPreview('<html><body><div>动态正文</div></body></html>').blocks)
      .toEqual([{ kind: 'paragraph', text: '动态正文' }])
    expect(() => extractWebReadPreview('<html><body><script>secret()</script></body></html>')).toThrow('可缓存')
  })

  it('uses readable main content when the first article is empty', () => {
    const preview = extractWebReadPreview('<html><body><article><script>hidden()</script></article><main><p>真正正文</p></main></body></html>')
    expect(preview.blocks).toEqual([{ kind: 'paragraph', text: '真正正文' }])
  })

  it('caps the preview without changing the source HTML', () => {
    const preview = extractWebReadPreview(`<article><p>${'中'.repeat(200_000)}</p></article>`)
    expect(preview.truncated).toBe(true)
    expect(Buffer.byteLength(preview.blocks[0].text, 'utf8')).toBeLessThanOrEqual(512 * 1024)
  })
})
