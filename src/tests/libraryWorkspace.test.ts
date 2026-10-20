import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import LibraryView from '../views/LibraryView.vue'
import { usePaperStore, type Paper } from '../stores/paper'
import { ElMessage } from 'element-plus'

vi.mock('../utils/pdfUtils', () => ({ parsePdfMeta: vi.fn() }))
vi.mock('element-plus', () => ({
  ElMessageBox: { confirm: vi.fn().mockResolvedValue('confirm') },
  ElMessage: { success: vi.fn(), error: vi.fn() },
}))
const stubs = Object.fromEntries([
  'ElButton', 'ElIcon', 'ElSelect', 'ElOption', 'ElInput', 'ElDialog', 'ElForm',
  'ElFormItem', 'ElDropdown', 'ElDropdownMenu', 'ElDropdownItem', 'ElProgress', 'ElTag',
].map(name => [name, true]))
const paper = (id: string, kb = 'default'): Paper => ({
  id, title: id, authors: [], abstract: '', year: 2026, tags: [], status: 'unread',
  fileName: `${id}.pdf`, fileHash: id, addedAt: 0, knowledgeBaseId: kb,
})
let wrappers: VueWrapper[] = []
beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers() })
afterEach(() => { wrappers.forEach(w => w.unmount()); wrappers = []; vi.useRealTimers() })
async function mountLibrary(pinia = createPinia()) {
  const store = usePaperStore(pinia)
  if (!store.loaded) {
    store.loaded = true
    store.knowledgeBases = ['default', 'other', 'third'].map(id => ({ id, name: id, description: '', color: '', createdAt: 0 }))
    store.papers = [paper('a'), paper('b'), paper('c', 'other')]
  }
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/library', component: LibraryView }] })
  await router.push('/library')
  const wrapper = shallowMount(LibraryView, { global: { plugins: [pinia, router], stubs: { ...stubs, RouterLink: { template: '<a><slot /></a>' } } } })
  wrappers.push(wrapper)
  await flushPromises()
  return { wrapper, store, pinia, vm: wrapper.vm as any }
}

