export const CONTEXT_GROUP_SEPARATOR = '\n\n---\n\n'

export interface ContextTokenizer {
  tokenize(text: string): string[]
}

export interface ContextPiece {
  page: number
  text: string
}

export interface ContextGroup {
  pieces: ContextPiece[]
}

export interface MaterializedContext {
  text: string
  pageOrder: number[]
  tokenCount: number
  truncated: boolean
}

const renderToken = (token: string) => token.replaceAll('▁', ' ')

/**
 * 在固定的 token 预算内把候选片段物化为最终提示词文本，
 * 并从同一次计算中产出真正贡献了文本的原文页码（按首次出现顺序、去重）。
 * 只有贡献了非空文本的页码才计入；被预算完全截断、未产出任何 token 的页码不出现。
 */
export function materializeContext(
  groups: ContextGroup[],
  tokenizer: ContextTokenizer,
  maxTokens: number,
): MaterializedContext {
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) throw new Error('maxTokens 必须为正整数')
  const pageOrder: number[] = []
  const seen = new Set<number>()
  let text = ''
  let tokenCount = 0
  let truncated = false

  const emit = (raw: string, page?: number): boolean => {
    const tokens = tokenizer.tokenize(raw)
    const take = Math.min(tokens.length, maxTokens - tokenCount)
    if (take <= 0) {
      if (tokens.length > 0) truncated = true
      return false
    }
    text += tokens.slice(0, take).map(renderToken).join('')
    tokenCount += take
    if (page !== undefined && take > 0 && !seen.has(page)) {
      seen.add(page)
      pageOrder.push(page)
    }
    if (take < tokens.length) truncated = true
    return take === tokens.length
  }

  for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
    const pieces = groups[groupIndex].pieces.filter(piece => piece.text.trim().length > 0)
    if (pieces.length === 0) continue
    const prefix = text.length > 0 ? CONTEXT_GROUP_SEPARATOR : ''
    const prefixTokens = tokenizer.tokenize(prefix).length
    const firstTokens = tokenizer.tokenize(pieces[0].text).length
    // 守卫：当「分隔符 + 至少一个内容 token」都放不下时，整组直接不进入，
    // 避免留下一个吃掉全部剩余预算的尾部分隔符。
    // 用 `>=` 是刻意为之：恰好占满（== maxTokens）时同样拒绝。
    // `firstTokens > 0` 仅为防御——pieces 已在上面按非空白过滤，
    // 合规的精确分词器必 >0；该子句用于兜底返回 [] 的退化分词器。
    if (tokenCount + prefixTokens >= maxTokens && firstTokens > 0) {
      truncated = true
      break
    }
    if (prefix && !emit(prefix)) break
    for (let pieceIndex = 0; pieceIndex < pieces.length; pieceIndex++) {
      if (!emit(pieces[pieceIndex].text, pieces[pieceIndex].page)) break
    }
    if (tokenCount >= maxTokens) {
      truncated ||= groupIndex < groups.length - 1
      break
    }
  }
  return { text: text.trim(), pageOrder, tokenCount, truncated }
}
