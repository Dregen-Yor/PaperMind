import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { LLMFn } from './llm'

pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.min.mjs'

// ── 语义分块：节标题识别模式（英文 + 中文）───────────────────────────────────
const SECTION_PATTERNS: RegExp[] = [
  // 英文编号节标题："1. Introduction"、"2 Methods"、"1.1 Background"
  /^(\d+\.?\d*\.?\s+)[A-Z][a-zA-Z\s]{2,}$/,
  // 英文全大写标题："INTRODUCTION"、"RELATED WORK"
  /^[A-Z][A-Z\s]{3,30}$/,
  // 常见节名称（大小写不敏感）
  /^(Abstract|Introduction|Methods?|Results?|Discussion|Conclusion|References|Acknowledgements?|Appendix)$/i,
  // 中文章节："第一章"、"第3节"
  /^第[一二三四五六七八九十\d]+[章节]/,
  // 中文编号节："1 引言"、"3.1 实验设置"、"1.1 研究背景"
  /^\d+(?:\.\d+)*[\s]+[一-龥]{2,10}$/,
]

/** 扫描每页文本，返回节标题所在的页码索引列表（0-based）。 */
export function detectSectionBoundaries(pages: string[]): number[] {
  const boundaries: number[] = []
  let previousHeading: string | undefined
  let previousHeadingPage = -2
  for (let i = 0; i < pages.length; i++) {
    const lines = pages[i].split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    const heading = lines.find(line => SECTION_PATTERNS.some(pattern => pattern.test(line)))
    // Running headers often repeat the section title on every adjacent page. Keep its
    // first occurrence as the boundary, rather than turning each page into a section.
    const normalizedHeading = heading?.replace(/\s+/g, ' ').toLocaleLowerCase()
    if (heading && !(normalizedHeading === previousHeading && previousHeadingPage === i - 1)) {
      boundaries.push(i)
    }
    if (normalizedHeading) {
      previousHeading = normalizedHeading
      previousHeadingPage = i
    }
  }
  return boundaries
}

/** 将不足 minPages 页的节并入前一节（若无前节则并入后节）。 */
export function mergeSmallSections(
  ranges: Array<{ start: number; end: number }>,
  minPages = 2,
): Array<{ start: number; end: number }> {
  const result = [...ranges]
  let i = 0
  while (i < result.length) {
    const size = result[i].end - result[i].start + 1
    if (size < minPages && result.length > 1) {
      if (i > 0) {
        // 并入前一节
        result[i - 1] = { start: result[i - 1].start, end: result[i].end }
        result.splice(i, 1)
      } else {
        // 首节并入后一节
        result[1] = { start: result[0].start, end: result[1].end }
        result.splice(0, 1)
      }
    } else {
      i++
    }
  }
  return result
}

export interface IndexNode {
  title: string
  nodeId: string
  startPage: number // 0-based inclusive
  endPage: number   // 0-based inclusive
  summary: string
  nodes: IndexNode[]
}

const CHUNK = 5 // pages per leaf

export async function extractPages(base64: string): Promise<string[]> {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const pdf = await pdfjsLib.getDocument({ data: bytes.buffer }).promise
  const pages: string[] = []
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()
    pages.push(reconstructTextLines(content.items as PdfTextItem[]))
  }
  return pages
}

interface PdfTextItem {
  str?: string
  transform?: number[]
  hasEOL?: boolean
}

/** Rebuild visual text lines from PDF.js items so line-anchored headings survive extraction. */
export function reconstructTextLines(items: PdfTextItem[]): string {
  const lines: Array<{ y: number; items: Array<{ x: number; text: string }> }> = []
  let current: { y: number; items: Array<{ x: number; text: string }> } | undefined
  const flush = () => { current = undefined }
  for (const item of items) {
    const text = item.str?.trim()
    if (!text) continue
    const x = item.transform?.[4] ?? 0
    const y = item.transform?.[5] ?? 0
    if (!current || Math.abs(current.y - y) > 2) {
      current = { y, items: [] }
      lines.push(current)
    }
    current.items.push({ x, text })
    if (item.hasEOL) flush()
  }
  return lines
    .map(line => line.items.sort((a, b) => a.x - b.x).map(item => item.text).join(' '))
    .join('\n')
}

