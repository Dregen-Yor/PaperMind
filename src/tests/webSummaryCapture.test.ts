import { beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { captureWebSummaryPdf } from '../../electron/webSummaryCapture'

const fake = vi.hoisted(() => ({ windows: [] as any[], handlers: [] as any[], failed: false, missing: false }))
vi.mock('electron', () => ({
  session: { fromPartition: () => ({
    setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), on: vi.fn(),
    webRequest: { onBeforeRequest: (handler: any) => fake.handlers.push(handler) },
  }) },
  BrowserWindow: class {
    destroyed = false
    path = ''
    constructor(public options: any) { fake.windows.push(this) }
    destroy() { this.destroyed = true }
    isDestroyed() { return this.destroyed }
    webContents = {
      setWindowOpenHandler: vi.fn(), on: vi.fn(),
      loadURL: async (url: string) => { this.path = fileURLToPath(url); expect(existsSync(this.path)).toBe(true) },
      executeJavaScript: vi.fn(async () => { throw new Error('MHTML scripts are disabled') }),
      debugger: { attach: vi.fn(), sendCommand: vi.fn(async (method: string, _params?: any) => method === 'Runtime.evaluate'
        ? { result: { value: { missingImages: fake.missing ? 1 : 0, pendingMath: false, height: 2000 } } } : {}), detach: vi.fn(), isAttached: () => true },
      printToPDF: vi.fn(async () => { if (fake.failed) throw new Error('print failed'); return Buffer.from('%PDF-1.7\nresult') }),
    }
  },
}))
function liveProtocol(method: string, params: any, status: () => any): any {
  if (method === 'Runtime.evaluate' && params.expression.includes('function createWebSummaryPreparation')) return { result: { objectId: 'preparation' } }
  if (method === 'Runtime.evaluate') return { result: { value: status() } }
  if (method === 'Runtime.callFunctionOn') {
    if (params.functionDeclaration.includes('this.steps')) return { result: { value: 1 } }
    if (params.functionDeclaration.includes('this.resourceStatus')) return { result: { value: { pendingImages: 0, missingImageSources: [] } } }
    return { result: { value: { virtualized: false, height: 2000 } } }
  }
  return {}
}
const snapshot = { finalUrl: 'https://example.org/', title: 'Test', html: '<p>Article</p>', capturedAt: 1, contentHash: 'hash', byteLength: 14,
  archiveMhtml: Buffer.from('MIME-Version: 1.0\r\nContent-Type: multipart/related\r\n').toString('base64') }
