import { BrowserWindow, session, shell, WebContentsView } from 'electron'
import type { Session, WebContents } from 'electron'
import { createHash } from 'crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { withWebSummaryCapture } from './webSummaryCapture'
import { isAllowedExternalUrl, isAllowedPreviewUrl } from '../src/utils/webPreviewUrl'
import type { PreviewBounds, PreviewSnapshot, PreviewState } from '../src/types/webPreview'

// Keep Chromium's resource cache across app restarts, isolated from app pages.
const PREVIEW_PARTITION = 'persist:papermind-preview'
const CACHED_PARTITION = 'papermind-cached-preview'
const controllers = new WeakMap<BrowserWindow, PreviewController>()
const configuredSessions = new WeakSet<Session>()
const configuredCachedSessions = new WeakSet<Session>()
const allowedCachedFiles = new Set<string>()
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
  if (description.includes('主文档加载超时')) return description
  if (description.includes('CERT')) return '网站证书无效，请检查链接或在系统浏览器中打开。'
  if (description.includes('NAME_NOT_RESOLVED')) return '找不到网站，请检查地址或网络连接。'
  if (description.includes('INTERNET_DISCONNECTED')) return '网络已断开，请连接网络后重试。'
  return '网页暂时无法打开，请重试或在系统浏览器中打开。'
}