async function summarizeRange(
  pages: string[], start: number, end: number, nodeId: string, llm: LLMFn
): Promise<IndexNode> {
  const text = pages.slice(start, end + 1).join('\n\n').slice(0, 3000)
  const prompt = `Index pages ${start + 1}-${end + 1} of an academic paper.\n\nText:\n${text}\n\nReply JSON only: {"title":"...","summary":"2-3 sentences"}`
  let title = `Pages ${start + 1}–${end + 1}`
  let summary = ''
  try {
    const raw = (await llm(prompt)).replace(/```json\n?|```/g, '').trim()
    const p = JSON.parse(raw)
    title = p.title || title
    summary = p.summary || ''
  } catch { /* keep defaults */ }
  return { title, nodeId, startPage: start, endPage: end, summary, nodes: [] }
}

export interface IndexOptions {
  /** 固定切块时每块页数，默认 5 */
  chunkPages?: number
  /** 语义分块后合并小节的最小页数，默认 2 */
  minSectionPages?: number
  /** 强制使用固定切块，跳过语义分块（消融对比用），默认 false */
  forceFixedChunk?: boolean
  /** Semantic sections longer than this are split into bounded leaves. */
  maxSectionPages?: number
}

export async function buildPageIndex(
  pages: string[],
  llm: LLMFn,
  opts: IndexOptions = {},
): Promise<IndexNode> {
  const { chunkPages = CHUNK, minSectionPages = 2, forceFixedChunk = false, maxSectionPages } = opts
  if (maxSectionPages !== undefined && (!Number.isInteger(maxSectionPages) || maxSectionPages < minSectionPages)) {
    throw new Error('maxSectionPages must be an integer greater than or equal to minSectionPages')
  }
  // 语义分块：识别节边界；边界不足2个时降级为固定切块
  const boundaries = forceFixedChunk ? [] : detectSectionBoundaries(pages)
  let ranges: Array<{ start: number; end: number; part?: number }>

  if (boundaries.length >= 2) {
    ranges = boundaries.map((start, i) => ({
      start,
      end: i + 1 < boundaries.length ? boundaries[i + 1] - 1 : pages.length - 1,
    }))
    // Prepend pre-heading pages (title, abstract, etc.) if the first boundary is not page 0
    if (boundaries[0] > 0) {
      ranges.unshift({ start: 0, end: boundaries[0] - 1 })
    }
    ranges = mergeSmallSections(ranges, minSectionPages)
  } else {
    // 降级：固定切块（原有行为）
    ranges = []
    for (let i = 0; i < pages.length; i += chunkPages) {
      ranges.push({ start: i, end: Math.min(i + chunkPages - 1, pages.length - 1) })
    }
  }

  if (maxSectionPages !== undefined) {
    ranges = ranges.flatMap(range => {
      const pieces: Array<{ start: number; end: number; part?: number }> = []
      for (let start = range.start; start <= range.end; start += maxSectionPages) {
        pieces.push({ start, end: Math.min(start + maxSectionPages - 1, range.end), part: pieces.length + 1 })
      }
      // Do not turn a small remainder into a one-page leaf after min-section merging.
      if (pieces.length > 1 && pieces.at(-1)!.end - pieces.at(-1)!.start + 1 < minSectionPages) {
        pieces[pieces.length - 2].end = pieces.at(-1)!.end
        pieces.pop()
      }
      if (pieces.length === 1) delete pieces[0].part
      return pieces
    })
  }

  const leaves: IndexNode[] = []
  for (let i = 0; i < ranges.length; i++) {
    const { start, end } = ranges[i]
    const leaf = await summarizeRange(pages, start, end, String(i), llm)
    if (ranges[i].part) leaf.title = `${leaf.title} (Part ${ranges[i].part})`
    leaves.push(leaf)
  }
  if (leaves.length === 1) return leaves[0]

  const sectionList = leaves.map((n, i) => `[${i + 1}] ${n.title}: ${n.summary}`).join('\n')
  const prompt = `Create a top-level index for an academic paper.\n\nSections:\n${sectionList}\n\nReply JSON only: {"title":"...","summary":"2-3 sentences"}`
  let title = 'Paper'
  let summary = ''
  try {
    const raw = (await llm(prompt)).replace(/```json\n?|```/g, '').trim()
    const p = JSON.parse(raw)
    title = p.title || title
    summary = p.summary || ''
  } catch { /* keep defaults */ }

  return { title, nodeId: 'root', startPage: 0, endPage: pages.length - 1, summary, nodes: leaves }
}

export interface NodeScore {
  id: number
  score: number
}

export interface ScoreOptions {
  /** 最多选取几个节点（含最高分节点本身），默认 2 */
  topK?: number
  /** 除最高分节点外，其余节点纳入所需的最低分，默认 4 */
  minScore?: number
}

