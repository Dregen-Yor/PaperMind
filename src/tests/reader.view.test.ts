import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, nextTick } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import ReaderView from '../views/ReaderView.vue'
import ChatPanel from '../components/ChatPanel.vue'
import PdfViewer from '../components/PdfViewer.vue'
import { usePaperStore, type Paper } from '../stores/paper'
import { useChatStore, type Conversation } from '../stores/chat'

vi.mock('../utils/pdfUtils', () => ({ base64ToUrl: () => 'blob:reader-test' }))

const papers: Paper[] = ['a', 'b'].map(id => ({
  id,
  title: 'Paper ' + id,
  authors: [],
  abstract: '',
  year: 2026,
  tags: [],
  status: 'reading',
  fileName: id + '.pdf',
  fileHash: '',
  addedAt: 0,
  knowledgeBaseId: 'default',
}))

let wrapper: VueWrapper | undefined
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.restoreAllMocks()
})

describe('reader conversation lifecycle', () => {
  it('keeps the current paper conversation when an earlier creation resolves late', async () => {
    const pinia = createPinia()
    const paperStore = usePaperStore(pinia)
    const chatStore = useChatStore(pinia)
    paperStore.papers = papers.map(paper => ({ ...paper }))
    paperStore.loaded = true
    chatStore.loaded = true
    vi.spyOn(paperStore, 'readPaperFile').mockResolvedValue('pdf-fixture')

    const pending: Array<{ paperId: string; resolve: () => void }> = []
    vi.spyOn(chatStore, 'newConversation').mockImplementation((title, paperIds) => new Promise(resolve => {
      const conversation: Conversation = { id: 'conv-' + paperIds[0], title, paperIds, messages: [], createdAt: 0 }
      pending.push({
        paperId: paperIds[0],
        resolve: () => {
          chatStore.conversations.push(conversation)
          resolve(conversation)
        },
      })
    }))

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/library/:id', component: ReaderView }],
    })
    await router.push('/library/a')
    wrapper = shallowMount(ReaderView, {
      global: {
        plugins: [pinia, router],
        stubs: { ElButton: true, ElIcon: true, ElSelect: true, ElOption: true, ElEmpty: true },
      },
    })
    await flushPromises()
    await router.push('/library/b')
    await flushPromises()

    expect(pending.map(item => item.paperId)).toEqual(['a', 'b'])
    pending[1].resolve()
    await flushPromises()
    expect(wrapper.findComponent(ChatPanel).props('conversation')?.id).toBe('conv-b')

    pending[0].resolve()
    await flushPromises()
    expect(wrapper.findComponent(ChatPanel).props('conversation')?.paperIds).toEqual(['b'])
  })

  it('带 ?page= 打开阅读页时滚动到目标页（1-based query）', async () => {
    const pinia = createPinia()
    const paperStore = usePaperStore(pinia)
    const chatStore = useChatStore(pinia)
    paperStore.papers = papers.map(paper => ({ ...paper }))
    paperStore.loaded = true
    chatStore.loaded = true
    vi.spyOn(paperStore, 'readPaperFile').mockResolvedValue('pdf-fixture')

    const scrollToPage = vi.fn()
    const PdfViewerStub = defineComponent({
      name: 'PdfViewer',
      props: ['src', 'paperId'],
      setup: () => ({ scrollToPage }),
      template: '<div />',
    })

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/library/:id', component: ReaderView }],
    })
    await router.push('/library/a?page=3')
    wrapper = shallowMount(ReaderView, {
      global: {
        plugins: [pinia, router],
        stubs: { ElButton: true, ElIcon: true, ElSelect: true, ElOption: true, ElEmpty: true, PdfViewer: PdfViewerStub },
      },
    })
    await flushPromises()
    await nextTick()

    expect(wrapper.findComponent(PdfViewer).props('src')).toBe('blob:reader-test')
    expect(scrollToPage).toHaveBeenCalledWith(3)
  })
})
