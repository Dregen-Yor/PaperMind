import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { usePaperStore, type Paper } from '../stores/paper'
import { useChatStore } from '../stores/chat'
import ReaderView from '../views/ReaderView.vue'
import PdfViewer from '../components/PdfViewer.vue'
import LibraryView from '../views/LibraryView.vue'
import { ElMessageBox } from 'element-plus'

vi.mock('../utils/pdfUtils', () => ({ parsePdfMeta: vi.fn(async () => ({
  title: 'Imported title', authors: ['New author'], abstract: '', year: 0,
  fileData: 'JVBERi0xLjcKb3JpZ2luYWw=', fileHash: 'a'.repeat(64),
})) }))
vi.mock('element-plus', () => ({ ElMessageBox: { confirm: vi.fn().mockResolvedValue(undefined) }, ElMessage: { success: vi.fn() } }))

const savedPaper: Paper = { id: 'a', knowledgeBaseId: 'default', title: 'Edited title', authors: [], abstract: '', year: 2026,
  tags: ['keep'], status: 'done', fileName: 'original.pdf', fileHash: 'a'.repeat(64), addedAt: 1 }
const stubs = Object.fromEntries(['ElButton', 'ElIcon', 'ElSelect', 'ElOption', 'ElEmpty', 'ElInput', 'ElDialog', 'ElForm', 'ElFormItem', 'ElDropdown', 'ElDropdownMenu', 'ElDropdownItem', 'ElProgress', 'ElTag'].map(name => [name, true]))
let wrapper: VueWrapper | undefined
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(window.db.paper.contentUrl).mockResolvedValue(null)
  vi.mocked(window.db.paper.restoreFile).mockResolvedValue(undefined)
})
afterEach(() => { wrapper?.unmount(); wrapper = undefined })

async function mountView(component: typeof ReaderView | typeof LibraryView) {
  const pinia = createPinia()
  const papers = usePaperStore(pinia)
  papers.loaded = true
  papers.papers = [{ ...savedPaper }, { ...savedPaper, id: 'b' }]
  const chats = useChatStore(pinia)
  chats.loaded = true
  vi.spyOn(chats, 'newConversation').mockImplementation(async (_title, paperIds) => ({ id: 'chat-' + paperIds[0], title: 'Saved chat', paperIds, messages: [], createdAt: 1 }))
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/library/:id', component: ReaderView }, { path: '/library', component: LibraryView },
  ] })
  await router.push(component === ReaderView ? '/library/a' : '/library')
  wrapper = shallowMount(component, { global: { plugins: [pinia, router], stubs } })
  await flushPromises()
  return { papers, router }
}

async function selectFile(input: ReturnType<VueWrapper['find']>) {
  Object.defineProperty(input.element, 'files', { configurable: true, value: [new File(['%PDF-1.7\noriginal'], 'original.pdf', { type: 'application/pdf' })] })
  await input.trigger('change')
  await flushPromises()
}

