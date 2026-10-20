import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import ElementPlus from 'element-plus'
import ChatPanel from '../components/ChatPanel.vue'
import ChatSources from '../components/ChatSources.vue'
import WebQaPanel from '../components/WebQaPanel.vue'
import { usePaperStore } from '../stores/paper'
import type { Conversation } from '../types/chat'
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ GlobalWorkerOptions: { workerSrc: '' } }))
let wrapper: VueWrapper | undefined
afterEach(() => { wrapper?.unmount(); vi.restoreAllMocks() })

it('keeps all selected papers visible across knowledge bases, including missing records, and permits removal', async () => {
  const pinia = createPinia()
  usePaperStore(pinia).papers = [{ id: 'other', title: 'Other library paper', kbId: 'other-kb', authors: [] }] as any
  wrapper = mount(ChatSources, { props: { activeKbId: 'empty', selectedPaperIds: ['other', 'missing'], activeConvId: '' }, global: { plugins: [pinia, ElementPlus], stubs: { RouterLink: true } } })
  const selected = wrapper.get('[aria-label="已选论文"]')
  expect(selected.text()).toContain('Other library paper')
  expect(selected.text()).toContain('论文记录已缺失')
  await selected.get('[aria-label="移除论文 missing"]').trigger('click')
  expect(wrapper.emitted('toggle-paper')?.[0]).toEqual(['missing'])
})

it('does not drag the reader down when streaming while they scroll through history', async () => {
  const conversation: Conversation = { id: 'one', title: '', paperIds: [], createdAt: 0, messages: [{ id: 'a', role: 'assistant', content: 'initial', timestamp: 0, runStatus: 'streaming' }] }
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }] })
  await router.push('/')
  wrapper = mount(ChatPanel, { props: { conversation }, global: { plugins: [createPinia(), router, ElementPlus] } })
  await flushPromises()
  const scroll = wrapper.get('.chat-messages').element as HTMLElement
  Object.defineProperties(scroll, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 200 } })
  scroll.scrollTop = 100
  await wrapper.get('.chat-messages').trigger('scroll')
  await wrapper.setProps({ conversation: { ...conversation, messages: [{ ...conversation.messages[0], content: 'more output' }] } })
  await flushPromises()
  expect(scroll.scrollTop).toBe(100)
  await wrapper.get('[aria-label="回到底部"]').trigger('click')
  expect(scroll.scrollTop).toBe(1000)
})

describe('web question keyboard', () => {
  it('uses Enter to send but protects Shift+Enter and IME composition', async () => {
    wrapper = mount(WebQaPanel, { props: { session: null, sessions: [], busy: false, error: '', streamedText: '', canAsk: true, sourceChanged: false, modelName: '' } })
    const input = wrapper.get('textarea')
    await input.setValue('question')
    await input.trigger('keydown', { key: 'Enter', shiftKey: true })
    await input.trigger('keydown', { key: 'Enter', isComposing: true })
    expect(wrapper.emitted('send')).toBeUndefined()
    await input.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')).toEqual([['question']])
    expect(wrapper.text()).toContain('Shift + Enter 换行')
  })
})
