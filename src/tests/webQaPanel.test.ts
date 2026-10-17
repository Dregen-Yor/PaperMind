import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import WebQaPanel from '../components/WebQaPanel.vue'
import type { WebQaSessionDetail } from '../types/webQa'

const session: WebQaSessionDetail = {
  id: 's1', snapshotId: 's1', finalUrl: 'https://example.org/old', title: '旧页',
  capturedAt: 1, byteLength: 20, createdAt: 1, updatedAt: 1,
  snapshot: { finalUrl: 'https://example.org/old', title: '旧页', html: '<html>旧页</html>',
    capturedAt: 1, contentHash: 'hash', byteLength: 20 },
  messages: [{ id: 'm1', sessionId: 's1', role: 'user', content: '旧问题', status: 'completed',
    error: '', modelId: '', createdAt: 1 }],
}

describe('web QA panel', () => {
  it('disables the first question until a page is loaded', async () => {
    const wrapper = mount(WebQaPanel, { props: {
      session: null, sessions: [], busy: false, error: '', streamedText: '',
      canAsk: false, sourceChanged: false, modelName: 'Model A',
    } })
    await wrapper.get('[aria-label="问题输入框"]').setValue('问题')
    expect(wrapper.get('[data-action="send-question"]').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('先在左侧打开或从历史中选择网页')
  })

  it('keeps restored history visible and marks it as pinned when the page changed', () => {
    const wrapper = mount(WebQaPanel, { props: {
      session, sessions: [session], busy: false, error: '', streamedText: '',
      canAsk: true, sourceChanged: true, modelName: 'Model A',
    }, global: { stubs: { MarkdownContent: true } } })
    expect(wrapper.text()).toContain('旧问题')
    expect(wrapper.text()).toContain('当前网页已变化')
    expect(wrapper.get('[data-action="new-session"]').text()).toContain('新建问答')
    expect(wrapper.text()).toContain('旧页')
  })

  it('clears a retried question draft after its answer completes', async () => {
    const failed: WebQaSessionDetail = { ...session, messages: [
      { ...session.messages[0], content: '重试问题' },
      { id: 'm2', sessionId: 's1', role: 'assistant', content: '', status: 'failed',
        error: '超时', modelId: 'model-a', createdAt: 2 },
    ] }
    const wrapper = mount(WebQaPanel, { props: {
      session: failed, sessions: [failed], busy: false, error: '', streamedText: '',
      canAsk: true, sourceChanged: false, modelName: 'Model A',
    }, global: { stubs: { MarkdownContent: true } } })
    await wrapper.get('[aria-label="问题输入框"]').setValue('重试问题')
    await wrapper.setProps({ session: { ...failed, messages: [failed.messages[0],
      { ...failed.messages[1], content: '回答', status: 'completed', error: '' }] } })
    expect((wrapper.get('[aria-label="问题输入框"]').element as HTMLTextAreaElement).value).toBe('')
  })
})
