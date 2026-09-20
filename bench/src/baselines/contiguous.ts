import type { Section } from './sections'
import type { ContextPiece } from '../../../src/utils/contextTrace'
import { tokenRangeToPieces, spanPages, type PageToken } from './tokenStream'

/**
 * 长章节基线的「定位后阅读」扩展（计划 §2.3）：
 * 以锚点为起点，在所属章节内左右交替增长，直到 4096 token 预算或章节边界；
 * 永不跨章节、永不组合无关章节。区域是单一上下文单元。
 */
export interface ContiguousRegion {
  text: string
  tokenCount: number
  startToken: number
  endToken: number
  startPage: number
  endPage: number
  /** 所属章节标题；preamble 为空串 */
  sectionTitle: string
  /** text 的逐页精确分片：拼接后与 text 逐字相等 */
  pieces: ContextPiece[]
}

/**
 * 找到锚点起始 token 所属章节并扩展。锚点跨到下一章节的部分被裁掉（不跨边界）。
 * 返回 null 表示锚点不属于任何有内容的章节（确定性 fallback 由调用方取下一个锚点）。
 */
export function expandWithinSection(
  tokens: PageToken[],
  sections: Section[],
  anchor: { startToken: number; endToken: number },
  maxTokens: number,
): ContiguousRegion | null {
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) throw new Error('maxTokens 必须为正数')
  const section = sections.find(s => anchor.startToken >= s.startToken && anchor.startToken < s.endToken)
  if (!section) return null
  // 锚点尾部若越过章节边界，先裁剪；裁剪后为空则本锚点不可用
  let start = Math.max(anchor.startToken, section.startToken)
  let end = Math.min(anchor.endToken, section.endToken)
  if (end <= start) return null
  end = Math.min(end, start + maxTokens)
  // 左右交替增长（先左后右），确定性且近似居中；任一侧触界后只长另一侧
  while (end - start < maxTokens && (start > section.startToken || end < section.endToken)) {
    if (start > section.startToken) start--
    if (end - start < maxTokens && end < section.endToken) end++
  }
  const pieces = tokenRangeToPieces(tokens, start, end)
  return {
    text: pieces.map(piece => piece.text).join(''),
    tokenCount: end - start,
    startToken: start,
    endToken: end,
    // span 是 token 区间包络，可能点名未产出文本的页：pieces[0].page 可大于 startPage。
    // 页序以 pieces 为准；四个 Context Page 指标消费 materializer 的 pageOrder，而非这里的 span。
    // 且 pieces 可能为空：生产 atomsToPieces 从不过滤，bench tokenRangeToPieces 会，
    // 不得把 evidenceBlock.ts:245 的「由 pieces 反推 span」照搬进 bench（缺长度守卫）。
    ...spanPages(tokens, start, end),
    sectionTitle: section.title,
    pieces,
  }
}
