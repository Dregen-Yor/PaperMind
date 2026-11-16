import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import ElementPlus from 'element-plus'
import SettingsView from '../views/SettingsView.vue'
import { useChatStore } from '../stores/chat'

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ GlobalWorkerOptions: {} }))
vi.mock('../utils/transformersEmbedder', () => ({ createTransformersEmbedder: vi.fn().mockRejectedValue(new Error('offline')) }))

describe('official Docling settings', () => {
  beforeEach(() => vi.clearAllMocks())

  it('shows the fixed official service and only submits an API key', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/settings', component: SettingsView }] })
    await router.push('/settings')
    const wrapper = mount(SettingsView, { global: { plugins: [pinia, router, ElementPlus] } })
    const store = useChatStore()
    const save = vi.spyOn(store, 'setDoclingCredentials')

    expect(wrapper.text()).toContain('官方 Docling 文档解析服务')
    expect(wrapper.text()).toContain('https://docling.example.com')
    expect(wrapper.text()).toContain('PDF、OCR、公式和表格')
    expect(wrapper.find('[data-test="docling-base-url"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="docling-timeout"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="docling-ocr"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="docling-formula"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="docling-table"]').exists()).toBe(false)

    await wrapper.get('[data-test="docling-api-key"] input').setValue('candidate-key')
    await wrapper.get('[data-test="docling-save"]').trigger('click')
    await flushPromises()
    expect(save).toHaveBeenCalledWith({ apiKey: 'candidate-key' })

    await wrapper.get('[data-test="docling-test"]').trigger('click')
    await flushPromises()
    expect(window.db.docling.testConnection).toHaveBeenCalledWith({ apiKey: 'candidate-key' })
    wrapper.unmount()
  })
})
