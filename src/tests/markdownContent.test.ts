import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import MarkdownContent from '../components/MarkdownContent.vue'
import { renderMarkdown } from '../utils/markdown'
const id = 'a'.repeat(64)
const data = 'data:image/png;base64,aGVsbG8='
beforeEach(() => { vi.mocked(window.db.docling.readAsset).mockClear().mockResolvedValue(data) })
describe('offline illustrated Markdown', () => {
  it('renders controlled IDs with no arbitrary file or script access', () => {
    const html = renderMarkdown(`![Figure 1](asset:${id}) [p2](paper-source:paper:1) ![bad](asset:../../secret)`)
    expect(html).toContain(`data-asset-id="${id}"`)
    expect(html).toContain('data-page="1"')
    expect(html).not.toContain('../../secret')
    expect(renderMarkdown('[bad](javascript:alert(1))')).not.toContain('href="javascript:')
  })
  it('loads assets after mounting and re-mounting historical messages', async () => {
    const first = mount(MarkdownContent, { props: { content: `![Figure 1](asset:${id})` }, global: { stubs: { ElDialog: true } } })
    await flushPromises()
    expect(first.find('img').attributes('src')).toBe(data)
    first.unmount()
    const second = mount(MarkdownContent, { props: { content: `![Figure 1](asset:${id})` }, global: { stubs: { ElDialog: true } } })
    await flushPromises()
    expect(second.find('img').attributes('src')).toBe(data)
    expect(window.db.docling.readAsset).toHaveBeenCalledTimes(2)
  })
  it('emits accurate page navigation using click and keyboard', async () => {
    const wrapper = mount(MarkdownContent, { props: { content: '[p2](paper-source:paper:1)' }, global: { stubs: { ElDialog: true } } })
    await wrapper.find('a').trigger('click')
    await wrapper.find('a').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('open-source')).toEqual([[{ label: 'p2', paperId: 'paper', startPage: 1, endPage: 1 }], [{ label: 'p2', paperId: 'paper', startPage: 1, endPage: 1 }]])
  })
  it('opens an accessible image preview and reports missing local assets', async () => {
    const wrapper = mount(MarkdownContent, { props: { content: `![Figure 1](asset:${id})` }, global: { stubs: { ElDialog: { template: '<div v-if="modelValue"><slot /></div>', props: ['modelValue'] } } } })
    await flushPromises()
    await wrapper.find('img').trigger('keydown', { key: 'Enter' })
    expect(wrapper.findAll('img')).toHaveLength(2)
    wrapper.unmount()
    vi.mocked(window.db.docling.readAsset).mockResolvedValue(null)
    const missing = mount(MarkdownContent, { props: { content: `![Figure 1](asset:${id})` }, global: { stubs: { ElDialog: true } } })
    await flushPromises()
    expect(missing.text()).toContain('原图不可用')
  })
})
