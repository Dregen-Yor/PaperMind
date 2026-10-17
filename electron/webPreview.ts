import { BrowserWindow, session, shell, WebContentsView } from 'electron'
import type { Session, WebContents } from 'electron'
import { createHash } from 'crypto'
import { isAllowedExternalUrl, isAllowedPreviewUrl } from '../src/utils/webPreviewUrl'
import type { PreviewBounds, PreviewSnapshot, PreviewState } from '../src/types/webPreview'

const PREVIEW_PARTITION = 'papermind-preview'
const controllers = new WeakMap<BrowserWindow, PreviewController>()
const configuredSessions = new WeakSet<Session>()
const blockedNotices = new WeakMap<WebContents, (message: string) => void>()

function configureSession(previewSession: Session) {
  if (configuredSessions.has(previewSession)) return
  configuredSessions.add(previewSession)
  previewSession.setPermissionCheckHandler(() => false)
  previewSession.setPermissionRequestHandler((contents, _permission, callback) => {
    callback(false)
    blockedNotices.get(contents)?.('该网站请求的权限已被预览页拒绝。')
  })
  previewSession.on('will-download', (event, _item, contents) => {
    event.preventDefault()
    blockedNotices.get(contents)?.('预览页不支持下载，请在系统浏览器中打开。')
  })
}

function loadErrorMessage(description: string): string {
  if (description.includes('CERT')) return '网站证书无效，请检查链接或在系统浏览器中打开。'
  if (description.includes('NAME_NOT_RESOLVED')) return '找不到网站，请检查地址或网络连接。'
  if (description.includes('INTERNET_DISCONNECTED')) return '网络已断开，请连接网络后重试。'
  return '网页暂时无法打开，请重试或在系统浏览器中打开。'
}

export class PreviewController {
  private view: WebContentsView | null = null
  private attached = false
  private targetUrl = ''
  private generation = 0
  private explicitOpenRequest = 0
  private bounds: PreviewBounds = { x: 0, y: 0, width: 0, height: 0 }
  private state: PreviewState = {
    url: '', loading: false, canGoBack: false, canGoForward: false,
    error: '', notice: '', visible: false,
  }

  constructor(private readonly win: BrowserWindow) {}

  getState(): PreviewState { return { ...this.state } }

  private publish(patch: Partial<PreviewState> = {}) {
    this.state = { ...this.state, ...patch }
    const history = this.view?.webContents.navigationHistory
    this.state.canGoBack = history?.canGoBack() ?? false
    this.state.canGoForward = history?.canGoForward() ?? false
    this.win.webContents.send('preview:state', this.getState())
  }

  private attach() {
    if (!this.view || this.attached) return
    this.win.contentView.addChildView(this.view)
    this.attached = true
  }

  private detach() {
    if (!this.view || !this.attached) return
    this.win.contentView.removeChildView(this.view)
    this.attached = false
  }

