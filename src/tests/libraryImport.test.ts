import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { usePaperStore } from '../stores/paper'
import { useChatStore } from '../stores/chat'
import { parsePdfMeta } from '../utils/pdfUtils'
import LibraryView from '../views/LibraryView.vue'
import { ElMessageBox } from 'element-plus'

vi.mock('../utils/pdfUtils', () => ({ parsePdfMeta: vi.fn() }))
vi.mock('element-plus', () => ({
  ElMessageBox: { confirm: vi.fn().mockResolvedValue(undefined) },
  ElMessage: { success: vi.fn() },
}))

type PdfMeta = Awaited<ReturnType<typeof parsePdfMeta>>
const confirmResult = 'confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(finish => { resolve = finish })
  return { promise, resolve }
}
const metadata = (name: string): PdfMeta => ({
  title: name, authors: [], abstract: '', year: 2026, fileData: 'cGRm', fileHash: name,
})
const stubs = Object.fromEntries([
  'ElButton', 'ElIcon', 'ElSelect', 'ElOption', 'ElInput', 'ElDialog', 'ElForm',
  'ElFormItem', 'ElDropdown', 'ElDropdownMenu', 'ElDropdownItem', 'ElProgress', 'ElTag',
].map(name => [name, true]))
let wrappers: VueWrapper[] = []

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(parsePdfMeta).mockImplementation(async file => metadata(file.name))
  vi.mocked(window.db.paper.contentUrl).mockResolvedValue(null)
  vi.mocked(window.db.paper.create).mockImplementation(async paper => ({
    ...paper, fileHash: paper.fileHash ?? '', filePath: `/test/papers/${paper.id}.pdf`,
  }))
  vi.mocked(window.db.paper.restoreFile).mockResolvedValue(undefined)
  vi.mocked(ElMessageBox.confirm).mockResolvedValue(confirmResult)
})
afterEach(() => {
  wrappers.forEach(wrapper => wrapper.unmount())
  wrappers = []
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function mountLibrary(pinia = createPinia()) {
  const papers = usePaperStore(pinia)
  if (!papers.loaded) {
    papers.loaded = true
    papers.knowledgeBases = [
      { id: 'default', name: '默认知识库', description: '', color: '#73543c', createdAt: 0 },
      { id: 'other', name: '另一个知识库', description: '', color: '#65765a', createdAt: 1 },
    ]
  }
  const chats = useChatStore(pinia)
  chats.loaded = true
  vi.spyOn(chats, 'indexPaper').mockResolvedValue(undefined)
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/library', component: LibraryView },
    { path: '/library/:id', component: { template: '<div>Reader</div>' } },
    { path: '/elsewhere', component: { template: '<div>Elsewhere</div>' } },
  ] })
  await router.push('/library')
  const wrapper = shallowMount(LibraryView, { global: { plugins: [pinia, router], stubs } })
  wrappers.push(wrapper)
  await flushPromises()
  return { wrapper, papers, router, pinia }
}

async function selectFiles(wrapper: VueWrapper, names: string[]) {
  const input = wrapper.get('input[type="file"]')
  Object.defineProperty(input.element, 'files', {
    configurable: true,
    value: names.map(name => new File(['pdf'], name, { type: 'application/pdf' })),
  })
  await input.trigger('change')
  await flushPromises()
}

