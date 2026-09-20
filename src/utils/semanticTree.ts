/**
 * 轻量语义树（方案 §6–§8）——一次 LLM 全文理解产出的论文导航结构。
 *
 * 定位：树**只承担导航职责**。节点上的 label / description 是模型生成的导航元数据，
 * 不能作为事实依据；回答必须依据节点 evidenceRefs 回到 {@link EvidenceBlock} 的原文（§4）。
 *
 * 只按语义构造（§7）：输入不提供目录或章节父子关系，输出禁止以通用章节名充当节点名，
 * 每条父子边必须写明语义关系，否则父子关系会退化成目录包含关系。
 */
import type { EvidenceBlock } from './evidenceBlock'
import type { LLMFn } from './llm'

/**
 * 持久化 schema 版本。v2 起证据块必须携带逐页 `pieces` 分区，
 * 因此旧记录一律作废重建（不再有 v1 的块 JSON 语义）。
 */
export const SEMANTIC_TREE_SCHEMA_VERSION = 2
export const SEMANTIC_TREE_PROMPT_VERSION = 'v1'

/** 整棵树最多 16 个节点（§6.2）。 */
export const MAX_TREE_NODES = 16
/** 根节点下最多 5 个一级语义模块。 */
export const MAX_TREE_LEVEL1 = 5
/** 所有一级模块合计最多 10 个二级证据簇。 */
export const MAX_TREE_LEVEL2 = 10
/** 根节点之外最多两层。 */
export const MAX_TREE_DEPTH = 2

export const SEMANTIC_RELATIONS = [
  'motivates',
  'constitutes',
  'supports',
  'explains',
  'compares',
  'limits',
  'contradicts',
] as const

export type SemanticRelation = (typeof SEMANTIC_RELATIONS)[number]

export interface SemanticNode {
  /** 树内稳定且唯一的节点 ID */
  id: string
  /** 论文特有的概念、主张或证据簇名称 */
  label: string
  /** 该节点在整篇论文中承担的作用（1–2 句） */
  description: string
  /** 与父节点之间的语义关系；根节点为 null */
  relationToParent: SemanticRelation | null
  /** 相关原文证据块 ID；同一块可被多个节点引用（§6.5） */
  evidenceRefs: string[]
  children: SemanticNode[]
}

export interface SemanticTree {
  schemaVersion: number
  promptVersion: string
  root: SemanticNode
}

/** 建树失败原因。产品据此决定降级，bench 据此统计失败率（§8.2 / §11.4）。 */
export type SemanticTreeFailure =
  | 'no-evidence'
  | 'input-too-large'
  | 'llm-failed'
  | 'invalid-json'
  | 'invalid-structure'
  | 'invalid-evidence-ref'
  | 'generic-label'
  | 'size-limit'

/**
 * 已经真实发生的建树成本。失败发生在模型返回之后时（JSON 非法、结构校验不过），
 * 这一次调用与 token 已经花掉了——记成 0 会系统性低估失败率高的方案（§10.2）。
 */
export interface SemanticTreeBuildCost {
  llmCalls: number
  inputTokens: number
  outputTokens: number
  latencyMs: number
}

/** 建树失败。调用方必须整棵树降级，不得猜测修复（§13）。 */
export class SemanticTreeBuildError extends Error {
  constructor(
    readonly reason: SemanticTreeFailure,
    message: string,
    /** 调用前就失败（无证据块 / 输入超限）时为 undefined */
    readonly cost?: SemanticTreeBuildCost,
  ) {
    super(message)
    this.name = 'SemanticTreeBuildError'
  }
}

/** 树诊断指标（§11.4）。 */
export interface SemanticTreeDiagnostics {
  nodeCount: number
  depth: number
  level1Count: number
  level2Count: number
  /** 被树引用的证据块数量（去重） */
  referencedBlockCount: number
  /** 被树引用的证据块覆盖率；不进入树的内容仍可由平面检索召回（§8.3） */
  evidenceCoverage: number
  /** 被多个节点共同引用的证据块数量（多重归属，§6.5） */
  sharedBlockCount: number
  /** 引用跨越非连续区块的节点数量——跨章节取证的组织能力（§7.3） */
  crossSectionNodeCount: number
}

export interface SemanticTreeBuildMeta extends SemanticTreeDiagnostics {
  inputTokens: number
  outputTokens: number
  latencyMs: number
  llmCalls: number
}

