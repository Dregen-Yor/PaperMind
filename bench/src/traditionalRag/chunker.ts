import type { BenchChunk, TextTokenizer } from './types'
import { tokenRangeToPieces, type PageToken } from '../baselines/tokenStream'

/** 页间分隔符不成为 token；token 本身携带页号，避免跨页时按字符猜测。 */
export function chunkPages(pages: string[], tokenizer: TextTokenizer, options: { chunkSize: number; overlap: number }): BenchChunk[] {
  if (!Number.isInteger(options.chunkSize) || options.chunkSize <= 0 || !Number.isInteger(options.overlap) || options.overlap < 0 || options.overlap >= options.chunkSize) throw new Error('chunkSize/overlap 非法')
  const tokens: PageToken[] = []
  pages.forEach((page, pageNo) => tokenizer.tokenize(page).forEach(text => tokens.push({ text, page: pageNo })))
  const out: BenchChunk[] = []; const step = options.chunkSize - options.overlap
  for (let start = 0, id = 0; start < tokens.length; start += step, id++) {
    const slice = tokens.slice(start, start + options.chunkSize)
    // XLM-R 的 Metaspace token 用 ▁ 表示词前空白，不能直接 join 后送给检索器/LLM。
    // 页码变化处显式换行；逐页分片由 tokenRangeToPieces 统一产出，text 即各分片拼接，保证 == join(pieces)。
    const pieces = tokenRangeToPieces(tokens, start, start + slice.length)
    // startPage/endPage 是 token 区间包络（Math.min/max），可能点名未产出文本的页——pieces[0].page 可大于 startPage。
    // 页序以 pieces 为准；四个 Context Page 指标消费 materializer 的 pageOrder，而非这里的 span。
    // 且 pieces 可能为空：生产 atomsToPieces 从不过滤，bench tokenRangeToPieces 会，
    // 不得把 evidenceBlock.ts:245 的「由 pieces 反推 span」照搬进 bench（缺长度守卫）。
    out.push({ id, text: pieces.map(piece => piece.text).join(''), tokenCount: slice.length, startPage: Math.min(...slice.map(t => t.page)), endPage: Math.max(...slice.map(t => t.page)), pieces })
    if (start + options.chunkSize >= tokens.length) break
  }
  return out
}
