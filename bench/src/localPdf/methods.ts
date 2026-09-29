import { buildBm25Scorer } from '../../../src/utils/bm25'
import type { Embedder } from '../../../src/utils/embedder'
import { startPassagePipeline } from '../../../src/utils/passageIndexBuilder'
import { retrievePassageContext, type OutlineScoringNode } from '../../../src/utils/passageRetrieval'
import { buildPdfOutlineIndex, type PdfOutlineEntry, type PdfOutlineNode } from '../../../src/utils/pdfOutline'
import type { Method, ContextTrace } from './types'
import type { PdfTextLine } from '../../../src/utils/pdfDocument'
import { hashCanonical, requireThat } from './contract'
import { materializeTracedContext } from './context'
export const RETRIEVAL_CONFIG = { minTokens: 120, maxTokens: 350, contextBudget: 4096, rrfK: 60, sectionWeight: 0.5, neighbourFactor: 0.5, skipLimit: 20 }
export interface PreparedCorpus { paperId: string; pages: string[]; outline: PdfOutlineEntry[]; layoutLines: PdfTextLine[][] }
export interface MethodDeps { countTokens: (s: string) => number; embedder?: Embedder }
export interface PreparedMethod {
  method: Method
  retrieve?: (question: string) => Promise<{ text: string; trace: ContextTrace[] }>
  fullText?: string; fallbackReason?: string
}
export async function prepareMethod(method: Method, corpus: PreparedCorpus, deps: MethodDeps): Promise<PreparedMethod> {
  if (method === 'R') return { method, fullText: corpus.pages.join('\n\n') }
  const dense = method !== 'A'; const embedder = dense ? deps.embedder : undefined
  requireThat(!dense || embedder, 'dense embedder required')
  const pipeline = await startPassagePipeline(corpus.pages, {
    countTokens: deps.countTokens, embedder, buildStructure: false,
    segmentation: { minTokens: 120, maxTokens: 350 },
    llm: async () => { throw new Error('Index must not call generative LLM') },
    persist: () => {}, passageConfigHash: hashCanonical(RETRIEVAL_CONFIG), structureHash: 'no-generative-structure',
  })
  const index = await pipeline.rest
  requireThat(index.passages.length > 0, 'no passages')
  if (dense) requireThat(index.passageVectors?.length === index.passages.length, 'dense indexing failed')
  let outline: OutlineScoringNode[] | undefined; let fallbackReason: string | undefined
  if (method === 'C') {
    if (!corpus.outline.length) fallbackReason = 'missing-outline'
    else {
      try {
        const roots = buildPdfOutlineIndex(corpus.outline, index.passages, corpus.pages.length)
        const flat: PdfOutlineNode[] = []
        const visit = (nodes: PdfOutlineNode[]) => { for (const n of nodes) { flat.push(n); visit(n.children) } }
        visit(roots)
        const vectors = await embedder!.embedPassages(flat.map(n => [...n.path, n.title].join(' > ')))
        requireThat(vectors.length === flat.length && vectors.every(v => v.length === index.vectorDim && v.every(Number.isFinite)), 'invalid outline vectors')
        outline = flat.map((n, i) => ({ id: n.id, passageOrders: n.passageOrders, vector: vectors[i] }))
      } catch { fallbackReason = 'invalid-outline-or-vectors' }
    }
  }
  const bm25Scorer = buildBm25Scorer(index.passages.map(p => p.searchText))
  return { method, fallbackReason, retrieve: async question => {
    const result = await retrievePassageContext(index, question, { ...RETRIEVAL_CONFIG, maxTokens: 4096, embedder, bm25Scorer, ...(outline ? { outline: { nodes: outline, weight: 0.5 } } : {}) })
    if (dense) requireThat(['bm25+dense', 'bm25+dense+outline'].includes(result.hybrid.retrievalMode), 'dense retrieval failed; refusing lexical fallback')
    return materializeTracedContext(index.passages, result.hybrid.selectedPassageIds, corpus.pages, deps.countTokens, 4096)
  } }
}
