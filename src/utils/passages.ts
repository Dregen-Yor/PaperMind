/**
 * 段落切分（方案 §1）——混合检索的最小检索单位。
 *
 * 与证据块（`evidenceBlock.ts`）的分工：证据块服务语义树取证，按字符目标封块；
 * 段落按论文自然段切分，是段落级 BM25 / 向量 / 卡片先验三路打分的坐标。
 * 同一份原文两套切法，互不影响。
 *
 * 不可动摇的不变量：每个段落的 `text` 逐字等于其 `pieces` 的拼接，
 * 且进入上下文的永远是 `text`（原文）；清洗只作用于 `searchText`。
 */
import type { ContextPiece } from './contextTrace'
import { detectRunningLines, normalizeEvidenceText } from './evidenceBlock'
import { isHeadingLine } from './sectionHeadings'

export interface Passage {
  /** 论文内稳定且唯一的段落 ID，形如 `P01` */
  id: string
  order: number
  /** `text` 的逐页精确分区：按序拼接所有 piece 得到 `text` */
  pieces: ContextPiece[]
  /** 原文；进入上下文的唯一来源 */
  text: string
  /** 仅供打分与向量使用的轻度清洗文本（去页眉页脚/页码、复原断词） */
  searchText: string
  /** 由注入的 token 计数器给出，按 piece 累加（与 materializeContext 的计法一致） */
  tokenCount: number
  prevId: string | null
  nextId: string | null
  /** 所属小节标题（标题行文本）；首个标题之前的正文为空串 */
  subsection: string
}

export type TokenCounter = (text: string) => number

export interface PassageOptions {
  /** 自然段低于此 token 数即向后合并，直到达标或遇到小节边界。默认 120 */
  minTokens?: number
  /** 自然段超过此 token 数即在句子边界切开。默认 350 */
  maxTokens?: number
}

export const DEFAULT_PASSAGE_OPTIONS: Required<PassageOptions> = { minTokens: 120, maxTokens: 350 }

/** 4 字符 ≈ 1 token：与 `semanticTree.estimateTokens` 同口径，产品侧不引入真分词器。 */
export function createEstimatingTokenCounter(): TokenCounter {
  return (text: string) => (text.length === 0 ? 0 : Math.max(1, Math.round(text.length / 4)))
}

/** 分片无损校验（形态照抄 `evidenceBlock.hasExactPagePartition`，字段名换成 `text`）。 */
export function hasPassagePartition(passage: unknown): boolean {
  if (!passage || typeof passage !== 'object') return false
  const { pieces, text } = passage as { pieces?: unknown; text?: unknown }
  if (typeof text !== 'string' || !Array.isArray(pieces) || pieces.length === 0) return false
  const typed: ContextPiece[] = []
  for (const piece of pieces) {
    if (!piece || typeof piece !== 'object') return false
    const { page, text: pieceText } = piece as { page?: unknown; text?: unknown }
    if (typeof page !== 'number' || !Number.isInteger(page) || page < 0) return false
    if (typeof pieceText !== 'string') return false
    typed.push({ page, text: pieceText })
  }
  return typed.map(piece => piece.text).join('') === text
}

/** 同一页内的一个连续行块；`breakBefore` 表示它开启一个新自然段（换行符宽度不同）。 */
interface Atom {
  page: number
  text: string
  breakBefore: boolean
}

interface Paragraph {
  atoms: Atom[]
  subsection: string
}

