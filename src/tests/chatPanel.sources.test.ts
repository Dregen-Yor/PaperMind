import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import ElementPlus from 'element-plus'
import ChatPanel from '../components/ChatPanel.vue'
import type { Conversation } from '../stores/chat'

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ default: {}, GlobalWorkerOptions: { workerSrc: '' } }))

let wrapper: VueWrapper | undefined
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.restoreAllMocks() })

const conv = (sources: Conversation['messages'][number]['sources']): Conversation => ({
  id: 'c1', title: 't', paperIds: [], createdAt: 0,
  messages: [{ id: 'm1', role: 'assistant', content: '回答', timestamp: 1, sources }],
})

async function mountPanel(conversation: Conversation) {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }] })
  await router.push('/')
  return mount(ChatPanel, { props: { conversation }, global: { plugins: [createPinia(), router, ElementPlus] } })
}

describe('来源芯片交互（#1）', () => {
  it('可跳转芯片点击发出 open-source（含 page 0-based）', async () => {
    wrapper = await mountPanel(conv([{ label: 'Pages 11–15: R1', paperId: 'p1', startPage: 10, endPage: 14 }]))
    const chip = wrapper.find('.source-chip.is-jumpable')
    expect(chip.exists()).toBe(true)
    await chip.trigger('click')
    expect(wrapper.emitted('open-source')![0][0]).toEqual({ label: 'Pages 11–15: R1', paperId: 'p1', startPage: 10, endPage: 14 })
  })

  it('旧数据/无页码芯片不可点、不崩溃', async () => {
    wrapper = await mountPanel(conv([{ label: 'Pages 1–2: 老数据' }, { label: '/abstract 摘要', paperId: 'p1' }]))
    expect(wrapper.findAll('.source-chip.is-jumpable')).toHaveLength(0)
    await wrapper.findAll('.source-chip')[0].trigger('click')
    expect(wrapper.emitted('open-source')).toBeUndefined()
  })
})
