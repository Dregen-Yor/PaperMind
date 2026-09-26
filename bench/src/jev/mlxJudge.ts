/**
 * `EvidenceJudge` 的 MLX 实现：把判定委托给 Python 侧车。
 *
 * 批量切分是刻意的：侧车逐节点调用，一次请求塞太多节点会让单次往返变长，
 * 而超时是按请求计的。按 `batchSize` 切分把单次往返的时延与失败面都限制在一批之内。
 *
 * **切分不提供失败隔离**：批间是串行 `await`，第 i 批抛错会直接 reject 整个 `judge()`、
 * 放弃 i+1..n 批。按 §4 的口径这仍然是对的——判定失败本就是**整篇**回落到 `passage-hybrid`，
 * 不是逐批降级。别把 batchSize 当成「坏一批只丢一批」的保险。
 */
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { SidecarJudge, type SidecarSpawn } from './protocol'
import type { EvidenceJudge, JudgeInput } from '../../../src/utils/evidenceJudge'

const HERE = dirname(fileURLToPath(import.meta.url))

export interface MlxJudgeOptions {
  /** 本地权重目录，默认仓库根的 models/laya/laya-mlx */
  modelPath?: string
  /** venv 的 python，默认仓库根的 models/laya/.venv/bin/python */
  pythonPath?: string
  batchSize?: number
  timeoutMs?: number
}

export function defaultSpawn(opts: MlxJudgeOptions = {}): SidecarSpawn {
  const root = resolve(HERE, '../../..')
  const python = opts.pythonPath ?? resolve(root, 'models/laya/.venv/bin/python')
  const model = opts.modelPath ?? resolve(root, 'models/laya/laya-mlx')
  const script = resolve(HERE, 'sidecar.py')
  return () => ({ command: python, args: [script, model] })
}

/**
 * 批量切分的 EvidenceJudge。每批独立往返，批间串行以固定单条判定的时延特征。
 *
 * 返回类型刻意带上 `close`：`SidecarJudge` 已经实现了它，委托是零成本；而任何长跑调用方
 * （本任务的冒烟脚本、Plan 2 的 runner）收尾时都必须关掉子进程，否则侧车的 stdio 管道
 * 会让 Node 事件循环一直活着、脚本挂住不退出。只返回 `EvidenceJudge` 就没法关。
 */
export function createMlxJudge(opts: MlxJudgeOptions = {}): EvidenceJudge & { close: () => Promise<void> } {
  const inner = new SidecarJudge({
    spawn: defaultSpawn(opts),
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  })
  const batchSize = opts.batchSize ?? 16
  return {
    async judge(input: JudgeInput): Promise<number[]> {
      const out: number[] = []
      for (let i = 0; i < input.nodes.length; i += batchSize) {
        out.push(...await inner.judge({ query: input.query, nodes: input.nodes.slice(i, i + batchSize) }))
      }
      return out
    },
    close: () => inner.close(),
  }
}
