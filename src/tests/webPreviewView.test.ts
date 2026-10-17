import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import WebPreviewView from '../views/WebPreviewView.vue'
import type { PreviewApi, PreviewState } from '../types/webPreview'
import { createPinia, setActivePinia } from 'pinia'
import App from '../App.vue'
import router from '../router'

const emptyState: PreviewState = {
  url: '', loading: false, canGoBack: false, canGoForward: false,
  error: '', notice: '', visible: false,
}

let wrapper: VueWrapper | undefined
let pushState: ((state: PreviewState) => void) | undefined
let unsubscribe: () => void
let preview: PreviewApi

beforeEach(() => {
  setActivePinia(createPinia())
  unsubscribe = vi.fn()
  preview = {
    open: vi.fn(async () => {}),
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

  it('opens a pasted domain as HTTPS in the measured native slot', async () => {
    wrapper = mount(WebPreviewView)
    await wrapper.get('[aria-label="网页地址"]').setValue(' example.org/article ')
    await wrapper.get('[aria-label="网页地址"]').trigger('keydown.enter')
    await flushPromises()
    expect(preview.open).toHaveBeenCalledWith('https://example.org/article', {
      x: 72, y: 64, width: 900, height: 700,
    })
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
