import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import WebPreviewView from '../views/WebPreviewView.vue'
import type { PreviewApi, PreviewState } from '../types/webPreview'
import { createPinia, setActivePinia } from 'pinia'
import App from '../App.vue'
import router from '../router'
import { ElMessageBox } from 'element-plus'

const emptyState: PreviewState = {
  url: '', loading: false, canGoBack: false, canGoForward: false,
  error: '', notice: '', visible: false,
}

let wrapper: VueWrapper | undefined
let pushState: ((state: PreviewState) => void) | undefined
let unsubscribe: () => void
let preview: PreviewApi
const page = { id: 'page-1', canonicalUrl: 'https://example.org/article', title: '文章',
  createdAt: 1, lastOpenedAt: 1, latestSnapshotId: 'snap-1', snapshotCount: 1,
  sessionCount: 0, totalBytes: 80 }
const cached = { id: 'snap-1', pageId: 'page-1', finalUrl: page.canonicalUrl, title: '本地缓存文章',
  capturedAt: 1, byteLength: 80, contentHash: 'hash', preview: { truncated: false,
    blocks: [{ kind: 'paragraph' as const, text: '离线正文' }] } }

beforeEach(() => {
  setActivePinia(createPinia())
  vi.mocked(window.db.webQa.archive).mockClear()
  vi.mocked(window.db.webQa.listPages).mockClear()
  vi.mocked(window.db.webQa.listPages).mockResolvedValue([])
  vi.mocked(window.db.webQa.archive).mockResolvedValue(page)
  vi.mocked(window.db.webQa.getPreview).mockResolvedValue(cached)
  vi.mocked(window.db.webQa.listSessions).mockResolvedValue([])
  unsubscribe = vi.fn()
  preview = {
    open: vi.fn(async () => {}),
    openAndCapture: vi.fn(async () => ({
      finalUrl: 'https://example.org/', title: 'Example', html: '<html></html>',
      capturedAt: 1, contentHash: 'hash', byteLength: 13,
    })),
    setBounds: vi.fn(async () => {}),
    back: vi.fn(async () => {}),
    forward: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    openExternal: vi.fn(async () => {}),
    captureSnapshot: vi.fn(async () => ({
      finalUrl: 'https://example.org/', title: 'Example', html: '<html></html>',
      capturedAt: 1, contentHash: 'hash', byteLength: 13,
    })),
    onState: vi.fn((callback: (state: PreviewState) => void): (() => void) => {
      pushState = callback
      return unsubscribe
    }),
  }
  window.preview = preview
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  })
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 72, y: 64, width: 900, height: 700,
    top: 64, left: 72, right: 972, bottom: 764,
    toJSON: () => ({}),
  })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  pushState = undefined
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('HTML preview page', () => {
  it('is reachable from the sidebar as an independent compact reading page', async () => {
    expect(router.resolve('/web-preview').matched.at(-1)?.path).toBe('/web-preview')
    await router.push('/web-preview')
    wrapper = mount(App, { global: { plugins: [createPinia(), router] } })
    await flushPromises()
    expect(wrapper.get('a[href="#/web-preview"]').text()).toContain('网页问答')
    expect(wrapper.get('.app-shell').classes()).toContain('is-reading')
  })

  it('archives an actively opened HTTPS link after load and capture', async () => {
    wrapper = mount(WebPreviewView)
    await wrapper.get('[aria-label="网页地址"]').setValue(' example.org/article ')
    expect(window.db.webQa.archive).not.toHaveBeenCalled()
    await wrapper.get('[aria-label="网页地址"]').trigger('keydown.enter')
    await flushPromises()
    expect(preview.openAndCapture).toHaveBeenCalledWith('https://example.org/article', {
      x: 72, y: 64, width: 900, height: 700,
    })
    expect(window.db.webQa.archive).toHaveBeenCalledOnce()
  })

  it('archives a dropped HTTPS link but leaves site navigation unsaved', async () => {
    wrapper = mount(WebPreviewView)
    await wrapper.get('.preview-slot').trigger('drop', {
      dataTransfer: { getData: (type: string) => type === 'text/uri-list' ? 'https://example.org/article' : '' },
    })
    await flushPromises()
    expect(preview.openAndCapture).toHaveBeenCalledOnce()
    expect(window.db.webQa.archive).toHaveBeenCalledOnce()
    pushState?.({ ...emptyState, url: 'https://example.org/other', visible: true })
    await flushPromises()
    expect(window.db.webQa.archive).toHaveBeenCalledOnce()
  })

  it('accepts a plain-text link drop when no URI list is supplied', async () => {
    wrapper = mount(WebPreviewView)
    await wrapper.get('.preview-slot').trigger('drop', {
      dataTransfer: { getData: (type: string) => type === 'text/plain' ? 'https://example.org/article' : '' },
    })
    await flushPromises()
    expect(preview.openAndCapture).toHaveBeenCalledWith('https://example.org/article', expect.any(Object))
  })

  it('opens a saved page from text-only cache without loading the original URL', async () => {
    vi.mocked(window.db.webQa.listPages).mockResolvedValue([page])
    wrapper = mount(WebPreviewView)
    await flushPromises()
    await wrapper.get('[data-action="history-page"]').setValue('page-1')
    await flushPromises()
    expect(wrapper.text()).toContain('本地缓存文章')
    expect(wrapper.text()).toContain('离线正文')
    expect(preview.open).not.toHaveBeenCalled()
    expect(preview.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 0, height: 0 })
  })

  it('groups distinct sessions under a page and opens each saved answer from cache', async () => {
    const sessions = ['s1', 's2'].map((id, index) => ({ id, pageId: page.id,
      snapshotId: cached.id, finalUrl: cached.finalUrl, title: cached.title,
      capturedAt: 1, byteLength: 80, createdAt: index + 1, updatedAt: index + 1,
      firstQuestion: `问题 ${index + 1}` }))
    vi.mocked(window.db.webQa.listPages).mockResolvedValue([page])
    vi.mocked(window.db.webQa.listSessions).mockResolvedValue(sessions)
    vi.mocked(window.db.webQa.getSession).mockImplementation(async id => ({ ...sessions.find(s => s.id === id)!,
      messages: [{ id: `m-${id}`, sessionId: id, role: 'user', content: `问题 ${id}`,
        status: 'completed', error: '', modelId: '', createdAt: 1 },
      { id: `a-${id}`, sessionId: id, role: 'assistant', content: `回答 ${id}`,
        status: 'completed', error: '', modelId: 'model-a', createdAt: 2 }] }))
    wrapper = mount(WebPreviewView)
    await flushPromises()
    await wrapper.get('[data-action="history-page"]').setValue(page.id)
    await flushPromises()
    expect(wrapper.get('#web-qa-history').findAll('option')).toHaveLength(3)
    await wrapper.get('#web-qa-history').setValue('s2')
    await flushPromises()
    expect(wrapper.text()).toContain('问题 s2')
    expect(preview.open).not.toHaveBeenCalled()
  })

  it('requires Save after unsaved site navigation before starting a new session', async () => {
    vi.mocked(window.db.webQa.listPages).mockResolvedValue([page])
    wrapper = mount(WebPreviewView)
    await wrapper.get('[aria-label="网页地址"]').setValue('example.org/article')
    await wrapper.get('[aria-label="网页地址"]').trigger('keydown.enter')
    await flushPromises()
    pushState?.({ ...emptyState, url: 'https://example.org/other', visible: true })
    await wrapper.get('[data-action="new-session"]').trigger('click')
    expect(wrapper.get('[data-action="send-question"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-action="save-current"]').exists()).toBe(true)
    await wrapper.get('[data-action="save-current"]').trigger('click')
    await flushPromises()
    expect(preview.captureSnapshot).toHaveBeenCalledOnce()
    expect(window.db.webQa.archive).toHaveBeenCalledTimes(2)
  })

  it('deletes a page only after confirmation', async () => {
    vi.mocked(window.db.webQa.listPages).mockResolvedValue([page])
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockRejectedValueOnce(new Error('cancel'))
      .mockResolvedValueOnce('confirm' as never)
    wrapper = mount(WebPreviewView)
    await flushPromises()
    await wrapper.get('[data-action="history-page"]').setValue(page.id)
    await flushPromises()
    await wrapper.get('[data-action="remove-page"]').trigger('click')
    await flushPromises()
    expect(window.db.webQa.removePage).not.toHaveBeenCalled()
    await wrapper.get('[data-action="remove-page"]').trigger('click')
    await flushPromises()
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(window.db.webQa.removePage).toHaveBeenCalledWith(page.id)
    expect(preview.close).toHaveBeenCalledOnce()
  })

  it('allows a new QA after returning from the live source to cached reading', async () => {
    vi.mocked(window.db.webQa.listPages).mockResolvedValue([page])
    wrapper = mount(WebPreviewView)
    await flushPromises()
    await wrapper.get('[data-action="history-page"]').setValue(page.id)
    await flushPromises()
    await wrapper.get('[data-action="open-source"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-action="return-cache"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-action="new-session"]').trigger('click')
    expect(wrapper.get('[aria-label="问题输入框"]').attributes('disabled')).toBeUndefined()
  })

  it('explains HTTP input without asking Electron to load it', async () => {
    wrapper = mount(WebPreviewView)
    await wrapper.get('[aria-label="网页地址"]').setValue('http://example.org')
    await wrapper.get('[aria-label="网页地址"]').trigger('keydown.enter')
    expect(wrapper.text()).toContain('仅支持 HTTPS 链接')
    expect(preview.open).not.toHaveBeenCalled()
  })

  it('shows invalid-address feedback while another page remains visible', async () => {
    wrapper = mount(WebPreviewView)
    pushState?.({ ...emptyState, url: 'https://example.org/start', visible: true })
    await wrapper.get('[aria-label="网页地址"]').setValue('http://example.org/next')
    await wrapper.get('[aria-label="网页地址"]').trigger('keydown.enter')
    expect(wrapper.get('[role="alert"]').text()).toContain('仅支持 HTTPS 链接')
    expect(preview.open).not.toHaveBeenCalled()
  })

  it('tracks page navigation but preserves an unfinished address edit until Escape', async () => {
    wrapper = mount(WebPreviewView)
    pushState?.({ ...emptyState, url: 'https://example.org/start', visible: true, canGoBack: true })
    await wrapper.vm.$nextTick()
    expect((wrapper.get('[aria-label="网页地址"]').element as HTMLInputElement).value).toBe('https://example.org/start')
    expect(wrapper.get('[data-action="back"]').attributes('disabled')).toBeUndefined()

    await wrapper.get('[aria-label="网页地址"]').setValue('unfinished.example')
    pushState?.({ ...emptyState, url: 'https://example.org/next', visible: true })
    await wrapper.vm.$nextTick()
    expect((wrapper.get('[aria-label="网页地址"]').element as HTMLInputElement).value).toBe('unfinished.example')

    await wrapper.get('[aria-label="网页地址"]').trigger('keydown.esc')
    expect((wrapper.get('[aria-label="网页地址"]').element as HTMLInputElement).value).toBe('https://example.org/next')
    expect(wrapper.get('[data-action="back"]').attributes('disabled')).toBeDefined()
  })

  it('wires navigation actions and closes the native view on exit', async () => {
    wrapper = mount(WebPreviewView)
    pushState?.({ ...emptyState, url: 'https://example.org/start', visible: true, canGoBack: true, canGoForward: true })
    await wrapper.vm.$nextTick()
    await wrapper.get('[data-action="back"]').trigger('click')
    await wrapper.get('[data-action="forward"]').trigger('click')
    await wrapper.get('[data-action="reload"]').trigger('click')
    await wrapper.get('[data-action="external"]').trigger('click')
    expect(preview.back).toHaveBeenCalledOnce()
    expect(preview.forward).toHaveBeenCalledOnce()
    expect(preview.reload).toHaveBeenCalledOnce()
    expect(preview.openExternal).toHaveBeenCalledWith('https://example.org/start')

    wrapper.unmount()
    wrapper = undefined
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(preview.close).toHaveBeenCalledOnce()
  })

  it('shows an actionable error when a page cannot load', async () => {
    wrapper = mount(WebPreviewView)
    expect(wrapper.text()).toContain('粘贴 HTTPS 链接，按 Enter 预览原网页')
    pushState?.({ ...emptyState, url: 'https://example.org/', error: '找不到网站，请检查地址或网络连接。' })
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('找不到网站')
    await wrapper.get('[data-action="retry"]').trigger('click')
    expect(preview.open).toHaveBeenCalledWith('https://example.org/', expect.any(Object))
  })

  it('starts with the PDF reader 58/42 split and keyboard-adjustable separator', async () => {
    wrapper = mount(WebPreviewView)
    const separator = wrapper.get('[role="separator"]')
    expect(separator.attributes('aria-valuenow')).toBe('58')
    await separator.trigger('keydown.right')
    expect(separator.attributes('aria-valuenow')).toBe('60')
    await separator.trigger('keydown.home')
    expect(separator.attributes('aria-valuenow')).toBe('30')
    await separator.trigger('dblclick')
    expect(separator.attributes('aria-valuenow')).toBe('58')
  })

  it('sets native webpage bounds to zero on the narrow QA pane', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
    wrapper = mount(WebPreviewView)
    pushState?.({ ...emptyState, url: 'https://example.org/', visible: true })
    await wrapper.get('[aria-label="显示问答面板"]').trigger('click')
    await flushPromises()
    expect(preview.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 0, height: 0 })
  })
})