const SENTENCE_END = /[.!?:;。！？：；]["')\]]?$/
const PARAGRAPH_START = /^[A-Z0-9(“"(\[]/

/** 无空行页面里的行级启发式：上一行以句末标点收尾且本行以大写/数字开头即视作新段。 */
function startsNewParagraph(previousLine: string, line: string): boolean {
  if (!previousLine) return true
  if (!SENTENCE_END.test(previousLine)) return false
  return PARAGRAPH_START.test(line)
}

/** 逐页、逐行扫描，产出自然段；标题行并入其后一段的段首并强制开新段。 */
function collectParagraphs(pages: string[]): Paragraph[] {
  const paragraphs: Paragraph[] = []
  let atoms: Atom[] = []
  let subsection = ''
  let paragraphSubsection = ''
  let previousLine = ''

  const flush = () => {
    if (atoms.length > 0) paragraphs.push({ atoms, subsection: paragraphSubsection })
    atoms = []
  }
  const append = (page: number, text: string, breakBefore: boolean) => {
    const last = atoms.at(-1)
    if (last && last.page === page && !breakBefore) last.text += `\n${text}`
    else atoms.push({ page, text, breakBefore })
  }
  const startParagraph = (page: number, text: string) => {
    flush()
    paragraphSubsection = subsection
    append(page, text, true)
  }

  for (let page = 0; page < pages.length; page++) {
    for (const raw of pages[page].split(/\r?\n/)) {
      const text = raw.trim()
      if (!text) {
        flush()
        previousLine = ''
        continue
      }
      const heading = isHeadingLine(text)
      if (heading) {
        // 标题行开启新小节，并并入其后一段的段首（不单独成段）：先关掉当前段
        flush()
        subsection = heading
        paragraphSubsection = heading
        append(page, text, true)
        previousLine = text
        continue
      }
      if (atoms.length === 0 || startsNewParagraph(previousLine, text)) startParagraph(page, text)
      else append(page, text, false)
      previousLine = text
    }
  }
  flush()
  return paragraphs
}

function countParagraphTokens(paragraph: Paragraph, countTokens: TokenCounter): number {
  return paragraph.atoms.reduce((sum, atom) => sum + countTokens(atom.text), 0)
}

/** 不足 minTokens 的段落在同一小节内向后合并；小节边界、标题边界都不跨。 */
function mergeSmallParagraphs(paragraphs: Paragraph[], minTokens: number, countTokens: TokenCounter): Paragraph[] {
  const merged: Paragraph[] = []
  let buffer: Paragraph | undefined
  for (const paragraph of paragraphs) {
    if (buffer && buffer.subsection === paragraph.subsection && countParagraphTokens(buffer, countTokens) < minTokens) {
      buffer = { atoms: [...buffer.atoms, ...paragraph.atoms], subsection: buffer.subsection }
      continue
    }
    if (buffer) merged.push(buffer)
    buffer = paragraph
  }
  if (buffer) merged.push(buffer)
  return merged
}

/**
 * 在 `text[start, text.length)` 上找「不超预算的最长前缀」的结束下标。
 * 指数扩张 + 二分：只对计数器做 O(log n) 次探测，超长单行也不会退化成平方复杂度。
 * 前提是计数器对前缀长度单调不减（本模块的 `长度 / 4` 计法满足）。
 * 一个字符都放不下时也至少前进一个字符，保证调用方循环终止。
 */
function furthestWithinBudget(text: string, start: number, maxTokens: number, countTokens: TokenCounter): number {
  const fits = (end: number) => countTokens(text.slice(start, end)) <= maxTokens
  let best = start
  let step = 1
  let probe = Math.min(text.length, start + step)
  while (probe > best && fits(probe)) {
    best = probe
    step *= 2
    probe = Math.min(text.length, start + step)
  }
  let low = best + 1
  let high = probe
  while (low <= high) {
    const mid = (low + high) >> 1
    if (fits(mid)) {
      best = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return Math.max(best, start + 1)
}

/**
 * 按字符预算硬切的兜底：整段没有可用句子边界时（中文句号后不带空格的连续正文、
 * 表格行等）仍要保证每个片段有界——段落预算是后续检索与上下文的前提。
 * 切片是连续子串，按序拼接逐字还原输入；切口尽量落在空白之后以免切词。
 */
function splitByCharBudget(text: string, maxTokens: number, countTokens: TokenCounter): string[] {
  const pieces: string[] = []
  let start = 0
  while (start < text.length) {
    let end = furthestWithinBudget(text, start, maxTokens, countTokens)
    if (end < text.length) {
      const window = text.slice(start, end)
      const lastBreak = Math.max(window.lastIndexOf(' '), window.lastIndexOf('\n'), window.lastIndexOf('\t'))
      if (lastBreak > 0) end = start + lastBreak + 1
    }
    pieces.push(text.slice(start, end))
    start = end
  }
  return pieces
}

/** 在句子边界处把超长文本切成长度接近 maxTokens 的片段。 */
function splitLongText(text: string, maxTokens: number, countTokens: TokenCounter): string[] {
  const sentences = text.split(/(?<=[.!?。！？])\s+/).filter(sentence => sentence.length > 0)
  const pieces: string[] = []
  let current = ''
  for (const sentence of sentences) {
    const candidate = current ? `${current} ${sentence}` : sentence
    if (current && countTokens(candidate) > maxTokens) {
      pieces.push(current)
      current = sentence
    } else {
      current = candidate
    }
  }
  if (current) pieces.push(current)
  // 句子边界切不动的片段（单句本身就超预算）再按字符预算兜底，任何片段都有界
  return pieces.flatMap(piece => (countTokens(piece) > maxTokens ? splitByCharBudget(piece, maxTokens, countTokens) : [piece]))
}

/** 超过 maxTokens 的段落按原子边界或句子边界切开。 */
function splitOversizedParagraph(paragraph: Paragraph, maxTokens: number, countTokens: TokenCounter): Paragraph[] {
  const out: Paragraph[] = []
  let current: Atom[] = []
  let currentTokens = 0
  const flush = () => {
    if (current.length > 0) out.push({ atoms: current, subsection: paragraph.subsection })
    current = []
    currentTokens = 0
  }

  for (const atom of paragraph.atoms) {
    const atomTokens = countTokens(atom.text)
    if (atomTokens > maxTokens) {
      flush()
      for (const piece of splitLongText(atom.text, maxTokens, countTokens)) {
        out.push({ atoms: [{ page: atom.page, text: piece, breakBefore: true }], subsection: paragraph.subsection })
      }
      continue
    }
    if (current.length > 0 && currentTokens + atomTokens > maxTokens) flush()
    current.push(atom)
    currentTokens += atomTokens
  }
  flush()
  return out
}

/** 原子序列 → 逐页精确分片：新段落前缀 `\n\n`，同段落跨页前缀 `\n`。 */
function atomsToPieces(atoms: Atom[]): ContextPiece[] {
  const pieces: ContextPiece[] = []
  atoms.forEach((atom, index) => {
    const prefix = index === 0 ? '' : atom.breakBefore ? '\n\n' : '\n'
    const fragment = `${prefix}${atom.text}`
    const last = pieces.at(-1)
    if (last && last.page === atom.page) last.text += fragment
    else pieces.push({ page: atom.page, text: fragment })
  })
  return pieces
}

export function buildPassages(
  pages: string[],
  countTokens: TokenCounter,
  opts: PassageOptions = {},
): Passage[] {
  const minTokens = opts.minTokens ?? DEFAULT_PASSAGE_OPTIONS.minTokens
  const maxTokens = opts.maxTokens ?? DEFAULT_PASSAGE_OPTIONS.maxTokens
  if (!Number.isInteger(minTokens) || minTokens <= 0) throw new Error('minTokens 必须是正整数')
  if (!Number.isInteger(maxTokens) || maxTokens < minTokens) throw new Error('maxTokens 必须是不小于 minTokens 的整数')
  if (pages.length === 0) return []

  const runningLines = detectRunningLines(pages)
  const merged = mergeSmallParagraphs(collectParagraphs(pages), minTokens, countTokens)
  const groups = merged.flatMap(paragraph => splitOversizedParagraph(paragraph, maxTokens, countTokens))

  const passages: Passage[] = groups.map((group, index) => {
    const pieces = atomsToPieces(group.atoms)
    const text = pieces.map(piece => piece.text).join('')
    const id = `P${String(index + 1).padStart(2, '0')}`
    if (!hasPassagePartition({ pieces, text })) throw new Error(`段落 ${id} 的分片与原文不一致`)
    return {
      id,
      order: index,
      pieces,
      text,
      searchText: normalizeEvidenceText(text, runningLines),
      tokenCount: pieces.reduce((sum, piece) => sum + countTokens(piece.text), 0),
      prevId: null,
      nextId: null,
      subsection: group.subsection,
    }
  })

  for (let i = 0; i < passages.length; i++) {
    passages[i].prevId = i > 0 ? passages[i - 1].id : null
    passages[i].nextId = i + 1 < passages.length ? passages[i + 1].id : null
  }
  return passages
}
