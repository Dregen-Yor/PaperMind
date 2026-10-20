// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

const startup = vi.hoisted(() => {
  class Window {
    static getAllWindows() { return windows }
    listeners = new Map<string, () => void>()
    minimized = false
    restore = vi.fn(() => { this.minimized = false })
    focus = vi.fn()
    isMinimized() { return this.minimized }
    on(event: string, listener: () => void) { this.listeners.set(event, listener) }
    loadURL = vi.fn()
    loadFile = vi.fn()
    webContents = {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      getURL: vi.fn(() => ''),
    }
    constructor() { windows.push(this) }
  }
  const windows: Window[] = []
  return {
    Window,
    windows,
    listeners: new Map<string, () => void>(),
    ready: Promise.resolve(),
    requestLock: vi.fn(() => true),
    quit: vi.fn(),
    whenReady: vi.fn<() => Promise<void>>(),
    initDb: vi.fn(),
    registerIpc: vi.fn(),
    handleProtocol: vi.fn(),
  }
})

vi.mock('electron', () => ({
  app: {
    requestSingleInstanceLock: startup.requestLock,
    quit: startup.quit,
    whenReady: startup.whenReady,
    on: (event: string, listener: () => void) => startup.listeners.set(event, listener),
    commandLine: { appendSwitch: vi.fn() },
    isPackaged: true,
    getAppPath: () => '/app',
  },
  BrowserWindow: startup.Window,
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: startup.handleProtocol },
  nativeImage: { createFromPath: vi.fn() },
  net: { fetch: vi.fn() },
  shell: { openExternal: vi.fn() },
}))
vi.mock('../../electron/db', () => ({ initDb: startup.initDb, paperApi: { filePath: vi.fn() } }))
vi.mock('../../electron/ipc', () => ({ registerIpc: startup.registerIpc }))
vi.mock('../../electron/branding', () => ({ configureIdentity: vi.fn(), getIconPath: () => '/icon.png' }))
vi.mock('../../electron/webPreview', () => ({ registerPreviewWindow: vi.fn(), unregisterPreviewWindow: vi.fn() }))
vi.mock('../../electron/doclingTunnel', () => ({ stopManagedDoclingTunnel: vi.fn() }))
vi.mock('../../electron/paperProtocol', () => ({ servePaperRequest: vi.fn() }))

let finishReady: () => void
beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  startup.windows.length = 0
  startup.listeners.clear()
  startup.requestLock.mockReturnValue(true)
  startup.ready = new Promise<void>(resolve => { finishReady = resolve })
  startup.whenReady.mockImplementation(() => startup.ready)
})

async function ready() {
  finishReady()
  await startup.ready
}

describe('single instance main process startup', () => {
  it('keeps preview registration if beforeunload cancels close and releases it only on closed', async () => {
    await import('../../electron/main')
    await ready()
    const { unregisterPreviewWindow } = await import('../../electron/webPreview')
    const win = startup.windows[0]
    // close is cancellable; the still-open window must retain its IPC owner.
    win.listeners.get('close')?.()
    expect(unregisterPreviewWindow).not.toHaveBeenCalled()
    win.listeners.get('closed')?.()
    expect(unregisterPreviewWindow).toHaveBeenCalledWith(win)
  })
  it('quits a losing instance without initializing the database, IPC, protocol handler or window', async () => {
    startup.requestLock.mockReturnValue(false)
    await import('../../electron/main')
    await ready()
    startup.listeners.get('activate')?.()

    expect(startup.initDb).not.toHaveBeenCalled()
    expect(startup.registerIpc).not.toHaveBeenCalled()
    expect(startup.handleProtocol).not.toHaveBeenCalled()
    expect(startup.windows).toHaveLength(0)
    expect(startup.requestLock).toHaveBeenCalledOnce()
    expect(startup.quit).toHaveBeenCalledOnce()
    expect(startup.whenReady).not.toHaveBeenCalled()
  })

  it('acquires the lock before starting the owning instance and waits for readiness', async () => {
    await import('../../electron/main')
    expect(startup.requestLock).toHaveBeenCalledOnce()
    expect(startup.initDb).not.toHaveBeenCalled()
    expect(startup.windows).toHaveLength(0)

    await ready()

    expect(startup.quit).not.toHaveBeenCalled()
    expect(startup.initDb).toHaveBeenCalledOnce()
    expect(startup.registerIpc).toHaveBeenCalledOnce()
    expect(startup.handleProtocol).toHaveBeenCalledWith('papermind-paper', expect.any(Function))
    expect(startup.windows).toHaveLength(1)
    expect(startup.requestLock.mock.invocationCallOrder[0]).toBeLessThan(startup.whenReady.mock.invocationCallOrder[0])
    expect(startup.initDb.mock.invocationCallOrder[0]).toBeLessThan(startup.registerIpc.mock.invocationCallOrder[0])
  })

  it('restores and focuses the existing main window when another instance starts', async () => {
    await import('../../electron/main')
    await ready()
    const mainWindow = startup.windows[0]
    mainWindow.minimized = true

    startup.listeners.get('second-instance')?.()

    expect(mainWindow.restore).toHaveBeenCalledOnce()
    expect(mainWindow.focus).toHaveBeenCalledOnce()
    expect(startup.windows).toHaveLength(1)
    expect(startup.initDb).toHaveBeenCalledOnce()
  })

  it('handles a second instance before the owner has a window', async () => {
    await import('../../electron/main')

    expect(startup.listeners.has('second-instance')).toBe(true)
    expect(() => startup.listeners.get('second-instance')?.()).not.toThrow()
    expect(startup.windows).toHaveLength(0)
    expect(startup.initDb).not.toHaveBeenCalled()

    await ready()
    expect(startup.windows).toHaveLength(1)
  })

  it('preserves activate behavior after the main window closes', async () => {
    await import('../../electron/main')
    await ready()
    startup.listeners.get('activate')?.()
    expect(startup.windows).toHaveLength(1)

    const closedWindow = startup.windows.pop()!
    closedWindow.listeners.get('closed')?.()
    expect(() => startup.listeners.get('second-instance')?.()).not.toThrow()
    expect(closedWindow.focus).not.toHaveBeenCalled()
    startup.listeners.get('activate')?.()

    expect(startup.windows).toHaveLength(1)
    expect(startup.windows[0]).not.toBe(closedWindow)
    expect(startup.initDb).toHaveBeenCalledOnce()
  })
})
