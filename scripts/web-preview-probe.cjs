// Isolated benchmark process. Never opens the application database or profile.
const { app, BrowserWindow, session } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const { createHash } = require('node:crypto')
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const { PreviewController } = require(config.controller)
app.setPath('userData', config.profile)
if (!config.gpu) {
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-software-rasterizer')
}
if (config.http1) app.commandLine.appendSwitch('disable-http2')

const result = {
  config, startedAt: new Date().toISOString(), events: [], failures: [],
  responses: [], completed: false, measurementVersion: 2,
  runtime: { electron: process.versions.electron, chromium: process.versions.chrome, platform: process.platform, arch: process.arch },
}
let page
let active = false
let start = 0
const elapsed = () => Math.round(performance.now() - start)
const save = () => writeFileSync(config.output, JSON.stringify(result, null, 2))
app.on('web-contents-created', (_event, contents) => {
  if (!active) return
  page = contents
  for (const event of ['did-start-loading', 'did-navigate', 'dom-ready', 'did-finish-load', 'did-stop-loading']) {
    contents.on(event, () => {
      result.events.push({ event, ms: elapsed() })
      if (event === 'did-finish-load') {
        result.loadMs = elapsed()
        void contents.debugger.sendCommand('Runtime.evaluate', {
          expression: 'document.fonts.ready.then(() => true)', awaitPromise: true, returnByValue: true,
        }).then(() => { result.fontsReadyMs = elapsed(); save() }).catch(() => {})
      }
      save()
      console.log(`${config.label} ${event} ${elapsed()}ms`)
    })
  }
  contents.debugger.attach('1.3')
  void contents.debugger.sendCommand('Network.enable')
  contents.debugger.on('message', (_event, method, data) => {
    if (method === 'Network.responseReceived') {
      const r = data.response
      result.responses.push({
        url: r.url, status: r.status, protocol: r.protocol,
        fromDiskCache: r.fromDiskCache, timing: r.timing, ms: elapsed(),
      })
    }
    if (method === 'Network.loadingFailed') {
      result.failures.push({ type: data.type, error: data.errorText, cancelled: !!data.canceled, ms: elapsed() })
    }
  })
})

