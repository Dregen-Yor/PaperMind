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
    child.stdout!.on('data', (chunk: string) => this.onData(chunk, child))
    // 侧车立刻退出、而这次写入还没冲刷完时，stdin 会触发 EPIPE。没有这个 handler 它会
    // 变成 unhandled 'error' 事件把进程整个带崩，而不是让调用方收到一个可回落的 reject。
    // （写入在子进程退出之前就冲刷完时不会报 EPIPE——那种情况下它被静默丢弃。）
    child.stdin!.on('error', () => { /* 由 exit 事件统一收尾 */ })
    // exit / error 各自每代子进程最多触发一次，且 failAll 会立刻把 this.child 清空，
    // 所以上一代的迟到事件不可能误伤新一代的在途请求——这两个 handler 刻意不加 child 身份判断。
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

  private onData(chunk: string, source: ChildProcess): void {
    // 上一代子进程的 stdout 监听器永不摘除。它若在 exit → 重新 spawn 之后才吐出残行，
    // 会拼进新一代的首行，产出一条谁也认不出的畸形行。按 child 身份过滤，迟到数据整体丢弃。
    //
    // 这个守卫只管「残行在换代之后才到达」这一种竞态。残行若在换代之前就已进过 buffer，
    // 由 ensureChild 的 `this.buffer = ''` 清掉——两道防线各管一段，都不是多余的。
    // 单测无法确定性复现这一条：真实子进程的 stdout 在 exit 时即关闭，「exit 之后才送达」的
    // 窗口逼不出来，任何能写出的测试在无守卫时也照样通过。因此该守卫**没有**回归测试兜底，
    // 删掉它不会让任何测试变红——改这里请自己核对，别以为有测试看着。
    if (source !== this.child) return
    this.buffer += chunk
    let index: number
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      if (line.trim() === '') continue
      let message: { id?: unknown; scores?: unknown; error?: unknown }
      // 解析失败的行无法归属到任何 id，只能丢弃——由该请求自己的超时兜底。这里刻意**不**
      // failAll：一条坏行会连坐并发中的其余请求，而超时至少能把影响限制在真正的那一条上。
      try { message = JSON.parse(line) } catch { continue }
      // id 非数字同样无法配对；同上，交给超时。
      if (typeof message.id !== 'number') continue
      const p = this.pending.get(message.id)
      if (!p) continue
      this.pending.delete(message.id)
      clearTimeout(p.timer)
      // 侧车把失败原因放在 error 里（Task 8 的 sidecar.py 就是这么回话的）。不带上它，
      // 调用方只会看到 not-an-array——而「权重目录不存在 / 导入失败 / OOM」正是最需要原文的
      // 诊断。协议线上格式不变，只是不再把这段文字丢掉。
      // `!= null` 同时放过 undefined 与 null：`!== undefined` 会把 `"error": null` 判成失败，
      // 而 Python 的 json.dumps 只要 dict 里有这个键就会写出它——一个「成功时也带 error 键」
      // 的侧车会被整体误拒，且失败长得跟真错误一样，比超时更难查。
      // 之所以不用 `typeof === 'string'`：数字或对象的 error 若漏下去，仍会退化成同一个笼统的
      // not-an-array，等于换个类型重犯一遍静默丢弃。非字符串转成 JSON 文本。
      if (message.error != null) {
        const text = typeof message.error === 'string' ? message.error : JSON.stringify(message.error)
        p.reject(new Error(`sidecar error: ${text}`))
        continue
      }
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
