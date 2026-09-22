// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest'
import { join } from 'node:path'
import { getIconPath, configureIdentity } from '../../electron/branding'

describe('branding paths and identity', () => {
  it.each([
    ['darwin', 'mac.png'], ['win32', 'win.ico'], ['linux', 'linux/512x512.png'],
  ] as const)('resolves %s without shell cwd', (platform, file) => {
    expect(getIconPath({ platform, isPackaged: false, appPath: '/tmp/Paper Mind 中文', resourcesPath: '/unused' }))
      .toBe(join('/tmp/Paper Mind 中文', 'assets/icons', file))
    expect(getIconPath({ platform, isPackaged: true, appPath: '/archive/app.asar', resourcesPath: '/installed/resources' }))
      .toBe(join('/installed/resources', 'icons', file))
  })
  it.each(['darwin', 'linux', 'win32'] as const)('calls only %s identity APIs', platform => {
    const app = { setName: vi.fn(), setAppUserModelId: vi.fn(), setDesktopName: vi.fn() }
    configureIdentity(app, platform)
    expect(app.setName).toHaveBeenCalledWith('PaperMind')
    expect(app.setAppUserModelId).toHaveBeenCalledTimes(platform === 'win32' ? 1 : 0)
    expect(app.setDesktopName).toHaveBeenCalledTimes(platform === 'linux' ? 1 : 0)
    if (platform === 'win32') expect(app.setAppUserModelId).toHaveBeenCalledWith('com.papermind.app')
    if (platform === 'linux') expect(app.setDesktopName).toHaveBeenCalledWith('com.papermind.app.desktop')
  })
})

const state = vi.hoisted(() => ({
  packaged: false,
  empty: false,
  dockIcon: vi.fn(),
  window: vi.fn(),
}))
vi.mock('electron', () => ({
  app: {
    get isPackaged() { return state.packaged },
    setName: vi.fn(), setAppUserModelId: vi.fn(), setDesktopName: vi.fn(),
    getAppPath: () => '/tmp/Paper Mind 中文',
    commandLine: { appendSwitch: vi.fn() },
    whenReady: () => Promise.resolve(),
    on: vi.fn(), quit: vi.fn(),
    dock: { setIcon: state.dockIcon },
  },
  BrowserWindow: class {
    static getAllWindows() { return [] }
    constructor(options: unknown) { state.window(options) }
    webContents = { setWindowOpenHandler: vi.fn(), on: vi.fn() }
    loadURL = vi.fn()
    loadFile = vi.fn()
  },
  nativeImage: { createFromPath: () => ({ isEmpty: () => state.empty }) },
  shell: { openExternal: vi.fn() },
}))
vi.mock('../../electron/db', () => ({ initDb: vi.fn() }))
vi.mock('../../electron/ipc', () => ({ registerIpc: vi.fn() }))

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
afterEach(() => {
  Object.defineProperty(process, 'platform', platformDescriptor)
  vi.restoreAllMocks()
  vi.clearAllMocks()
  state.packaged = false
  state.empty = false
})

it('packaged macOS keeps bundle icon', async () => {
  vi.resetModules()
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'darwin' })
  state.packaged = true
  await import('../../electron/main')
  await vi.waitFor(() => expect(state.window).toHaveBeenCalledOnce())
  expect(state.dockIcon).not.toHaveBeenCalled()
})

it('missing development icon logs its path and still opens a window', async () => {
  vi.resetModules()
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'darwin' })
  state.empty = true
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  await import('../../electron/main')
  await vi.waitFor(() => expect(state.window).toHaveBeenCalledOnce())
  expect(warn).toHaveBeenCalledWith('[branding] Unable to load icon:', expect.stringContaining('mac.png'))
  expect(state.dockIcon).not.toHaveBeenCalled()
})

it('uses the Linux icon for the window outside macOS', async () => {
  vi.resetModules()
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'linux' })
  await import('../../electron/main')
  await vi.waitFor(() => expect(state.window).toHaveBeenCalledOnce())
  expect(state.window).toHaveBeenCalledWith(expect.objectContaining({
    icon: join('/tmp/Paper Mind 中文', 'assets/icons', 'linux/512x512.png'),
  }))
  expect(state.dockIcon).not.toHaveBeenCalled()
})
