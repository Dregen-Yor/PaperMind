import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { reactive } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import ElementPlus, { ElMessage } from 'element-plus'
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

/** 尚无失败卡的会话：用于观察「store 完全没落卡」时的兜底反馈。 */
const healthyConv = (): Conversation => ({
  id: 'c1', title: 't', paperIds: [], createdAt: 0,
  messages: [{ id: 'm1', role: 'user', content: '你好', timestamp: 1 }],
})

const makeRouter = () => createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: '/', component: { template: '<div />' } },
    { path: '/settings', component: { template: '<div />' } },
  ],
})

/** 挂载 ChatPanel；onError 接管 app.config.errorHandler，用于捕获逃逸出事件处理器的错误。 */
async function mountPanel(conversation: Conversation, onError?: (error: unknown) => void) {
  const pinia = createPinia()
  const chatStore = useChatStore(pinia)
  const router = makeRouter()
  await router.push('/')
  wrapper = mount(ChatPanel, {
    props: { conversation },
    global: {
      plugins: [pinia, router, ElementPlus],
      ...(onError ? { config: { errorHandler: (error: unknown) => onError(error) } } : {}),
    },
  })
  return { chatStore, router }
}

/** 走真实 composer：写入输入框后点发送按钮。 */
async function submit(text: string) {
  await wrapper!.find('textarea').setValue(text)
  await wrapper!.find('.send-btn').trigger('click')
  await flushPromises()
}

const retryButton = () => wrapper!.findAll('button').find(b => b.text() === '重试')!

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

  it('store 未落失败卡时用 toast 兜底提示原因', async () => {
    const conversation = healthyConv()
    const { chatStore } = await mountPanel(conversation)
    const toast = vi.spyOn(ElMessage, 'error')
    // 模拟 Conversation not found / 用户消息落库失败 / recordFailure 自身写库失败：
    // reject 且一条消息都没写进会话
    vi.spyOn(chatStore, 'sendMessage').mockRejectedValue(new Error('Conversation not found'))

    await submit('hi')

    expect(conversation.messages.some(m => m.role === 'assistant' && m.error)).toBe(false)
    expect(toast).toHaveBeenCalledWith('Conversation not found')
  })

  it('store 已落失败卡时不叠加 toast（卡即反馈）', async () => {
    const conversation = reactive(healthyConv())
    const { chatStore } = await mountPanel(conversation)
    const toast = vi.spyOn(ElMessage, 'error')
    vi.spyOn(chatStore, 'sendMessage').mockImplementation(async () => {
      conversation.messages.push({ id: 'm2', role: 'assistant', content: '', timestamp: 2, error: 'LLM 请求失败 (401)：缺少 API Key' })
      throw new Error('LLM 请求失败 (401)：缺少 API Key')
    })

    await submit('hi')

    expect(wrapper!.find('.msg-error').exists()).toBe(true)
    expect(toast).not.toHaveBeenCalled()
  })

  it('retry 失败不逃逸：错误由失败卡承载，不再抛给 Vue', async () => {
    const errors: unknown[] = []
    const { chatStore } = await mountPanel(failedConv(), error => errors.push(error))
    const retry = vi.spyOn(chatStore, 'retryMessage').mockRejectedValue(new Error('again'))

    await retryButton().trigger('click')
    await flushPromises()

    expect(retry).toHaveBeenCalledWith('c1', 'm2')
    expect(errors).toEqual([])

    // 失败后组件仍可交互：retrying 已复位，重试按钮可再次触发
    await retryButton().trigger('click')
    await flushPromises()
    expect(retry).toHaveBeenCalledTimes(2)
  })
})