describe('library PDF import batches', () => {
  // Replacing the active batch's loop bound must not drop an accepted file.
  it('imports every accepted file when a shorter batch is selected during parsing', async () => {
    const { wrapper, papers } = await mountLibrary()
    const first = deferred<PdfMeta>()
    vi.mocked(parsePdfMeta).mockImplementation(async file => file.name === 'first-a.pdf'
      ? first.promise : metadata(file.name))
    await selectFiles(wrapper, ['first-a.pdf', 'first-b.pdf'])
    await selectFiles(wrapper, ['second-c.pdf'])
    first.resolve(metadata('first-a.pdf'))
    await flushPromises()
    expect(papers.papers.map(paper => paper.fileName).sort()).toEqual([
      'first-a.pdf', 'first-b.pdf', 'second-c.pdf',
    ])
    expect(wrapper.get('.import-counter').text()).toBe('3 / 3')
  })

  // Saving after an await must use the user's accepted target, not the visible tab.
  it('keeps the selected target for every file when the user changes knowledge base', async () => {
    const { wrapper, papers } = await mountLibrary()
    const first = deferred<PdfMeta>()
    vi.mocked(parsePdfMeta).mockImplementation(async file => file.name === 'first-a.pdf'
      ? first.promise : metadata(file.name))
    await selectFiles(wrapper, ['first-a.pdf', 'first-b.pdf'])
    await wrapper.findAll('.kb-tab')[1].trigger('click')
    first.resolve(metadata('first-a.pdf'))
    await flushPromises()
    expect(papers.papers.map(paper => [paper.fileName, paper.knowledgeBaseId]).sort()).toEqual([
      ['first-a.pdf', 'default'], ['first-b.pdf', 'default'],
    ])
    expect(wrapper.get('.import-panel').text()).toContain('默认知识库')
  })

  // The consumer returning to the library must still see the in-flight task.
  it('retains accepted import progress when the library is unmounted and reopened', async () => {
    const first = deferred<PdfMeta>()
    vi.mocked(parsePdfMeta).mockImplementation(async file => file.name === 'first-a.pdf'
      ? first.promise : metadata(file.name))
    const { wrapper, papers, pinia } = await mountLibrary()
    await selectFiles(wrapper, ['first-a.pdf', 'first-b.pdf'])
    wrapper.unmount()
    const reopened = await mountLibrary(pinia)
    const hasPendingProgress = reopened.wrapper.find('.import-panel').exists()
    first.resolve(metadata('first-a.pdf'))
    await flushPromises()
    expect(hasPendingProgress).toBe(true)
    expect(papers.papers.map(paper => paper.fileName).sort()).toEqual(['first-a.pdf', 'first-b.pdf'])
    expect(reopened.wrapper.get('.import-counter').text()).toBe('2 / 2')
  })

  // Resolving an old confirmation must not take over the user's later navigation.
  it.each(['/elsewhere', '/library'])('does not let a detached duplicate confirmation override %s', async destination => {
    const { wrapper, papers, router, pinia } = await mountLibrary()
    wrappers.push(shallowMount({ template: '<div />' }, { global: { plugins: [router] } }))
    papers.papers = [{
      ...metadata('existing.pdf'), id: 'existing', fileName: 'existing.pdf',
      knowledgeBaseId: 'default', status: 'unread', tags: [], addedAt: 1,
    }]
    vi.mocked(window.db.paper.contentUrl).mockResolvedValue('papermind-paper://paper/existing')
    const confirmation = deferred<Awaited<ReturnType<typeof ElMessageBox.confirm>>>()
    vi.mocked(ElMessageBox.confirm).mockImplementationOnce(() => confirmation.promise)
    await selectFiles(wrapper, ['existing.pdf'])
    await router.push(destination)
    wrapper.unmount()
    if (destination === '/library') {
      wrappers.push(shallowMount(LibraryView, { global: { plugins: [pinia, router], stubs } }))
    }
    confirmation.resolve(confirmResult)
    await flushPromises()
    expect(router.currentRoute.value.path).toBe(destination)
    expect(papers.papers.map(paper => paper.id)).toEqual(['existing'])
  })

  it.each([
    { label: 'equal-sized', next: ['second-c.pdf', 'second-d.pdf'], expected: ['first-a.pdf', 'first-b.pdf', 'second-c.pdf', 'second-d.pdf'] },
    { label: 'longer', next: ['second-c.pdf', 'second-d.pdf', 'second-e.pdf'], expected: ['first-a.pdf', 'first-b.pdf', 'second-c.pdf', 'second-d.pdf', 'second-e.pdf'] },
  ])('keeps progress and accepted files independent for a $label second batch', async ({ next, expected }) => {
    const { wrapper, papers } = await mountLibrary()
    const first = deferred<PdfMeta>()
    vi.mocked(parsePdfMeta).mockImplementation(async file => file.name === 'first-a.pdf'
      ? first.promise : metadata(file.name))
    await selectFiles(wrapper, ['first-a.pdf', 'first-b.pdf'])
    await selectFiles(wrapper, next)
    expect(wrapper.findAll('.import-item').map(row => row.attributes('data-status'))).toEqual(
      ['parsing', ...expected.slice(1).map(() => 'pending')],
    )
    first.resolve(metadata('first-a.pdf'))
    await flushPromises()
    expect(papers.papers.map(paper => paper.fileName).sort()).toEqual(expected)
    expect(wrapper.findAll('.import-item').map(row => row.attributes('data-status'))).toEqual(expected.map(() => 'done'))
  })

  it('captures a separate destination for a newly queued batch', async () => {
    const { wrapper, papers } = await mountLibrary()
    const first = deferred<PdfMeta>()
    vi.mocked(parsePdfMeta).mockImplementation(async file => file.name === 'first-a.pdf'
      ? first.promise : metadata(file.name))
    await selectFiles(wrapper, ['first-a.pdf'])
    await wrapper.findAll('.kb-tab')[1].trigger('click')
    await selectFiles(wrapper, ['second-b.pdf'])
    await wrapper.findAll('.kb-tab')[0].trigger('click')
    expect(wrapper.findAll('.import-item-target').map(row => row.text())).toEqual([
      '导入至 默认知识库', '导入至 另一个知识库',
    ])
    first.resolve(metadata('first-a.pdf'))
    await flushPromises()
    expect(papers.papers.map(paper => [paper.fileName, paper.knowledgeBaseId]).sort()).toEqual([
      ['first-a.pdf', 'default'], ['second-b.pdf', 'other'],
    ])
  })

  it('keeps separate rows for same-named files with different contents', async () => {
    const { wrapper, papers } = await mountLibrary()
    const first = deferred<PdfMeta>()
    vi.mocked(parsePdfMeta).mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({ ...metadata('same.pdf'), fileHash: 'second-content' })
    await selectFiles(wrapper, ['same.pdf'])
    await selectFiles(wrapper, ['same.pdf'])
    expect(wrapper.findAll('.import-item').map(row => row.attributes('data-status'))).toEqual(['parsing', 'pending'])
    first.resolve({ ...metadata('same.pdf'), fileHash: 'first-content' })
    await flushPromises()
    expect(papers.papers.map(paper => paper.fileHash).sort()).toEqual(['first-content', 'second-content'])
    expect(wrapper.findAll('.import-item').map(row => row.attributes('data-status'))).toEqual(['done', 'done'])
  })

  it.each(['parse', 'write'])('continues accepted work after a file %s failure', async stage => {
    const { wrapper, papers } = await mountLibrary()
    if (stage === 'parse') {
      vi.mocked(parsePdfMeta).mockRejectedValueOnce(new Error('PDF 解析失败'))
    } else {
      vi.mocked(window.db.paper.create).mockRejectedValueOnce(new Error('文件写入失败'))
    }
    await selectFiles(wrapper, ['broken.pdf', 'healthy.pdf'])
    expect(papers.papers.map(paper => paper.fileName)).toEqual(['healthy.pdf'])
    expect(wrapper.findAll('.import-item').map(row => row.attributes('data-status'))).toEqual(['error', 'done'])
    expect(wrapper.get('.import-counter').text()).toBe('2 / 2')
    expect(wrapper.get('.import-item-error').text()).toContain(stage === 'parse' ? 'PDF 解析失败' : '文件写入失败')
  })

  it('reports a deleted queued destination without redirecting its files or stopping later batches', async () => {
    const { wrapper, papers } = await mountLibrary()
    const first = deferred<PdfMeta>()
    vi.mocked(parsePdfMeta).mockImplementation(async file => file.name === 'first-a.pdf'
      ? first.promise : metadata(file.name))
    await selectFiles(wrapper, ['first-a.pdf'])
    await wrapper.findAll('.kb-tab')[1].trigger('click')
    await selectFiles(wrapper, ['orphan.pdf'])
    await wrapper.findAll('.kb-tab')[0].trigger('click')
    await selectFiles(wrapper, ['later.pdf'])
    papers.knowledgeBases = papers.knowledgeBases.filter(kb => kb.id !== 'other')
    first.resolve(metadata('first-a.pdf'))
    await flushPromises()
    expect(papers.papers.map(paper => [paper.fileName, paper.knowledgeBaseId]).sort()).toEqual([
      ['first-a.pdf', 'default'], ['later.pdf', 'default'],
    ])
    expect(wrapper.get('.import-item-error').text()).toContain('另一个知识库')
    expect(wrapper.findAll('.import-item').map(row => row.attributes('data-status'))).toEqual(['done', 'error', 'done'])
    expect(wrapper.get('.import-counter').text()).toBe('3 / 3')
  })

  it('detects a duplicate of an earlier queued file after its write completes', async () => {
    const { wrapper, papers } = await mountLibrary()
    const first = deferred<PdfMeta>()
    vi.mocked(parsePdfMeta).mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(metadata('same.pdf'))
    vi.mocked(window.db.paper.contentUrl).mockResolvedValue('papermind-paper://paper/existing')
    vi.mocked(ElMessageBox.confirm).mockRejectedValueOnce('cancel')
    await selectFiles(wrapper, ['same.pdf'])
    await selectFiles(wrapper, ['same.pdf'])
    first.resolve(metadata('same.pdf'))
    await flushPromises()
    expect(papers.papers.map(paper => paper.fileName)).toEqual(['same.pdf'])
    expect(wrapper.findAll('.import-item').map(row => row.attributes('data-status'))).toEqual(['done', 'skipped'])
    expect(wrapper.get('.import-counter').text()).toBe('2 / 2')
  })

  it('clears the file input while parsing so the same file can be selected again', async () => {
    const { wrapper } = await mountLibrary()
    const first = deferred<PdfMeta>()
    vi.mocked(parsePdfMeta).mockImplementationOnce(() => first.promise)
    const input = wrapper.get('input[type="file"]')
    Object.defineProperty(input.element, 'value', { configurable: true, writable: true, value: 'chosen.pdf' })
    await selectFiles(wrapper, ['chosen.pdf'])
    const valueWhileParsing = (input.element as HTMLInputElement).value
    first.resolve(metadata('chosen.pdf'))
    await flushPromises()
    expect(valueWhileParsing).toBe('')
  })

  it('keeps the queue shared after returning and selecting another batch', async () => {
    const first = deferred<PdfMeta>()
    vi.mocked(parsePdfMeta).mockImplementation(async file => file.name === 'first-a.pdf'
      ? first.promise : metadata(file.name))
    const { wrapper, papers, pinia } = await mountLibrary()
    await selectFiles(wrapper, ['first-a.pdf', 'first-b.pdf'])
    wrapper.unmount()
    const reopened = await mountLibrary(pinia)
    await selectFiles(reopened.wrapper, ['second-c.pdf'])
    expect(reopened.wrapper.findAll('.import-item').map(row => row.attributes('data-status'))).toEqual(['parsing', 'pending', 'pending'])
    first.resolve(metadata('first-a.pdf'))
    await flushPromises()
    expect(papers.papers.map(paper => paper.fileName).sort()).toEqual(['first-a.pdf', 'first-b.pdf', 'second-c.pdf'])
    expect(reopened.wrapper.get('.import-counter').text()).toBe('3 / 3')
  })

  it('does not let the previous completion timer hide a newly accepted import', async () => {
    vi.useFakeTimers()
    const { wrapper } = await mountLibrary()
    await selectFiles(wrapper, ['complete.pdf'])
    await vi.advanceTimersByTimeAsync(2000)
    const next = deferred<PdfMeta>()
    vi.mocked(parsePdfMeta).mockImplementationOnce(() => next.promise)
    await selectFiles(wrapper, ['pending.pdf'])
    await vi.advanceTimersByTimeAsync(3000)
    expect(wrapper.find('.import-panel').exists()).toBe(true)
    expect(wrapper.get('.import-counter').text()).toBe('0 / 1')
    next.resolve(metadata('pending.pdf'))
    await flushPromises()
    await vi.advanceTimersByTimeAsync(2499)
    expect(wrapper.find('.import-panel').exists()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(wrapper.find('.import-panel').exists()).toBe(false)
  })
})
