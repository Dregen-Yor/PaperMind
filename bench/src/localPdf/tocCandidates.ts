import type { PdfTextLine } from '../../../src/utils/pdfDocument'
import { isHeadingLine } from '../../../src/utils/sectionHeadings'

export interface TocCandidate {
  title: string
  page: number
  numbering: number[] | null
  indent: number
  fontSize: number
  bold: boolean
  source: 'toc-page' | 'heading'
}

const CAPTION = /^(figure|fig\.|table|algorithm)\b/i
const REFERENCE_ENTRY = /^\p{Lu}[\p{L}'-]+(?:\s+et al\.)?\s+\d{4}[. ]/u
const TOC_HEADING = /^(contents|table of contents)$/i
const TOC_ENTRY = /^(.*?)\s*(?:\.{2,}|\s{2,})\s*([ivxlcdm]+|\d+)$/i
const ARXIV_HEADER = /^arxiv:\d/i
const CODE_MARKER = /(?:<|>|::=|←|%)/u

function normalizeTitle(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim()
}

function numbering(text: string): number[] | null {
  const match = /^(\d+(?:\.\d+)*)\.?\s+/.exec(text.trim())
  return match ? match[1].split('.').map(Number) : null
}

function median(values: number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

export function extractHeadingCandidates(layoutLines: PdfTextLine[][]): TocCandidate[] {
  const lines = layoutLines.flat().filter(line => line.text.trim())
  const bodySize = median(lines.map(line => line.fontSize).filter(size => Number.isFinite(size) && size > 0))
  const repeated = new Map<string, Set<number>>()
  for (const line of lines) {
    const key = `${normalizeTitle(line.text)}\0${Math.round(line.y)}`
    const pages = repeated.get(key) ?? new Set<number>()
    pages.add(line.page); repeated.set(key, pages)
  }
  const topLevelNumberedPerPage = new Map<number, number>()
  for (const line of lines) {
    if (numbering(line.text)?.length !== 1) continue
    topLevelNumberedPerPage.set(line.page, (topLevelNumberedPerPage.get(line.page) ?? 0) + 1)
  }
  return lines.flatMap(line => {
    const title = line.text.trim()
    const key = `${normalizeTitle(title)}\0${Math.round(line.y)}`
    if (repeated.get(key)!.size >= 3 || CAPTION.test(title) || REFERENCE_ENTRY.test(title)) return []
    const numbered = numbering(title)
    if (ARXIV_HEADER.test(title) || !/\p{L}/u.test(title) || CODE_MARKER.test(title) || numbered?.some(part => part <= 0)) return []
    if (numbered?.length === 1) {
      const rest = title.replace(/^\d+\.?\s+/, '')
      const denseListItem = (topLevelNumberedPerPage.get(line.page) ?? 0) >= 4 && !/^\d+\.\s+\p{Lu}/u.test(title)
      if (numbered[0] > 20 || /^\p{Ll}/u.test(rest) || denseListItem) return []
    }
    const words = title.split(/\s+/).length
    const short = title.length <= 100 && words <= 20 && !/[.;:!?。；：！？]$/.test(title)
    const recognized = isHeadingLine(title) !== null
    const typographic = short && bodySize > 0 && line.fontSize >= bodySize * 1.2
    if (!recognized && !typographic) return []
    return [{
      title,
      page: line.page,
      numbering: numbered,
      indent: line.x,
      fontSize: line.fontSize,
      bold: line.bold,
      source: 'heading' as const,
    }]
  })
}

function romanToInt(raw: string): number | null {
  const text = raw.toLocaleUpperCase()
  if (!/^[IVXLCDM]+$/.test(text)) return null
  const values: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 }
  let total = 0
  for (let i = 0; i < text.length; i++) total += values[text[i]] < (values[text[i + 1]] ?? 0) ? -values[text[i]] : values[text[i]]
  const canonical = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'],
    [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ] as const
  let remaining = total; let rebuilt = ''
  for (const [value, symbol] of canonical) while (remaining >= value) { rebuilt += symbol; remaining -= value }
  return total > 0 && rebuilt === text ? total : null
}

function printedPage(raw: string): number | null {
  if (/^\d+$/.test(raw)) {
    const value = Number(raw)
    return Number.isInteger(value) && value > 0 ? value : null
  }
  return romanToInt(raw)
}

export function extractVerifiedTocCandidates(layoutLines: PdfTextLine[][], headings: TocCandidate[]): TocCandidate[] {
  const tocPages = layoutLines.filter(lines => lines.some(line => TOC_HEADING.test(line.text.trim())))
  const parsed = tocPages.flatMap(lines => lines.flatMap(line => {
    const match = TOC_ENTRY.exec(line.text.trim())
    if (!match) return []
    const page = printedPage(match[2])
    const title = match[1].trim()
    return page === null || !title ? [] : [{ line, title, printedPage: page }]
  })).sort((a, b) => a.line.x - b.line.x || b.line.y - a.line.y)
  const headingByTitle = new Map<string, TocCandidate[]>()
  for (const heading of headings) {
    const key = normalizeTitle(heading.title)
    headingByTitle.set(key, [...(headingByTitle.get(key) ?? []), heading])
  }
  const verified = parsed.flatMap(entry => {
    const matches = headingByTitle.get(normalizeTitle(entry.title)) ?? []
    return matches.length === 1 ? [{ ...entry, heading: matches[0], offset: matches[0].page - entry.printedPage }] : []
  })
  if (verified.length < 2 || new Set(verified.map(entry => entry.offset)).size !== 1) return []
  return verified.map(({ line, title, heading }) => ({
    title,
    page: heading.page,
    numbering: numbering(title),
    indent: line.x,
    fontSize: line.fontSize,
    bold: line.bold,
    source: 'toc-page',
  }))
}
