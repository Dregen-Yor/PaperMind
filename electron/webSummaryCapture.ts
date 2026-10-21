import { BrowserWindow, session, type WebContents } from 'electron'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { PreviewSnapshot } from '../src/types/webPreview'

const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024
const CAPTURE_TIMEOUT_MS = 45_000

/** Distinguish clipped reading content from navigation, icons and intentional ellipsis. */
export function isWebReadingOverflow(node: Element, doc: Document) {
  if (node === doc.documentElement || node === doc.scrollingElement
    || node.closest('nav, aside, header, footer, [role="navigation"], [aria-hidden="true"]')) return false
  const primary = doc.querySelector('main, article, [role="main"]')
  if (primary && !primary.contains(node) && !node.contains(primary)) return false
  const style = doc.defaultView!.getComputedStyle(node)
  return node.clientHeight >= 40 && node.scrollHeight > node.clientHeight + 2
    && /(auto|scroll|hidden|clip)/.test(style.overflowY || style.overflow)
    && ((node.clientHeight >= 80 && node.scrollHeight > node.clientHeight * 1.3)
      || (node.textContent?.trim().length || 0) >= 100)
}

/** Runs through the inspector in both live and offline renderers; no module closures. */
export function inspectWebSummaryDocument(doc: Document, overflow = isWebReadingOverflow) {
  const view = doc.defaultView!
  const hidden = (node: Element) => {
    if (node.closest('.katex-mathml, mjx-assistive-mml')) return true
    for (let current: Element | null = node; current;) {
      const style = view.getComputedStyle(current)
      if (style.display === 'none' || style.visibility === 'hidden') return true
      current = current.parentElement || (current.getRootNode() as ShadowRoot).host || null
    }
    return false
  }
  const roots: ParentNode[] = [doc]
  const nodes: Element[] = []
  for (let i = 0; i < roots.length; i++) {
    for (const node of Array.from(roots[i].querySelectorAll('*'))) {
      nodes.push(node)
      if (node.shadowRoot) roots.push(node.shadowRoot)
    }
  }
  const images = nodes.filter((node): node is HTMLImageElement => node.tagName === 'IMG' && !hidden(node))
  const missing = images.filter(image => image.complete && !image.naturalWidth)
  let missingFonts = 0
  doc.fonts?.forEach(font => { if (font.status === 'error') missingFonts++ })
  const height = Math.max(doc.body.scrollHeight, doc.documentElement.scrollHeight)
  return {
    visibility: doc.visibilityState,
    fontsLoading: !!doc.fonts && doc.fonts.status === 'loading',
    pendingImages: images.filter(image => !image.complete).length,
    missingImages: missing.length,
    missingImageSources: missing.map(image => image.currentSrc || image.src),
    pendingImageSources: images.filter(image => !image.complete).map(image => image.currentSrc || image.src),
    missingFonts,
    pendingApp: nodes.some(node => node.getAttribute('aria-busy') === 'true' && !hidden(node)
      && !node.closest('nav, aside, header, footer, [role="navigation"]')),
    pendingMath: nodes.filter(node => node.matches('script[type^="math/tex"]')).some(script =>
      !script.previousElementSibling?.matches('.MathJax, .MathJax_Display, .MathJax_SVG, .MathJax_CHTML, mjx-container')),
    embeddedFrames: nodes.filter(node => {
      if (node.tagName !== 'IFRAME' || hidden(node) || node.closest('[aria-hidden="true"], [role="presentation"]')) return false
      const style = view.getComputedStyle(node)
      return parseFloat(style.width) !== 0 && parseFloat(style.height) !== 0
        && !(node.hasAttribute('width') && node.hasAttribute('height')
          && Number(node.getAttribute('width')) <= 1 && Number(node.getAttribute('height')) <= 1)
    }).length,
    clippedContent: nodes.some(node => {
      if (node === doc.documentElement || node === doc.scrollingElement || hidden(node)) return false
      return overflow(node, doc)
    }),
    // Structural stability tolerates clocks/carets while waiting for SPA layout,
    // images and math. Exact DOM identity is checked once scripts are suspended.
    signature: [doc.body.innerText?.length || doc.body.textContent?.length || 0, nodes.length,
      images.map(image => image.currentSrc || image.src).join('|'), height].join(':'),
    height,
  }
}

