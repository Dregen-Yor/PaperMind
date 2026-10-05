import { hashCanonical, requireThat, uniqueIds } from './contract'
import { E_METHOD_CONFIGS, expandHeadingPaths, headingConfigSha256, rankHeadingScores, type HeadingDiagnostic, type HeadingIndexArtifact, type HeadingMethod } from './headingRetrieval'
import type { TocTreeArtifact } from './tocTree'
import { resolveTocNodeIds } from './tocRouting'

export function validateHeadingIndex(value: unknown, method: HeadingMethod, tree: TocTreeArtifact): HeadingIndexArtifact {
  const index = value as HeadingIndexArtifact
  requireThat(index?.version === 'heading-hierarchy-v1', 'invalid heading index version')
  requireThat(index.treeInputSha256 === tree.inputSha256, 'heading tree identity mismatch')
  requireThat(hashCanonical(index.config) === hashCanonical(E_METHOD_CONFIGS[method]), 'heading method config mismatch')
  requireThat(index.configSha256 === headingConfigSha256(index.config), 'heading config hash mismatch')
  const nodes = expandHeadingPaths(tree)
  requireThat(Array.isArray(index.nodes) && hashCanonical(index.nodes) === hashCanonical(nodes), 'heading nodes mismatch')
  requireThat(Array.isArray(index.vectors), 'invalid heading vectors')
  if (index.config.algorithm === 'bm25') {
    requireThat(index.embedderId === null && index.vectors.length === 0, 'BM25 heading index must not contain embeddings')
  } else {
    requireThat(typeof index.embedderId === 'string' && index.embedderId.length > 0, 'missing heading embedder identity')
    const dim = index.vectors[0]?.length ?? 0
    requireThat(dim > 0 && index.vectors.length === nodes.length && nodes.every((_, i) => {
      const vector = index.vectors[i]
      return Array.isArray(vector) && vector.length === dim
        && Array.from(vector).every(Number.isFinite) && vector.some(n => n !== 0)
    }), 'invalid heading vectors')
  }
  return index
}

export function validateHeadingDiagnostic(heading: HeadingDiagnostic, index: HeadingIndexArtifact, tree: TocTreeArtifact): void {
  requireThat(heading.configSha256 === index.configSha256, 'heading diagnostic config mismatch')
  const nodes = index.nodes
  const byId = new Map(heading.ranking.map(n => [n.nodeId, n]))
  uniqueIds(heading.ranking.map(n => n.nodeId))
  requireThat(byId.size === nodes.length && nodes.every(n => byId.has(n.nodeId)), 'heading ranking nodes mismatch')
  const dense = index.config.algorithm !== 'bm25'
  requireThat(heading.ranking.every(n => Number.isFinite(n.bm25Score) && n.bm25Score >= 0
    && Number.isFinite(n.score) && (dense
      ? typeof n.denseScore === 'number' && Number.isFinite(n.denseScore) && Math.abs(n.denseScore) <= 1 + 1e-6
      : n.denseScore === null)), 'invalid heading diagnostic scores')
  const lexical = nodes.map((n, id) => ({ id, score: byId.get(n.nodeId)!.bm25Score }))
  const similarities = dense ? nodes.map((n, id) => ({ id, score: byId.get(n.nodeId)!.denseScore! })) : []
  const ranked = rankHeadingScores(lexical, similarities, index.config)
  requireThat(heading.ranking.every((n, i) => n.nodeId === nodes[ranked[i].id].nodeId
    && Math.abs(n.score - ranked[i].score) <= 1e-12), 'heading ranking scores or order mismatch')
  const selected = resolveTocNodeIds(ranked.slice(0, index.config.topK).map(n => nodes[n.id].nodeId), tree)
  requireThat(hashCanonical(heading.selectedNodeIds) === hashCanonical(selected), 'heading top-k selection mismatch')
  const ranges = selected.map(nodeId => {
    const node = nodes.find(n => n.nodeId === nodeId)!
    return { nodeId, startPage: node.startPage, endPage: node.endPage }
  })
  requireThat(hashCanonical(heading.selectedRanges) === hashCanonical(ranges), 'heading selected ranges mismatch')
}
