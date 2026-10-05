import { buildBm25Scorer, type ScoredDoc } from '../../../src/utils/bm25'
import { cosineSimilarity, type Embedder } from '../../../src/utils/embedder'
import { hashCanonical, requireThat } from './contract'
import { validateTocTree, type TocTreeArtifact, type TocTreeNode } from './tocTree'
import { materializePageRanges, resolveTocNodeIds } from './tocRouting'

export interface HeadingConfig {
  algorithm: 'bm25' | 'dense' | 'hybrid'
  topK: number
  rrfK: number
  contextBudget: number
}
const config = (algorithm: HeadingConfig['algorithm'], topK: number): HeadingConfig => ({ algorithm, topK, rrfK: 60, contextBudget: 4096 })
export const E_METHOD_CONFIGS = {
  'E-bm25-k3': config('bm25', 3),
  'E-dense-k3': config('dense', 3),
  'E-hybrid-k1': config('hybrid', 1),
  'E-hybrid-k3': config('hybrid', 3),
  'E-hybrid-k5': config('hybrid', 5),
} as const
export type HeadingMethod = keyof typeof E_METHOD_CONFIGS
export const isHeadingMethod = (method: string): method is HeadingMethod => Object.hasOwn(E_METHOD_CONFIGS, method)
export interface HeadingNode {
  nodeId: string
  path: string
  startPage: number
  endPage: number
}
export interface HeadingIndexArtifact {
  version: 'heading-hierarchy-v1'
  treeInputSha256: string
  config: HeadingConfig
  configSha256: string
  embedderId: string | null
  nodes: HeadingNode[]
  vectors: number[][]
}
export interface HeadingDiagnostic {
  configSha256: string
  ranking: Array<{ nodeId: string; bm25Score: number; denseScore: number | null; score: number }>
  selectedNodeIds: string[]
  selectedRanges: Array<{ nodeId: string; startPage: number; endPage: number }>
}
export function expandHeadingPaths(tree: TocTreeArtifact): HeadingNode[] {
  const out: HeadingNode[] = []
  const visit = (nodes: TocTreeNode[], ancestors: string[]) => {
    for (const node of nodes) {
      const title = node.title.replace(/^\d+(?:\.\d+)*\.?\s+/, '').trim()
      requireThat(title.length > 0, 'empty heading path component')
      const path = [...ancestors, title]
      out.push({ nodeId: node.id, path: path.join(' > '), startPage: node.startPage, endPage: node.endPage })
      visit(node.children, path)
    }
  }
  visit(tree.roots, [])
  return out
}
const rank = (scores: ScoredDoc[]) => [...scores].sort((a, b) => b.score - a.score || a.id - b.id)
const validVector = (v: Float32Array, dim: number) => v instanceof Float32Array && v.length === dim && dim > 0 && v.every(Number.isFinite) && v.some(x => x !== 0)

export async function prepareHeadingRetrieval(
  tree: TocTreeArtifact,
  pages: string[],
  deps: { countTokens: (s: string) => number; embedder?: Embedder },
  options: HeadingConfig,
) {
  requireThat(['bm25', 'dense', 'hybrid'].includes(options.algorithm), 'invalid heading algorithm')
  requireThat(Number.isInteger(options.topK) && options.topK > 0, 'invalid heading topK')
  requireThat(Number.isFinite(options.rrfK) && options.rrfK > 0, 'invalid RRF constant')
  requireThat(Number.isInteger(options.contextBudget) && options.contextBudget > 0, 'invalid context budget')
  validateTocTree(tree, pages.length)
  const nodes = expandHeadingPaths(tree)
  const bm25 = buildBm25Scorer(nodes.map(node => `${node.path}\n${pages.slice(node.startPage, node.endPage + 1).join('\n\n')}`))
  const dense = options.algorithm !== 'bm25'
  requireThat(!dense || deps.embedder, 'heading embedder required')
  const vectors = dense ? await deps.embedder!.embedPassages(nodes.map(node => node.path)) : []
  const dim = vectors[0]?.length ?? 0
  requireThat(!dense || vectors.length === nodes.length && vectors.every(v => validVector(v, dim)), 'invalid heading vectors')
  const configSha256 = hashCanonical({ version: 'heading-hierarchy-v1', ...options, bm25: { k1: 1.2, b: 0.75 }, lexicalInput: 'path+original-page-range', denseInput: 'full-heading-path', zeroBm25RankCredit: false, parentSelection: 'prefer-selected-child' })
  const index: HeadingIndexArtifact = {
    version: 'heading-hierarchy-v1', treeInputSha256: tree.inputSha256,
    config: { ...options }, configSha256, embedderId: dense ? deps.embedder!.id : null,
    nodes, vectors: vectors.map(v => Array.from(v)),
  }
  return {
    index,
    async retrieve(question: string) {
      requireThat(question.trim().length > 0, 'empty heading query')
      const lexical = bm25(question)
      let similarities: ScoredDoc[] = []
      if (dense) {
        const query = await deps.embedder!.embedQuery(question)
        requireThat(validVector(query, dim), 'invalid heading query vector')
        similarities = vectors.map((v, id) => ({ id, score: cosineSimilarity(query, v) }))
      }
      const fused = new Map<number, number>()
      if (options.algorithm === 'hybrid') {
        for (const scores of [rank(lexical.filter(s => s.score > 0)), rank(similarities)]) {
          scores.forEach((s, i) => fused.set(s.id, (fused.get(s.id) ?? 0) + 1 / (options.rrfK + i + 1)))
        }
      }
      const ranked = rank(nodes.map((_, id) => ({ id, score: options.algorithm === 'bm25' ? lexical[id].score : options.algorithm === 'dense' ? similarities[id].score : fused.get(id) ?? 0 })))
      const selectedNodeIds = resolveTocNodeIds(ranked.slice(0, options.topK).map(s => nodes[s.id].nodeId), tree)
      const selectedRanges = selectedNodeIds.map(nodeId => {
        const node = nodes.find(n => n.nodeId === nodeId)!
        return { nodeId, startPage: node.startPage, endPage: node.endPage }
      })
      const heading: HeadingDiagnostic = {
        configSha256,
        ranking: ranked.map(s => ({ nodeId: nodes[s.id].nodeId, bm25Score: lexical[s.id].score, denseScore: dense ? similarities[s.id].score : null, score: s.score })),
        selectedNodeIds, selectedRanges,
      }
      return { ...materializePageRanges(pages, selectedRanges, deps.countTokens, options.contextBudget), heading }
    },
  }
}
