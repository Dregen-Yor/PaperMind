// Run with node_modules/.bin/electron scripts/web-summary-capture-smoke.cjs.
// Requires pdftotext (Poppler). No network or model credentials are used.
const { app, BrowserWindow, session } = require('electron')
const { buildSync } = require('esbuild')
const { mkdtempSync, writeFileSync, readFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const assert = require('node:assert/strict')
const root = mkdtempSync(join(tmpdir(), 'papermind-capture-matrix-'))
const repo = resolve(__dirname, '..')
app.setPath('userData', join(root, 'profile'))
app.commandLine.appendSwitch('disable-gpu')
app.on('window-all-closed', () => {})
for (const name of ['webSummaryCapture', 'webPreview']) {
  buildSync({ entryPoints: [join(repo, 'electron', name + '.ts')], outfile: join(root, name + '.cjs'),
    bundle: true, minify: true, platform: 'node', format: 'cjs', external: ['electron'] })
}
const svg = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="120"><rect width="300" height="120" fill="lightblue"/><text x="20" y="60">Original diagram</text></svg>')
const paragraphs = Array.from({ length: 70 }, (_, i) => `<p>Original evidence paragraph ${i}: the full article must be preserved.</p>`).join('')
const cases = [
  { name: 'static-root-scroll', body: `<article><h1>START_STATIC</h1>${paragraphs}<p>END_STATIC</p></article>`, marker: 'END_STATIC' },
  { name: 'spa-delayed-busy', body: '<main aria-busy="true">Loading…</main><script>setTimeout(()=>{document.querySelector("main").innerHTML="<h1>START_SPA</h1><p>END_SPA: original content arrived after page load.</p>";document.querySelector("main").removeAttribute("aria-busy")},1300)</script>', marker: 'END_SPA' },
  { name: 'native-lazy-images', body: `<article><h1>Lazy article</h1><div style="height:3500px"></div><img loading="lazy" src="${svg}"><p>END_NATIVE_LAZY</p></article>`, marker: 'END_NATIVE_LAZY', image: true },
  { name: 'observer-lazy-images', body: `<article><h1>Observer article</h1><div style="height:3500px"></div><img id="figure" width="300" height="120" data-src="${svg}"><p>END_OBSERVER_LAZY</p></article><script>const observer=new IntersectionObserver(entries=>{for(const e of entries)if(e.isIntersecting)e.target.src=e.target.dataset.src});observer.observe(document.querySelector("img"))</script>`, marker: 'END_OBSERVER_LAZY', image: true },
  { name: 'nested-scroll-archive', body: `<main style="height:300px;overflow-y:auto"><article><h1>START_NESTED</h1>${paragraphs}<p>END_NESTED</p></article></main>`, marker: 'END_NESTED' },
  { name: 'clock-checkpoint', body: `<article><h1>Clock article</h1><span id="clock">0</span>${paragraphs}<p>END_CLOCK</p></article><script>let ticks=0;setInterval(()=>document.querySelector("#clock").textContent=String(++ticks),10)</script>`, marker: 'END_CLOCK', clock: true },
  { name: 'delayed-math', body: '<article><h1>Equation article</h1><script type="math/tex" id="math">E=mc^2</script><p>END_MATH</p></article><script>setTimeout(()=>document.querySelector("#math").insertAdjacentHTML("beforebegin",\'<span class="MathJax_SVG">E = mc²</span>\'),700)</script>', marker: 'END_MATH' },
  { name: 'canvas-live', body: '<article><h1>Original Canvas</h1><canvas width="300" height="120"></canvas><p>END_CANVAS</p></article><script>const c=document.querySelector("canvas").getContext("2d");c.fillStyle="orange";c.fillRect(10,10,250,80);c.fillStyle="black";c.fillText("Original plot",20,50)</script>', marker: 'END_CANVAS' },
  { name: 'open-shadow-dom', body: `<article><h1>Shadow article</h1><div id="host"></div></article><script>document.querySelector("#host").attachShadow({mode:"open"}).innerHTML=${JSON.stringify(`<p>END_SHADOW: original shadow content.</p><img loading="lazy" src="${svg}">`)}</script>`, marker: 'END_SHADOW' },
  { name: 'missing-image-and-font', body: '<style>@font-face{font-family:Missing;src:url(missing.woff)}article{font-family:Missing,sans-serif}</style><article><h1>Resource limitation</h1><img src="missing.png"><p>END_MISSING: all other original text remains available.</p></article>', marker: 'END_MISSING', warning: true },
  { name: 'embedded-frame-boundary', body: '<article><h1>Parent content</h1><iframe title="Article frame" srcdoc="<p>Embedded body</p>"></iframe></article>', error: /嵌入框架/ },
  { name: 'hidden-scroll-readiness-boundary', body: `<article>${paragraphs}</article>`, hidden: true, error: /当前不可见/ },
  { name: 'virtualized-content-boundary', body: `<article>${paragraphs}</article><script>addEventListener("scroll",()=>{document.querySelector("article p").remove()},{once:true})</script>`, error: /虚拟列表/ },
  { name: 'infinite-feed-boundary', body: `<article>${paragraphs}</article><script>addEventListener("scroll",()=>{if(scrollY+innerHeight>=document.documentElement.scrollHeight-5)document.querySelector("article").insertAdjacentHTML("beforeend",'<p style="height:1200px">Additional feed content</p>')})</script>`, error: /持续追加|滚动范围|虚拟列表/ },
]
const timeout = setTimeout(() => { console.error('MATRIX_TIMEOUT', root); app.exit(2) }, 180000)
app.whenReady().then(async () => {
  let win
  try {
    const { withWebSummaryCapture, captureWebSummaryPdf } = require(join(root, 'webSummaryCapture.cjs'))
    const results = []
    for (const fixture of cases) {
      const started = Date.now()
      const file = join(root, fixture.name + '.html')
      writeFileSync(file, `<!doctype html><html><head><style>body{font:18px sans-serif;margin:20px}</style></head><body>${fixture.body}</body></html>`)
      win = new BrowserWindow({ show: false, width: 1000, height: 700,
        webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false, offscreen: !fixture.hidden } })
      await win.loadFile(file)
      let pdf, failure
      try {
        let snapshot
        await withWebSummaryCapture(win.webContents, async capture => {
          const before = await capture.readDom()
          try { pdf = await capture.print() } catch (error) {
            if (!String(error.message).includes('内部滚动正文')) throw error
            const archive = join(root, fixture.name + '.mhtml')
            await win.webContents.savePage(archive, 'MHTML')
            snapshot = { title: fixture.name, finalUrl: 'https://fixture.invalid/' + fixture.name,
              html: before.html, capturedAt: 1, contentHash: createHash('sha256').update(before.html).digest('hex'),
              byteLength: Buffer.byteLength(before.html), archiveMhtml: readFileSync(archive).toString('base64') }
          }
          const after = await capture.readDom()
          assert.equal(after.html, before.html, 'DOM changed between source serialization and printing')
        })
        if (snapshot) pdf = await captureWebSummaryPdf(snapshot)
      } catch (error) { failure = error }
      if (fixture.error) {
        assert.ok(failure, 'Unsupported content was silently accepted: ' + fixture.name)
        assert.match(failure.message, fixture.error)
      } else {
        if (failure) throw failure
        const output = join(root, fixture.name + '.pdf')
        writeFileSync(output, Buffer.from(pdf, 'base64'))
        const text = execFileSync('pdftotext', [output, '-'], { encoding: 'utf8' })
        assert.ok(text.includes(fixture.marker), 'Lost end-of-document or rendered content: ' + fixture.name)
        if (fixture.warning) assert.ok(text.includes('Source limitation:'))
        if (fixture.image) assert.equal(await win.webContents.executeJavaScript('document.querySelector("img").naturalWidth > 0'), true)
        if (fixture.clock) {
          const before = await win.webContents.executeJavaScript('document.querySelector("#clock").textContent')
          await new Promise(resolve => setTimeout(resolve, 60))
          assert.notEqual(await win.webContents.executeJavaScript('document.querySelector("#clock").textContent'), before, 'Page scripts were not restored')
        }
      }
      assert.equal(win.webContents.debugger.isAttached(), false)
      win.destroy(); win = undefined
      const result = { fixture: fixture.name, outcome: fixture.error ? 'explicit-boundary' : 'complete', elapsedMs: Date.now() - started }
      results.push(result); console.log(JSON.stringify(result))
    }
    // Exercise the actual controller as well as the capture core. HTTPS is handled
    // by a private local protocol interceptor; no public website is contacted.
    const source = '<!doctype html><article><h1>CONTROLLER_START</h1><span id="clock">0</span><p>CONTROLLER_END</p></article><script>let n=0;setInterval(()=>document.querySelector("#clock").textContent=String(++n),10)</script>'
    const previewSession = session.fromPartition('persist:papermind-preview')
    await previewSession.protocol.handle('https', request => {
      if (request.url.endsWith('/slow.png')) return new Promise(() => {})
      const html = request.url.endsWith('/stalled-asset') ? source + '<img src="https://fixture.invalid/slow.png">' : source
      return new Response(html, { headers: { 'Content-Type': 'text/html' } })
    })
    win = new BrowserWindow({ show: false })
    const controller = require(join(root, 'webPreview.cjs')).registerPreviewWindow(win)
    const snapshot = await controller.openAndCapture('https://fixture.invalid/article', { x: 0, y: 0, width: 900, height: 650 })
    assert.ok(snapshot.visualPdf && snapshot.archiveMhtml)
    assert.ok(snapshot.html.includes('CONTROLLER_END'))
    controller.close(); win.destroy(); win = undefined
    results.push({ fixture: 'controller-continuous-mutation', outcome: 'complete' })
    win = new BrowserWindow({ show: false })
    const slowController = require(join(root, 'webPreview.cjs')).registerPreviewWindow(win)
    const startSlow = Date.now()
    const partial = await slowController.openAndCapture('https://fixture.invalid/stalled-asset', { x: 0, y: 0, width: 900, height: 650 })
    assert.ok(partial.visualPdf, 'A stalled secondary resource prevented summary visual capture')
    const partialFile = join(root, 'stalled-asset.pdf')
    writeFileSync(partialFile, Buffer.from(partial.visualPdf, 'base64'))
    assert.ok(execFileSync('pdftotext', [partialFile, '-'], { encoding: 'utf8' }).includes('Source limitation:'))
    assert.ok(Date.now() - startSlow < 20000, 'Secondary-resource policy did not bound the wait')
    slowController.close(); win.destroy(); win = undefined
    results.push({ fixture: 'controller-stalled-resource', outcome: 'explicit-partial', elapsedMs: Date.now() - startSlow })

    writeFileSync(join(root, 'results.json'), JSON.stringify(results, null, 2))
    console.log('MATRIX_PASSED', results.length, root)
    clearTimeout(timeout); app.exit(0)
  } catch (error) {
    console.error('MATRIX_FAILED', error.stack, root)
    win?.destroy(); clearTimeout(timeout); app.exit(1)
  }
})