export interface SemanticTreeOptions {
  /**
   * 建树输入字符上限。超过即视为「一次模型上下文容纳不下」（§13），
   * 第一版不做递归补救，直接降级为现有检索路径。
   */
  maxInputChars?: number
  /** 测试注入单调时钟；生产默认 Date.now */
  now?: () => number
}

export const DEFAULT_MAX_INPUT_CHARS = 120_000

/**
 * 与 bench/src/metrics/retrieval.ts 的 estimateTokens 同口径（4 字符 ≈ 1 token）。
 * src/ 不能反向 import bench/，故此处保留一份等价实现。
 */
export function estimateTokens(text: string): number {
  return Math.round(text.length / 4)
}

/**
 * 通用章节功能名——被当成节点名即说明树退化成了目录（§7.2）。
 * 比较前会剥掉编号前缀（`3.` / `III.` / `二、` / `第3节`）。
 */
const GENERIC_SECTION_NAMES = new Set([
  'abstract', 'introduction', 'related work', 'related works', 'background',
  'method', 'methods', 'methodology', 'approach', 'model', 'architecture',
  'experiment', 'experiments', 'experimental setup', 'evaluation', 'results',
  'results and discussion', 'analysis', 'discussion', 'conclusion', 'conclusions',
  'limitations', 'future work', 'references', 'appendix', 'acknowledgements',
  '摘要', '引言', '介绍', '绪论', '相关工作', '背景', '研究背景', '方法', '方法概述',
  '模型', '网络结构', '实验', '实验设置', '实验方法', '评估', '结果', '结果与分析',
  '分析', '讨论', '结论', '总结', '局限', '未来工作', '参考文献', '附录', '致谢',
])

function stripNumbering(label: string): string {
  return label
    .trim()
    .replace(/^\d+(?:\.\d+)*\s*[.、)）]?\s*/, '')
    .replace(/^[ivxlcdm]+\s*[.)、]\s*/i, '')
    .replace(/^第\s*[一二三四五六七八九十百\d]+\s*[章节部分篇]\s*/, '')
    .replace(/^[一二三四五六七八九十]+\s*[、.)）]\s*/, '')
    .trim()
    .toLowerCase()
}

/** 节点名是否只是通用章节功能名。 */
export function isGenericSectionLabel(label: string): boolean {
  const stripped = stripNumbering(label)
  if (!stripped) return true
  return GENERIC_SECTION_NAMES.has(stripped) || GENERIC_SECTION_NAMES.has(stripped.replace(/\s+/g, ' '))
}

/**
 * 论文原文指纹（FNV-1a）。内容未变化时复用已有树，避免每次提问都重建（§10.3）。
 * 只需在本地检测「是否变了」，不承担跨机器一致性职责。
 */
