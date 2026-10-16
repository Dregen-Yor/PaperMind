import { spawn, type ChildProcess } from 'node:child_process'
import { connect } from 'node:net'

const LOCAL_PORT = 5001
const SSH_HOST = 'xmdjy@101.76.222.151'
const STARTUP_TIMEOUT_MS = 15_000

let tunnel: ChildProcess | null = null
let starting: Promise<void> | null = null

function isListening(): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port: LOCAL_PORT })
    socket.setTimeout(1_000)
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => { socket.destroy(); resolve(false) })
    socket.once('timeout', () => { socket.destroy(); resolve(false) })
  })
}

async function startTunnel(): Promise<void> {
  if (await isListening()) return
  const child = spawn('ssh', [
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-N', '-L', `127.0.0.1:${LOCAL_PORT}:127.0.0.1:5001`, SSH_HOST,
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  tunnel = child
  let ended = false
  let details = ''
  child.once('error', error => { ended = true; details = error.message })
  child.once('exit', code => { ended = true; if (code !== null) details ||= `SSH 退出码 ${code}` })
  child.stderr?.on('data', chunk => { details = (details + String(chunk)).slice(-2_000) })

  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (ended) break
    if (await isListening()) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  child.kill()
  if (tunnel === child) tunnel = null
  throw new Error(`无法建立 Docling SSH 连接（${SSH_HOST}）：${details.trim() || '连接超时或本地 5001 端口不可用'}。请检查 SSH 登录和服务器状态`)
}

export function ensureManagedDoclingTunnel(_baseUrl: string): Promise<void> {
  if (!starting) starting = startTunnel().finally(() => { starting = null })
  return starting
}

export function stopManagedDoclingTunnel(): void {
  tunnel?.kill()
  tunnel = null
}
