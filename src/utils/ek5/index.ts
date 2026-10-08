import type { ExtractedPdfDocument } from '../pdfDocument'
import type { Embedder } from '../embedder'
import { cosineSimilarity } from '../embedder'
import { buildBm25Scorer } from '../bm25'
import { buildTocTree } from './tocTree'
import { extractHeadingCandidates, extractVerifiedTocCandidates } from './tocCandidates'
import { buildHeadingGroups, materializeHeadingGroups, type HeadingGroups } from './headingGroups'
import { hashCanonical, requireThat } from './contract'
import type { RetrievalResult } from '../pageIndex'

export interface Ek5Index {
  version: 'ek5-product-v1'
  paperId: string
  sourceSha256: string
  embedderId: string
  groups: HeadingGroups
  vectors: number[][]
}
const validVector = (v: number[], dim: number) => Array.isArray(v) && v.length === dim && dim > 0 && v.every(Number.isFinite) && v.some(n => n !== 0)
export async function buildEk5Index(paperId: string, doc: ExtractedPdfDocument, embedder: Embedder): Promise<Ek5Index> {
  requireThat(doc.pages.some(p => p.trim()), '论文没有可提取的文本，请使用带文本层的 PDF。')
  const headingCandidates = extractHeadingCandidates(doc.layoutLines)
  let groups: HeadingGroups
  try {
    const tree = buildTocTree({ paperId, pageCount: doc.pages.length, outline: doc.outline,
      headingCandidates, tocCandidates: extractVerifiedTocCandidates(doc.layoutLines, headingCandidates) })
    groups = buildHeadingGroups(tree, doc.pages)
  } catch {
    throw new Error('无法识别这篇论文的章节结构。请检查 PDF 文本层，或划选原文提问。')
  }
  const vectors = (await embedder.embedPassages(groups.groups.map(g => g.path))).map(v => Array.from(v))
  requireThat(vectors.length === groups.groups.length && vectors.every(v => validVector(v, vectors[0]?.length)), '章节向量构建失败，请重试。')
  return { version: 'ek5-product-v1', paperId, sourceSha256: hashCanonical(doc.pages), embedderId: embedder.id, groups, vectors }
}
export function parseEk5Index(raw: string, pages: string[], embedderId: string): Ek5Index | undefined {
  try {
    const x = JSON.parse(raw) as Ek5Index
    requireThat(x.version === 'ek5-product-v1' && x.embedderId === embedderId && x.sourceSha256 === hashCanonical(pages), 'stale index')
    requireThat(x.groups.version === 'leaf-groups-v1' && x.groups.sourceSha256 === x.sourceSha256 && x.groups.groups.length > 0, 'invalid groups')
    requireThat(x.vectors.length === x.groups.groups.length && x.vectors.every(v => validVector(v, x.vectors[0]?.length)), 'invalid vectors')
    const ids = new Set<string>()
    const labels = new Set<string>()
    for (const g of x.groups.groups) {
      requireThat(typeof g.id === 'string' && /^G\d+$/.test(g.id) && !labels.has(g.id) && typeof g.nodeId === 'string' && g.nodeId.length > 0 && g.path.trim() && !ids.has(g.nodeId) && g.ranges.length > 0, 'invalid group')
      labels.add(g.id)
      ids.add(g.nodeId)
      for (const r of g.ranges) requireThat(Number.isInteger(r.page) && Number.isInteger(r.start) && Number.isInteger(r.end) && r.page >= 0 && r.page < pages.length && r.start >= 0 && r.end > r.start && r.end <= pages[r.page].length, 'invalid range')
      requireThat(g.text === g.ranges.map(r => pages[r.page].slice(r.start, r.end)).join('\n\n') && g.textSha256 === hashCanonical(g.text), 'changed text')
    }
    return x
  } catch { return undefined }
}
const scorers = new WeakMap<Ek5Index, ReturnType<typeof buildBm25Scorer>>()
export async function retrieveEk5(index: Ek5Index, query: string, embedder: Embedder): Promise<RetrievalResult> {
  requireThat(query.trim().length > 0, '请输入检索问题。')
  requireThat(index.embedderId === embedder.id, '检索模型已变更，请重建索引。')
  const groups = index.groups.groups
  let bm25 = scorers.get(index)
  if (!bm25) { bm25 = buildBm25Scorer(groups.map(g => `${g.path}\n${g.text}`)); scorers.set(index, bm25) }
  const vector = Array.from(await embedder.embedQuery(query))
  requireThat(validVector(vector, index.vectors[0].length), '查询向量无效，请重试。')
  const rank = (items: Array<{ id: number; score: number }>) => items.sort((a, b) => b.score - a.score || a.id - b.id)
  const lexical = rank(bm25(query).filter(s => s.score > 0))
  const dense = rank(index.vectors.map((v, id) => ({ id, score: cosineSimilarity(new Float32Array(vector), new Float32Array(v)) })))
  const scores = groups.map((_, id) => ({ id, score: 0 }))
  for (const list of [lexical, dense]) list.forEach((s, i) => { scores[s.id].score += 1 / (60 + i + 1) })
  const chosen = rank(scores).slice(0, 5)
  const selected = chosen.map(s => {
    const g = groups[s.id]
    return { nodeId: g.nodeId, nodes: [], title: g.path, summary: '', startPage: g.ranges[0].page, endPage: g.ranges.at(-1)!.page, score: s.score }
  })
  const { text } = materializeHeadingGroups(groups, selected.map(s => s.nodeId))
  return { context: text, selected, sources: selected.map(g => `${g.title} · 第 ${g.startPage + 1}–${g.endPage + 1} 页`), llmCalled: false, scores: [], degraded: false,
    contextGroups: selected.map(s => ({ pieces: [{ page: s.startPage, text: materializeHeadingGroups(groups, [s.nodeId]).text }] })) }
}
