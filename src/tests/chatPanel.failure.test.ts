import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import ElementPlus from 'element-plus'
import ChatPanel from '../components/ChatPanel.vue'
import { useChatStore, type Conversation } from '../stores/chat'

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ default: {}, GlobalWorkerOptions: { workerSrc: '' } }))

let wrapper: VueWrapper | undefined
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.restoreAllMocks() })

const failedConv = (): Conversation => ({
  id: 'c1', title: 't', paperIds: [], createdAt: 0,
  messages: [
    { id: 'm1', role: 'user', content: '你好', timestamp: 1 },
    { id: 'm2', role: 'assistant', content: '', timestamp: 2, error: 'LLM 请求失败 (401)：缺少 API Key' },
  ],
})

describe('ChatPanel 失败卡（#2）', () => {
  it('渲染失败卡，重试调用 store，跳转按钮进设置', async () => {
    const pinia = createPinia()
    const chatStore = useChatStore(pinia)
    const retry = vi.spyOn(chatStore, 'retryMessage').mockResolvedValue()
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', component: { template: '<div />' } },
        { path: '/settings', component: { template: '<div />' } },
      ],
    })
    await router.push('/')
    wrapper = mount(ChatPanel, {
      props: { conversation: failedConv() },
      global: { plugins: [pinia, router, ElementPlus] },
    })

    const card = wrapper.find('.msg-error')
    expect(card.exists()).toBe(true)
    expect(card.text()).toContain('LLM 请求失败 (401)')

    await wrapper.findAll('button').find(b => b.text() === '重试')!.trigger('click')
    await flushPromises()
    expect(retry).toHaveBeenCalledWith('c1', 'm2')

    await wrapper.findAll('button').find(b => b.text() === '打开设置')!.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/settings')
  })
})
