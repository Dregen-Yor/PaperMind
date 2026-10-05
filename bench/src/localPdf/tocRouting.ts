import { CONTEXT_GROUP_SEPARATOR } from '../../../src/utils/contextTrace'
import type { ContextTrace } from '../../../src/utils/sourceTrace'
import { hashCanonical, requireThat } from './contract'
import { graphemePrefixWithinBudget } from './context'
import { flattenTocTree, type TocTreeArtifact, type TocTreeNode } from './tocTree'

export const TOC_ROUTING_CONFIG = {
  maxNodeIds: 3,
  logicalAttempts: 2,
  contextBudget: 4096,
} as const

export const TOC_ROUTING_PROMPT_VERSION = 'toc-routing-v1'
export const TOC_ROUTING_CONFIG_SHA256 = hashCanonical({
  version: TOC_ROUTING_PROMPT_VERSION,
  ...TOC_ROUTING_CONFIG,
})

export interface TocRoutingDiagnostic {
  rawAttempts: string[]
  rejectionReasons?: string[]
  reasoning: string
  requestedNodeIds: string[]
  selectedNodeIds: string[]
  selectedRanges: Array<{ nodeId: string; startPage: number; endPage: number }>
}

export class TocRoutingError extends Error {
  constructor(readonly diagnostic: TocRoutingDiagnostic) {
    super('TOC routing failed after two invalid logical attempts')
    this.name = 'TocRoutingError'
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'unknown routing failure'
}

function renderNode(node: TocTreeNode): string[] {
  const indent = '  '.repeat(node.depth)
  const range = node.startPage === node.endPage
    ? `${node.startPage + 1}`
    : `${node.startPage + 1}-${node.endPage + 1}`
  return [
    `${indent}${node.id}  ${node.title}  [pages ${range}]`,
    ...node.children.flatMap(renderNode),
  ]
}

export function buildTocRoutingPrompt(question: string, tree: TocTreeArtifact): string {
  requireThat(typeof question === 'string' && question.trim().length > 0, 'invalid question')
  return [
    `Question: ${question}`,
    '',
    'Sections:',
    ...tree.roots.flatMap(renderNode),
    '',
    `Return exactly one JSON object: {"reasoning":"...","node_ids":["id"]}. Select 1-${TOC_ROUTING_CONFIG.maxNodeIds} IDs.`,
  ].join('\n')
}

export function parseTocRoutingResponse(raw: string, tree?: TocTreeArtifact): { reasoning: string; nodeIds: string[] } {
  requireThat(typeof raw === 'string', 'routing response must be text')
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('invalid routing JSON') }
  requireThat(value !== null && typeof value === 'object' && !Array.isArray(value), 'routing response must be one object')
  const object = value as Record<string, unknown>
  requireThat(Object.keys(object).sort().join(',') === 'node_ids,reasoning', 'routing response has invalid fields')
  requireThat(typeof object.reasoning === 'string', 'routing reasoning must be a string')
  requireThat(Array.isArray(object.node_ids)
    && object.node_ids.length >= 1
    && object.node_ids.length <= TOC_ROUTING_CONFIG.maxNodeIds
    && object.node_ids.every(id => typeof id === 'string'), 'routing node_ids must contain one to three strings')
  const nodeIds = object.node_ids as string[]
  if (tree) {
    const known = new Set(flattenTocTree(tree).map(node => node.id))
    requireThat(nodeIds.every(id => known.has(id)), 'routing response contains unknown node ID')
  }
  return { reasoning: object.reasoning, nodeIds }
}

export function resolveTocNodeIds(requested: string[], tree: TocTreeArtifact): string[] {
  const known = new Set(flattenTocTree(tree).map(node => node.id))
  const unique = requested.filter((id, index) => known.has(id) && requested.indexOf(id) === index)
  return unique.filter(id => !unique.some(other => other !== id && other.startsWith(`${id}.`)))
}

