import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import ElementPlus, { ElMessage } from 'element-plus'
import ChatPanel from '../components/ChatPanel.vue'
import { useChatStore, type Conversation } from '../stores/chat'
import { useChatDraftStore } from '../stores/chatDrafts'

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ default: {}, GlobalWorkerOptions: { workerSrc: '' } }))

const wrappers: VueWrapper[] = []
let pinia = createPinia()
const db = () => window.db.chat
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const conversation = (id: string): Conversation => ({ id, title: '新对话', paperIds: [], messages: [], createdAt: 0 })
const answer = () => ({ ok: true, status: 200, body: new Response('data: {"choices":[{"delta":{"content":"答复"}}]}\n\ndata: [DONE]\n\n').body })
async function panel(conv: Conversation) {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }] })
  await router.push('/')
  const wrapper = mount(ChatPanel, { props: { conversation: conv }, global: { plugins: [pinia, router, ElementPlus] } })
  wrappers.push(wrapper)
  return wrapper
}
const text = (wrapper: VueWrapper) => (wrapper.get('textarea').element as HTMLTextAreaElement).value
const addContext = (wrapper: VueWrapper, value: string) => (wrapper.vm as unknown as { addContext: (text: string) => void }).addContext(value)

beforeEach(() => {
  pinia = createPinia()
  vi.mocked(db().addMessage).mockReset().mockResolvedValue(undefined)
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    return body.stream ? answer() : { ok: true, json: async () => ({ choices: [{ message: { content: '生成的标题' } }] }) }
  }))
})
afterEach(async () => { await flushPromises(); wrappers.splice(0).forEach(wrapper => wrapper.unmount()); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('conversation-owned composer drafts', () => {
  it('uses and persists the profile selected in the composer for the next request', async () => {
    const store = useChatStore(pinia)
    store.profiles = [
      { ...store.profiles[0], id: 'first', name: 'First', model: 'first-model', apiKey: 'test' },
      { ...store.profiles[0], id: 'second', name: 'Second', model: 'second-model', apiKey: 'test' },
    ]
    store.chatProfileId = 'first'
    const conv = conversation('profile-choice')
    store.conversations = [conv]
    const wrapper = await panel(conv)
    await wrapper.get('textarea').setValue('保留草稿')
    await wrapper.get('select[aria-label="选择对话配置"]').setValue('second')
    await flushPromises()
    expect(text(wrapper)).toBe('保留草稿')
    expect(store.chatProfileId).toBe('second')
    expect(window.db.settings.set).toHaveBeenCalledWith('llm_profile_chat', 'second')
    await wrapper.get('[aria-label="发送消息"]').trigger('click')
    await flushPromises()
    const requests = vi.mocked(fetch).mock.calls.map(([, init]) => JSON.parse(String(init?.body)))
    expect(requests.find(body => body.stream)?.model).toBe('second-model')
  })

  it.each(['constructor', '__proto__'])('owns drafts safely for persisted conversation ID %s', async id => {
    const wrapper = await panel(conversation(id))
    await wrapper.get('textarea').setValue('自定义 ID 的草稿')
    addContext(wrapper, '自定义 ID 的原文')
    await wrapper.setProps({ conversation: conversation('other') })
    expect(text(wrapper)).toBe('')
    expect(wrapper.find('.context-chips').exists()).toBe(false)
    await wrapper.setProps({ conversation: conversation(id) })
    expect(text(wrapper)).toBe('自定义 ID 的草稿')
    expect(wrapper.get('.context-chips').text()).toContain('自定义 ID 的原文')
  })

  // Removing session ownership would lose both the question and selected passage on remount.
  it('restores a question and selected passage after ChatPanel is destroyed and recreated', async () => {
    const conv = conversation('a')
    const first = await panel(conv)
    await first.get('textarea').setValue('尚未发送的问题')
    addContext(first, '论文原文 A')
    await flushPromises()
    first.unmount()
    const returned = await panel(conv)
    expect(text(returned)).toBe('尚未发送的问题')
    expect(returned.get('.context-chips').text()).toContain('论文原文 A')
  })

  // Reusing one local composer for two IDs leaks A's question and selected passage into B.
  it('keeps each conversation question and context separate while switching props', async () => {
    const a = conversation('a')
    const b = conversation('b')
    const wrapper = await panel(a)
    await wrapper.get('textarea').setValue('A 的问题')
    addContext(wrapper, 'A 的原文')
    await wrapper.setProps({ conversation: b })
    expect(text(wrapper)).toBe('')
    expect(wrapper.find('.context-chips').exists()).toBe(false)
    await wrapper.get('textarea').setValue('B 的问题')
    addContext(wrapper, 'B 的原文')
    await wrapper.setProps({ conversation: a })
    expect(text(wrapper)).toBe('A 的问题')
    expect(wrapper.get('.context-chips').text()).toContain('A 的原文')
    expect(wrapper.text()).not.toContain('B 的原文')
  })

  // Checking only messages.length would delete the session draft during navigation.
  it.each(['question', 'context'])('retains an empty conversation containing a %s draft', async kind => {
    const store = useChatStore(pinia)
    store.conversations = [conversation('a')]
    const wrapper = await panel(store.conversations[0])
    if (kind === 'question') await wrapper.get('textarea').setValue('还没发送')
    else addContext(wrapper, '已选原文')
    await store.discardEmptyConversation('a')
    expect(store.conversations.map(conv => conv.id)).toEqual(['a'])
  })

  // Dropping the sending guard deletes an empty conversation before the first persistence starts.
  it('keeps a submitting conversation when its draft is cleared, then allows cleanup after a failed save', async () => {
    const store = useChatStore(pinia)
    store.conversations = [conversation('a')]
    const conv = store.conversations[0]
    const saved = deferred<void>()
    void saved.promise.catch(() => undefined)
    vi.mocked(db().addMessage).mockImplementationOnce(() => saved.promise)
    vi.spyOn(ElMessage, 'error').mockImplementation(() => ({ close: () => {} }))
    const wrapper = await panel(conv)
    await wrapper.get('textarea').setValue('正在提交的问题')
    addContext(wrapper, '正在提交的原文')
    await flushPromises()
    try {
      const click = wrapper.get('.send-btn').trigger('click')
      const clear = wrapper.get('textarea').setValue('')
      const removeContext = wrapper.get('[aria-label="移除上下文"]').trigger('click')
      expect(conv.messages).toEqual([])
      const discard = store.discardEmptyConversation('a')
      await Promise.all([click, clear, removeContext, discard])
      expect(store.conversations.map(item => item.id)).toEqual(['a'])
      // The optimistic user bubble now exists, but its IPC persistence is still unresolved.
      await store.discardEmptyConversation('a')
      expect(store.conversations.map(item => item.id)).toEqual(['a'])
    } finally {
      saved.reject(new Error('提交写入失败'))
      await flushPromises()
    }
    expect(conv.messages).toEqual([])
    await store.discardEmptyConversation('a')
    expect(store.conversations).toEqual([])
  })

  it('discards an empty conversation once its question and context have been removed', async () => {
    const store = useChatStore(pinia)
    store.conversations = [conversation('a')]
    const wrapper = await panel(store.conversations[0])
    await wrapper.get('textarea').setValue('临时问题')
    addContext(wrapper, '临时原文')
    await wrapper.get('textarea').setValue('')
    await wrapper.get('[aria-label="移除上下文"]').trigger('click')
    await store.discardEmptyConversation('a')
    expect(store.conversations).toEqual([])
  })

  it('removes a draft when its conversation is explicitly deleted', async () => {
    const store = useChatStore(pinia)
    const conv = conversation('a')
    store.conversations = [conv]
    const wrapper = await panel(conv)
    await wrapper.get('textarea').setValue('要删除的草稿')
    addContext(wrapper, '要删除的原文')
    await store.removeConversation('a')
    await flushPromises()
    wrapper.unmount()
    const returned = await panel(conv)
    expect(text(returned)).toBe('')
    expect(returned.find('.context-chips').exists()).toBe(false)
  })

  // Losing the captured ID after the first await would send and title B instead of A.
  it('sends to the captured conversation and titles it after switching to another draft', async () => {
    const store = useChatStore(pinia)
    store.conversations = [conversation('a'), conversation('b')]
    const [a, b] = store.conversations
    const saved = deferred<void>()
    vi.mocked(db().addMessage).mockImplementationOnce(() => saved.promise)
    const wrapper = await panel(a)
    await wrapper.get('textarea').setValue('A 的提问')
    addContext(wrapper, 'A 的原文')
    await wrapper.get('.send-btn').trigger('click')
    await wrapper.setProps({ conversation: b })
    await wrapper.get('textarea').setValue('B 的草稿')
    addContext(wrapper, 'B 的原文')
    saved.resolve()
    await flushPromises()
    expect(a.messages.map(message => message.content)).toEqual(['A 的提问', '答复'])
    expect(a.messages[0].context).toBe('A 的原文')
    expect(a.title).toBe('生成的标题')
    expect(b.messages).toEqual([])
    expect(b.title).toBe('新对话')
    expect(text(wrapper)).toBe('B 的草稿')
    expect(wrapper.get('.context-chips').text()).toContain('B 的原文')
    await wrapper.setProps({ conversation: a })
    expect(text(wrapper)).toBe('')
    expect(wrapper.find('.context-chips').exists()).toBe(false)
  })

  it('captures the send target before the first asynchronous scroll', async () => {
    const store = useChatStore(pinia)
    store.conversations = [conversation('a'), conversation('b')]
    const [a, b] = store.conversations
    const wrapper = await panel(a)
    await wrapper.get('textarea').setValue('属于 A')
    const click = wrapper.get('.send-btn').trigger('click')
    await wrapper.setProps({ conversation: b })
    await click
    await flushPromises()
    expect(a.messages[0]?.content).toBe('属于 A')
    expect(b.messages).toEqual([])
  })

  it('consumes a saved submission after unmount without losing the next draft', async () => {
    const store = useChatStore(pinia)
    store.conversations = [conversation('a')]
    const saved = deferred<void>()
    vi.mocked(db().addMessage).mockImplementationOnce(() => saved.promise)
    const wrapper = await panel(store.conversations[0])
    await wrapper.get('textarea').setValue('已提交')
    addContext(wrapper, '已提交原文')
    await wrapper.get('.send-btn').trigger('click')
    await flushPromises()
    wrapper.unmount()
    const returned = await panel(store.conversations[0])
    expect(returned.get('.send-btn').classes()).toContain('is-loading')
    await returned.get('textarea').setValue('回来后写的新问题')
    addContext(returned, '回来后选的新原文')
    saved.resolve()
    await flushPromises()
    expect(text(returned)).toBe('回来后写的新问题')
    expect(returned.get('.context-chips').text()).toContain('回来后选的新原文')
    expect(returned.get('.context-chips').text()).not.toContain('已提交原文')
    expect(returned.get('.send-btn').classes()).not.toContain('is-loading')
  })

  it('does not clear a newer edit that happens to match the submitted question', async () => {
    const store = useChatStore(pinia)
    store.conversations = [conversation('a')]
    const saved = deferred<void>()
    vi.mocked(db().addMessage).mockImplementationOnce(() => saved.promise)
    const wrapper = await panel(store.conversations[0])
    await wrapper.get('textarea').setValue('相同的问题')
    await wrapper.get('.send-btn').trigger('click')
    await wrapper.get('textarea').setValue('不同的问题')
    await wrapper.get('textarea').setValue('相同的问题')
    saved.resolve()
    await flushPromises()
    expect(text(wrapper)).toBe('相同的问题')
  })

  it.each(['save', 'fail'])('does not recreate a deleted draft when pending persistence later completes: %s', async outcome => {
    const store = useChatStore(pinia)
    store.conversations = [conversation('a')]
    const conv = store.conversations[0]
    const saved = deferred<void>()
    vi.mocked(db().addMessage).mockImplementationOnce(() => saved.promise)
    vi.spyOn(ElMessage, 'error').mockImplementation(() => ({ close: () => {} }))
    const wrapper = await panel(conv)
    await wrapper.get('textarea').setValue('不要恢复已删除草稿')
    await wrapper.get('.send-btn').trigger('click')
    await store.removeConversation('a')
    if (outcome === 'save') saved.resolve()
    else saved.reject(new Error('迟到的写入失败'))
    await flushPromises()
    expect(useChatDraftStore(pinia).read('a')).toBeUndefined()
    expect(useChatDraftStore(pinia).sending.has('a')).toBe(false)
    const returned = await panel(conv)
    expect(text(returned)).toBe('')
  })

  // Clearing after persistence without tracking edits erases the next question.
  it('preserves edits and newly selected context made before the submitted message is saved', async () => {
    const store = useChatStore(pinia)
    store.conversations = [conversation('a')]
    const saved = deferred<void>()
    vi.mocked(db().addMessage).mockImplementationOnce(() => saved.promise)
    const wrapper = await panel(store.conversations[0])
    await wrapper.get('textarea').setValue('第一条问题')
    addContext(wrapper, '第一段')
    await wrapper.get('.send-btn').trigger('click')
    await wrapper.get('textarea').setValue('下一条问题')
    addContext(wrapper, '第二段')
    saved.resolve()
    await flushPromises()
    expect(text(wrapper)).toBe('下一条问题')
    expect(wrapper.get('.context-chips').text()).toContain('第二段')
    expect(wrapper.get('.context-chips').text()).not.toContain('第一段')
  })

  // Eager clearing before addMessage succeeds permanently loses an unsaved question.
  it('retains an unsaved question and context when user-message persistence fails', async () => {
    const store = useChatStore(pinia)
    store.conversations = [conversation('a')]
    vi.mocked(db().addMessage).mockRejectedValueOnce(new Error('写入失败'))
    vi.spyOn(ElMessage, 'error').mockImplementation(() => ({ close: () => {} }))
    const wrapper = await panel(store.conversations[0])
    await wrapper.get('textarea').setValue('保留我的问题')
    addContext(wrapper, '保留我的原文')
    await wrapper.get('.send-btn').trigger('click')
    await flushPromises()
    expect(store.conversations[0].messages).toEqual([])
    expect(text(wrapper)).toBe('保留我的问题')
    expect(wrapper.get('.context-chips').text()).toContain('保留我的原文')
  })
})
