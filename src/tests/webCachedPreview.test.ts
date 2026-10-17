import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import WebCachedPreview from '../components/WebCachedPreview.vue'

const snapshot = {
  id: 'snap-1', pageId: 'page-1', finalUrl: 'https://example.org/article', title: '本地缓存标题',
  capturedAt: 1, byteLength: 80, contentHash: 'hash', preview: { truncated: true,
    blocks: [{ kind: 'heading' as const, level: 2, text: '正文标题' },
      { kind: 'paragraph' as const, text: '<script>alert(1)</script> 正文' }] },
}

describe('cached webpage preview', () => {
  it('shows readable blocks as escaped text and offers the original link', async () => {
    const wrapper = mount(WebCachedPreview, { props: { snapshot } })
    expect(wrapper.text()).toContain('本地缓存标题')
    expect(wrapper.text()).toContain('<script>alert(1)</script> 正文')
    expect(wrapper.find('script').exists()).toBe(false)
    expect(wrapper.text()).toContain('缓存预览已截断')
    expect(wrapper.text()).toContain('更新缓存')
    await wrapper.get('[data-action="open-source"]').trigger('click')
    expect(wrapper.emitted('open-source')).toHaveLength(1)
  })

  it('explains an empty migrated preview while retaining access to its conversation', () => {
    const wrapper = mount(WebCachedPreview, { props: { snapshot: { ...snapshot,
      preview: { blocks: [], truncated: false } } } })
    expect(wrapper.text()).toContain('缓存预览不可用')
    expect(wrapper.find('[data-action="open-source"]').exists()).toBe(true)
  })
})
