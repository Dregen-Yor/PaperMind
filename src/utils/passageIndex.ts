/**
 * 段落索引的版本化结构、指纹与失效规则（方案 §6.2）。
 *
 * `index_json` 升级为 v2：同一个 JSON 里既装索引（passages / 向量 / 卡片），
 * 也装由卡片推导的 `IndexNode` 树（UI 与依赖树的旧代码零改动）。
 * 表与 IPC 通道都不变，`pagesJson` 与 v1 逐字一致。
 */
import {
  decodeVectors, encodeVectors,
} from './embedder'
import type { IndexNode } from './pageIndex'
import { hasPassagePartition, type Passage } from './passages'
import { hashTreeSource } from './semanticTree'
import type { StructureCard, StructureFallbackReason } from './structureCards'

/**
 * 落盘记录格式版本（`index_json.version`）。方案 §6 规定：无 `version` 的旧记录在加载时
 * 一律视为过期，由后台重建。
 *
 * 显式标注 `: 2` 不可省：`const X = 2` 推出的是**可拓宽字面量类型**，`{ version: X }`
 * 这种无上下文的字面量会把属性拓宽成 `number`，于是按方案写的索引 fixture 不再是
 * `PassageIndex`（`PassageIndex.version` 要求字面量 `2`）。标注后类型不再拓宽。
 */
export const PASSAGE_INDEX_VERSION: 2 = 2

/**
 * 切段配置 schema 的版本，**只作为 `passageConfigHash` 的输入之一**（见 `PassageConfigInput`）。
 * 与 `PASSAGE_INDEX_VERSION` 当前同为 2 是巧合——两者独立演进：
 * 改了存储字段改前者，改了切段参数语义改后者。**不要合并成一个常量**，
 * 否则改存储格式会把所有论文的切段指纹一起推倒重建。
 */
export const PASSAGE_INDEX_SCHEMA_VERSION = 2

export interface PassageIndex {
  version: typeof PASSAGE_INDEX_VERSION
  /** 已完成的最高构建阶段；③ 落盘即代表卡片可用（向量可能因模型不可用而缺席） */
  stage: 1 | 2 | 3
  passages: Passage[]
  passageVectors?: Float32Array[]
  cards?: StructureCard[]
  paper?: { title: string; summary: string }
  cardVectors?: Float32Array[]
  structureFallback?: { reason: StructureFallbackReason }
  tree: IndexNode
  embedderId?: string
  structureHash?: string
  passageConfigHash: string
  /** 向量维度；判定向量可用性时与 passages.length 一起用 */
  vectorDim?: number
  /** 组间分隔符的 token 数，用于填充阶段的预算判定 */
  separatorTokens: number
}

export interface PassageConfigInput {
  schemaVersion: number
  segmentation: { minTokens: number; maxTokens: number }
}

export interface StructureConfigInput {
  schemaVersion: number
  passageConfigHash: string
  promptVersion: string
  maxInputChars: number
  /** 索引 profile 的端点 + 模型名（模型换了语义就换了，卡片必须重做） */
  model: string
}

/** 切段参数变了 → 段落 ID 与边界全变 → 全量重建。 */
export function passageConfigHash(config: PassageConfigInput): string {
  return hashTreeSource(JSON.stringify({
    schemaVersion: config.schemaVersion,
    minTokens: config.segmentation.minTokens,
    maxTokens: config.segmentation.maxTokens,
  }))
}

/** 切段参数 + 提示词版本 + 输入上限 + 索引模型 → 卡片重建范围。 */
export function structureHash(config: StructureConfigInput): string {
  return hashTreeSource(JSON.stringify({
    schemaVersion: config.schemaVersion,
    passageConfigHash: config.passageConfigHash,
    promptVersion: config.promptVersion,
    maxInputChars: config.maxInputChars,
    model: config.model,
  }))
}

export interface PassageIndexRecord {
  indexJson: string
  pagesJson: string
}

export interface PassageIndexBuildPlan {
  passages: boolean
  vectors: boolean
  structure: boolean
}

/**
 * 失效规则（方案 §6.2）：`passageConfigHash` 变 → 全部重建；`structureHash` 变 →
 * 只重做阶段③；`embedderId` 变 → 只重算向量。三者独立，任何一项都不能越界。
 *
 * `vectors: true` **不等于**「配了 embedder」。两侧都有 `embedderId === undefined` 的合法场景
 * （产品在模型没就绪时构建、bench 未注入 embedder），此时 `stored.embedderId ('x') !== undefined`
 * 恒成立，于是**每一篇没有向量的记录无论重建多少次都报 `vectors: true`**——它表达的是
 * 「存档里的向量与本次要用的模型不同源（或压根没有）」，不是「有模型可用」。
 * 调用方不得据此推断 embedder 存在（阶段② 在无 embedder 时第一行就返回，不产出向量）。
 */