export class PreviewController {
  private view: WebContentsView | null = null
  private cachedView: WebContentsView | null = null
  private cachedDir: string | null = null
  private cachedFileUrl: string | null = null
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
    if (!this.win.isDestroyed()) this.win.webContents.send('preview:state', this.getState())
  }

  private attach() {
    if (!this.view || this.attached) return
    this.win.contentView.addChildView(this.view)
    this.attached = true
  }

  private detach() {
    if (!this.view || !this.attached) return
    if (!this.win.isDestroyed()) this.win.contentView.removeChildView(this.view)
    this.attached = false
  }

  private closeLive() {
    const view = this.view
    this.detach()
    this.view = null
    this.targetUrl = ''
    if (view) {
      blockedNotices.delete(view.webContents)
      if (!view.webContents.isDestroyed()) view.webContents.close()
    }
  }

  private clearCached() {
    const view = this.cachedView
    if (view) {
      if (!this.win.isDestroyed()) this.win.contentView.removeChildView(view)
      if (!view.webContents.isDestroyed()) view.webContents.close()
    }
    this.cachedView = null
    if (this.cachedFileUrl) allowedCachedFiles.delete(this.cachedFileUrl)
    this.cachedFileUrl = null
    if (this.cachedDir) rmSync(this.cachedDir, { recursive: true, force: true })
    this.cachedDir = null
  }

  async showCached(mhtml: Buffer, bounds: PreviewBounds): Promise<void> {
    if (!Buffer.isBuffer(mhtml) || !mhtml.length || mhtml.length > 32 * 1024 * 1024) {
      throw new Error('网页原貌缓存无效')
    }
    this.explicitOpenRequest++
    this.generation++
    this.clearCached()
    this.closeLive()
    const cachedSession = session.fromPartition(CACHED_PARTITION)
    configureSession(cachedSession)
    if (!configuredCachedSessions.has(cachedSession)) {
      configuredCachedSessions.add(cachedSession)
      cachedSession.webRequest.onBeforeRequest((details, callback) => {
        const allowedFile = allowedCachedFiles.has(details.url) && details.resourceType === 'mainFrame'
        callback({ cancel: /^https?:/i.test(details.url) || (details.url.startsWith('file:') && !allowedFile) })
      })
    }
    const dir = mkdtempSync(join(tmpdir(), 'papermind-web-cache-'))
    const file = join(dir, 'page.mhtml')
    const fileUrl = pathToFileURL(file).toString()
    try { writeFileSync(file, mhtml, { mode: 0o600 }) }
    catch (error) {
      rmSync(dir, { recursive: true, force: true })
      throw error
    }
    const view = new WebContentsView({ webPreferences: {
      partition: CACHED_PARTITION, javascript: false, nodeIntegration: false,
      contextIsolation: true, sandbox: true, webSecurity: true,
    } })
    this.cachedView = view
    this.cachedDir = dir
    this.cachedFileUrl = fileUrl
    allowedCachedFiles.add(fileUrl)
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    view.webContents.on('will-navigate', event => event.preventDefault())
    this.win.contentView.addChildView(view)
    this.setBounds(bounds)
    try {
      await view.webContents.loadURL(fileUrl)
    } catch (error) {
      if (this.cachedView === view) this.clearCached()
      throw new Error(`网页原貌缓存加载失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private ensureView(): WebContentsView {
    if (this.view) return this.view
    configureSession(session.fromPartition(PREVIEW_PARTITION))
    const view = new WebContentsView({
      webPreferences: {
        partition: PREVIEW_PARTITION,
        backgroundThrottling: false,
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
      if (this.view !== view) return
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
      if (this.view !== view) return
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
    contents.on('did-start-loading', () => { if (this.view === view) this.publish({ loading: true, notice: '' }) })
    contents.on('did-stop-loading', () => { if (this.view === view) this.publish({ loading: false }) })
    contents.on('dom-ready', () => { if (this.view === view) this.publish({ loading: false }) })
    contents.on('did-navigate', (_event, url) => {
      if (this.view !== view) return
      if (!isAllowedPreviewUrl(url)) return
      this.targetUrl = url
      this.attach()
      this.publish({ url, error: '', notice: '', visible: true })
    })
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (this.view !== view) return
      if (isMainFrame && isAllowedPreviewUrl(url)) {
        this.explicitOpenRequest++
        this.generation++
        this.targetUrl = url
        this.attach()
        this.publish({ url, error: '', notice: '', visible: true })
      }
    })
    contents.on('did-fail-load', (_event, code, description, failedUrl, isMainFrame) => {
      if (this.view !== view) return
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
    if (this.cachedView) this.cachedView.setBounds(this.bounds)
    else this.view?.setBounds(this.bounds)
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
    this.clearCached()
    const view = this.ensureView()
    this.setBounds(bounds)
    this.attach()
    const generation = ++this.generation
    this.targetUrl = url
    this.publish({ url, loading: true, error: '', notice: '', visible: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    let onReady: () => void = () => {}
    try {
      const domReady = new Promise<void>((resolve, reject) => {
        onReady = resolve
        view.webContents.on('dom-ready', onReady)
        timer = setTimeout(() => reject(new Error('网页主文档加载超时，请重试')), 20_000)
      })
      // loadURL also waits for secondary resources. A stalled image must not
      // prevent the capture layer from applying its own bounded resource policy.
      await Promise.race([view.webContents.loadURL(url), domReady])
    } catch (error) {
      if (generation !== this.generation || this.view !== view) return
      const description = error instanceof Error ? error.message : String(error)
      if (description.includes('ERR_ABORTED')) return
      this.detach()
      this.publish({ loading: false, error: loadErrorMessage(description), visible: false })
    } finally {
      if (timer) clearTimeout(timer)
      view.webContents.removeListener('dom-ready', onReady)
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
    if (this.cachedView || !contents || contents.isDestroyed() || !this.state.visible || this.state.loading) {
      throw new Error('网页尚未加载完成，请稍后重试')
    }
    const beforeUrl = contents.getURL()
    if (!isAllowedPreviewUrl(beforeUrl)) throw new Error('仅支持 HTTPS 网页')
    const beforeGeneration = this.generation
    return withWebSummaryCapture(contents, async capture => {
      const raw = await capture.readDom() as { doctype: string; html: string; title: string; url: string }
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
      this.publish({ notice: '' })
      let visualPdf: string | undefined
      let visualError = ''
      try { visualPdf = await capture.print() }
      catch (cause) {
        capture.assertActive()
        visualError = cause instanceof Error ? cause.message : '网页视觉副本采集失败'
      }
      capture.assertActive()
      if (this.generation !== beforeGeneration || this.view?.webContents !== contents || contents.getURL() !== beforeUrl) {
        throw new Error('网页已变化，请重试采集')
      }
      let archiveMhtml: string | undefined
      try {
        const dir = mkdtempSync(join(tmpdir(), 'papermind-web-capture-'))
        try {
          const file = join(dir, 'page.mhtml')
          await contents.savePage(file, 'MHTML')
          const archive = readFileSync(file)
          if (!archive.length || archive.length > 32 * 1024 * 1024) throw new Error('网页原貌缓存超过 32 MiB')
          archiveMhtml = archive.toString('base64')
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      } catch {
        capture.assertActive()
        if (this.generation !== beforeGeneration || this.view?.webContents !== contents) throw new Error('网页已变化，请重试采集')
        this.publish({ notice: visualPdf
          ? '原貌浏览缓存失败，已保存摘要视觉副本和阅读内容。'
          : `网页原貌缓存失败，已保存阅读内容；摘要视觉副本未就绪：${visualError}` })
      }
      capture.assertActive()
      if (!visualPdf && archiveMhtml) this.publish({ notice: `摘要视觉副本未就绪，将尝试原貌缓存：${visualError}` })
      if (this.generation !== beforeGeneration || this.view?.webContents !== contents
        || contents.getURL() !== beforeUrl || this.state.loading) throw new Error('网页已变化，请重试采集')
      const after = await capture.readDom() as typeof raw
      if (after.url !== beforeUrl || after.doctype !== raw.doctype || after.html !== raw.html
        || after.title !== raw.title || this.generation !== beforeGeneration
        || this.view?.webContents !== contents || contents.getURL() !== beforeUrl || this.state.loading) {
        throw new Error('网页已变化，请重试采集')
      }
      return {
        finalUrl: beforeUrl,
        title: raw.title,
        html,
        capturedAt: Date.now(),
        contentHash: createHash('sha256').update(html, 'utf8').digest('hex'),
        byteLength,
        archiveMhtml,
        visualPdf,
      }
    }, { visible: this.win.isVisible() && !this.win.isMinimized() })
  }

  async openExternal(url: string) {
    if (!isAllowedExternalUrl(url)) throw new Error('只能在浏览器中打开 HTTP 或 HTTPS 链接')
    await shell.openExternal(url)
  }

  close() {
    this.explicitOpenRequest++
    this.generation++
    this.clearCached()
    this.closeLive()
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

export async function clearPreviewData(): Promise<void> {
  // Stop active pages before clearing so in-flight requests cannot refill the cache.
  for (const win of BrowserWindow.getAllWindows()) controllers.get(win)?.close()
  const previewSession = session.fromPartition(PREVIEW_PARTITION)
  await Promise.all([
    previewSession.clearCache(),
    previewSession.clearStorageData(),
    previewSession.clearCodeCaches({}),
  ])
}

export function previewControllerForSender(sender: WebContents): PreviewController {
  const win = BrowserWindow.fromWebContents(sender)
  const controller = win ? controllers.get(win) : null
  if (!win || !controller || win.webContents !== sender) throw new Error('未授权的网页预览请求')
  return controller
}
