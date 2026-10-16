import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, shallowMount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import PaperAbstractPanel from '../components/PaperAbstractPanel.vue'
import { useChatStore } from '../stores/chat'

const db = () => (globalThis as any).mockDb
const stubs = {
  ElButton: { template: '<button @click="$emit(\'click\')"><slot /></button>' },
  ElIcon: true,
  MarkdownContent: { props: ['content'], template: '<div class="rendered-report">{{ content }}</div>' },
}

beforeEach(() => {
  db().paperAbstract.get.mockReset().mockResolvedValue(null)
})

describe('paper abstract panel', () => {
  it('shows a saved report immediately without generating it', async () => {
    db().paperAbstract.get.mockResolvedValue({ paperId: 'paper', content: '# Saved report', sources: [], truncated: false, updatedAt: 1 })
    const pinia = createPinia()
    const generate = vi.spyOn(useChatStore(pinia), 'generatePaperAbstract')
    const wrapper = shallowMount(PaperAbstractPanel, { props: { paperId: 'paper' }, global: { plugins: [pinia], stubs } })
    await flushPromises()
    expect(wrapper.find('.rendered-report').text()).toContain('Saved report')
    expect(wrapper.text()).not.toContain('生成摘要')
    expect(generate).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('waits for the button before starting and displays the saved result', async () => {
    const pinia = createPinia()
    const generate = vi.spyOn(useChatStore(pinia), 'generatePaperAbstract').mockResolvedValue({
      paperId: 'paper', content: '# Fresh report', sources: [], truncated: false, updatedAt: 2,
    })
    const wrapper = shallowMount(PaperAbstractPanel, { props: { paperId: 'paper' }, global: { plugins: [pinia], stubs } })
    await flushPromises()
    expect(wrapper.text()).toContain('生成摘要')
    expect(generate).not.toHaveBeenCalled()
    await wrapper.find('button').trigger('click')
    await flushPromises()
    expect(generate).toHaveBeenCalledWith('paper', false)
    expect(wrapper.find('.rendered-report').text()).toContain('Fresh report')
    wrapper.unmount()
  })

  it('lets a saved report be regenerated with the current Docling pipeline', async () => {
    db().paperAbstract.get.mockResolvedValue({ paperId: 'paper', content: '# Old', sources: [], truncated: false, updatedAt: 1 })
    const pinia = createPinia()
    const generate = vi.spyOn(useChatStore(pinia), 'generatePaperAbstract').mockResolvedValue({
      paperId: 'paper', content: '# New', sources: [], truncated: false, updatedAt: 2,
    })
    const wrapper = shallowMount(PaperAbstractPanel, { props: { paperId: 'paper' }, global: { plugins: [pinia], stubs } })
    await flushPromises()
    await wrapper.find('button').trigger('click')
    await flushPromises()
    expect(generate).toHaveBeenCalledWith('paper', true)
    expect(wrapper.find('.rendered-report').text()).toContain('New')
    wrapper.unmount()
  })

  it('does not show an earlier paper report after switching papers', async () => {
    let resolveFirst!: (value: unknown) => void
    db().paperAbstract.get.mockImplementation((id: string) => id === 'first'
      ? new Promise(resolve => { resolveFirst = resolve })
      : Promise.resolve({ paperId: 'second', content: '# Second', sources: [], truncated: false, updatedAt: 1 }))
    const wrapper = shallowMount(PaperAbstractPanel, { props: { paperId: 'first' }, global: { plugins: [createPinia()], stubs } })
    await wrapper.setProps({ paperId: 'second' })
    await flushPromises()
    resolveFirst({ paperId: 'first', content: '# First', sources: [], truncated: false, updatedAt: 1 })
    await flushPromises()
    expect(wrapper.find('.rendered-report').text()).toContain('Second')
    wrapper.unmount()
  })
})