describe('library workspace continuity and actions', () => {
  it('retains library, search, status and sort when returning', async () => {
    const { wrapper, vm, pinia } = await mountLibrary()
    vm.activeKbId = 'other'; vm.searchQuery = 'c'; vm.statusFilter = 'reading'; vm.sortOrder = 'title'
    await flushPromises()
    wrapper.unmount()
    const next = await mountLibrary(pinia)
    expect([next.vm.activeKbId, next.vm.searchQuery, next.vm.statusFilter, next.vm.sortOrder]).toEqual(['other', 'c', 'reading', 'title'])
    next.store.knowledgeBases = next.store.knowledgeBases.filter(k => k.id !== 'other')
    await flushPromises()
    expect(next.vm.activeKbId).toBe('default')
  })
  it('opens a destination choice without writing and excludes the source', async () => {
    const { vm } = await mountLibrary()
    await vm.movePaper(paper('a'))
    expect(window.db.paper.update).not.toHaveBeenCalled()
    expect(vm.moveTargets.map((kb: { id: string }) => kb.id)).toEqual(['other', 'third'])
    expect(vm.moveTargetId).toBe('')
  })
  it('keeps a clear no-target state when only the source exists', async () => {
    const { vm, store } = await mountLibrary()
    store.knowledgeBases = store.knowledgeBases.slice(0, 1)
    await vm.movePaper(paper('a'))
    expect(window.db.paper.update).not.toHaveBeenCalled()
    expect(vm.moveTargets).toEqual([])
    expect(vm.movingPaper.id).toBe('a')
  })
  it('waits for persistence before reporting the selected destination', async () => {
    const { vm, store } = await mountLibrary()
    let finish!: () => void
    vi.mocked(window.db.paper.update).mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve }))
    vm.movePaper(paper('a'))
    vm.moveTargetId = 'third'
    const moving = vm.confirmMove()
    expect(store.getPaper('a')?.knowledgeBaseId).toBe('default')
    expect(ElMessage.success).not.toHaveBeenCalled()
    expect(vm.moveSaving).toBe(true)
    finish(); await moving; await flushPromises()
    expect(store.getPaper('a')?.knowledgeBaseId).toBe('third')
    expect(vm.movingPaper).toBeNull()
    expect(ElMessage.success).toHaveBeenCalledWith('已移至「third」')
  })
  it('retains the destination on failed move and supports retry', async () => {
    const { vm, store } = await mountLibrary()
    vi.mocked(window.db.paper.update).mockRejectedValueOnce(new Error('磁盘只读'))
    vm.movePaper(paper('a')); vm.moveTargetId = 'other'
    await vm.confirmMove()
    expect(vm.moveError).toContain('磁盘只读')
    expect(vm.moveTargetId).toBe('other')
    expect(store.getPaper('a')?.knowledgeBaseId).toBe('default')
    expect(ElMessage.success).not.toHaveBeenCalled()
    await vm.confirmMove()
    expect(store.getPaper('a')?.knowledgeBaseId).toBe('other')
  })
  it('does not write when the selected destination has been removed', async () => {
    const { vm, store } = await mountLibrary()
    vm.movePaper(paper('a')); vm.moveTargetId = 'other'
    store.knowledgeBases = store.knowledgeBases.filter(kb => kb.id !== 'other')
    await vm.confirmMove()
    expect(window.db.paper.update).not.toHaveBeenCalled()
  })
  it('does not shorten the first deletion when another paper is deleted', async () => {
    const { vm, wrapper } = await mountLibrary()
    await vm.deletePaper(paper('a'))
    await vi.advanceTimersByTimeAsync(2000)
    await vm.deletePaper(paper('b'))
    expect(window.db.paper.remove).not.toHaveBeenCalled()
    expect(wrapper.findAll('.undo-btn')).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(3000)
    expect(window.db.paper.remove).toHaveBeenCalledExactlyOnceWith('a')
    await vi.advanceTimersByTimeAsync(2000)
    expect(window.db.paper.remove).toHaveBeenCalledTimes(2)
  })
  it('keeps deletion ownership across leaving and returning', async () => {
    const { vm, wrapper, pinia, store } = await mountLibrary()
    await vm.deletePaper(paper('a'))
    wrapper.unmount()
    const next = await mountLibrary(pinia)
    expect(next.wrapper.findAll('.card-title').map(c => c.text())).toEqual(['b'])
    await vi.advanceTimersByTimeAsync(5000)
    expect(window.db.paper.remove).toHaveBeenCalledExactlyOnceWith('a')
    expect(store.getPaper('a')).toBeUndefined()
  })
  it('restores the visible paper and reports a failed delayed deletion', async () => {
    vi.mocked(window.db.paper.remove).mockRejectedValueOnce(new Error('磁盘只读'))
    const { vm, wrapper, store } = await mountLibrary()
    await vm.deletePaper(paper('a'))
    await vi.advanceTimersByTimeAsync(5000)
    await flushPromises()
    expect(store.getPaper('a')).toBeDefined()
    expect(wrapper.findAll('.card-title').map(c => c.text())).toContain('a')
    expect(wrapper.text()).toContain('磁盘只读')
  })
  it('keeps a pending database deletion hidden until it settles and rejects late undo', async () => {
    const { vm, wrapper, store } = await mountLibrary()
    let finish!: () => void
    vi.mocked(window.db.paper.remove).mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve }))
    await vm.deletePaper(paper('a'))
    await vi.advanceTimersByTimeAsync(5000)
    expect(wrapper.text()).toContain('正在删除')
    expect(wrapper.findAll('.undo-btn')).toHaveLength(0)
    expect(store.getPaper('a')).toBeDefined()
    finish(); await flushPromises()
    expect(store.getPaper('a')).toBeUndefined()
  })
  it('allows retrying a failed deletion without losing its error before acknowledgement', async () => {
    const { vm, wrapper, pinia, store } = await mountLibrary()
    vi.mocked(window.db.paper.remove).mockRejectedValueOnce(new Error('暂不可写'))
    await vm.deletePaper(paper('a'))
    await vi.advanceTimersByTimeAsync(5000)
    wrapper.unmount()
    const next = await mountLibrary(pinia)
    expect(next.wrapper.text()).toContain('暂不可写')
    await next.wrapper.findAll('.undo-btn').find(b => b.text() === '重试删除')!.trigger('click')
    await flushPromises()
    expect(store.getPaper('a')).toBeUndefined()
    expect(next.wrapper.text()).not.toContain('暂不可写')
  })
  it('falls back safely when the default library is absent and all libraries disappear', async () => {
    const { vm, store } = await mountLibrary()
    store.knowledgeBases = store.knowledgeBases.filter(kb => kb.id === 'third')
    await flushPromises()
    expect(vm.activeKbId).toBe('third')
    store.knowledgeBases = []
    await flushPromises()
    expect(vm.activeKbId).toBe('')
  })
  it('can undo each deletion independently without writing', async () => {
    const { vm, wrapper } = await mountLibrary()
    await vm.deletePaper(paper('a')); await vm.deletePaper(paper('b'))
    await wrapper.findAll('.undo-btn')[0].trigger('click')
    await vi.advanceTimersByTimeAsync(5000)
    expect(window.db.paper.remove).toHaveBeenCalledExactlyOnceWith('b')
    expect(wrapper.findAll('.card-title').map(c => c.text())).toContain('a')
  })
})
