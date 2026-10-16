import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { previewControllerForSender, registerPreviewWindow, unregisterPreviewWindow } from '../../electron/webPreview'

const fake = vi.hoisted(() => ({
  views: [] as any[],
  permissionHandler: undefined as undefined | ((_contents: unknown, permission: string, callback: (allowed: boolean) => void) => void),
  sessionHandlers: new Map<string, (...args: any[]) => void>(),
  externalOpen: vi.fn(async (_url: string) => {}),
  windowBySender: new Map<object, object>(),
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: (sender: object) => fake.windowBySender.get(sender) ?? null },
  session: {
    fromPartition: () => ({
      setPermissionRequestHandler: (handler: typeof fake.permissionHandler) => { fake.permissionHandler = handler },
      on: (name: string, handler: (...args: any[]) => void) => { fake.sessionHandlers.set(name, handler) },
    }),
  },
  shell: { openExternal: fake.externalOpen },
  WebContentsView: class {
    bounds = { x: 0, y: 0, width: 0, height: 0 }
    webContents = new (class {
      listeners = new Map<string, Array<(...args: any[]) => void>>()
      currentUrl = ''
      destroyed = false
      windowOpenHandler: ((details: { url: string }) => { action: string }) | undefined
      navigationHistory = {
        canGoBack: vi.fn(() => false),
        canGoForward: vi.fn(() => false),
        goBack: vi.fn(),
        goForward: vi.fn(),
      }
      on(name: string, handler: (...args: any[]) => void) {
        this.listeners.set(name, [...(this.listeners.get(name) ?? []), handler])
      }
      emit(name: string, ...args: any[]) {
        for (const handler of this.listeners.get(name) ?? []) handler(...args)
      }
      setWindowOpenHandler(handler: (details: { url: string }) => { action: string }) { this.windowOpenHandler = handler }
      loadURL = vi.fn(async (url: string) => { this.currentUrl = url })
      getURL() { return this.currentUrl }
      reload = vi.fn()
      close = vi.fn(() => { this.destroyed = true })
      isDestroyed() { return this.destroyed }
    })()
    constructor(public options: Record<string, unknown>) { fake.views.push(this) }
    setBounds(bounds: { x: number; y: number; width: number; height: number }) { this.bounds = bounds }
  },
}))

function appWindow() {
  const win = {
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    webContents: { send: vi.fn() },
    getContentBounds: () => ({ x: 0, y: 0, width: 1000, height: 800 }),
  }
  fake.windowBySender.set(win.webContents, win)
  return win as unknown as BrowserWindow
}

beforeEach(() => {
  fake.views.length = 0
  fake.sessionHandlers.clear()
  fake.permissionHandler = undefined
  fake.externalOpen.mockClear()
  fake.windowBySender.clear()
})

describe('isolated HTML preview controller', () => {
  it('creates one isolated view and clamps its bounds to the application window', async () => {
    const win = appWindow()
    const controller = registerPreviewWindow(win)
    await controller.open('https://example.org/start', { x: -10, y: 64, width: 1200, height: 900 })
    expect(fake.views[0].bounds).toEqual({ x: 0, y: 64, width: 1000, height: 736 })
    await controller.open('https://example.org/next', { x: 80, y: 64, width: 700, height: 500 })

    expect(fake.views).toHaveLength(1)
    expect(fake.views[0].options.webPreferences).toMatchObject({
      nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
    })
    expect(fake.views[0].bounds).toEqual({ x: 80, y: 64, width: 700, height: 500 })
    expect((win.contentView as any).addChildView).toHaveBeenCalledTimes(1)
    expect(fake.views[0].webContents.loadURL).toHaveBeenCalledTimes(2)
  })

  it('blocks insecure redirects without opening the system browser', async () => {
    const controller = registerPreviewWindow(appWindow())
    await controller.open('https://example.org/start', { x: 80, y: 64, width: 700, height: 500 })
    const contents = fake.views[0].webContents
    for (const url of ['http://example.org/plain', 'file:///tmp/local.html']) {
      const event = { url, isMainFrame: true, preventDefault: vi.fn() }
      contents.emit('will-redirect', event)
      expect(event.preventDefault).toHaveBeenCalledOnce()
    }
    expect(contents.loadURL).toHaveBeenCalledTimes(1)
    expect(fake.externalOpen).not.toHaveBeenCalled()
  })

  it('routes HTTPS new-window links into the current view and denies unsupported targets', async () => {
    const controller = registerPreviewWindow(appWindow())
    await controller.open('https://example.org/start', { x: 80, y: 64, width: 700, height: 500 })
    const contents = fake.views[0].webContents
    expect(contents.windowOpenHandler({ url: 'https://example.org/next' })).toEqual({ action: 'deny' })
    await vi.waitFor(() => expect(contents.loadURL).toHaveBeenCalledWith('https://example.org/next'))
    expect(contents.windowOpenHandler({ url: 'javascript:alert(1)' })).toEqual({ action: 'deny' })
    expect(contents.loadURL).toHaveBeenCalledTimes(2)
  })

  it('denies webpage permission requests and downloads', async () => {
    const controller = registerPreviewWindow(appWindow())
    await controller.open('https://example.org/start', { x: 80, y: 64, width: 700, height: 500 })
    const reply = vi.fn()
    fake.permissionHandler?.({}, 'notifications', reply)
    expect(reply).toHaveBeenCalledWith(false)
    const event = { preventDefault: vi.fn() }
    fake.sessionHandlers.get('will-download')?.(event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
  })

  it('ignores a stale load failure after the address changes', async () => {
    const win = appWindow()
    const controller = registerPreviewWindow(win)
    await controller.open('https://example.org/old', { x: 80, y: 64, width: 700, height: 500 })
    await controller.open('https://example.org/new', { x: 80, y: 64, width: 700, height: 500 })
    fake.views[0].webContents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://example.org/old', true)
    expect(controller.getState().error).toBe('')
  })

  it('removes and destroys the native view on close', async () => {
    const win = appWindow()
    const controller = registerPreviewWindow(win)
    await controller.open('https://example.org/start', { x: 80, y: 64, width: 700, height: 500 })
    controller.close()
    expect((win.contentView as any).removeChildView).toHaveBeenCalledWith(fake.views[0])
    expect(fake.views[0].webContents.close).toHaveBeenCalledOnce()
    unregisterPreviewWindow(win)
  })

  it('only gives preview control to the registered application renderer', () => {
    const win = appWindow()
    const controller = registerPreviewWindow(win)
    expect(previewControllerForSender(win.webContents)).toBe(controller)
    expect(() => previewControllerForSender({} as any)).toThrow('未授权的网页预览请求')
  })
})
