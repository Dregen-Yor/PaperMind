/**
 * 侧车协议：一行 JSON 请求 / 一行 JSON 响应，按 `id` 配对。
 *
 * 只依赖 Node 内置模块——这是刻意的：协议层能脱离 Python 与 MLX 被完整单测，
 * 真实推理只在 `sidecar.py` 与实验里出现。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { assertJudgeOutput, type EvidenceJudge, type JudgeInput } from '../../../src/utils/evidenceJudge'

export interface SidecarHandle {
  command: string
  args: string[]
}

export type SidecarSpawn = () => SidecarHandle

interface Pending {
  expected: number
  resolve: (scores: number[]) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface SidecarJudgeOptions {
  spawn: SidecarSpawn
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 30_000

export class SidecarJudge implements EvidenceJudge {
  private child: ChildProcess | undefined
  private buffer = ''
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly timeoutMs: number

  constructor(private readonly opts: SidecarJudgeOptions) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  private ensureChild(): ChildProcess {
    if (this.child && this.child.exitCode === null) return this.child
    const { command, args } = this.opts.spawn()
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] })
    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (chunk: string) => this.onData(chunk))
    // 侧车立刻退出时，紧接着的 stdin.write 会触发 EPIPE。没有这个 handler 它会变成
    // unhandled 'error' 事件把进程整个带崩，而不是让调用方收到一个可回落的 reject。
    child.stdin!.on('error', () => { /* 由 exit 事件统一收尾 */ })
    child.on('exit', () => this.failAll(new Error('sidecar exited')))
    child.on('error', (error) => this.failAll(new Error(`sidecar spawn failed: ${error.message}`)))
    this.buffer = ''
    this.child = child
    return child
  }

  /** 侧车重启后旧请求全部作废：判定无副作用，调用方按篇回落或重试。 */
  private failAll(error: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(error)
    }
    this.pending.clear()
    this.child = undefined
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let index: number
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      if (line.trim() === '') continue
      let message: { id?: unknown; scores?: unknown }
      try { message = JSON.parse(line) } catch { continue }
      if (typeof message.id !== 'number') continue
      const p = this.pending.get(message.id)
      if (!p) continue
      this.pending.delete(message.id)
      clearTimeout(p.timer)
      try {
        p.resolve(assertJudgeOutput(message.scores, p.expected))
      } catch (error) {
        p.reject(error as Error)
      }
    }
  }

  async judge(input: JudgeInput): Promise<number[]> {
    if (input.nodes.length === 0) return []
    const child = this.ensureChild()
    const id = this.nextId++
    const request = {
      id,
      query: input.query,
      nodes: input.nodes.map(n => ({ id: n.id, title: n.title, path: n.path })),
    }
    return new Promise<number[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('sidecar timeout'))
      }, this.timeoutMs)
      this.pending.set(id, { expected: input.nodes.length, resolve, reject, timer })
      child.stdin!.write(`${JSON.stringify(request)}\n`)
    })
  }

  async close(): Promise<void> {
    const child = this.child
    if (!child) return
    this.failAll(new Error('sidecar closed'))
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1000)
      // exit 后必须清掉这个兜底定时器：留着它会让 Node 的事件循环在 close() 已经
      // 返回之后继续存活最多 1 秒，拖慢测试 worker 退出，并可能触发 open-handle 告警。
      child.once('exit', () => { clearTimeout(timer); resolve() })
      child.kill()
    })
  }
}