beforeEach(() => { fake.windows.length = 0; fake.handlers.length = 0; fake.failed = false; fake.missing = false })
describe('isolated saved webpage capture', () => {
  it('reuses a saved visual PDF without restoring an MHTML archive', async () => {
    const pdf = Buffer.from('%PDF-1.7\nvisual').toString('base64')
    expect(await captureWebSummaryPdf({ ...snapshot, archiveMhtml: undefined, visualPdf: pdf })).toBe(pdf)
    expect(fake.windows).toHaveLength(0)
  })
  it('prints loaded original resources without changing its DOM and resets media mode', async () => {
    const { captureLoadedWebSummaryPdf } = await import('../../electron/webSummaryCapture')
    const contents = { isDestroyed: () => false, debugger: { attach: vi.fn(), detach: vi.fn(), isAttached: () => false,
      sendCommand: vi.fn(async (method: string, params?: any) => liveProtocol(method, params, () => ({ height: 2000 }))) },
      printToPDF: vi.fn(async () => Buffer.from('%PDF-1.7\noriginal')) }
    await expect(captureLoadedWebSummaryPdf(contents as any)).resolves.toBe(Buffer.from('%PDF-1.7\noriginal').toString('base64'))
    const expression = contents.debugger.sendCommand.mock.calls.find(([method]) => method === 'Runtime.evaluate')![1] as any
    expect(expression.expression).not.toContain('expandWebSummaryDocument')
    expect(expression.expression).not.toContain('style.setProperty')
    expect(contents.debugger.sendCommand).toHaveBeenCalledWith('Emulation.setEmulatedMedia', { media: '' })
    expect(contents.debugger.detach).toHaveBeenCalled()
  })
  it('waits for math rendering instead of rejecting the first pending sample', async () => {
    const { captureLoadedWebSummaryPdf } = await import('../../electron/webSummaryCapture')
    let samples = 0
    const contents = { isDestroyed: () => false, debugger: { attach: vi.fn(), detach: vi.fn(), isAttached: () => false,
      sendCommand: vi.fn(async (method: string, params?: any) => liveProtocol(method, params, () => ({ pendingMath: ++samples === 1, height: 2000 }))) },
      printToPDF: vi.fn(async () => Buffer.from('%PDF-1.7\nmath')) }
    await expect(captureLoadedWebSummaryPdf(contents as any)).resolves.toBeTruthy()
    expect(samples).toBeGreaterThanOrEqual(2)
    expect(contents.printToPDF).toHaveBeenCalled()
  })
  it('restores script execution and detaches the inspector even when printing fails', async () => {
    const { captureLoadedWebSummaryPdf } = await import('../../electron/webSummaryCapture')
    const contents = { isDestroyed: () => false, debugger: { attach: vi.fn(), detach: vi.fn(), isAttached: () => false,
      sendCommand: vi.fn(async (method: string, params?: any) => liveProtocol(method, params, () => ({ height: 2000 }))) },
      printToPDF: vi.fn(async () => { throw new Error('printer failed') }) }
    await expect(captureLoadedWebSummaryPdf(contents as any)).rejects.toThrow('printer failed')
    expect(contents.debugger.sendCommand).toHaveBeenCalledWith('Emulation.setScriptExecutionDisabled', { value: true })
    expect(contents.debugger.sendCommand).toHaveBeenCalledWith('Emulation.setScriptExecutionDisabled', { value: false })
    expect(contents.debugger.sendCommand).toHaveBeenCalledWith('Runtime.releaseObject', { objectId: 'preparation' })
    expect(contents.debugger.detach).toHaveBeenCalled()
  })
  it('rejects legacy snapshots rather than summarizing text without the original appearance', async () => {
    await expect(captureWebSummaryPdf({ ...snapshot, archiveMhtml: undefined })).rejects.toThrow('更新缓存')
    expect(fake.windows).toHaveLength(0)
  })
  it('renders a private offline snapshot and removes its resources after printing', async () => {
    const result = await captureWebSummaryPdf(snapshot)
    expect(Buffer.from(result, 'base64').toString()).toContain('%PDF')
    const win = fake.windows[0]
    expect(win.options.show).toBe(false)
    expect(win.options.webPreferences).toMatchObject({ sandbox: true, nodeIntegration: false, javascript: false })
    expect(win.destroyed).toBe(true)
    expect(existsSync(win.path)).toBe(false)
    expect(win.webContents.debugger.sendCommand).toHaveBeenCalledWith('Emulation.setEmulatedMedia', { media: 'screen' })
    expect(win.webContents.debugger.sendCommand).toHaveBeenCalledWith('Runtime.evaluate', expect.objectContaining({ returnByValue: true, expression: expect.stringContaining('missingImages') }))
    expect(win.webContents.executeJavaScript).not.toHaveBeenCalled()
    const callback = vi.fn()
    fake.handlers[0]({ url: 'https://example.org/image.png', resourceType: 'image' }, callback)
    expect(callback).toHaveBeenCalledWith({ cancel: true })
  })
  it('cleans up when printing fails', async () => {
    fake.failed = true
    await expect(captureWebSummaryPdf(snapshot)).rejects.toThrow('print failed')
    expect(fake.windows[0].destroyed).toBe(true)
    expect(existsSync(fake.windows[0].path)).toBe(false)
  })
  it('preserves readable pages with an explicit source warning when an original image is unavailable', async () => {
    fake.missing = true
    await expect(captureWebSummaryPdf(snapshot)).resolves.toBeTruthy()
    expect(fake.windows[0].webContents.printToPDF).toHaveBeenCalledWith(expect.objectContaining({
      displayHeaderFooter: true,
      headerTemplate: expect.stringContaining('1 original image(s) unavailable'),
    }))
    expect(fake.windows[0].destroyed).toBe(true)
  })
})