export async function routeTocQuestion(
  question: string,
  tree: TocTreeArtifact,
  complete: (prompt: string) => Promise<string>,
): Promise<TocRoutingDiagnostic> {
  const rawAttempts: string[] = []
  const rejectionReasons: string[] = []
  const prompt = buildTocRoutingPrompt(question, tree)
  for (let attempt = 0; attempt < TOC_ROUTING_CONFIG.logicalAttempts; attempt++) {
    let raw: string
    try { raw = await complete(prompt) }
    catch (error) { rejectionReasons.push(errorMessage(error)); continue }
    rawAttempts.push(raw)
    try {
      const parsed = parseTocRoutingResponse(raw, tree)
      const selectedNodeIds = resolveTocNodeIds(parsed.nodeIds, tree)
      requireThat(selectedNodeIds.length > 0, 'routing selected no valid nodes')
      const nodes = new Map(flattenTocTree(tree).map(node => [node.id, node]))
      return {
        rawAttempts,
        reasoning: parsed.reasoning,
        requestedNodeIds: parsed.nodeIds,
        selectedNodeIds,
        selectedRanges: selectedNodeIds.map(nodeId => {
          const node = nodes.get(nodeId)!
          return { nodeId, startPage: node.startPage, endPage: node.endPage }
        }),
      }
    } catch (error) {
      rejectionReasons.push(errorMessage(error))
      // A malformed logical response consumes one of the two explicit attempts.
    }
  }
  throw new TocRoutingError({
    rawAttempts,
    rejectionReasons,
    reasoning: '',
    requestedNodeIds: [],
    selectedNodeIds: [],
    selectedRanges: [],
  })
}

export function materializePageRanges(
  pages: string[],
  ranges: Array<{ nodeId: string; startPage: number; endPage: number }>,
  countTokens: (text: string) => number,
  maxTokens: number,
): { text: string; trace: ContextTrace[]; tokenCount: number } {
  requireThat(Number.isInteger(maxTokens) && maxTokens > 0, 'invalid context budget')
  const seenPages = new Set<number>()
  let text = ''
  const trace: ContextTrace[] = []
  let emittedGroups = 0

  const append = (raw: string, passageId: string, source: ContextTrace['source']): boolean => {
    if (!raw.length) return true
    const take = graphemePrefixWithinBudget(text, raw, countTokens, maxTokens)
    if (take === 0) return false
    const contextStart = text.length
    text += raw.slice(0, take)
    trace.push({
      passageId,
      contextStart,
      contextEnd: text.length,
      source: source ? { ...source, end: source.start + take } : null,
    })
    return take === raw.length
  }

  for (const range of ranges) {
    requireThat(typeof range.nodeId === 'string' && range.nodeId.length > 0, 'invalid node range ID')
    requireThat(Number.isInteger(range.startPage) && Number.isInteger(range.endPage)
      && range.startPage >= 0 && range.startPage <= range.endPage && range.endPage < pages.length, 'invalid page range')
    const selectedPages: number[] = []
    for (let page = range.startPage; page <= range.endPage; page++) {
      if (!seenPages.has(page)) selectedPages.push(page)
    }
    if (!selectedPages.length) continue
    selectedPages.forEach(page => seenPages.add(page))
    const contentPages = selectedPages.filter(page => pages[page].length > 0)
    if (!contentPages.length) continue
    const groupPrefix = emittedGroups > 0 ? CONTEXT_GROUP_SEPARATOR : ''
    if (groupPrefix && !append(groupPrefix, range.nodeId, null)) break
    for (let index = 0; index < contentPages.length; index++) {
      const page = contentPages[index]
      const pagePrefix = index > 0 ? '\n\n' : ''
      if (pagePrefix && !append(pagePrefix, range.nodeId, null)) return { text, trace, tokenCount: countTokens(text) }
      if (!append(pages[page], range.nodeId, { page, start: 0, end: pages[page].length })) {
        return { text, trace, tokenCount: countTokens(text) }
      }
    }
    emittedGroups++
  }
  return { text, trace, tokenCount: countTokens(text) }
}
