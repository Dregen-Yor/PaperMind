import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import Editor from '../components/PaperMetadataEditor.vue'
import { usePaperStore, type Paper } from '../stores/paper'

const paper: Paper = { id: 'a', title: 'Old', authors: ['Alice'], year: 2020, tags: ['old'], abstract: '', fileName: 'a.pdf', fileHash: '', addedAt: 0, knowledgeBaseId: 'default', status: 'unread' }
const stubs = {
  ElDialog: { template: '<section><slot /><slot name="footer" /></section>' },
  ElButton: { props: ['disabled'], template: '<button :disabled="disabled"><slot /></button>' },
}
function setup(input = paper) {
  const pinia = createPinia()
  const store = usePaperStore(pinia)
  store.papers = [{ ...input }]
  const wrapper = mount(Editor, { props: { paper: input }, global: { plugins: [pinia], stubs } })
  return { wrapper, store }
}
beforeEach(() => { vi.clearAllMocks(); vi.mocked(window.db.paper.update).mockResolvedValue(undefined) })
describe('manual paper metadata editing', () => {
  it('saves all editable metadata only after confirmation and updates the paper', async () => {
    const { wrapper, store } = setup()
    expect(wrapper.find('[aria-label="论文标题"]').exists()).toBe(true)
    await wrapper.get('[aria-label="论文标题"]').setValue('New title')
    await wrapper.get('[aria-label="论文作者"]').setValue('王小明；Alice\nBob')
    await wrapper.get('[aria-label="发表年份"]').setValue('2025')
    await wrapper.get('[aria-label="论文标签"]').setValue('AI，论文,AI')
    expect(store.getPaper('a')?.title).toBe('Old')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(store.getPaper('a')).toMatchObject({ title: 'New title', authors: ['王小明', 'Alice', 'Bob'], year: 2025, tags: ['AI', '论文'] })
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
  it('cancels edits without writing and tolerates missing legacy fields', async () => {
    const { wrapper } = setup({ ...paper, authors: undefined, tags: undefined, year: undefined } as unknown as Paper)
    expect(wrapper.find('[aria-label="论文作者"]').exists()).toBe(true)
    await wrapper.get('[aria-label="论文标题"]').setValue('Unsaved')
    await wrapper.findAll('button').find(b => b.text() === '取消')!.trigger('click')
    expect(window.db.paper.update).not.toHaveBeenCalled()
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
  it('retains edits on write failure and allows retry', async () => {
    const { wrapper, store } = setup()
    expect(wrapper.find('[aria-label="论文标题"]').exists()).toBe(true)
    vi.mocked(window.db.paper.update).mockRejectedValueOnce(new Error('磁盘只读'))
    await wrapper.get('[aria-label="论文标题"]').setValue('Retry title')
    await wrapper.get('form').trigger('submit'); await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('磁盘只读')
    expect(store.getPaper('a')?.title).toBe('Old')
    expect(wrapper.emitted('close')).toBeUndefined()
    await wrapper.get('form').trigger('submit'); await flushPromises()
    expect(store.getPaper('a')?.title).toBe('Retry title')
  })
})