describe('saved page completeness', () => {
  it('allows the root scrollbar that Chromium paginates as a full webpage', async () => {
    const { inspectWebSummaryDocument } = await import('../../electron/webSummaryCapture')
    document.documentElement.style.overflowY = 'scroll'
    Object.defineProperty(document.documentElement, 'clientHeight', { value: 600, configurable: true })
    Object.defineProperty(document.documentElement, 'scrollHeight', { value: 20000, configurable: true })
    try { expect(inspectWebSummaryDocument(document).clippedContent).toBe(false) }
    finally { document.documentElement.style.overflowY = ''; delete (document.documentElement as any).clientHeight; delete (document.documentElement as any).scrollHeight }
  })
  it('recognizes rendered MathJax SVG and excludes hidden decorative images', async () => {
    const { inspectWebSummaryDocument } = await import('../../electron/webSummaryCapture')
    document.body.innerHTML = '<div hidden><img src="tracker.png"></div><span class="MathJax_SVG"></span><script type="math/tex">x</script>'
    expect(inspectWebSummaryDocument(document)).toMatchObject({ missingImages: 0, pendingImages: 0, pendingMath: false })
  })
  it('expands nested fixed-height reading panes before pagination', async () => {
    const { expandWebSummaryDocument } = await import('../../electron/webSummaryCapture')
    document.body.innerHTML = '<main style="height:200px;overflow-y:auto;position:fixed"><article>First and last paragraphs</article></main>'
    const pane = document.querySelector('main')!
    Object.defineProperty(pane, 'scrollHeight', { value: 5000 })
    Object.defineProperty(pane, 'clientHeight', { value: 200 })
    const result = expandWebSummaryDocument(document)
    expect(result.expanded).toBeGreaterThan(0)
    expect(pane.style.height).toBe('auto')
    expect(pane.style.overflow).toBe('visible')
    expect(pane.style.position).toBe('static')
    expect(pane.style.flex).toBe('0 0 auto')
  })
  it('keeps KaTeX accessibility MathML hidden while expanding reading panes', async () => {
    const { expandWebSummaryDocument } = await import('../../electron/webSummaryCapture')
    document.body.innerHTML = '<span class="katex-mathml" style="position:absolute;height:1px;width:1px;overflow-y:hidden"><span>equation</span></span>'
    const math = document.querySelector<HTMLElement>('.katex-mathml')!
    Object.defineProperty(math, 'scrollHeight', { value: 40 })
    Object.defineProperty(math, 'clientHeight', { value: 1 })
    expect(expandWebSummaryDocument(document).expanded).toBe(0)
    expect(math.style.position).toBe('absolute')
  })
  it('reports canvas pixels and unresolved SVG glyphs absent from MHTML serialization', async () => {
    const { expandWebSummaryDocument } = await import('../../electron/webSummaryCapture')
    document.body.innerHTML = '<canvas width="100" height="100"></canvas><svg><use href="#lost-glyph" /></svg>'
    expect(expandWebSummaryDocument(document)).toMatchObject({ unsupportedCanvases: 1, missingSvgReferences: 1 })
  })
})

describe('generic webpage capture preparation', () => {
  it('promotes native lazy images and restores their original attributes and scroll positions', async () => {
    const { createWebSummaryPreparation } = await import('../../electron/webSummaryCapture')
    document.body.innerHTML = '<article><img loading="lazy" src="figure.png"><p>Original article evidence</p></article>'
    const image = document.querySelector('img')!
    const preparation = createWebSummaryPreparation(document)
    expect(image.getAttribute('loading')).toBe('eager')
    preparation.restore()
    expect(image.getAttribute('loading')).toBe('lazy')
  })
  it('detects removed original rows instead of pretending a virtualized view is complete', async () => {
    const { createWebSummaryPreparation } = await import('../../electron/webSummaryCapture')
    document.body.innerHTML = '<article><p>FIRST ORIGINAL ROW</p><p>Second row</p></article>'
    const preparation = createWebSummaryPreparation(document)
    document.querySelector('p')!.remove()
    expect(preparation.step(1).virtualized).toBe(true)
    preparation.restore()
  })
  it('ignores clipped navigation and icons while preserving the main reading pane', async () => {
    const { inspectWebSummaryDocument } = await import('../../electron/webSummaryCapture')
    document.body.innerHTML = '<nav style="overflow-y:auto">Navigation</nav><main><span style="overflow:hidden">Icon</span><article style="overflow-y:auto">Original article</article></main>'
    for (const node of Array.from(document.querySelectorAll('nav, span, article'))) {
      Object.defineProperty(node, 'clientHeight', { value: node.tagName === 'SPAN' ? 20 : 200 })
      Object.defineProperty(node, 'scrollHeight', { value: 3000 })
    }
    expect(inspectWebSummaryDocument(document).clippedContent).toBe(true)
    document.querySelector('article')!.remove()
    expect(inspectWebSummaryDocument(document).clippedContent).toBe(false)
  })
  it('does not mistake a small live counter or changing navigation for virtualized article rows', async () => {
    const { createWebSummaryPreparation } = await import('../../electron/webSummaryCapture')
    document.body.innerHTML = '<nav><li>Navigation</li></nav><article><p>Original article evidence with a live count: 1.</p></article>'
    const preparation = createWebSummaryPreparation(document)
    document.querySelector('li')!.remove()
    document.querySelector('p')!.textContent = 'Original article evidence with a live count: 2.'
    expect(preparation.step(1).virtualized).toBe(false)
    preparation.restore()
  })
  it('classifies embedded frame content explicitly instead of silently truncating it', async () => {
    const { inspectWebSummaryDocument } = await import('../../electron/webSummaryCapture')
    document.body.innerHTML = '<article>Parent article<iframe title="Embedded article"></iframe></article>'
    expect(inspectWebSummaryDocument(document).embeddedFrames).toBe(1)
  })
})