const inspect = async () => {
  const response = await page.debugger.sendCommand('Runtime.evaluate', {
    expression: `({
      navigation: performance.getEntriesByType('navigation').map(x => x.toJSON()),
      paint: performance.getEntriesByType('paint').map(x => x.toJSON()),
      resources: performance.getEntriesByType('resource').map(x => x.toJSON()),
      readyState: document.readyState,
      text: document.body?.innerText || '',
      mathCount: document.querySelectorAll('.katex').length,
      images: Array.from(document.images).map(x => ({
        src: x.currentSrc || x.src, complete: x.complete,
        width: x.naturalWidth, height: x.naturalHeight
      })),
      fontsStatus: document.fonts.status,
      fonts: Array.from(document.fonts).map(x => ({family:x.family,status:x.status}))
    })`,
    returnByValue: true,
  })
  if (response.exceptionDetails) throw new Error('Page inspection failed')
  return response.result.value
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1200, height: 800, show: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  })
  await win.loadURL('data:text/html,<title>PaperMind performance measurement</title>')
  const controller = new PreviewController(win)
  const previewSession = session.fromPartition(config.partition)
  if (config.imageConcurrency > 0) {
    const activeImages = new Set()
    const waiting = []
    const release = details => {
      if (!activeImages.delete(details.id)) return
      const next = waiting.shift()
      if (next) {
        activeImages.add(next.id)
        next.callback({ cancel: false })
      }
    }
    previewSession.webRequest.onBeforeRequest((details, callback) => {
      if (details.resourceType !== 'image' || activeImages.has(details.id)) return callback({ cancel: false })
      if (activeImages.size < config.imageConcurrency) {
        activeImages.add(details.id)
        callback({ cancel: false })
      } else waiting.push({ id: details.id, callback })
    })
    previewSession.webRequest.onCompleted(release)
    previewSession.webRequest.onErrorOccurred(release)
  }
  let proxy = await previewSession.resolveProxy(config.url)
  const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy
  if (envProxy) {
    const parsed = new URL(envProxy)
    result.systemProxyMatchesEnvironment = proxy.includes(parsed.host)
    if (config.envProxy) {
      if (parsed.username || parsed.password) throw new Error('Authenticated proxy is not supported by this benchmark')
      await previewSession.setProxy({ proxyRules: `${parsed.protocol}//${parsed.host}` })
      proxy = await previewSession.resolveProxy(config.url)
    }
  }
  if (config.direct) {
    await previewSession.setProxy({ mode: 'direct' })
    proxy = await previewSession.resolveProxy(config.url)
  }
  result.proxyMode = proxy.replace(/(PROXY|HTTPS|SOCKS5?|QUIC)\s+[^;]+/g, '$1 [endpoint]')
  active = true
  start = performance.now()
  const checkpoint = setInterval(save, 5000)
  if (config.preconnect) previewSession.preconnect({ url: config.url, numSockets: 2 })
  const watchdog = setTimeout(() => {
    result.error = 'Benchmark process deadline'
    save()
    app.exit(2)
  }, config.timeoutMs + 10000)
  let timer
  try {
    const snapshot = await Promise.race([
      controller.openAndCapture(config.url, { x: 0, y: 0, width: 1100, height: 740 }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Benchmark navigation deadline')), config.timeoutMs) }),
    ])
    result.captureMs = elapsed()
    result.snapshot = {
      htmlBytes: snapshot.byteLength, archiveBytes: snapshot.archiveMhtml
        ? Buffer.byteLength(snapshot.archiveMhtml, 'base64') : 0,
    }
    // load does not necessarily cover fonts requested during formula rendering.
    await Promise.race([
      page.debugger.sendCommand('Runtime.evaluate', {
        expression: 'document.fonts.ready.then(() => true)', awaitPromise: true, returnByValue: true,
      }),
      new Promise((_, reject) => {
        clearTimeout(timer)
        timer = setTimeout(() => reject(new Error('Benchmark font deadline')), Math.max(1, config.timeoutMs - elapsed()))
      }),
    ])
    result.fullMs = result.fontsReadyMs ?? elapsed()
  } catch (error) {
    result.error = String(error)
  } finally {
    clearTimeout(timer)
  }
  try {
    result.page = await inspect()
    result.textHash = createHash('sha256').update(result.page.text).digest('hex')
    result.textLength = result.page.text.length
    delete result.page.text
    const imagesOk = result.page.images.every(image => image.complete && image.width > 0)
    const fontsOk = result.page.fontsStatus === 'loaded' && result.page.fonts.every(font => font.status !== 'error')
    result.archiveSaved = (result.snapshot?.archiveBytes ?? 0) > 0
    result.completed = !result.error && result.page.readyState === 'complete' && imagesOk && fontsOk
      && !result.failures.some(failure => failure.type !== 'Other' && !failure.cancelled)
      && !result.responses.some(response => response.status >= 400 && !response.url.endsWith('/favicon.ico'))
    result.fcpMs = result.page.paint.find(paint => paint.name === 'first-contentful-paint')?.startTime
    if (!result.completed && !result.error) result.error = 'Incomplete images, fonts, or other page resources'
  } catch (error) { result.inspectError = String(error) }
  save()
  await previewSession.flushStorageData()
  controller.close()
  win.destroy()
  clearTimeout(watchdog)
  clearInterval(checkpoint)
  console.log(JSON.stringify({
    label: config.label, completed: result.completed, fcpMs: result.fcpMs,
    fullMs: result.fullMs, captureMs: result.captureMs, error: result.error,
    images: result.page?.images.length, textHash: result.textHash,
  }))
  app.quit()
}).catch(error => {
  result.error = String(error)
  save()
  console.error(error)
  app.exit(1)
})