  private ensureView(): WebContentsView {
    if (this.view) return this.view
    configureSession(session.fromPartition(PREVIEW_PARTITION))
    const view = new WebContentsView({
      webPreferences: {
        partition: PREVIEW_PARTITION,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    })
    this.view = view
    const contents = view.webContents
    blockedNotices.set(contents, message => this.publish({ notice: message }))

    const guardNavigation = (event: { url: string; isMainFrame: boolean; preventDefault: () => void }, redirect: boolean) => {
      if (!event.isMainFrame) return
      if (!redirect) this.explicitOpenRequest++
      if (isAllowedPreviewUrl(event.url)) {
        this.targetUrl = event.url
        return
      }
      if (redirect) this.explicitOpenRequest++
      event.preventDefault()
      this.publish({ notice: '该链接无法在预览页打开，仅支持 HTTPS 网页。' })
    }
    contents.on('will-navigate', event => guardNavigation(event, false))
    contents.on('will-redirect', event => guardNavigation(event, true))
    contents.on('did-start-navigation', details => {
      if (details.isMainFrame) {
        this.generation++
        if (isAllowedPreviewUrl(details.url)) this.targetUrl = details.url
      }
    })
    contents.setWindowOpenHandler(({ url }) => {
      if (isAllowedPreviewUrl(url)) {
        queueMicrotask(() => { if (this.view === view) void this.open(url, this.bounds) })
      } else {
        this.publish({ notice: '该链接无法在预览页打开，仅支持 HTTPS 网页。' })
      }
      return { action: 'deny' }
    })
    contents.on('did-start-loading', () => this.publish({ loading: true, notice: '' }))
    contents.on('did-stop-loading', () => this.publish({ loading: false }))
    contents.on('did-navigate', (_event, url) => {
      if (!isAllowedPreviewUrl(url)) return
      this.targetUrl = url
      this.attach()
      this.publish({ url, error: '', notice: '', visible: true })
    })
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame && isAllowedPreviewUrl(url)) {
        this.explicitOpenRequest++
        this.generation++
        this.targetUrl = url
        this.attach()
        this.publish({ url, error: '', notice: '', visible: true })
      }
    })
    contents.on('did-fail-load', (_event, code, description, failedUrl, isMainFrame) => {
      if (!isMainFrame || code === -3 || failedUrl !== this.targetUrl) return
      this.detach()
      this.publish({ url: failedUrl, loading: false, error: loadErrorMessage(description), visible: false })
    })
    this.attach()
    return view
  }

  setBounds(bounds: PreviewBounds) {
    const { width: outerWidth, height: outerHeight } = this.win.getContentBounds()
    const x = Math.min(outerWidth, Math.max(0, Math.floor(Number.isFinite(bounds.x) ? bounds.x : 0)))
    const y = Math.min(outerHeight, Math.max(0, Math.floor(Number.isFinite(bounds.y) ? bounds.y : 0)))
    const width = Math.max(0, Math.min(outerWidth - x, Math.floor(Number.isFinite(bounds.width) ? bounds.width : 0)))
    const height = Math.max(0, Math.min(outerHeight - y, Math.floor(Number.isFinite(bounds.height) ? bounds.height : 0)))
    this.bounds = { x, y, width, height }
    this.view?.setBounds(this.bounds)
  }

  async open(url: string, bounds: PreviewBounds) {
    this.explicitOpenRequest++
    await this.load(url, bounds)
  }

  async openAndCapture(url: string, bounds: PreviewBounds): Promise<PreviewSnapshot> {
    const request = ++this.explicitOpenRequest
    await this.load(url, bounds)
    if (request !== this.explicitOpenRequest) throw new Error('网页已变化，请重新打开')
    await this.waitForIdle(request)
    if (request !== this.explicitOpenRequest || this.state.error || !this.state.visible) {
      throw new Error('网页未能完成加载')
    }
    const snapshot = await this.captureSnapshot()
    if (request !== this.explicitOpenRequest) throw new Error('网页已变化，请重新打开')
    return snapshot
  }

  private waitForIdle(request: number): Promise<void> {
    if (request !== this.explicitOpenRequest) return Promise.reject(new Error('网页已变化，请重新打开'))
    if (!this.state.loading) {
      return this.state.error || !this.state.visible
        ? Promise.reject(new Error('网页未能完成加载')) : Promise.resolve()
    }
    const contents = this.view?.webContents
    if (!contents) return Promise.reject(new Error('网页预览已关闭'))
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout)
        contents.removeListener('did-stop-loading', onStop)
        contents.removeListener('did-fail-load', onFail)
      }
      const onStop = () => {
        cleanup()
        if (request !== this.explicitOpenRequest || this.state.error || !this.state.visible) {
          reject(new Error('网页未能完成加载'))
        } else resolve()
      }
      const onFail = (_event: unknown, code: number, _description: string, failedUrl: string, isMainFrame: boolean) => {
        if (!isMainFrame || code === -3 || failedUrl !== this.targetUrl) return
        cleanup()
        reject(new Error('网页未能完成加载'))
      }
      const timeout = setTimeout(() => { cleanup(); reject(new Error('网页加载超时，请重试')) }, 20_000)
      contents.on('did-stop-loading', onStop)
      contents.on('did-fail-load', onFail)
      if (!this.state.loading) onStop()
    })
  }

  private async load(url: string, bounds: PreviewBounds) {
    if (!isAllowedPreviewUrl(url)) throw new Error('仅支持 HTTPS 链接')
    const view = this.ensureView()
    this.setBounds(bounds)
    this.attach()
    const generation = ++this.generation
    this.targetUrl = url
    this.publish({ url, loading: true, error: '', notice: '', visible: true })
    try {
      await view.webContents.loadURL(url)
    } catch (error) {
      if (generation !== this.generation || this.view !== view) return
      const description = error instanceof Error ? error.message : String(error)
      if (description.includes('ERR_ABORTED')) return
      this.detach()
      this.publish({ loading: false, error: loadErrorMessage(description), visible: false })
    }
  }

  back() {
    this.explicitOpenRequest++
    const history = this.view?.webContents.navigationHistory
    if (history?.canGoBack()) history.goBack()
  }

  forward() {
    this.explicitOpenRequest++
    const history = this.view?.webContents.navigationHistory
    if (history?.canGoForward()) history.goForward()
  }

  reload() {
    this.explicitOpenRequest++
    if (this.state.error && this.state.url) return this.open(this.state.url, this.bounds)
    if (this.view && this.state.url) {
      this.generation++
      this.view.webContents.reload()
    }
  }

  async captureSnapshot(): Promise<PreviewSnapshot> {
    const contents = this.view?.webContents
    if (!contents || contents.isDestroyed() || !this.state.visible || this.state.loading) {
      throw new Error('网页尚未加载完成，请稍后重试')
    }
    const beforeUrl = contents.getURL()
    if (!isAllowedPreviewUrl(beforeUrl)) throw new Error('仅支持 HTTPS 网页')
    const beforeGeneration = this.generation
    const raw = await contents.executeJavaScript(`({
      doctype: document.doctype ? new XMLSerializer().serializeToString(document.doctype) : '',
      html: document.documentElement.outerHTML,
      title: document.title,
      url: location.href
    })`) as { doctype: string; html: string; title: string; url: string }
    if (this.generation !== beforeGeneration || this.view?.webContents !== contents
      || contents.getURL() !== beforeUrl || raw.url !== beforeUrl || this.state.loading) {
      throw new Error('网页已变化，请重试采集')
    }
    if (typeof raw.html !== 'string' || typeof raw.title !== 'string' || typeof raw.doctype !== 'string') {
      throw new Error('网页 DOM 采集失败，请重试')
    }
    const html = raw.doctype ? `${raw.doctype}\n${raw.html}` : raw.html
    const byteLength = Buffer.byteLength(html, 'utf8')
    if (byteLength > 8 * 1024 * 1024) throw new Error('网页超过 8 MiB，无法完整发送')
    return {
      finalUrl: beforeUrl,
      title: raw.title,
      html,
      capturedAt: Date.now(),
      contentHash: createHash('sha256').update(html, 'utf8').digest('hex'),
      byteLength,
    }
  }

  async openExternal(url: string) {
    if (!isAllowedExternalUrl(url)) throw new Error('只能在浏览器中打开 HTTP 或 HTTPS 链接')
    await shell.openExternal(url)
  }

  close() {
    this.explicitOpenRequest++
    this.generation++
    this.detach()
    if (this.view) blockedNotices.delete(this.view.webContents)
    if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.close()
    this.view = null
    this.targetUrl = ''
    this.publish({ url: '', loading: false, error: '', notice: '', visible: false })
  }
}

export function registerPreviewWindow(win: BrowserWindow): PreviewController {
  const existing = controllers.get(win)
  if (existing) return existing
  const controller = new PreviewController(win)
  controllers.set(win, controller)
  return controller
}

export function unregisterPreviewWindow(win: BrowserWindow) {
  controllers.get(win)?.close()
  controllers.delete(win)
}

export function previewControllerForSender(sender: WebContents): PreviewController {
  const win = BrowserWindow.fromWebContents(sender)
  const controller = win ? controllers.get(win) : null
  if (!win || !controller || win.webContents !== sender) throw new Error('未授权的网页预览请求')
  return controller
}
