/**
 * 对照臂 A `toc-bm25` 的打分器：把 `EvidenceJudge` 换成 BM25。
 *
 * 这是设计文档 §3.1 的**主对照**——与 `toc-jev` 用**同一棵树、同一份输入文字、
 * 同一套遍历（`traverseWithJudge` 一行不改）**，只有打分器不同。因此 A 与 B 的
 * 差异是单变量的：任何差别都归因于「用 Jev 还是用词法匹配」。
 *
 * **只在标题与父路径上打分**，不给正文：判定器的输入（`JudgeNode`）本来就只带
 * 这两者（spec §1：树只承担导航职责）。给正文会让 A 臂拿到 B 臂没有的信息，
 * 单变量前提当场失效。
 */
import { buildBm25Scorer } from '../../../src/utils/bm25'
import type { EvidenceJudge, JudgeInput, JudgeNode } from '../../../src/utils/evidenceJudge'

/** 节点的「文档」= 父路径 + 自身标题，父到子拼接，与判定器看到的层级信息一致。 */
function nodeDocument(node: JudgeNode): string {
  return [...node.path, node.title].join(' ')
}

export function createBm25Judge(): EvidenceJudge {
  return {
    async judge({ query, nodes }: JudgeInput): Promise<number[]> {
      if (nodes.length === 0) return []

      // 统计量**按每次调用（= 层）现算**，与 Jev 臂的批量语义对齐：
      // 两者都在同一层、同一批候选上打分，不引入跨层语料。
      const raw = buildBm25Scorer(nodes.map(nodeDocument))(query).map(scored => scored.score)
      const max = raw.reduce((a, b) => (b > a ? b : a), 0)

      // 归一化**只为满足 `assertJudgeOutput` 的 [0,1] 契约**，不改变任何选择：
      // 遍历用的是层内相对阈值 θ = α·max，对正数缩放免疫——`s/scale >= α·(max/scale)`
      // 与 `s >= α·max` 等价。所以这里做 or 不做，A 臂选出的节点完全相同。
      // max === 0（查询词一个都没进标题）时整层返回 0 而不是 0/0：NaN 会被
      // `assertJudgeOutput` 拦下并让整篇回落，把一个正常退化当成判定失败上报。
      return max > 0 ? raw.map(score => score / max) : raw.map(() => 0)
    },
  }
}
