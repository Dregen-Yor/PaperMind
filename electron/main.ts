import { app, BrowserWindow, nativeImage, net, protocol, shell } from 'electron'
import { join } from 'path'
import { initDb, paperApi } from './db'
import { registerIpc } from './ipc'
import { configureIdentity, getIconPath } from './branding'
import { registerPreviewWindow, unregisterPreviewWindow } from './webPreview'
import { stopManagedDoclingTunnel } from './doclingTunnel'
import { servePaperRequest } from './paperProtocol'

protocol.registerSchemesAsPrivileged([{
  scheme: 'papermind-paper',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
}])

configureIdentity(app, process.platform)

// Fix GPU crash on Linux (Intel GBM/Wayland ENOMEM)
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-software-rasterizer')

const getRuntimeIconPath = () => getIconPath({
  platform: process.platform,
  isPackaged: app.isPackaged,
  appPath: app.getAppPath(),
  resourcesPath: process.resourcesPath,
})

let mainWindow: BrowserWindow | null = null

const createWindow = () => {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: process.platform === 'darwin' ? undefined : getRuntimeIconPath(),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  mainWindow = win
  win.on('closed', () => {
    unregisterPreviewWindow(win)
    mainWindow = null
  })
  registerPreviewWindow(win)

  const openExternalUrl = (url: string) => {
    try {
      const protocol = new URL(url).protocol
      if (protocol === 'http:' || protocol === 'https:') void shell.openExternal(url)
    } catch { /* Ignore malformed URLs. */ }
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    if (url === win.webContents.getURL()) return
    event.preventDefault()
    openExternalUrl(url)
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(join(__dirname, '../dist/index.html'))
  }
}

// File transaction recovery must only run in the process that owns the database.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(() => {
    if (process.platform === 'darwin' && !app.isPackaged) {
      const iconPath = getRuntimeIconPath()
      const icon = nativeImage.createFromPath(iconPath)
      if (icon.isEmpty()) {
        console.warn('[branding] Unable to load icon:', iconPath)
      } else {
        app.dock?.setIcon(icon)
      }
    }

    initDb()
    protocol.handle('papermind-paper', request => servePaperRequest(
      request,
      id => paperApi.filePath(id),
      (url, headers) => net.fetch(url, { headers }),
    ))
    registerIpc()
    createWindow()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  app.on('before-quit', stopManagedDoclingTunnel)
}