/** Bounded scrolling loads native and observer-based lazy resources without clicking controls. */
export function createWebSummaryPreparation(doc: Document, overflow = isWebReadingOverflow) {
  const view = doc.defaultView!
  const images: Array<{ image: HTMLImageElement; loading: string | null }> = []
  const knownImages = new Set<HTMLImageElement>()
  const positions: Array<{ node: HTMLElement; top: number; left: number }> = []
  const knownTargets = new Set<Element>()
  const resourceSources = new Set<string>()
  const resources: HTMLImageElement[] = []
  const refresh = () => {
    const roots: ParentNode[] = [doc]
    const nodes: Element[] = []
    for (let i = 0; i < roots.length; i++) {
      for (const node of Array.from(roots[i].querySelectorAll('*'))) { nodes.push(node); if (node.shadowRoot) roots.push(node.shadowRoot) }
    }
    for (const node of nodes) {
      if (node.tagName === 'IMG' && !knownImages.has(node as HTMLImageElement)) {
        const image = node as HTMLImageElement
        knownImages.add(image); images.push({ image, loading: image.getAttribute('loading') })
        image.setAttribute('loading', 'eager')
        // Many observer-based lazy loaders declare the original resource in
        // metadata. It remains the page author's URL, not an inferred substitute.
        if (!image.getAttribute('src') || (image.complete && image.naturalWidth <= 1)) {
          const original = image.getAttribute('data-src') || image.getAttribute('data-original') || image.getAttribute('data-lazy-src')
          if (original) image.src = original
        }
        if (!image.getAttribute('srcset') && image.getAttribute('data-srcset')) image.srcset = image.getAttribute('data-srcset')!
      }
      const style = view.getComputedStyle(node)
      if (style.display === 'none' || style.visibility === 'hidden') continue
      if ((node === doc.scrollingElement || (overflow(node, doc) && /auto|scroll/.test(style.overflowY))) && !knownTargets.has(node)) {
        knownTargets.add(node)
        positions.push({ node: node as HTMLElement, top: node.scrollTop, left: node.scrollLeft })
      }
      const addResource = (src: string) => {
        let url: string
        try { url = new URL(src, doc.baseURI).href } catch { url = src }
        if (resourceSources.has(url)) return
        if (resourceSources.size >= 256) throw new Error('网页外部图形资源过多，请选择较短的章节页面')
        resourceSources.add(url)
        const image = doc.createElement('img'); image.src = url; resources.push(image)
      }
      for (const match of style.backgroundImage.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/g)) addResource(match[1] || match[2] || match[3])
      if (node.namespaceURI === 'http://www.w3.org/2000/svg' && ['image', 'use'].includes(node.localName)) {
        const href = node.getAttribute('href') || node.getAttribute('xlink:href')
        if (href && !href.startsWith('#')) addResource(href)
      }
    }
  }
  refresh()
  const collectAnchors = () => Array.from((doc.querySelector('main, article, [role="main"]') || doc.body)
    .querySelectorAll('p, li, [role="row"]')).filter(node => !node.closest('nav, aside, header, footer')).slice(0, 20)
    .map(node => ({ node, text: node.textContent || '' }))
  let anchors = collectAnchors()
  return {
    get steps() { return Math.max(1, ...positions.map(({ node }) => Math.ceil(node.scrollHeight / Math.max(1, node.clientHeight)))) },
    resourceStatus() {
      refresh()
      return { pendingImages: resources.filter(image => !image.complete).length,
        pendingImageSources: resources.filter(image => !image.complete).map(image => image.src),
        missingImageSources: resources.filter(image => image.complete && !image.naturalWidth).map(image => image.src) }
    },
    step(ratio: number) {
      if (ratio === 0) anchors = collectAnchors()
      const virtualized = anchors.some(({ node, text }) => {
        if (!node.isConnected) return true
        const current = node.textContent || ''
        let prefix = 0, suffix = 0
        while (prefix < Math.min(text.length, current.length) && text[prefix] === current[prefix]) prefix++
        while (suffix < Math.min(text.length, current.length) - prefix
          && text[text.length - 1 - suffix] === current[current.length - 1 - suffix]) suffix++
        // A small live counter does not mean the surrounding article was recycled.
        return Math.max(text.length, current.length) - prefix - suffix >= Math.max(20, text.length / 2)
      })
      for (const { node } of positions) node.scrollTop = Math.round(Math.max(0, node.scrollHeight - node.clientHeight) * ratio)
      return { virtualized, height: Math.max(doc.body.scrollHeight, doc.documentElement.scrollHeight) }
    },
    restore() {
      for (const { node, top, left } of positions) { node.scrollTop = top; node.scrollLeft = left }
      for (const { image, loading } of images) {
        if (loading === null) image.removeAttribute('loading')
        else image.setAttribute('loading', loading)
      }
    },
  }
}

