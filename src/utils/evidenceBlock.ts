/**
 * 原文证据块（方案 §5）——语义树之外独立存在的最小可引用单位。
 *
 * 职责边界：本模块**只**保存论文原文并为其提供稳定锚点，不做任何语义判断。
 * `rawText` 永远不允许被改写；页眉页脚剔除、断词复原、空白折叠等修正
 * 一律只作用于 `normalizedText`（§5.3）。即使某个证据块从未被语义树引用，
 * 它也照样保留在存储中，可由平面检索召回。
 */

/** 证据块来源类型，供诊断与后续按来源加权使用。 */
export type EvidenceSourceType =
  | 'body'
  | 'figure-caption'
  | 'table-caption'
  | 'formula'
  | 'footnote'
  | 'other'

export interface EvidenceBlock {
  /** 论文内稳定且唯一的块 ID，形如 `B001` */
  id: string
  /** PDF 解析得到的原始文本，一经生成不得改写 */
  rawText: string
  /** 仅供搜索的轻度清洗文本 */
  normalizedText: string
  /** 0-based 闭区间 */
  startPage: number
  /** 0-based 闭区间 */
  endPage: number
  /** 在论文中的原始顺序，等于块数组下标 */
  order: number
  previousId: string | null
  nextId: string | null
  sourceType: EvidenceSourceType
}

export interface EvidenceBlockOptions {
  /** 目标块大小（字符），达到后即在下一个段落边界封块。默认 2400（约 600 token） */
  targetChars?: number
  /** 硬上限（字符），任何块都不得超过（单段超长时按此硬切）。默认 3200（约 800 token） */
  maxChars?: number
  /** 末块小于此值且并入前块不超上限时前并。默认 1600（约 400 token） */
  minChars?: number
}

const DEFAULT_TARGET_CHARS = 2400
const DEFAULT_MAX_CHARS = 3200
const DEFAULT_MIN_CHARS = 1600

/**
 * 分块默认参数。导出是为了让建树缓存身份（`semanticTreeConfigHash`）与实际
 * 使用的参数来自同一处——同一篇原文，分块参数变了树就会变（§10.3）。
 */
export const DEFAULT_EVIDENCE_OPTIONS: Required<EvidenceBlockOptions> = {
  targetChars: DEFAULT_TARGET_CHARS,
  maxChars: DEFAULT_MAX_CHARS,
  minChars: DEFAULT_MIN_CHARS,
}

/** 页眉检测的最少页数：低于此数重复不足以判定为「跨页重复」。 */
const RUNNING_LINE_MIN_PAGES = 3
/** 页码哨兵：不同页的页码字面量不同，用统一哨兵才能整体剔除。 */
const PAGE_NUMBER_SENTINEL = '<page-number>'
const PAGE_NUMBER_PATTERN = /^\d{1,4}$/

const FIGURE_CAPTION = /^(fig(?:ure)?\.?|图)\s*\d+/i
const TABLE_CAPTION = /^(tab(?:le)?\.?|表)\s*\d+/i
const FORMULA_ENV = /\\begin\{(equation|align|eqnarray|gather|multline)\*?\}/
const FOOTNOTE_MARKER = /^([*†‡]|\d{1,2}\s)/
const FOOTNOTE_HINT = /corresponding|e-?mail|@|https?:\/\/|作者简介|通讯作者/i

const normalizeLine = (line: string): string => line.trim().replace(/\s+/g, ' ').toLowerCase()

/** 判断一行是否属于「公式密集」：数学符号占比高，或含 LaTeX 公式环境。 */
function isFormulaDense(text: string): boolean {
  if (FORMULA_ENV.test(text)) return true
  const mathChars = text.match(/[=+\-<>∑∫√^_{}\\]/g)?.length ?? 0
  return text.length > 0 && mathChars / text.length > 0.08
}