describe('missing PDF repair entry points', () => {
  it('opens the original paper after explicit repair without changing its metadata', async () => {
    const { papers } = await mountView(ReaderView)
    expect(wrapper!.find('.repair-pdf-button').exists()).toBe(true)
    await wrapper!.find('.repair-pdf-button').trigger('click')
    vi.mocked(window.db.paper.contentUrl).mockResolvedValue('papermind-paper://paper/a')
    await selectFile(wrapper!.find('input[type="file"]'))
    await vi.waitFor(() => expect(wrapper!.findComponent(PdfViewer).exists()).toBe(true))
    expect(window.db.paper.restoreFile).toHaveBeenCalledWith('a', 'JVBERi0xLjcKb3JpZ2luYWw=')
    expect(wrapper!.findComponent(PdfViewer).props('paperId')).toBe('a')
    expect(papers.getPaper('a')).toEqual(savedPaper)
    expect(window.db.paper.create).not.toHaveBeenCalled()
  })

  it('shows a mismatched PDF error and lets the user retry', async () => {
    await mountView(ReaderView)
    vi.mocked(window.db.paper.restoreFile).mockRejectedValueOnce(new Error('PDF 与原论文不匹配'))
    await wrapper!.find('.repair-pdf-button').trigger('click')
    await selectFile(wrapper!.find('input[type="file"]'))
    await vi.waitFor(() => expect(wrapper!.text()).toContain('PDF 与原论文不匹配'))
    expect(wrapper!.find('.repair-pdf-button').attributes('disabled')).toBeUndefined()
    vi.mocked(window.db.paper.contentUrl).mockResolvedValue('papermind-paper://paper/a')
    await wrapper!.find('.repair-pdf-button').trigger('click')
    await selectFile(wrapper!.find('input[type="file"]'))
    await vi.waitFor(() => expect(wrapper!.findComponent(PdfViewer).exists()).toBe(true))
  })

  it('keeps a late repair completion from replacing another paper view', async () => {
    const { router } = await mountView(ReaderView)
    let finish!: () => void
    vi.mocked(window.db.paper.restoreFile).mockImplementation(() => new Promise(resolve => { finish = resolve }))
    await wrapper!.find('.repair-pdf-button').trigger('click')
    await selectFile(wrapper!.find('input[type="file"]'))
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    await router.push('/library/b')
    await flushPromises()
    vi.mocked(window.db.paper.contentUrl).mockResolvedValue('papermind-paper://paper/a')
    finish()
    await flushPromises()
    expect(wrapper!.findComponent(PdfViewer).exists()).toBe(false)
    expect(wrapper!.find('.reader-title').text()).toBe('Edited title')
    expect(window.db.paper.restoreFile).toHaveBeenCalledWith('a', expect.any(String))
  })

  it('explains why a legacy paper cannot be safely reassociated', async () => {
    const { papers } = await mountView(ReaderView)
    papers.papers[0].fileHash = ''
    await flushPromises()
    expect(wrapper!.text()).toContain('没有可信的原文件哈希')
    expect(wrapper!.find('.repair-pdf-button').exists()).toBe(false)
  })

  it('repairs same-hash reimport when the stored PDF is missing and preserves the existing entry', async () => {
    const { papers, router } = await mountView(LibraryView)
    await selectFile(wrapper!.find('input[type="file"]'))
    expect(window.db.paper.restoreFile).toHaveBeenCalledWith('a', 'JVBERi0xLjcKb3JpZ2luYWw=')
    expect(window.db.paper.create).not.toHaveBeenCalled()
    expect(ElMessageBox.confirm).not.toHaveBeenCalled()
    expect(papers.getPaper('a')).toEqual(savedPaper)
    expect(router.currentRoute.value.path).toBe('/library/a')
  })

  it('keeps the regular duplicate open-or-skip choice when the PDF is available', async () => {
    await mountView(LibraryView)
    vi.mocked(window.db.paper.contentUrl).mockResolvedValue('papermind-paper://paper/a')
    vi.mocked(ElMessageBox.confirm).mockRejectedValueOnce('cancel')
    await selectFile(wrapper!.find('input[type="file"]'))
    expect(ElMessageBox.confirm).toHaveBeenCalled()
    expect(window.db.paper.restoreFile).not.toHaveBeenCalled()
    expect(window.db.paper.create).not.toHaveBeenCalled()
    expect(wrapper!.text()).toContain('已跳过')
  })

  it('reports failed reimport repair without opening a broken entry or adding another paper', async () => {
    const { router } = await mountView(LibraryView)
    vi.mocked(window.db.paper.restoreFile).mockRejectedValueOnce(new Error('文件写入失败'))
    await selectFile(wrapper!.find('input[type="file"]'))
    expect(wrapper!.text()).toContain('文件写入失败')
    expect(router.currentRoute.value.path).toBe('/library')
    expect(window.db.paper.create).not.toHaveBeenCalled()
  })
})