function printOptions(status: Record<string, any>) {
  // Keep unavailable source images explicit in the very PDF the model reads.
  // A broken source image must not prevent summarizing all other original content.
  const escape = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
  const names = (status.missingImageSources || []).map((src: string) => {
    try { return decodeURIComponent(new URL(src).pathname.split('/').pop() || 'image') } catch { return 'image' }
  }).join(', ')
  const warnings: string[] = []
  if (status.missingImages) warnings.push(`${status.missingImages} original image(s) unavailable${names ? ` (${names.slice(0, 800)})` : ''}`)
  if (status.missingFonts) warnings.push(`${status.missingFonts} font(s) unavailable; fallback glyphs may differ, do not transcribe unreadable equations`)
  const warning = warnings.length ? `Source limitation: ${warnings.join('; ')}. State this limitation; do not infer missing content.` : ''
  return {
    printBackground: true, preferCSSPageSize: false, pageSize: 'A4' as const,
    margins: { top: warning ? 0.65 : 0.25, bottom: 0.25, left: 0.25, right: 0.25 },
    ...(warning ? { displayHeaderFooter: true, footerTemplate: '<span></span>',
      headerTemplate: `<div style="font-size:9px;color:#555;padding:0 24px;width:100%;">${escape(warning)}</div>` } : {}),
  }
}

/** Runs inside the offline renderer; keep this function free of module closures. */
export function expandWebSummaryDocument(doc: Document, overflow = isWebReadingOverflow) {
  const view = doc.defaultView!
  const hidden = (node: Element) => {
    if (node.closest('.katex-mathml, mjx-assistive-mml')) return true
    for (let current: Element | null = node; current; current = current.parentElement) {
      const style = view.getComputedStyle(current)
      if (style.display === 'none' || style.visibility === 'hidden') return true
    }
    return false
  }
  const elements = Array.from(doc.querySelectorAll<HTMLElement>('*'))
  let expanded = 0
  // Overflow reading panes often sit inside a fixed flex layout. Grow both the
  // scroll pane and its ancestors so the PDF contains the complete saved chapter.
  for (const node of elements) {
    if (hidden(node) || node.clientHeight <= 0) continue
    const style = view.getComputedStyle(node)
    if (!overflow(node, doc)) continue
    for (let current: HTMLElement | null = node; current; current = current.parentElement) {
      for (const [property, value] of Object.entries({ height: 'auto', 'max-height': 'none',
        overflow: 'visible', 'overflow-y': 'visible', 'min-height': '0', flex: '0 0 auto' })) {
        current.style.setProperty(property, value, 'important')
      }
      const position = view.getComputedStyle(current).position
      if (position === 'fixed' || position === 'absolute') {
        current.style.setProperty('position', 'static', 'important')
        current.style.setProperty('inset', 'auto', 'important')
      }
    }
    expanded++
  }
  const unsupportedCanvases = Array.from(doc.querySelectorAll('canvas')).filter(canvas =>
    !hidden(canvas) && canvas.width > 0 && canvas.height > 0).length
  const missingSvgReferences = Array.from(doc.querySelectorAll('svg use')).filter(node => {
    if (hidden(node)) return false
    const href = node.getAttribute('href') || node.getAttribute('xlink:href') || ''
    return href.startsWith('#') && !doc.getElementById(href.slice(1))
  }).length
  return { expanded, unsupportedCanvases, missingSvgReferences }
}