/** 按内容形态判断证据块来源。启发式，只用于诊断与排序提示，不参与事实判定。 */
export function classifySourceType(text: string): EvidenceSourceType {
  const trimmed = text.trim()
  if (!trimmed) return 'other'
  if (FIGURE_CAPTION.test(trimmed)) return 'figure-caption'
  if (TABLE_CAPTION.test(trimmed)) return 'table-caption'
  if (isFormulaDense(trimmed)) return 'formula'
  if (FOOTNOTE_MARKER.test(trimmed) && FOOTNOTE_HINT.test(trimmed)) return 'footnote'
  return 'body'
}

function firstAndLastLines(page: string): string[] {
  const lines = page.split(/\r?\n/).map(normalizeLine).filter(Boolean)
  if (lines.length === 0) return []
  return lines.length === 1 ? [lines[0]] : [lines[0], lines[lines.length - 1]]
}

/**
 * 找出跨页重复的页眉/页脚行（返回小写归一化后的行文本）。
 *
 * running header 会在每页顶部重复，因此只在「每页首行/末行」中取样，
 * 并要求出现在足够比例的页面上。纯数字行（页码）在各页字面量不同，
 * 统一归到 `PAGE_NUMBER_SENTINEL` 以整体识别。
 *
 * 页数低于 {@link RUNNING_LINE_MIN_PAGES} 时一律返回空集：
 * 两页重复不足以与正文小标题区分。
 */
