import type { TextTokenizer } from '../traditionalRag/types'
import type { ContextPiece } from '../../../src/utils/contextTrace'

/**
 * 强基线共用的「带页号 token 流」原语。
 * 与 traditionalRag/chunker 相同的 token 语义（XLM-R Metaspace 的 ▁ 还原为空格、
 * 跨页显式换行且不计入 token），但保留每个 token 的全局下标，
 * 供章节边界对齐与连续区域扩展做确定性切片。
 */
export interface PageToken { text: string; page: number }

export interface LineSpan {
  /** 该行首个 token 的全局下标 */
  start: number
  /** 该行 token 数 */
  count: number
  page: number
  text: string
}

export function buildTokenStream(pages: string[], tokenizer: TextTokenizer): { tokens: PageToken[]; lines: LineSpan[] } {
  const tokens: PageToken[] = []
  const lines: LineSpan[] = []
  pages.forEach((page, pageNo) => {
    for (const line of page.split('\n')) {
      const start = tokens.length
      const piece = tokenizer.tokenize(line)
      for (const text of piece) tokens.push({ text, page: pageNo })
      lines.push({ start, count: tokens.length - start, page: pageNo, text: line })
    }
  })
  return { tokens, lines }
}

/**
 * [start, end) 区间的 token 还原为可读文本（整段 `trim()`）。
 * 换行与 `▁`→空格 的规则与 chunkPages 相同，但对「仅含空白 token 的页边界」的处理
 * 与 tokenRangeToPieces 不同（后者只裁首尾分片并按分片丢弃空白），二者**不再逐字等价**。
 * 当前 bench 已无生产调用方，仅测试在用；去留留待 Task 11 决定。
 */
export function sliceText(tokens: PageToken[], start: number, end: number): string {
  let out = ''
  for (let i = start; i < end; i++) {
    if (i > start && tokens[i].page !== tokens[i - 1].page) out += '\n'
    out += tokens[i].text.replaceAll('▁', ' ')
  }
  return out.trim()
}

/**
 * [start, end) 区间的 token 还原为「逐页分片」：连续同页 token 合并为一个 piece；
 * 页间换行固定为 '\n'，归属于新页的首个分片。裁切范围仅为：首分片 `trimStart`、
 * 末分片 `trimEnd`——二者都会剥掉**所有** JS 空白（含换行），不止空格——随后丢弃
 * 裁完变空的分片。由此：
 * - 首分片（乃至全部分片）可能为纯空白被丢弃，故 `pieces` **可以为空**；
 * - `pieces[0].page` 可能**大于**该区间的起始页号；
 * - 与 `sliceText` 的整段 trim **不再等价**：`join(pieces)` 可能多出一个前导 '\n'。
 * 这是 BenchChunk / StreamPassage / ContiguousRegion 共用的唯一分组实现。
 */
export function tokenRangeToPieces(tokens: PageToken[], start: number, end: number): ContextPiece[] {
  const pieces: ContextPiece[] = []
  for (let i = start; i < end; i++) {
    const pageBreak = i > start && tokens[i].page !== tokens[i - 1].page ? '\n' : ''
    const fragment = pageBreak + tokens[i].text.replaceAll('▁', ' ')
    const last = pieces.at(-1)
    if (last?.page === tokens[i].page) last.text += fragment
    else pieces.push({ page: tokens[i].page, text: fragment })
  }
  if (pieces.length > 0) {
    pieces[0].text = pieces[0].text.trimStart()
    pieces[pieces.length - 1].text = pieces[pieces.length - 1].text.trimEnd()
  }
  return pieces.filter(piece => piece.text.length > 0)
}

export function spanPages(tokens: PageToken[], start: number, end: number): { startPage: number; endPage: number } {
  if (end <= start) {
    // 空区间没有 token 可依：退回最近一个 token 的页号；流为空时 0
    const fallback = tokens[Math.max(0, Math.min(start, tokens.length - 1))]?.page ?? 0
    return { startPage: fallback, endPage: fallback }
  }
  let startPage = tokens[start].page
  let endPage = startPage
  for (let i = start; i < end; i++) {
    if (tokens[i].page < startPage) startPage = tokens[i].page
    if (tokens[i].page > endPage) endPage = tokens[i].page
  }
  return { startPage, endPage }
}

/**
 * 在整篇 token 流上按 512/128 语义切锚点段（长章节基线的锚点）。
 * 与 chunkPages 相同的步长与终止规则，但每个 passage 携带全局 token 下标，
 * 使锚点能无歧义地映射回 token 流做章节内扩展。
 */
export interface StreamPassage {
  id: number
  text: string
  tokenCount: number
  startPage: number
  endPage: number
  /** 全局 token 下标，[startToken, endToken) */
  startToken: number
  endToken: number
  /** text 的逐页精确分片：拼接后与 text 逐字相等 */
  pieces: ContextPiece[]
}

export function chunkTokenStream(tokens: PageToken[], options: { chunkSize: number; overlap: number }): StreamPassage[] {
  if (!Number.isInteger(options.chunkSize) || options.chunkSize <= 0 || !Number.isInteger(options.overlap) || options.overlap < 0 || options.overlap >= options.chunkSize) throw new Error('chunkSize/overlap 非法')
  const out: StreamPassage[] = []
  const step = options.chunkSize - options.overlap
  for (let start = 0, id = 0; start < tokens.length; start += step, id++) {
    const end = Math.min(start + options.chunkSize, tokens.length)
    const pieces = tokenRangeToPieces(tokens, start, end)
    out.push({
      id,
      text: pieces.map(piece => piece.text).join(''),
      tokenCount: end - start,
      // span 是 token 区间包络，可能点名未产出任何文本的页（见 tokenRangeToPieces 的空白分片丢弃）。
      // 页序以 pieces 为准；四个 Context Page 指标将消费 materializer 的 pageOrder，而非这里的 span。
      // 且 pieces 可能为空：生产 atomsToPieces 从不过滤，bench tokenRangeToPieces 会，
      // 不得把 evidenceBlock.ts:245 的「由 pieces 反推 span」照搬进 bench（缺长度守卫）。
      ...spanPages(tokens, start, end),
      startToken: start,
      endToken: end,
      pieces,
    })
    if (end >= tokens.length) break
  }
  return out
}
