import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount, flushPromises } from '@vue/test-utils'
import ElementPlus, { ElMessage } from 'element-plus'
import SettingsView from '../views/SettingsView.vue'
import { useChatStore } from '../stores/chat'
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ GlobalWorkerOptions: {} }))
vi.mock('../utils/transformersEmbedder', () => ({ createTransformersEmbedder: vi.fn().mockRejectedValue(new Error('offline')) }))
beforeEach(() => { vi.clearAllMocks(); vi.mocked(window.db.settings.get).mockResolvedValue(null) })
function setup() {
  const pinia = createPinia(); setActivePinia(pinia)
  const store = useChatStore()
  return { store, wrapper: mount(SettingsView, { global: { plugins: [pinia, ElementPlus] } }) }
}
describe('E-k5 settings', () => {
  it('offers one retrieval mode and no legacy switch or indexing LLM selector', () => {
    const { wrapper } = setup()
    expect(wrapper.find('[data-test="ek5-settings"]').exists()).toBe(true)
    expect(wrapper.findAllComponents({ name: 'ElSwitch' })).toHaveLength(0)
    expect(wrapper.text()).not.toContain('启用语义树')
    expect(wrapper.text()).toContain('参考内容上限')
    wrapper.unmount()
  })
  it('persists the combined context guard', async () => {
    const { store, wrapper } = setup()
    await store.setRetrievalContextChars(50000)
    expect(window.db.settings.set).toHaveBeenCalledWith('ek5_context_chars', 50000)
    await expect(store.setRetrievalContextChars(0)).rejects.toThrow()
    wrapper.unmount()
  })
  it('reports rebuild failures honestly', async () => {
    const { store, wrapper } = setup()
    vi.spyOn(store, 'rebuildEk5Indexes').mockResolvedValue({ rebuilt: 0, errors: ['bad PDF'] })
    const warning = vi.spyOn(ElMessage, 'warning')
    await wrapper.get('[data-test="rebuild-ek5"]').trigger('click'); await flushPromises()
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('bad PDF'))
    wrapper.unmount()
  })
})
