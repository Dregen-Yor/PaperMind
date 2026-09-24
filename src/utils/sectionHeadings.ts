/**
 * 标题行识别（自 `bench/src/baselines/sections.ts` 移入）。
 *
 * 段落切分（`passages.ts`）与长章节基线（`bench/src/baselines/sections.ts`）必须共用
 * 这一份规则：各写一份的话同一条标题会在两处得到不同判定，而两处的下游
 * （段落边界 / 章节区域）都是按它切的。
 */

const MARKDOWN_HEADING = /^#{1,6}\s+(.+)$/
const NUMBERED_HEADING = /^(\d+(?:\.\d+)*)\.?\s+(.+)$/
const KNOWN_ENGLISH_HEADING = /^(abstract|introduction|background|related work|preliminaries|motivation|methods?|methodology|approach|model|experiments?|experimental setup|evaluation|results?( and discussion)?|discussion|analysis|conclusions?|limitations?|references|acknowledg(e)?ments?|appendix|appendices)$/i
const CN_CHAPTER = /^第[一二三四五六七八九十百\d]+[章节部分]\s*\S{0,60}$/
const CN_ENUMERATED = /^[一二三四五六七八九十]+、\s*\S{1,60}$/

/** 编号标题内容部分的上限：超过就按正文处理，这是假阳性的唯一防线。 */
const MAX_HEADING_CHARS = 100
const MAX_HEADING_WORDS = 20

/**
 * 命中即返回去掉编号后的标题文本，未命中返回 null。
 * 标题只用于切段与「通用章节名」判定，不进入上下文。
 */
export function isHeadingLine(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  const markdown = MARKDOWN_HEADING.exec(trimmed)
  if (markdown) return markdown[1].trim()

  if (CN_CHAPTER.test(trimmed) || CN_ENUMERATED.test(trimmed)) return trimmed
  if (KNOWN_ENGLISH_HEADING.test(trimmed)) return trimmed

  const numbered = NUMBERED_HEADING.exec(trimmed)
  if (numbered) {
    const rest = numbered[2].trim()
    const words = rest.split(/\s+/).length
    const endsLikeSentence = /[。;；]$/.test(rest)
    if (rest.length > 0 && rest.length <= MAX_HEADING_CHARS && words <= MAX_HEADING_WORDS && !endsLikeSentence) {
      return rest
    }
  }
  return null
}