export function hashTreeSource(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * 建树缓存身份（§10.3）：同一篇原文下，这里任何一项变化都会产出不同的树，
 * 因此都必须让旧树失效——只比内容指纹会让提示词/模型/分块参数的变更永远不生效。
 */
export interface SemanticTreeBuildConfig {
  schemaVersion: number
  promptVersion: string
  /** 证据块分块参数（buildEvidenceBlocks 的 opts） */
  evidence: { targetChars: number; maxChars: number; minChars: number }
  /** 建树输入字符上限 */
  maxInputChars: number
  /** 建树模型标识，需含端点：同名模型换端点未必是同一个模型 */
  model: string
}

/**
 * 把构建配置折成一个定长指纹。按固定字段顺序序列化，
 * 避免对象键序不同导致同配置算出不同指纹、白白重建。
 */
export function semanticTreeConfigHash(config: SemanticTreeBuildConfig): string {
  return hashTreeSource(JSON.stringify([
    config.schemaVersion,
    config.promptVersion,
    config.evidence.targetChars,
    config.evidence.maxChars,
    config.evidence.minChars,
    config.maxInputChars,
    config.model,
  ]))
}

export function buildSemanticTreePrompt(blocks: EvidenceBlock[]): string {
  const body = blocks
    .map(block => `[${block.id}] (p.${block.startPage + 1}–${block.endPage + 1})\n${block.rawText}`)
    .join('\n\n')

  return `你在为一篇学术论文构建一棵**轻量语义导航树**。

下面按论文原始顺序给出全文的证据块，每块带有稳定 ID 与页码：

${body}

请通读全文后，输出这棵论文特有的语义树。硬性约束：

1. **只按语义关系组织**：父子关系只能表达概念、主张、组成、解释、支持、比较和限制等语义关系。
2. **不得**依据章节标题、目录结构或页码连续性构造父子关系。原文里出现的 Introduction / Method / Experiments 等标题只是正文的一部分，**禁止**把它们直接当作节点名。
3. 节点名必须使用**论文特有的语义**（例如「跨层表示对齐机制」），不能是「方法」「实验」「第三节」这类泛化功能名。
4. 规模上限：整棵树最多 ${MAX_TREE_NODES} 个节点；根节点下 3–${MAX_TREE_LEVEL1} 个一级语义模块；所有一级模块合计 6–${MAX_TREE_LEVEL2} 个二级证据簇；根节点之外最多两层。内容简单的论文可以只生成一层，**不要为了凑数量而虚构分支**。
5. 每个节点的 description 用 1–2 句话说清它在整篇论文中承担的作用。
6. evidenceRefs 只能填写上面真实存在的块 ID，可以写多个；同一个块可以被多个节点引用。语义相关但分散在不同页、不同位置的证据应当归入同一节点。
7. 每条父子边必须写明 relationToParent，取值限定为：${SEMANTIC_RELATIONS.join(' / ')}。
8. 无法确认的关系就保持粗粒度，不要为了树好看而虚构论证。

只输出 JSON，不要任何解释文字，格式如下：

{"root":{"id":"r","label":"论文的中心问题或核心结论","description":"...","relationToParent":null,"evidenceRefs":["B001"],"children":[{"id":"n1","label":"...","description":"...","relationToParent":"constitutes","evidenceRefs":["B002","B003"],"children":[]}]}}`
}

interface Collected {
  nodes: SemanticNode[]
  maxDepth: number
}

class ValidationFailure extends Error {
  constructor(readonly reason: SemanticTreeFailure, message: string) {
    super(message)
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

function readNode(
  raw: unknown,
  depth: number,
  isRoot: boolean,
  seenIds: Set<string>,
  blockIds: Set<string>,
  collected: Collected,
): SemanticNode {
  if (!isPlainObject(raw)) throw new ValidationFailure('invalid-structure', '节点不是对象')
  const { id, label, description, relationToParent, evidenceRefs, children } = raw

  if (typeof id !== 'string' || !id.trim()) throw new ValidationFailure('invalid-structure', '节点 ID 缺失或不是非空字符串')
  if (seenIds.has(id)) throw new ValidationFailure('invalid-structure', `节点 ID 重复：${id}`)
  seenIds.add(id)

  if (typeof label !== 'string' || !label.trim()) throw new ValidationFailure('invalid-structure', `节点 ${id} 的 label 为空`)
  if (typeof description !== 'string' || !description.trim()) throw new ValidationFailure('invalid-structure', `节点 ${id} 的 description 为空`)

  let relation: SemanticRelation | null
  if (isRoot) {
    if (relationToParent !== undefined && relationToParent !== null) {
      throw new ValidationFailure('invalid-structure', '根节点不应带 relationToParent')
    }
    relation = null
  } else {
    if (typeof relationToParent !== 'string' || !(SEMANTIC_RELATIONS as readonly string[]).includes(relationToParent)) {
      throw new ValidationFailure('invalid-structure', `节点 ${id} 的 relationToParent 非法：${String(relationToParent)}`)
    }
    relation = relationToParent as SemanticRelation
  }

  if (!Array.isArray(evidenceRefs)) throw new ValidationFailure('invalid-structure', `节点 ${id} 的 evidenceRefs 不是数组`)
  for (const ref of evidenceRefs) {
    if (typeof ref !== 'string') throw new ValidationFailure('invalid-structure', `节点 ${id} 的 evidenceRefs 必须为字符串数组`)
    // 引用不存在的块是硬失败：绝不猜测修复（§13）
    if (!blockIds.has(ref)) throw new ValidationFailure('invalid-evidence-ref', `节点 ${id} 引用了不存在的证据块：${ref}`)
  }

  if (!Array.isArray(children)) throw new ValidationFailure('invalid-structure', `节点 ${id} 的 children 不是数组`)
  if (depth > MAX_TREE_DEPTH) throw new ValidationFailure('size-limit', `树的层数超过 ${MAX_TREE_DEPTH}`)

  const node: SemanticNode = {
    id,
    label,
    description,
    relationToParent: relation,
    evidenceRefs: [...(evidenceRefs as string[])],
    children: [],
  }
  collected.nodes.push(node)
  collected.maxDepth = Math.max(collected.maxDepth, depth)
  for (const child of children) {
    node.children.push(readNode(child, depth + 1, false, seenIds, blockIds, collected))
  }
  return node
}

export interface SemanticTreeValidation {
  ok: boolean
  tree?: SemanticTree
  failure?: SemanticTreeFailure
  message?: string
  diagnostics: SemanticTreeDiagnostics
}

function computeDiagnostics(
  node: SemanticNode | undefined,
  nodes: SemanticNode[],
  maxDepth: number,
  blocks: EvidenceBlock[],
): SemanticTreeDiagnostics {
  const orderByBlockId = new Map(blocks.map(block => [block.id, block.order]))
  const referenceCounts = new Map<string, number>()
  let crossSectionNodeCount = 0

  for (const candidate of nodes) {
    for (const ref of candidate.evidenceRefs) {
      referenceCounts.set(ref, (referenceCounts.get(ref) ?? 0) + 1)
    }
    const orders = [...new Set(candidate.evidenceRefs.map(ref => orderByBlockId.get(ref)))]
      .filter((order): order is number => order !== undefined)
      .sort((a, b) => a - b)
    if (orders.length > 1 && orders[orders.length - 1] - orders[0] + 1 !== orders.length) {
      crossSectionNodeCount++
    }
  }

  return {
    nodeCount: nodes.length,
    depth: maxDepth,
    level1Count: node?.children.length ?? 0,
    level2Count: node?.children.reduce((sum, child) => sum + child.children.length, 0) ?? 0,
    referencedBlockCount: referenceCounts.size,
    evidenceCoverage: blocks.length > 0 ? referenceCounts.size / blocks.length : 0,
    sharedBlockCount: [...referenceCounts.values()].filter(count => count > 1).length,
    crossSectionNodeCount,
  }
}

/**
 * 校验 LLM 产出的语义树（§8.3）。校验不通过一律整棵树作废，不做局部修补。
 *
 * 规模上限按「天花板」执行：节点数、层数、每层规模都不得突破，但**不设下限**——
 * §6.2 明确「节点不足时不需要为了满足数量而虚构分支」，
 * 内容简单的论文可以只生成一层。
 */
export function validateSemanticTree(value: unknown, blocks: EvidenceBlock[]): SemanticTreeValidation {
  const collected: Collected = { nodes: [], maxDepth: 0 }
  let root: SemanticNode | undefined
  let failure: ValidationFailure | undefined

  try {
    if (!isPlainObject(value)) throw new ValidationFailure('invalid-structure', '输出不是 JSON 对象')
    if (!('root' in value)) throw new ValidationFailure('invalid-structure', '输出缺少 root 字段')
    root = readNode(value.root, 0, true, new Set<string>(), new Set(blocks.map(b => b.id)), collected)

    const level1Count = root.children.length
    const level2Count = root.children.reduce((sum, child) => sum + child.children.length, 0)
    if (level1Count > MAX_TREE_LEVEL1) {
      throw new ValidationFailure('size-limit', `一级模块 ${level1Count} 个，超过上限 ${MAX_TREE_LEVEL1}`)
    }
    if (level2Count > MAX_TREE_LEVEL2) {
      throw new ValidationFailure('size-limit', `二级证据簇 ${level2Count} 个，超过上限 ${MAX_TREE_LEVEL2}`)
    }
    if (collected.nodes.length > MAX_TREE_NODES) {
      throw new ValidationFailure('size-limit', `节点总数 ${collected.nodes.length} 个，超过上限 ${MAX_TREE_NODES}`)
    }
    const generic = collected.nodes.find(node => isGenericSectionLabel(node.label))
    if (generic) {
      throw new ValidationFailure('generic-label', `节点名「${generic.label}」是通用章节名，不是论文特有的语义节点`)
    }
  } catch (error) {
    if (!(error instanceof ValidationFailure)) throw error
    failure = error
  }

  const diagnostics = computeDiagnostics(root, collected.nodes, collected.maxDepth, blocks)
  if (failure) {
    return { ok: false, failure: failure.reason, message: failure.message, diagnostics }
  }
  return {
    ok: true,
    tree: {
      schemaVersion: SEMANTIC_TREE_SCHEMA_VERSION,
      promptVersion: SEMANTIC_TREE_PROMPT_VERSION,
      root: root as SemanticNode,
    },
    diagnostics,
  }
}

/** 从模型输出中取出结构化树；容忍代码围栏与前后解释文字（§8.1）。 */
export function parseSemanticTree(raw: string): unknown {
  const cleaned = raw.replace(/```(?:json)?\s*|```/gi, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end < start) throw new SemanticTreeBuildError('invalid-json', '模型输出中找不到 JSON 对象')
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1))
  } catch {
    throw new SemanticTreeBuildError('invalid-json', '模型输出的 JSON 无法解析')
  }
  if (!isPlainObject(parsed)) throw new SemanticTreeBuildError('invalid-json', '模型输出的 JSON 不是对象')
  return parsed
}

