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
  it('lets a starter question fill the composer without sending until confirmed', async () => {
    const wrapper = mount(WebQaPanel, { props: {
      session: null, sessions: [], busy: false, error: '', streamedText: '',
      canAsk: true, sourceChanged: false, modelName: 'Model A',
    } })
    const starters = wrapper.findAll('.starter-question')
    expect(starters.map(button => button.text())).toEqual(['概括核心观点', '解释关键内容', '分析局限与启发'])
    await starters[0].trigger('click')
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('请概括这篇网页的核心观点和主要结论。')
    expect(wrapper.emitted('send')).toBeUndefined()
    await wrapper.get('[aria-label="发送消息"]').trigger('click')
    expect(wrapper.emitted('send')).toEqual([['请概括这篇网页的核心观点和主要结论。']])
    wrapper.unmount()
  })

  it('keeps webpage history in a collapsed disclosure and allows selecting a saved page', async () => {
    const wrapper = mount(WebQaPanel, { props: {
      session: null, sessions: [], busy: false, error: '', streamedText: '',
      canAsk: false, sourceChanged: false, modelName: 'Model A',
      pages: [{ id: 'page-1', title: '保存的文章', canonicalUrl: 'https://example.org',
        createdAt: 1, lastOpenedAt: 1, latestSnapshotId: 'snap-1', snapshotCount: 1,
        sessionCount: 0, totalBytes: 20 }],
    } })
    const disclosure = wrapper.get('details')
    expect(disclosure.attributes('open')).toBeUndefined()
    expect(disclosure.get('summary').text()).toContain('网页与来源')
    await disclosure.get('[data-action="history-page"]').setValue('page-1')
    expect(wrapper.emitted('select-page')).toEqual([['page-1']])
    wrapper.unmount()
  })

  it('offers saved profiles without losing the question and prevents switching during generation', async () => {
    const wrapper = mount(WebQaPanel, { props: {
      session: null, sessions: [], busy: false, error: '', streamedText: '',
      canAsk: true, sourceChanged: false, modelName: 'First', profileId: 'first',
      profiles: [
        { id: 'first', name: 'First', provider: 'openai', model: 'model-a' },
        { id: 'second', name: 'Second', provider: 'anthropic', model: 'model-b' },
      ],
    } })
    await wrapper.get('textarea').setValue('待发送的问题')
    const select = wrapper.get('select[aria-label="选择对话配置"]')
    expect(select.findAll('option').map(option => option.text())).toEqual([
      'First · openai · model-a', 'Second · anthropic · model-b',
    ])
    await select.setValue('second')
    expect(wrapper.emitted('select-profile')).toEqual([['second']])
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('待发送的问题')
    await wrapper.setProps({ busy: true })
    expect(select.attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })

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
    expect(wrapper.get('[data-action="new-session"]').attributes('aria-label')).toBe('新建网页问答')
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
