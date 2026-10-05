/**
 * 证据判定器：给一批候选节点打分，回答「这一节对当前问题是不是证据」。
 *
 * 刻意不依赖任何运行时——实现方可以是本地决策模型（MLX / ONNX）、
 * BM25 词法对照，或测试里的假实现。判定逻辑因此可以在不装模型、
 * 不装 Python 的机器上被完整单测。
 */

/**
 * 送去判定的候选节点。只带标题与父路径，**不带正文**——树只承担导航职责，
 * 判定的是「这一节值不值得去读」，真正的证据仍要回原文页取证（spec §1 的模块边界）。
 */
export interface JudgeNode {
  id: string
  title: string
  /** 从根到父节点的标题路径，根层节点为空数组 */
  path: string[]
}

export interface JudgeInput {
  query: string
  /** 同一层的候选节点，一次批量判定 */
  nodes: JudgeNode[]
}

export interface EvidenceJudge {
  /** 返回与 `nodes` 等长、逐位对应的概率数组 */
  judge(input: JudgeInput): Promise<number[]>
}

/**
 * 校验判定器输出。判定器可能来自模型、子进程或对照实现，
 * 任何一处返回垃圾都必须在进入阈值计算之前拦下——否则 NaN 会在
 * `Math.max` 里静默传播，最终表现为「什么都没选中」而不是报错。
 */
export function assertJudgeOutput(output: unknown, expectedLength: number): number[] {
  if (!Array.isArray(output)) throw new Error('not-an-array')
  if (output.length !== expectedLength) throw new Error('length-mismatch')
  for (const value of output) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error('invalid-score')
    }
  }
  return output
}