export interface SemanticTreeBuildResult {
  tree: SemanticTree
  meta: SemanticTreeBuildMeta
}

/**
 * 一次 LLM 调用构建整棵语义树（§8.1）。
 *
 * 每篇论文最多一次调用：不逐块摘要、不逐节点生成、不递归调用模型。
 * 任何失败都以 {@link SemanticTreeBuildError} 抛出，调用方据此降级到现有检索路径，
 * 不写入半成品树（§8.2）。
 */
export async function buildSemanticTree(
  blocks: EvidenceBlock[],
  llm: LLMFn,
  opts: SemanticTreeOptions = {},
): Promise<SemanticTreeBuildResult> {
  const now = opts.now ?? Date.now
  const maxInputChars = opts.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS

  if (blocks.length === 0) throw new SemanticTreeBuildError('no-evidence', '没有可用的原文证据块')
  const prompt = buildSemanticTreePrompt(blocks)
  if (prompt.length > maxInputChars) {
    throw new SemanticTreeBuildError(
      'input-too-large',
      `建树输入 ${prompt.length} 字符，超过上限 ${maxInputChars}；第一版不做递归补救`,
    )
  }

  const startedAt = now()
  let raw: string
  try {
    raw = await llm(prompt)
  } catch (error) {
    // 请求确实发出去了（输入 token 已消耗），只是没拿到可用输出
    throw new SemanticTreeBuildError('llm-failed', error instanceof Error ? error.message : String(error), {
      llmCalls: 1,
      inputTokens: estimateTokens(prompt),
      outputTokens: 0,
      latencyMs: Math.max(0, now() - startedAt),
    })
  }
  const latencyMs = Math.max(0, now() - startedAt)
  const cost: SemanticTreeBuildCost = {
    llmCalls: 1,
    inputTokens: estimateTokens(prompt),
    outputTokens: estimateTokens(raw),
    latencyMs,
  }

  let parsed: unknown
  try {
    parsed = parseSemanticTree(raw)
  } catch (error) {
    if (error instanceof SemanticTreeBuildError) throw new SemanticTreeBuildError(error.reason, error.message, cost)
    throw error
  }
  const validation = validateSemanticTree(parsed, blocks)
  if (!validation.ok || !validation.tree) {
    throw new SemanticTreeBuildError(
      validation.failure ?? 'invalid-structure',
      validation.message ?? '语义树校验失败',
      cost,
    )
  }

  return {
    tree: validation.tree,
    meta: {
      ...validation.diagnostics,
      inputTokens: estimateTokens(prompt),
      outputTokens: estimateTokens(raw),
      latencyMs,
      llmCalls: 1,
    },
  }
}

/** 展平为一维路由列表，保留 depth 与父节点标签，供单轮检索判断使用（§9）。 */
export interface FlattenedNode {
  node: SemanticNode
  depth: number
  parentLabel: string | null
}

export function flattenSemanticTree(tree: SemanticTree): FlattenedNode[] {
  const out: FlattenedNode[] = []
  const walk = (node: SemanticNode, depth: number, parentLabel: string | null) => {
    out.push({ node, depth, parentLabel })
    for (const child of node.children) walk(child, depth + 1, node.label)
  }
  walk(tree.root, 0, null)
  return out
}

/** 树中全部证据块引用的并集。 */
export function collectTreeEvidenceRefs(tree: SemanticTree): Set<string> {
  const refs = new Set<string>()
  for (const { node } of flattenSemanticTree(tree)) {
    for (const ref of node.evidenceRefs) refs.add(ref)
  }
  return refs
}
