/**
 * `EvidenceJudge` 的 MLX 实现：把判定委托给 Python 侧车。
 *
 * 批量切分是刻意的：侧车逐节点调用，一次请求塞太多节点会让单次往返变长，
 * 而超时是按请求计的。按 `batchSize` 切分后，单批失败只影响该批。
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

/** 批量切分的 EvidenceJudge。每批独立往返，批间串行以固定单条判定的时延特征。 */
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
    // 暴露给冒烟脚本显式收尾：不 close 的话，侧车子进程的 stdio 管道仍是 Node 事件循环里的
    // 活动句柄，脚本会一直挂着不退出。委托给内层 SidecarJudge 的 close()。
    close: () => inner.close(),
  }
}
