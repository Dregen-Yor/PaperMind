import { app, BrowserWindow, nativeImage, shell } from 'electron'
import { join } from 'path'
import { initDb } from './db'
import { registerIpc } from './ipc'
import { configureIdentity, getIconPath } from './branding'

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
  registerIpc()
  createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