export function detectRunningLines(pages: string[]): Set<string> {
  const result = new Set<string>()
  if (pages.length < RUNNING_LINE_MIN_PAGES) return result

  const counts = new Map<string, number>()
  for (const page of pages) {
    // 同一页内重复出现只记一次，避免单页内容拉高计数
    const seen = new Set<string>()
    for (const line of firstAndLastLines(page)) {
      const key = PAGE_NUMBER_PATTERN.test(line) ? PAGE_NUMBER_SENTINEL : line
      if (seen.has(key)) continue
      seen.add(key)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }

  const threshold = Math.max(RUNNING_LINE_MIN_PAGES, Math.ceil(pages.length * 0.5))
  for (const [line, count] of counts) {
    if (count >= threshold) result.add(line)
  }
  return result
}

/** 生成供搜索使用的轻度清洗文本；`rawText` 不受影响。 */
export function normalizeEvidenceText(rawText: string, runningLines: Set<string>): string {
  const kept = rawText
    .split(/\r?\n/)
    .filter(line => {
      const key = normalizeLine(line)
      if (!key) return true
      if (runningLines.has(key)) return false
      return !(runningLines.has(PAGE_NUMBER_SENTINEL) && PAGE_NUMBER_PATTERN.test(key))
    })
    .join('\n')
  return kept
    // 断词复原：只并入被换行切断的词
    .replace(/(\w)-\s*\n\s*(\w)/g, '$1$2')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/**
 * 一个待成块的文本原子。`breakBefore` 为 true 表示它开启一个新段落
 * （与前一原子之间保留段落分隔），false 表示它是超长段落的硬切续片。
 */
interface Atom {
  text: string
  page: number
  breakBefore: boolean
}

/** 把超过上限的段落按字符硬切；切片是原串的连续分区，拼接无损。 */
function splitOversized(text: string, maxChars: number, page: number): Atom[] {
  const atoms: Atom[] = []
  for (let start = 0; start < text.length; start += maxChars) {
    atoms.push({ text: text.slice(start, start + maxChars), page, breakBefore: start === 0 })
  }
  return atoms
}

function collectAtoms(pages: string[], maxChars: number): Atom[] {
  const atoms: Atom[] = []
  for (let page = 0; page < pages.length; page++) {
    const paragraphs = pages[page]
      .split(/\n{2,}/)
      .map(paragraph => paragraph.trim())
      .filter(Boolean)
    for (const paragraph of paragraphs) {
      if (paragraph.length > maxChars) atoms.push(...splitOversized(paragraph, maxChars, page))
      else atoms.push({ text: paragraph, page, breakBefore: true })
    }
  }
  return atoms
}

/** 原子序列按渲染规则拼成实际文本；`\n\n` 只出现在段落边界。 */
function joinAtoms(atoms: Atom[]): string {
  let out = ''
  for (let i = 0; i < atoms.length; i++) {
    if (i > 0 && atoms[i].breakBefore) out += '\n\n'
    out += atoms[i].text
  }
  return out
}

function makeBlock(atoms: Atom[], index: number, runningLines: Set<string>): EvidenceBlock {
  const rawText = joinAtoms(atoms)
  return {
    id: `B${String(index + 1).padStart(3, '0')}`,
    rawText,
    normalizedText: normalizeEvidenceText(rawText, runningLines),
    startPage: atoms[0].page,
    endPage: atoms[atoms.length - 1].page,
    order: index,
    previousId: null,
    nextId: null,
    sourceType: classifySourceType(rawText),
  }
}

/**
 * 把逐页原文切成原文证据块（§5）。
 *
 * 分块只服务上下文预算，**不决定语义树结构**：达到 `targetChars` 后即在
 * 下一个自然段落边界封块，单段超过 `maxChars` 时按字符硬切以保证有界。
 */
export function buildEvidenceBlocks(pages: string[], opts: EvidenceBlockOptions = {}): EvidenceBlock[] {
  const targetChars = opts.targetChars ?? DEFAULT_TARGET_CHARS
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS
  const minChars = opts.minChars ?? DEFAULT_MIN_CHARS
  if (!Number.isInteger(targetChars) || targetChars <= 0) throw new Error('targetChars 必须是正整数')
  if (!Number.isInteger(maxChars) || maxChars < targetChars) throw new Error('maxChars 必须是不小于 targetChars 的整数')
  if (!Number.isInteger(minChars) || minChars < 0) throw new Error('minChars 必须是非负整数')

  const runningLines = detectRunningLines(pages)
  const atoms = collectAtoms(pages, maxChars)

  const grouped: Atom[][] = []
  let buffer: Atom[] = []
  for (const atom of atoms) {
    if (buffer.length > 0) {
      const wouldBeLength = joinAtoms([...buffer, atom]).length
      // 达到目标大小即封块；或加上本原子会突破硬上限时先封块
      if (wouldBeLength > maxChars || joinAtoms(buffer).length >= targetChars) {
        grouped.push(buffer)
        buffer = []
      }
    }
    buffer.push(atom)
  }
  if (buffer.length > 0) grouped.push(buffer)

  // 末块过碎时并入前块——但不得因此突破硬上限
  if (grouped.length > 1) {
    const last = grouped[grouped.length - 1]
    const previous = grouped[grouped.length - 2]
    const mergedLength = joinAtoms([...previous, ...last]).length
    if (joinAtoms(last).length < minChars && mergedLength <= maxChars) {
      grouped.splice(grouped.length - 2, 2, [...previous, ...last])
    }
  }

  const blocks = grouped.map((atomsInBlock, index) => makeBlock(atomsInBlock, index, runningLines))
  for (let i = 0; i < blocks.length; i++) {
    blocks[i].previousId = i > 0 ? blocks[i - 1].id : null
    blocks[i].nextId = i + 1 < blocks.length ? blocks[i + 1].id : null
  }
  return blocks
}

/** 按 ID 建立索引，供语义树引用解析。 */
export function indexBlocksById(blocks: EvidenceBlock[]): Map<string, EvidenceBlock> {
  return new Map(blocks.map(block => [block.id, block]))
}

/** 以块 ID 反查相邻块，用于取证时补齐上下文（§9）。 */
export function collectWithNeighbours(
  blocks: EvidenceBlock[],
  ids: Iterable<string>,
  radius = 1,
): EvidenceBlock[] {
  const byId = indexBlocksById(blocks)
  const picked = new Set<number>()
  for (const id of ids) {
    const anchor = byId.get(id)
    if (!anchor) continue
    for (let offset = -radius; offset <= radius; offset++) {
      const candidate = blocks[anchor.order + offset]
      if (candidate) picked.add(candidate.order)
    }
  }
  return [...picked].sort((a, b) => a - b).map(order => blocks[order])
}
