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
  if (!isPlainObject(value.tree)) return undefined
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

  if (isPlainObject(value.structureFallback) && typeof (value.structureFallback as Record<string, unknown>).reason === 'string') {
    index.structureFallback = { reason: (value.structureFallback as { reason: StructureFallbackReason }).reason }
  }
  if (isPlainObject(value.paper) && typeof (value.paper as Record<string, unknown>).title === 'string') {
    index.paper = value.paper as unknown as { title: string; summary: string }
  }
  if (Array.isArray(value.cards) && value.cards.length > 0) index.cards = value.cards as StructureCard[]

  const dim = typeof value.vectorDim === 'number' && Number.isInteger(value.vectorDim) && value.vectorDim > 0 ? value.vectorDim : undefined
  if (dim !== undefined) {
    index.vectorDim = dim
    if (typeof value.passageVectors === 'string') {
      const vectors = decodeVectors(value.passageVectors, dim)
      if (vectors && vectors.length === typedPassages.length) index.passageVectors = vectors
    }
    if (typeof value.cardVectors === 'string' && index.cards) {
      const vectors = decodeVectors(value.cardVectors, dim)
      if (vectors && vectors.length === index.cards.length) index.cardVectors = vectors
    }
  }
  return index
}

/** 便捷包装：直接吃 `window.db.index.get` 返回的记录。 */
export function passageIndexOf(record: { indexJson: string } | undefined): PassageIndex | undefined {
  return record ? parsePassageIndex(record.indexJson) : undefined
}
