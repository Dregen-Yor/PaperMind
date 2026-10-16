import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'

const chrome = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const profile = mkdtempSync(join(tmpdir(), 'papermind-pdf-perf-'))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitForPort() {
  const file = join(profile, 'DevToolsActivePort')
  for (let attempt = 0; attempt < 100; attempt++) {
    if (existsSync(file)) return Number(readFileSync(file, 'utf8').split('\n')[0])
    await sleep(100)
  }
  throw new Error('Chrome DevTools port did not open')
}

async function connect(url) {
  const socket = new WebSocket(url)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  let id = 0
  const pending = new Map()
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (process.env.PDF_BENCH_VERBOSE && message.method === 'Runtime.consoleAPICalled') {
      process.stderr.write(`${message.params.args.map(arg => arg.value ?? arg.description).join(' ')}\n`)
    }
    if (process.env.PDF_BENCH_VERBOSE && message.method === 'Runtime.exceptionThrown') {
      process.stderr.write(`page exception: ${message.params.exceptionDetails.text}\n`)
    }
    if (!message.id) return
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    if (message.error) waiter.reject(new Error(message.error.message))
    else waiter.resolve(message.result)
  })
  socket.addEventListener('close', () => {
    for (const waiter of pending.values()) waiter.reject(new Error('Chrome DevTools connection closed'))
    pending.clear()
  })
  return {
    send(method, params = {}) {
      const callId = ++id
      return new Promise((resolve, reject) => {
        pending.set(callId, { resolve, reject })
        socket.send(JSON.stringify({ id: callId, method, params }))
      })
    },
    close: () => socket.close(),
  }
}

let browser
let connection
try {
  browser = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=720,820', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  let errors = ''
  browser.stderr.on('data', data => { errors += data })
  browser.on('exit', code => { if (process.env.PDF_BENCH_VERBOSE) process.stderr.write(`Chrome exited ${code}\n`) })
  const port = await waitForPort()
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const page = targets.find(target => target.type === 'page')
  if (!page) throw new Error(`No Chrome page: ${errors}`)
  connection = await connect(page.webSocketDebuggerUrl)
  await connection.send('Runtime.enable')
  await connection.send('Page.navigate', { url: process.argv[2] })
  let loaded = false
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const state = await connection.send('Runtime.evaluate', { expression: 'location.pathname.endsWith("/harness.html") && document.readyState === "complete"', returnByValue: true })
      if (state.result.value) { loaded = true; break }
    } catch { /* navigation replaces the execution context */ }
    await sleep(100)
  }
  if (!loaded) throw new Error(`Benchmark page did not load: ${errors}`)
  let timeout
  const evaluated = await Promise.race([
    connection.send('Runtime.evaluate', { expression: 'window.__pdfBenchResult', awaitPromise: true, returnByValue: true }),
    new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('Benchmark timed out')), 90000) }),
  ]).finally(() => clearTimeout(timeout))
  const result = evaluated.result.value
  if (!result) throw new Error(`No benchmark result: ${JSON.stringify(evaluated)}`)
  process.stdout.write(`${JSON.stringify(result)}\n`)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
} finally {
  connection?.close()
  if (browser && browser.exitCode === null) {
    browser.kill()
    await once(browser, 'exit')
  }
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