// Restore the immutable archive in a separate offline renderer. Never borrow the
// interactive preview: route changes and navigation must not change this source.
export async function captureWebSummaryPdf(snapshot: PreviewSnapshot): Promise<string> {
  if (snapshot.visualPdf) {
    const pdf = Buffer.from(snapshot.visualPdf, 'base64')
    if (pdf.length < 5 || pdf.length > 64 * 1024 * 1024 || pdf.subarray(0, 5).toString() !== '%PDF-'
      || pdf.toString('base64') !== snapshot.visualPdf) throw new Error('已保存的网页视觉副本无效，请更新缓存')
    return snapshot.visualPdf
  }
  if (!snapshot.archiveMhtml) throw new Error('此网页没有原貌快照，请更新缓存后生成摘要')
  const archive = Buffer.from(snapshot.archiveMhtml, 'base64')
  if (!archive.length || archive.length > MAX_ARCHIVE_BYTES) throw new Error('网页原貌快照无效或超过 32 MB，请重新保存')
  const dir = mkdtempSync(join(tmpdir(), 'papermind-web-summary-'))
  let win: BrowserWindow | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const file = join(dir, 'source.mhtml')
    writeFileSync(file, archive, { mode: 0o600 })
    const fileUrl = pathToFileURL(file).toString()
    const isolated = session.fromPartition(`web-summary-${randomUUID()}`, { cache: false })
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    isolated.setPermissionCheckHandler(() => false)
    isolated.on('will-download', event => event.preventDefault())
    isolated.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !(details.url === fileUrl && details.resourceType === 'mainFrame')
        && !/^(data:|blob:|about:)/i.test(details.url) })
    })
    win = new BrowserWindow({
      show: false, width: 1280, height: 900,
      webPreferences: { session: isolated, javascript: false, nodeIntegration: false,
        contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: false },
    })
    const contents = win.webContents
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', event => event.preventDefault())
    contents.on('will-redirect', event => event.preventDefault())
    const render = async () => {
      await contents.loadURL(fileUrl)
      contents.debugger.attach('1.3')
      const inspection = `(() => {
        const appearance = (${expandWebSummaryDocument.toString()})(document, ${isWebReadingOverflow.toString()});
        for (const image of document.images) image.loading = 'eager';
        return {
          ...appearance,
          ...(${inspectWebSummaryDocument.toString()})(document, ${isWebReadingOverflow.toString()})
        };
      })()`
      // MHTML forbids asynchronous page callbacks even when trusted inspector
      // evaluation starts successfully. Poll synchronous state from the main process.
      let status: Record<string, any>
      while (true) {
        if (win!.isDestroyed()) throw new Error('网页快照视觉采集已结束')
        const evaluated = await contents.debugger.sendCommand('Runtime.evaluate', { returnByValue: true, expression: inspection })
        if (evaluated.exceptionDetails || !evaluated.result?.value) throw new Error('网页快照原貌检查失败，请更新缓存后重试')
        status = evaluated.result.value
        if (status.pendingMath || status.pendingApp) throw new Error('快照保存时正文或公式尚未就绪，请等待原网页完成加载后更新缓存')
        if (!status.fontsLoading && !status.pendingImages) break
        await new Promise(resolve => setTimeout(resolve, 150))
      }
      if (status.unsupportedCanvases) throw new Error('此网页包含未保存像素的 Canvas 图表，当前快照无法完整生成图文摘要；请使用原文 PDF')
      if (status.missingSvgReferences) throw new Error('网页快照中的 SVG 公式或图形引用缺失，请更新缓存或使用原文 PDF')
      if (status.clippedContent) throw new Error('网页快照仍有无法展开的滚动内容，请保存较短的章节页面或使用原文 PDF')
      if (status.embeddedFrames) throw new Error('网页包含嵌入框架，当前快照不能保证其完整内容；请单独打开正文框架后保存')
      if (status.pendingMath) throw new Error('网页快照中的公式尚未渲染完成，请等待原网页公式显示后更新缓存')
      if (!Number.isFinite(status.height) || status.height > 120_000) throw new Error('当前网页过长，无法完整生成视觉副本，请保存较短的章节页面')
      await contents.debugger.sendCommand('Emulation.setEmulatedMedia', { media: 'screen' })
      const pdf = await contents.printToPDF(printOptions(status))
      if (!pdf.length || pdf.length > 64 * 1024 * 1024) throw new Error('网页视觉副本为空或过大，请缩小页面范围后重试')
      return pdf.toString('base64')
    }
    return await Promise.race([render(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        if (win && !win.isDestroyed()) win.destroy()
        reject(new Error('网页快照视觉采集超时，请更新缓存后重试'))
      }, CAPTURE_TIMEOUT_MS)
    })])
  } finally {
    if (timer) clearTimeout(timer)
    if (win && !win.isDestroyed()) {
      if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach()
      win.destroy()
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Keep serialization, MHTML and PDF at one checkpoint, then always restore the live page. */
export interface WebSummaryDomCheckpoint { doctype: string; html: string; title: string; url: string }

export async function withWebSummaryCapture<T>(contents: WebContents,
  task: (capture: { assertActive: () => void; readDom: () => Promise<WebSummaryDomCheckpoint>; print: () => Promise<string> }) => Promise<T>,
  options: { visible?: boolean } = {}): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let attached = false, suspended = false, expired = false
  let preparation: string | undefined
  const deadline = Date.now() + CAPTURE_TIMEOUT_MS
  let resourceDeadline = Date.now() + 12_000
  const check = () => {
    if (expired || contents.isDestroyed() || Date.now() >= deadline) throw new Error('网页采集超时或已关闭，未保存不完整内容，请重试')
  }
  const evaluate = async (expression: string) => {
    check()
    const result = await contents.debugger.sendCommand('Runtime.evaluate', { expression, returnByValue: true })
    check()
    if (result.exceptionDetails || !result.result || result.result.value === undefined) throw new Error('网页采集检查失败')
    return result.result.value
  }
  const step = async (ratio: number) => {
    check()
    const result = await contents.debugger.sendCommand('Runtime.callFunctionOn', { objectId: preparation,
      functionDeclaration: 'function(ratio) { return this.step(ratio) }', arguments: [{ value: ratio }], returnByValue: true })
    check()
    if (result.exceptionDetails || !result.result?.value) throw new Error('网页资源准备失败')
    if (result.result.value.virtualized) throw new Error('网页使用动态替换内容的虚拟列表，无法保存完整正文；请打开独立文章或使用导出文件')
    return result.result.value
  }
  const settle = async () => {
    let signature = '', stableSince = Date.now()
    while (true) {
      const status = await evaluate(`(${inspectWebSummaryDocument.toString()})(document, ${isWebReadingOverflow.toString()})`)
      if (preparation) {
        const resourceResult = await contents.debugger.sendCommand('Runtime.callFunctionOn', { objectId: preparation,
          functionDeclaration: 'function() { return this.resourceStatus() }', returnByValue: true })
        check()
        const resources = resourceResult.result?.value
        if (resourceResult.exceptionDetails || !resources) throw new Error('网页图形资源检查失败')
        status.pendingImages = (status.pendingImages || 0) + (resources.pendingImages || 0)
        status.pendingImageSources = [...(status.pendingImageSources || []), ...(resources.pendingImageSources || [])]
        status.missingImageSources = [...new Set([...(status.missingImageSources || []), ...(resources.missingImageSources || [])])]
        status.missingImages = Math.max(status.missingImages || 0, status.missingImageSources.length)
      }
      if (Date.now() >= resourceDeadline && !status.pendingMath && !status.pendingApp) {
        status.resourceTimedOut = !!(status.pendingImages || status.fontsLoading)
        status.missingImageSources = [...new Set([...(status.missingImageSources || []), ...(status.pendingImageSources || [])])]
        status.missingImages = Math.max((status.missingImages || 0) + (status.pendingImages || 0), status.missingImageSources.length)
        if (status.fontsLoading) status.missingFonts = (status.missingFonts || 0) + 1
        status.pendingImages = 0; status.fontsLoading = false
      }

      if (!Number.isFinite(status.height) || status.height > 120_000) throw new Error('网页过长，无法完整保存，请选择较短的章节页面')
      if (status.signature !== signature) { signature = status.signature; stableSince = Date.now() }
      if (!status.fontsLoading && !status.pendingImages && !status.pendingMath && !status.pendingApp
        && (!status.signature || Date.now() - stableSince >= 450)) return status
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  try {
    check()
    if (contents.debugger.isAttached()) throw new Error('网页调试器正被使用，无法采集视觉副本，请稍后重试')
    contents.debugger.attach('1.3'); attached = true
    const run = async () => {
      const prepared = await contents.debugger.sendCommand('Runtime.evaluate', {
        expression: `(${createWebSummaryPreparation.toString()})(document, ${isWebReadingOverflow.toString()})`, returnByValue: false })
      check()
      preparation = prepared.result?.objectId
      if (prepared.exceptionDetails || !preparation) throw new Error('网页资源准备失败')
      const initialStatus = await settle()
      if (initialStatus.resourceTimedOut) contents.stop()
      if (preparation) {
        const info = await contents.debugger.sendCommand('Runtime.callFunctionOn', { objectId: preparation,
          functionDeclaration: 'function() { return this.steps }', returnByValue: true })
        check()
        const steps = info.result?.value
        if (!Number.isInteger(steps) || steps > 120) throw new Error('网页滚动范围过大，未省略正文；请选择独立章节页面')
        const owner = BrowserWindow.fromWebContents?.(contents)
        const hidden = options.visible === false || (owner && (!owner.isVisible() || owner.isMinimized())) || initialStatus.visibility === 'hidden'
        if (steps > 1 && hidden && !contents.isOffscreen()) {
          throw new Error('网页当前不可见，无法确认懒加载正文；请回到网页预览完成保存，之后摘要可在后台生成')
        }
        await step(0)
        for (let i = 1; i <= steps; i++) {
          await step(i / steps)
          await new Promise(resolve => setTimeout(resolve, 50))
        }
        // A bottom sentinel that repeatedly appends rows is an unbounded feed,
        // not a finite article. Do not report a partial viewport as a full page.
        let height = (await step(1)).height
        for (let i = 0; i < 3; i++) {
          await new Promise(resolve => setTimeout(resolve, 100))
          const next = (await step(1)).height
          if (next <= height + 2) break
          if (i === 2) throw new Error('网页持续追加内容，无法确定完整范围；请打开独立文章或章节')
          height = next
        }
      }
      // Lazy resources discovered during scrolling get their own bounded wait.
      resourceDeadline = Date.now() + 12_000
      const status = await settle()
      if (initialStatus.resourceTimedOut) {
        status.missingImageSources = [...new Set([...(initialStatus.missingImageSources || []), ...(status.missingImageSources || [])])]
        status.missingImages = Math.max(initialStatus.missingImages || 0, status.missingImages || 0, status.missingImageSources.length)
        status.missingFonts = Math.max(initialStatus.missingFonts || 0, status.missingFonts || 0)
      }
      if (status.resourceTimedOut) contents.stop()
      check()
      suspended = true
      await contents.debugger.sendCommand('Emulation.setScriptExecutionDisabled', { value: true })
      check()
      return task({
        assertActive: check,
        readDom: () => evaluate(`({doctype: document.doctype ? new XMLSerializer().serializeToString(document.doctype) : '', html: document.documentElement.outerHTML, title: document.title, url: location.href})`),
        print: async () => {
          check()
          if (status.embeddedFrames) throw new Error('网页包含嵌入框架，不能保证正文完整；请单独打开正文框架后保存')
          if (status.clippedContent) throw new Error('网页包含内部滚动正文，将使用原貌快照展开后生成摘要')
          await contents.debugger.sendCommand('Emulation.setEmulatedMedia', { media: 'screen' })
          const pdf = await contents.printToPDF(printOptions(status))
          check()
          if (!pdf.length || pdf.length > 64 * 1024 * 1024) throw new Error('网页视觉副本为空或超过 64 MB')
          return pdf.toString('base64')
        },
      })
    }
    return await Promise.race([run(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { expired = true; reject(new Error('网页采集超时，未保存不完整内容，请稍后重试')) }, CAPTURE_TIMEOUT_MS)
    })])
  } finally {
    expired = true
    if (timer) clearTimeout(timer)
    if (attached && !contents.isDestroyed()) {
      if (suspended) await contents.debugger.sendCommand('Emulation.setScriptExecutionDisabled', { value: false }).catch(() => {})
      if (preparation) await contents.debugger.sendCommand('Runtime.callFunctionOn', { objectId: preparation,
        functionDeclaration: 'function() { this.restore() }' }).catch(() => {})
      await contents.debugger.sendCommand('Emulation.setEmulatedMedia', { media: '' }).catch(() => {})
      if (preparation) await contents.debugger.sendCommand('Runtime.releaseObject', { objectId: preparation }).catch(() => {})
      try { contents.debugger.detach() } catch { /* The renderer may already have closed its debugger. */ }
    }
  }
}

export async function captureLoadedWebSummaryPdf(contents: WebContents): Promise<string> {
  return withWebSummaryCapture(contents, capture => capture.print())
}
