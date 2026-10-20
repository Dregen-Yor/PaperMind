import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import ElementPlus, { ElMessageBox } from 'element-plus'
import SettingsView from '../views/SettingsView.vue'
import { useChatStore } from '../stores/chat'
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ GlobalWorkerOptions: {} }))
vi.mock('../utils/transformersEmbedder', () => ({ createTransformersEmbedder: vi.fn().mockRejectedValue(new Error('offline')) }))
const backup = { version: 1, knowledgeBases: [], papers: [], conversations: [], highlights: [], settings: [] }
let wrapper: VueWrapper | undefined
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(window.db.data.import).mockResolvedValue(undefined)
})
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.restoreAllMocks() })
async function setup() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/settings', component: SettingsView }, { path: '/library', component: { template: '<div />' } },
  ] })
  await router.push('/settings')
  wrapper = mount(SettingsView, { global: { plugins: [pinia, router, ElementPlus], stubs: {
    ElDialog: { props: ['modelValue'], template: '<section v-if="modelValue"><slot /><slot name="footer" /></section>' },
  } } })
  await flushPromises()
  return { router, store: useChatStore() }
}
async function choose(data: unknown = backup) {
  const input = wrapper!.get('input[type="file"]')
  Object.defineProperty(input.element, 'files', { configurable: true, value: [{ name: 'backup.json', text: async () => JSON.stringify(data) }] })
  await input.trigger('change')
  await flushPromises()
}
describe('backup recovery consent and unsaved settings', () => {
  it('previews replacement before any destructive IPC and cancels without writing', async () => {
    await setup()
    await choose()
    expect(window.db.data.import).not.toHaveBeenCalled()
    expect(wrapper!.get('[data-test="restore-preview"]').text()).toContain('替换')
    await wrapper!.get('[data-test="restore-cancel"]').trigger('click')
    expect(window.db.data.import).not.toHaveBeenCalled()
    expect(wrapper!.find('[data-test="restore-preview"]').exists()).toBe(false)
  })
  it('keeps recovery preview and input data after failed persistence for retry', async () => {
    await setup()
    vi.mocked(window.db.data.import).mockRejectedValueOnce(new Error('磁盘空间不足'))
    await choose()
    await wrapper!.get('[data-test="restore-confirm"]').trigger('click')
    await flushPromises()
    expect(window.db.data.import).toHaveBeenCalledWith(backup)
    expect(wrapper!.get('[data-test="restore-error"]').text()).toContain('磁盘空间不足')
    expect(wrapper!.find('[data-test="restore-preview"]').exists()).toBe(true)
  })
  it('shows backup counts including PDFs that will remain unavailable', async () => {
    await setup()
    await choose({ ...backup, papers: [{ id: 'missing', fileData: null }, { id: 'present', fileData: 'cGRm' }] })
    expect(wrapper!.get('[data-test="restore-preview"]').text()).toContain('2 篇论文')
    expect(wrapper!.get('[data-test="restore-preview"]').text()).toContain('1 篇缺少 PDF')
    expect(window.db.data.import).not.toHaveBeenCalled()
  })
  it('does not replace data when the user cancels exporting a safety copy', async () => {
    await setup()
    vi.mocked(window.db.data.exportFile).mockResolvedValueOnce({ canceled: true })
    await choose()
    await wrapper!.get('[data-test="restore-backup-first"]').trigger('click')
    await flushPromises()
    expect(window.db.data.import).not.toHaveBeenCalled()
    expect(wrapper!.find('[data-test="restore-preview"]').exists()).toBe(true)
  })
  it('blocks navigation with unsaved Docling settings and lets the user keep editing', async () => {
    const { router } = await setup()
    await wrapper!.get('input[data-test="docling-base-url"]').setValue('http://example.test:5001')
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockRejectedValueOnce('cancel')
    await router.push('/library')
    expect(confirm).toHaveBeenCalled()
    expect(router.currentRoute.value.path).toBe('/settings')
    expect((wrapper!.get('input[data-test="docling-base-url"]').element as HTMLInputElement).value).toBe('http://example.test:5001')
  })
  it('shows explicit and automatic save modes and keeps failed settings dirty', async () => {
    const { store } = await setup()
    vi.spyOn(store, 'setDoclingConfig').mockRejectedValueOnce(new Error('写入失败'))
    await wrapper!.get('input[data-test="docling-base-url"]').setValue('http://example.test:5001')
    await wrapper!.get('[data-test="docling-save"]').trigger('click')
    await flushPromises()
    expect(wrapper!.text()).toContain('自动保存')
    expect(wrapper!.get('[data-test="docling-save-state"]').text()).toContain('未保存')
  })
  it('does not submit the same restore twice while its first write is pending', async () => {
    const { router } = await setup()
    vi.mocked(window.db.data.import).mockImplementationOnce(() => new Promise(() => {}))
    await choose()
    await wrapper!.get('[data-test="restore-confirm"]').trigger('click')
    await wrapper!.get('[data-test="restore-confirm"]').trigger('click')
    await router.push('/library')
    expect(window.db.data.import).toHaveBeenCalledTimes(1)
    expect(router.currentRoute.value.path).toBe('/settings')
  })
  it('warns before closing a window with an unsaved Docling edit', async () => {
    await setup()
    await wrapper!.get('input[data-test="docling-base-url"]').setValue('http://example.test:5001')
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })
  it('keeps edited Docling fields intact if a late initial settings load arrives', async () => {
    const { store } = await setup()
    await wrapper!.get('input[data-test="docling-base-url"]').setValue('http://example.test:5001')
    store.doclingConfig = { ...store.doclingConfig, baseUrl: 'http://saved.test:5001' }
    await flushPromises()
    expect((wrapper!.get('input[data-test="docling-base-url"]').element as HTMLInputElement).value).toBe('http://example.test:5001')
  })
  it('allows the required reload after a successful confirmed restore', async () => {
    await setup()
    await choose()
    await wrapper!.get('[data-test="restore-confirm"]').trigger('click')
    await flushPromises()
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(window.db.data.import).toHaveBeenCalledTimes(1)
  })
  it('serializes model selection so an older failure cannot roll back a newer success', async () => {
    const { store } = await setup()
    store.profiles = ['old', 'first', 'second'].map(id => ({ ...store.profiles[0], id, name: id }))
    store.chatProfileId = 'old'
    let failFirst!: (error: Error) => void
    vi.mocked(window.db.settings.set).mockImplementationOnce(() => new Promise((_resolve, reject) => { failFirst = reject }))
    const select = wrapper!.findAllComponents({ name: 'ElSelect' })[0]
    select.vm.$emit('update:modelValue', 'first')
    select.vm.$emit('change', 'first')
    await flushPromises()
    expect(select.props('disabled')).toBe(true)
    select.vm.$emit('update:modelValue', 'second')
    select.vm.$emit('change', 'second')
    await flushPromises()
    expect(window.db.settings.set).toHaveBeenCalledTimes(1)
    failFirst(new Error('first save failed'))
    await flushPromises()
    expect(store.chatProfileId).toBe('old')
    select.vm.$emit('update:modelValue', 'second')
    select.vm.$emit('change', 'second')
    await flushPromises()
    expect(window.db.settings.set).toHaveBeenLastCalledWith('llm_profile_chat', 'second')
    expect(store.chatProfileId).toBe('second')
  })
})
