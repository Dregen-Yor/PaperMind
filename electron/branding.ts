import { join } from 'node:path'

export interface BrandingPaths {
  platform: NodeJS.Platform
  isPackaged: boolean
  appPath: string
  resourcesPath: string
}

export interface BrandingApp {
  setName(name: string): void
  setAppUserModelId(id: string): void
  setDesktopName(name: string): void
}

export function getIconPath(paths: BrandingPaths): string {
  const root = paths.isPackaged ? join(paths.resourcesPath, 'icons') : join(paths.appPath, 'assets/icons')
  const file = paths.platform === 'darwin' ? 'mac.png' : paths.platform === 'win32' ? 'win.ico' : 'linux/512x512.png'
  return join(root, file)
}

export function configureIdentity(app: BrandingApp, platform: NodeJS.Platform): void {
  app.setName('PaperMind')
  if (platform === 'win32') app.setAppUserModelId('com.papermind.app')
  if (platform === 'linux') app.setDesktopName('com.papermind.app.desktop')
}
