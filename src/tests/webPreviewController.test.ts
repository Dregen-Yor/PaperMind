import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'crypto'
import { readFileSync, writeFileSync } from 'fs'
import type { BrowserWindow } from 'electron'
import { clearPreviewData, previewControllerForSender, registerPreviewWindow, unregisterPreviewWindow } from '../../electron/webPreview'

const fake = vi.hoisted(() => ({
  views: [] as any[],
  permissionHandler: undefined as undefined | ((_contents: unknown, permission: string, callback: (allowed: boolean) => void) => void),
  permissionCheckHandler: undefined as undefined | ((_contents: unknown, permission: string) => boolean),
  sessionHandlers: new Map<string, (...args: any[]) => void>(),
  requestHandlers: [] as Array<(details: { url: string; resourceType: string }, callback: (result: { cancel: boolean }) => void) => void>,
  externalOpen: vi.fn(async (_url: string) => {}),
  windowBySender: new Map<object, object>(),
  clearingStartedWithLivePage: false,
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: (sender: object) => fake.windowBySender.get(sender) ?? null,
    getAllWindows: () => [...fake.windowBySender.values()],
  },
  session: {
    fromPartition: () => ({
      setPermissionRequestHandler: (handler: typeof fake.permissionHandler) => { fake.permissionHandler = handler },
      setPermissionCheckHandler: (handler: typeof fake.permissionCheckHandler) => { fake.permissionCheckHandler = handler },
      on: (name: string, handler: (...args: any[]) => void) => { fake.sessionHandlers.set(name, handler) },
      webRequest: { onBeforeRequest: (handler: typeof fake.requestHandlers[number]) => { fake.requestHandlers.push(handler) } },
      clearCache: async () => {
        fake.clearingStartedWithLivePage = fake.views.some(view => !view.webContents.isDestroyed())
      },
      clearStorageData: async () => {},
      clearCodeCaches: async () => {},
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
      removeListener(name: string, handler: (...args: any[]) => void) {
        this.listeners.set(name, (this.listeners.get(name) ?? []).filter(item => item !== handler))
      }
      emit(name: string, ...args: any[]) {
        for (const handler of this.listeners.get(name) ?? []) handler(...args)
      }
      setWindowOpenHandler(handler: (details: { url: string }) => { action: string }) { this.windowOpenHandler = handler }
      loadURL = vi.fn(async (url: string) => { this.currentUrl = url })
      savePage = vi.fn(async (path: string) => { writeFileSync(path, 'MIME-Version: 1.0\nContent-Type: multipart/related\n') })
      executeJavaScript = vi.fn(async () => ({
        doctype: '<!DOCTYPE html>', html: '<html><body>动态正文</body></html>',
        title: '文章', url: this.currentUrl,
      }))
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
    isDestroyed: vi.fn(() => false),
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
  fake.requestHandlers.length = 0
  fake.permissionHandler = undefined
  fake.permissionCheckHandler = undefined
  fake.externalOpen.mockClear()
  fake.windowBySender.clear()
  fake.clearingStartedWithLivePage = false
})

describe('isolated HTML preview controller', () => {
  it('closes active web pages before clearing browser data so requests cannot refill the cache', async () => {
    const controller = registerPreviewWindow(appWindow())
    await controller.open('https://example.org/start', { x: 0, y: 0, width: 600, height: 400 })
    await clearPreviewData()
    expect(fake.clearingStartedWithLivePage).toBe(false)
    expect(fake.views[0].webContents.isDestroyed()).toBe(true)
    expect(controller.getState()).toMatchObject({ visible: false, loading: false, url: '' })
  })
  it('releases child views after the owning window is destroyed without using its native view or IPC', async () => {
    const win = appWindow()
    const controller = registerPreviewWindow(win)
    await controller.open('https://example.org/start', { x: 0, y: 0, width: 600, height: 400 })
    vi.mocked(win.isDestroyed).mockReturnValue(true)
    vi.mocked(win.webContents.send).mockClear()
    vi.mocked(win.contentView.removeChildView).mockClear()
    expect(() => unregisterPreviewWindow(win)).not.toThrow()
    expect(win.webContents.send).not.toHaveBeenCalled()
    expect(win.contentView.removeChildView).not.toHaveBeenCalled()
    expect(fake.views[0].webContents.close).toHaveBeenCalledOnce()
  })
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
    const contents = fake.views[0].webContents
    fake.permissionHandler?.(contents, 'notifications', reply)
    expect(reply).toHaveBeenCalledWith(false)
    expect(fake.permissionCheckHandler?.(contents, 'notifications')).toBe(false)
    expect(controller.getState().notice).toContain('权限')
    const event = { preventDefault: vi.fn() }
    fake.sessionHandlers.get('will-download')?.(event, {}, contents)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(controller.getState().notice).toContain('下载')
  })

  it('keeps a failed link as the recovery target and restores the view after reload', async () => {
    const win = appWindow()
    const controller = registerPreviewWindow(win)
    await controller.open('https://example.org/article', { x: 80, y: 64, width: 700, height: 500 })
    const contents = fake.views[0].webContents
    contents.emit('did-navigate', {}, 'https://example.org/article')
    contents.emit('will-navigate', { url: 'https://example.org/missing', isMainFrame: true, preventDefault: vi.fn() })
    contents.emit('did-start-navigation', { url: 'https://example.org/missing', isMainFrame: true, isSameDocument: false })
    contents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://example.org/missing', true)
    expect(controller.getState()).toMatchObject({ url: 'https://example.org/missing', visible: false })
    expect((win.contentView as any).removeChildView).toHaveBeenCalledOnce()

    await controller.reload()
    expect(contents.loadURL).toHaveBeenCalledTimes(2)
    expect(contents.loadURL).toHaveBeenLastCalledWith('https://example.org/missing')
    contents.emit('did-start-navigation', { url: 'https://example.org/missing', isMainFrame: true, isSameDocument: false })
    contents.emit('did-navigate', {}, 'https://example.org/missing')
    expect(controller.getState()).toMatchObject({ url: 'https://example.org/missing', visible: true, error: '' })
    expect((win.contentView as any).addChildView).toHaveBeenCalledTimes(2)
  })

  it('recognizes a failed history navigation and reattaches after a successful Back', async () => {
    const win = appWindow()
    const controller = registerPreviewWindow(win)
    await controller.open('https://example.org/a', { x: 80, y: 64, width: 700, height: 500 })
    const contents = fake.views[0].webContents
    contents.emit('did-navigate', {}, 'https://example.org/a')
    await controller.open('https://example.org/b', { x: 80, y: 64, width: 700, height: 500 })
    contents.emit('did-navigate', {}, 'https://example.org/b')
    contents.navigationHistory.canGoBack.mockReturnValue(true)
    controller.back()
    contents.emit('did-start-navigation', { url: 'https://example.org/a', isMainFrame: true, isSameDocument: false })
    contents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://example.org/a', true)
    expect(controller.getState()).toMatchObject({ url: 'https://example.org/a', visible: false })

    controller.back()
    contents.emit('did-start-navigation', { url: 'https://example.org/a', isMainFrame: true, isSameDocument: false })
    contents.emit('did-navigate', {}, 'https://example.org/a')
    expect(controller.getState()).toMatchObject({ url: 'https://example.org/a', visible: true, error: '' })
    expect((win.contentView as any).addChildView).toHaveBeenCalledTimes(2)
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

  it('captures the fully serialized loaded DOM with a UTF-8 hash and byte length', async () => {
    const controller = registerPreviewWindow(appWindow())
    await controller.open('https://example.org/article', { x: 80, y: 64, width: 700, height: 500 })
    const contents = fake.views[0].webContents
    contents.emit('did-stop-loading')

    const result = await controller.captureSnapshot()
    expect(result.html).toBe('<!DOCTYPE html>\n<html><body>动态正文</body></html>')
    expect(result.finalUrl).toBe('https://example.org/article')
    expect(result.title).toBe('文章')
    expect(result.byteLength).toBe(Buffer.byteLength(result.html, 'utf8'))
    expect(result.contentHash).toBe(createHash('sha256').update(result.html).digest('hex'))
    expect(result.capturedAt).toBeGreaterThan(0)
    expect(Buffer.from(result.archiveMhtml!, 'base64').toString()).toContain('multipart/related')
    expect(contents.savePage).toHaveBeenCalledWith(expect.stringMatching(/\.mhtml$/), 'MHTML')
  })

  it('keeps the DOM and conversation source when complete-page saving fails', async () => {
    const controller = registerPreviewWindow(appWindow())
    await controller.open('https://example.org/article', { x: 80, y: 64, width: 700, height: 500 })
    const contents = fake.views[0].webContents
    contents.emit('did-stop-loading')
    contents.savePage.mockRejectedValueOnce(new Error('disk unavailable'))
    const snapshot = await controller.captureSnapshot()
    expect(snapshot.html).toContain('动态正文')
    expect(snapshot.archiveMhtml).toBeUndefined()
    expect(controller.getState().notice).toContain('原貌')
  })

  it('rejects a capture when the page DOM changes while its archive is saved', async () => {
    const controller = registerPreviewWindow(appWindow())
    await controller.open('https://example.org/article', { x: 80, y: 64, width: 700, height: 500 })
    const contents = fake.views[0].webContents
    contents.emit('did-stop-loading')
    contents.executeJavaScript.mockResolvedValueOnce({
      doctype: '<!DOCTYPE html>', html: '<html><body>第一版</body></html>',
      title: '文章', url: contents.currentUrl,
    }).mockResolvedValueOnce({
      doctype: '<!DOCTYPE html>', html: '<html><body>第二版</body></html>',
      title: '文章', url: contents.currentUrl,
    })
    await expect(controller.captureSnapshot()).rejects.toThrow('网页已变化')
  })

  it('renders an archived page in a separate native view and closes the live page', async () => {
    const win = appWindow()
    const controller = registerPreviewWindow(win)
    const bounds = { x: 80, y: 64, width: 700, height: 500 }
    await controller.open('https://example.org/article', bounds)
    const bytes = Buffer.from('MIME-Version: 1.0\nContent-Type: multipart/related\n')
    await controller.showCached(bytes, bounds)
    expect(fake.views).toHaveLength(2)
    expect(fake.views[1].options.webPreferences).toMatchObject({ javascript: false, nodeIntegration: false, sandbox: true })
    const cachedUrl = fake.views[1].webContents.loadURL.mock.calls[0][0] as string
    expect(cachedUrl).toMatch(/^file:.*\.mhtml$/)
    expect(readFileSync(new URL(cachedUrl)).equals(bytes)).toBe(true)
    const filter = fake.requestHandlers.at(-1)!
    const decision = vi.fn()
    filter({ url: 'https://example.org/tracker', resourceType: 'image' }, decision)
    expect(decision).toHaveBeenLastCalledWith({ cancel: true })
    filter({ url: 'file:///Users/test/private.txt', resourceType: 'image' }, decision)
    expect(decision).toHaveBeenLastCalledWith({ cancel: true })
    filter({ url: cachedUrl, resourceType: 'mainFrame' }, decision)
    expect(decision).toHaveBeenLastCalledWith({ cancel: false })
    expect((win.contentView as any).removeChildView).toHaveBeenCalledWith(fake.views[0])
    expect(fake.views[0].webContents.close).toHaveBeenCalledOnce()
    fake.views[0].webContents.emit('did-navigate', {}, 'https://example.org/article')
    expect((win.contentView as any).addChildView).toHaveBeenCalledTimes(2)
    await expect(controller.captureSnapshot()).rejects.toThrow()
    controller.close()
    expect(fake.views[1].webContents.close).toHaveBeenCalledOnce()
  })

  it('creates a fresh live view when leaving cached mode', async () => {
    const controller = registerPreviewWindow(appWindow())
    const bounds = { x: 80, y: 64, width: 700, height: 500 }
    await controller.open('https://example.org/article', bounds)
    await controller.showCached(Buffer.from('MIME-Version: 1.0\n'), bounds)
    await controller.open('https://example.org/article', bounds)
    expect(fake.views).toHaveLength(3)
    expect(fake.views[1].webContents.close).toHaveBeenCalledOnce()
    expect(fake.views[2].webContents.loadURL).toHaveBeenCalledWith('https://example.org/article')
  })

  it('captures a redirected HTTPS page from one explicit open', async () => {
    const controller = registerPreviewWindow(appWindow())
    const pending = controller.openAndCapture('https://example.org/start', { x: 80, y: 64, width: 700, height: 500 })
    const contents = fake.views[0].webContents
    contents.emit('will-redirect', { url: 'https://example.org/final', isMainFrame: true, preventDefault: vi.fn() })
    contents.currentUrl = 'https://example.org/final'
    contents.emit('did-navigate', {}, 'https://example.org/final')
    contents.emit('did-stop-loading')
    expect((await pending).finalUrl).toBe('https://example.org/final')
  })

  it('rejects an explicit import after a site click or insecure redirect', async () => {
    const controller = registerPreviewWindow(appWindow())
    const bounds = { x: 80, y: 64, width: 700, height: 500 }
    const clicked = controller.openAndCapture('https://example.org/start', bounds)
    const contents = fake.views[0].webContents
    contents.emit('will-navigate', { url: 'https://example.org/clicked', isMainFrame: true, preventDefault: vi.fn() })
    contents.currentUrl = 'https://example.org/clicked'
    contents.emit('did-stop-loading')
    await expect(clicked).rejects.toThrow()
    const redirected = controller.openAndCapture('https://example.org/again', bounds)
    const event = { url: 'http://example.org/plain', isMainFrame: true, preventDefault: vi.fn() }
    contents.emit('will-redirect', event)
    contents.emit('did-stop-loading')
    expect(event.preventDefault).toHaveBeenCalledOnce()
    await expect(redirected).rejects.toThrow()
  })

  it('rejects a failed load and an import superseded by another explicit open', async () => {
    const controller = registerPreviewWindow(appWindow())
    const bounds = { x: 80, y: 64, width: 700, height: 500 }
    const failed = controller.openAndCapture('https://example.org/fail', bounds)
    const contents = fake.views[0].webContents
    contents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://example.org/fail', true)
    await expect(failed).rejects.toThrow()
    const first = controller.openAndCapture('https://example.org/first', bounds)
    await controller.open('https://example.org/second', bounds)
    contents.emit('did-stop-loading')
    await expect(first).rejects.toThrow()
  })

  it('refuses capture while loading or after a same-URL reload races with serialization', async () => {
    const controller = registerPreviewWindow(appWindow())
    await controller.open('https://example.org/article', { x: 80, y: 64, width: 700, height: 500 })
    await expect(controller.captureSnapshot()).rejects.toThrow()
    const contents = fake.views[0].webContents
    contents.emit('did-stop-loading')
    let finish!: (value: object) => void
    contents.executeJavaScript.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = controller.captureSnapshot()
    contents.emit('did-start-navigation', { url: 'https://example.org/article', isMainFrame: true })
    finish({ doctype: '', html: '<html>stale</html>', title: '文章', url: 'https://example.org/article' })
    await expect(pending).rejects.toThrow('网页已变化')
  })

  it('rejects oversized HTML instead of sending a truncated snapshot', async () => {
    const controller = registerPreviewWindow(appWindow())
    await controller.open('https://example.org/article', { x: 80, y: 64, width: 700, height: 500 })
    const contents = fake.views[0].webContents
    contents.emit('did-stop-loading')
    contents.executeJavaScript.mockResolvedValueOnce({
      doctype: '', html: '字'.repeat(3_000_000), title: '大页面', url: 'https://example.org/article',
    })
    await expect(controller.captureSnapshot()).rejects.toThrow('8 MiB')
  })
})
