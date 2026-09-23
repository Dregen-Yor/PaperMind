import type { TextTokenizer } from '../traditionalRag/types'
import { isHeadingLine } from '../../../src/utils/sectionHeadings'
import { buildTokenStream, spanPages, type PageToken } from './tokenStream'

/**
 * 长章节基线的确定性章节边界提取（计划 §2.3：只依赖 canonical 文本中已有的标题，
 * 无 LLM 调用，保留全部原始页号映射）。
 * 标题行识别已移入 `src/utils/sectionHeadings.ts`，本文件只再导出：段落切分与章节
 * 区域必须共用同一份规则。规则本身刻意保守（Markdown 标题、短编号标题、已知英文
 * 节名、中文「第X章/节」与「一、」），编号行过长或过长句式的假阳性一律不当作标题。
 */
export interface Section {
  title: string
  /** 全局 token 下标，[startToken, endToken)；endToken 为 exclusive */
  startToken: number
  endToken: number
  startPage: number
  endPage: number
}

/**
 * 标题行识别已移入 `src/utils/sectionHeadings.ts`：段落切分与本章节边界必须
 * 共用同一份规则，否则同一条标题在两处会有不同判定。这里只做再导出，
 * 保持 bench 内部既有的 import 路径不变。
 */
export { isHeadingLine }

/**
 * 章节列表首尾相接覆盖整个 token 流：首个标题之前是 title 为空的 preamble 节。
 * 相邻标题之间没有正文时产生空节（startToken === endToken），不影响锚点扩展——
 * 锚点只会落在有内容的 token 上。
 */
export function detectSections(pages: string[], tokenizer: TextTokenizer): Section[] {
  const { tokens, lines } = buildTokenStream(pages, tokenizer)
  const boundaries: Array<{ title: string; startToken: number }> = []
  for (const line of lines) {
    if (line.count === 0) continue
    const title = isHeadingLine(line.text)
    if (title !== null) boundaries.push({ title, startToken: line.start })
  }
  const sections: Section[] = []
  const total = tokens.length
  for (let i = 0; i < boundaries.length; i++) {
    const start = boundaries[i].startToken
    const end = i + 1 < boundaries.length ? boundaries[i + 1].startToken : total
    // 连续标题行：前一个标题没有任何正文，跳过空节，只保留最后一个标题
    if (i + 1 < boundaries.length && boundaries[i + 1].startToken === start) continue
    if (start >= end) continue
    sections.push({ title: boundaries[i].title, startToken: start, endToken: end, ...spanPages(tokens, start, end) })
  }
  if (boundaries.length === 0 || boundaries[0].startToken > 0) {
    const preambleEnd = boundaries.length > 0 ? boundaries[0].startToken : total
    if (preambleEnd > 0) sections.unshift({ title: '', startToken: 0, endToken: preambleEnd, ...spanPages(tokens, 0, preambleEnd) })
  }
  return sections
}

export type { PageToken }
export { buildTokenStream }