export interface RetrievalResult {
  context: string
  sources: string[]
  /** 结构化选中节点（含页码区间），供评测直接取用，无需解析 sources 字符串 */
  selected: IndexNode[]
  /** LLM 返回的原始打分；降级或短路时为空数组 */
  scores: NodeScore[]
  /** 是否走了降级路径（LLM 响应不可用，回退到第一个节点） */
  degraded: boolean
  /** 本次检索是否实际发出了 LLM 打分请求（单叶节点短路时为 false） */
  llmCalled: boolean
  /** A stable diagnostic for degraded score parsing, if applicable. */
  degradedReason?: 'invalid-json' | 'invalid-score-schema' | 'incomplete-score-coverage' | 'score-request-failed'
}

function formatSource(n: IndexNode): string {
  return `Pages ${n.startPage + 1}–${n.endPage + 1}: ${n.title}`
}

/**
 * 平面索引的叶节点。单节点文档（buildPageIndex 直接返回叶子）时叶节点就是树本身——
 * 传空数组会让下游的 MRR 静默变 0。
 */
export function collectLeafNodes(root: IndexNode): IndexNode[] {
  return root.nodes.length > 0 ? root.nodes : [root]
}

export function parseAndValidateScores(raw: string, leafCount: number): NodeScore[] {
  const cleaned = raw.replace(/```(?:json)?\s*|```/gi, '').trim()
  const start = cleaned.indexOf('[')
  const end = cleaned.lastIndexOf(']')
  if (start < 0 || end < start) throw new Error('invalid-json')
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1))
  } catch {
    throw new Error('invalid-json')
  }
  if (!Array.isArray(parsed)) throw new Error('invalid-score-schema')
  const seen = new Set<number>()
  const scores: NodeScore[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') throw new Error('invalid-score-schema')
    const { id, score } = item as Record<string, unknown>
    if (typeof id !== 'number' || !Number.isInteger(id) || typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 10 || id < 0 || id >= leafCount || seen.has(id)) {
      throw new Error('invalid-score-schema')
    }
    seen.add(id)
    scores.push({ id, score })
  }
  if (seen.size !== leafCount) throw new Error('incomplete-score-coverage')
  return scores
}

/** 对所有叶节点打分，返回 Top-K 合并上下文。JSON 解析失败时降级为第一节点。 */
export async function scoreAndSelect(
  root: IndexNode,
  pages: string[],
  query: string,
  llm: LLMFn,
  opts: ScoreOptions = {},
): Promise<RetrievalResult> {
  const { topK = 2, minScore = 4 } = opts
  // 收集叶节点（无子节点的节点）
  const leaves = collectLeafNodes(root)

  // 单节点无需调用 LLM
  if (leaves.length === 1) {
    const leaf = leaves[0]
    return {
      context: pages.slice(leaf.startPage, leaf.endPage + 1).join('\n\n'),
      sources: [formatSource(leaf)],
      selected: [leaf],
      scores: [],
      degraded: false,
      llmCalled: false,
    }
  }

  const options = leaves.map((n, i) => `[${i}] ${n.title}: ${n.summary}`).join('\n')
  const prompt = `Query: ${query}\n\nSections:\n${options}\n\nRate each section's relevance to the query (0-10).\nReturn JSON only: [{"id":0,"score":8},{"id":1,"score":2},...]`

  let selected: IndexNode[]
  let scores: NodeScore[] = []
  let degraded = false
  let degradedReason: RetrievalResult['degradedReason']
  try {
    scores = parseAndValidateScores(await llm(prompt), leaves.length)
    const sorted = [...scores].sort((a, b) => b.score - a.score)

    // 最高分节点无条件纳入；其余需达到 minScore
    const picked: IndexNode[] = [leaves[sorted[0].id]]
    for (const s of sorted.slice(1, topK)) {
      if (s.score >= minScore) picked.push(leaves[s.id])
    }

    // 按文档顺序排列（startPage 升序）
    selected = [...new Map(picked.map(node => [node.nodeId, node])).values()]
      .sort((a, b) => a.startPage - b.startPage)
  } catch (error) {
    scores = []
    degraded = true
    degradedReason = error instanceof Error && [
      'invalid-json',
      'invalid-score-schema',
      'incomplete-score-coverage',
    ].includes(error.message)
      ? error.message as RetrievalResult['degradedReason']
      : 'score-request-failed'
    selected = [leaves[0]]
  }

  const context = selected
    .map(n => pages.slice(n.startPage, n.endPage + 1).join('\n\n'))
    .join('\n\n---\n\n')

  return { context, sources: selected.map(formatSource), selected, scores, degraded, llmCalled: true, ...(degradedReason ? { degradedReason } : {}) }
}