export function planPassageIndexRebuild(args: {
  stored?: PassageIndex
  passageConfigHash: string
  structureHash: string
  embedderId?: string
}): PassageIndexBuildPlan {
  const { stored } = args
  if (!stored) return { passages: true, vectors: true, structure: true }
  if (stored.passageConfigHash !== args.passageConfigHash) return { passages: true, vectors: true, structure: true }
  const vectors = stored.embedderId !== args.embedderId || stored.passageVectors === undefined || stored.stage < 2
  const structure = stored.structureHash !== args.structureHash || stored.stage < 3 || stored.cards === undefined
  return { passages: false, vectors, structure }
}

interface SerializedPassageIndex extends Omit<PassageIndex, 'passageVectors' | 'cardVectors'> {
  passageVectors?: string
  cardVectors?: string
}

/** 落盘：向量转 base64，其余原样。 */
export function serializePassageIndex(index: PassageIndex): SerializedPassageIndex {
  const { passageVectors, cardVectors, ...rest } = index
  return {
    ...rest,
    ...(passageVectors ? { passageVectors: encodeVectors(passageVectors) } : {}),
    ...(cardVectors ? { cardVectors: encodeVectors(cardVectors) } : {}),
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 段落记录的字段形态校验，与 `hasPassagePartition` 并列。缺它不行：分片自洽是
 * **构造上必然成立**的（`text` 定义为 `pieces` 的拼接），所以单靠它看不见丢失的
 * 非分片字段——缺 `searchText` 会把 `undefined` 喂给 BM25，缺 `tokenCount`
 * 会让预算判定失效，缺 `subsection` 会让卡片回落失去标题。
 */
function hasPassageFields(passage: unknown): boolean {
  if (!passage || typeof passage !== 'object') return false
  const { searchText, tokenCount, subsection } = passage as { searchText?: unknown; tokenCount?: unknown; subsection?: unknown }
  return typeof searchText === 'string'
    && typeof tokenCount === 'number' && Number.isInteger(tokenCount)
    && typeof subsection === 'string'
}

/**
 * `StructureFallbackReason` 的全部成员。标注成 `StructureFallbackReason[]` 只能让**拼错**的
 * 字面量在编译期报错，抓不住「联合类型加了新原因、这里忘了同步」——那种情况需要
 * `passageIndex.test.ts` 的 `Record<StructureFallbackReason, true>` 兜住：联合一改，测试
 * 就编译不过，逼着把新原因同时加进这里。漏同步的后果是新记录被当成损坏、反复重建。
 */
const STRUCTURE_FALLBACK_REASONS: readonly StructureFallbackReason[] = [
  'request-failed', 'invalid-json', 'invalid-structure', 'input-too-large', 'no-passages',
]

function isStructureFallbackReason(value: unknown): value is StructureFallbackReason {
  return typeof value === 'string' && (STRUCTURE_FALLBACK_REASONS as readonly string[]).includes(value)
}

/**
 * 卡片元素的形态校验。**只查形态、不查语义，刻意不调用 `validateStructureCards`**：
 * 那个校验器描述的是 **LLM 输出**，而标题回落的卡片合法地违反它三条——`keyTerms: []`
 * 低于 `MIN_KEY_TERMS`、回落标题（如「Introduction」）会被 `isGenericSectionLabel`
 * 判为通用章节名、卡片数可以少于 `MIN_STRUCTURE_CARDS`。加载期复用它会把合法记录判死。
 * 这里只保证读的时候不抛、不类型撒谎：缺 `range` 的卡片会让 `cardsToIndexNodes`
 * 在 `card.range[0]` 处抛错。
 */
function hasStructureCardFields(card: unknown): boolean {
  if (!isPlainObject(card)) return false
  const { id, range, title, summary, keyTerms } = card as Record<string, unknown>
  return typeof id === 'string'
    && Array.isArray(range) && range.length === 2 && range.every(item => typeof item === 'string')
    && typeof title === 'string'
    && typeof summary === 'string'
    && Array.isArray(keyTerms) && keyTerms.every(term => typeof term === 'string')
}

/**
 * `tree` 的形态校验（根与所有嵌套 `nodes`，按 `IndexNode` 的字段逐个查）。写成显式栈而不是
 * 递归：`index_json` 是从库里读出的字符串，`JSON.parse` 对极深的嵌套也能解析（迭代实现），
 * 而递归下潜到两万层就会 `RangeError`——那会从 `parsePassageIndex` 里抛出去，违反「只拒绝、
 * 不抛」。坏树没有可回落的替代物（UI 与 v1 语义路径直接读 `tree.nodes.length` / `.map`），
 * 只能整份记录作废、由调用方后台重建。
 */
function hasIndexNodeShape(root: unknown): boolean {
  const pending: unknown[] = [root]
  while (pending.length > 0) {
    const node = pending.pop()
    if (!isPlainObject(node)) return false
    const { title, nodeId, startPage, endPage, summary, nodes } = node as Record<string, unknown>
    if (typeof title !== 'string' || typeof nodeId !== 'string') return false
    if (typeof startPage !== 'number' || !Number.isInteger(startPage)) return false
    if (typeof endPage !== 'number' || !Number.isInteger(endPage)) return false
    if (typeof summary !== 'string' || !Array.isArray(nodes)) return false
    for (const child of nodes) pending.push(child)
  }
  return true
}

/**
 * 解析并校验一份存量索引。**任何不自洽都返回 undefined**（调用方视为无索引、后台重建）：
 * 静默接受一份损坏的索引会让检索用错的分片与页号，比报错更难查。
 * 向量不自洽时只丢向量（降到阶段①/③ 检索），不丢整个索引。
 */
export function parsePassageIndex(raw: unknown): PassageIndex | undefined {
  let value: unknown = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      return undefined
    }
  }
  if (!isPlainObject(value)) return undefined
  if (value.version !== PASSAGE_INDEX_VERSION) return undefined
  const stage = value.stage
  if (stage !== 1 && stage !== 2 && stage !== 3) return undefined
  const passages = value.passages
  if (!Array.isArray(passages) || passages.length === 0) return undefined
  if (!passages.every(passage => hasPassagePartition(passage) && hasPassageFields(passage))) return undefined
  if (!hasIndexNodeShape(value.tree)) return undefined
  if (typeof value.passageConfigHash !== 'string' || !value.passageConfigHash) return undefined
  const separatorTokens = typeof value.separatorTokens === 'number' && Number.isInteger(value.separatorTokens) && value.separatorTokens >= 0
    ? value.separatorTokens
    : undefined
  if (separatorTokens === undefined) return undefined

  const typedPassages = passages as Passage[]
  const index: PassageIndex = {
    version: PASSAGE_INDEX_VERSION,
    stage,
    passages: typedPassages,
    tree: value.tree as unknown as IndexNode,
    passageConfigHash: value.passageConfigHash,
    separatorTokens,
  }
  if (typeof value.embedderId === 'string') index.embedderId = value.embedderId
  if (typeof value.structureHash === 'string') index.structureHash = value.structureHash

  // 可选字段的形态纪律与 passages 一致：键出现就必须是声明里的形态，否则整份记录不可信。
  // `paper` 与 `structureFallback` 会被原样当声明类型用（`cardsToIndexNodes(..., { summary })`
  // 会把非字符串 summary 原样写进推导出的树，未知的 reason 会冒充 `StructureFallbackReason`），
  // 类型撒谎比缺字段更难查；两者都没有「丢了也能自愈」的回落路径，只能整份重建。
  if (value.paper !== undefined) {
    if (!isPlainObject(value.paper)) return undefined
    const { title, summary } = value.paper as Record<string, unknown>
    if (typeof title !== 'string' || typeof summary !== 'string') return undefined
    index.paper = { title, summary }
  }
  if (value.structureFallback !== undefined) {
    if (!isPlainObject(value.structureFallback)) return undefined
    const reason = (value.structureFallback as Record<string, unknown>).reason
    if (!isStructureFallbackReason(reason)) return undefined
    index.structureFallback = { reason }
  }
  // 卡片形态不对时**只丢卡片**（`cardVectors` 随之不挂），不丢整份索引：与「向量数组不自洽
  // 只丢向量」同一种处理，且 `planPassageIndexRebuild` 已经把 `cards === undefined` 当作
  // 「只重做阶段③」——段落与向量照用，比整份重建便宜得多。
  if (Array.isArray(value.cards) && value.cards.length > 0 && value.cards.every(hasStructureCardFields)) {
    index.cards = value.cards as StructureCard[]
  }

  const dim = typeof value.vectorDim === 'number' && Number.isInteger(value.vectorDim) && value.vectorDim > 0 ? value.vectorDim : undefined
  if (dim !== undefined) {
    if (typeof value.passageVectors === 'string') {
      const vectors = decodeVectors(value.passageVectors, dim)
      if (vectors && vectors.length === typedPassages.length) index.passageVectors = vectors
    }
    if (typeof value.cardVectors === 'string' && index.cards) {
      const vectors = decodeVectors(value.cardVectors, dim)
      if (vectors && vectors.length === index.cards.length) index.cardVectors = vectors
    }
    // `vectorDim` 只在真有向量数组留下时才挂：两个数组都被丢掉时它描述的是不存在的维度，
    // 只看 `vectorDim` 判断「有没有向量」的调用方会被骗。
    if (index.passageVectors !== undefined || index.cardVectors !== undefined) index.vectorDim = dim
  }
  return index
}

/** 便捷包装：直接吃 `window.db.index.get` 返回的记录。 */
export function passageIndexOf(record: { indexJson: string } | undefined): PassageIndex | undefined {
  return record ? parsePassageIndex(record.indexJson) : undefined
}
