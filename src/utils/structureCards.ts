/**
 * 结构卡片（方案 §2）：冷启动每篇论文**唯一一次** LLM 调用。
 *
 * 卡片不进上下文、不作为事实依据，只做两件事：把段落按主题归组（使「整片相关」
 * 成为段落的加分项），以及用模型写出的 summary / keyTerms 补上段落原文里没有的提问用词。
 * 校验不通过即整份作废，**不重试、不修补**，直接标题卡片回落（方案 §2.3 / §2.4）。
 */
import type { IndexNode } from './pageIndex'
import type { LLMFn } from './llm'
import type { Passage } from './passages'
import { DEFAULT_MAX_INPUT_CHARS, isGenericSectionLabel } from './semanticTree'

export const STRUCTURE_CARD_PROMPT_VERSION = 'v1'
export const MIN_STRUCTURE_CARDS = 3
export const MAX_STRUCTURE_CARDS = 10
export const MIN_KEY_TERMS = 1
export const MAX_KEY_TERMS = 12

/** 卡片作废的原因；`no-passages` 是设计文档四种原因之外的补充（论文无文本）。 */
export type StructureFallbackReason =
  | 'request-failed'
  | 'invalid-json'
  | 'invalid-structure'
  | 'input-too-large'
  | 'no-passages'

export interface StructureCard {
  id: string
  /** `[起始段落 ID, 结束段落 ID]`，闭区间且连续 */
  range: [string, string]
  title: string
  summary: string
  keyTerms: string[]
}

export interface StructureCallCost {
  llmCalls: number
  latencyMs: number
}

/**
 * 卡片失败**必须带成本**：模型已返回、只是输出不可用（非法 JSON、结构不过）时
 * 那次调用与 token 是真实成本，bench 要照记；只有调用前就被拒才是零成本
 * （沿用语义树 `SemanticTreeBuildError` 的口径）。
 */
export class StructureCardError extends Error {
  constructor(
    readonly reason: StructureFallbackReason,
    message: string,
    readonly cost?: StructureCallCost,
  ) {
    super(message)
    this.name = 'StructureCardError'
  }
}

export interface StructureCardMeta {
  latencyMs: number
  inputChars: number
  llmCalls: number
}

export interface StructureCardResult {
  cards: StructureCard[]
  paper?: { title: string; summary: string }
  meta: StructureCardMeta
}

export function buildStructureCardPrompt(passages: Passage[]): string {
  const body = passages.map(passage => `[${passage.id}]\n${passage.text}`).join('\n\n')
  const first = passages[0]?.id ?? 'P01'
  return `你在为一篇学术论文建立**主题卡片**。
下面按论文原始顺序给出全文的段落，每段带有稳定 ID：

${body}

请通读全文后，按**主题**把段落划分为 ${MIN_STRUCTURE_CARDS}–${MAX_STRUCTURE_CARDS} 片**连续**范围，并为每片写一张卡片。硬性约束：

1. 每片的 range 是从起点段落 ID 到终点段落 ID 的**连续**区间，全部段落被覆盖**恰好一次**（不重叠、不遗漏），并按段落顺序排列。
2. 卡片 title 必须是该主题**特有的具体名称**，**禁止**使用 Abstract / Introduction / Method / Experiments / 结论 这类通用章节名。
3. summary 用 2–3 句写清该主题的具体内容，**必须**包含原文出现的具体名称、数据集、指标与数字。
4. keyTerms 给 5–12 个读者可能的提问用词，**必须**包含原文没有出现但语义等价的说法（例如原文写 "We evaluate on Europarl and MultiUN"，keyTerms 应含 "datasets" / "evaluation data"）。
5. 按主题划分即可合并（如 Abstract 与 Introduction 合成一片）也可拆分（如把实验章拆为「设置」与「结果」两片）；不要照抄论文的章节标题。

只输出 JSON，不要任何解释文字，格式如下：

{"paper":{"title":"...","summary":"2-3 sentences"},"sections":[{"id":"S1","range":["${first}","P05"],"title":"...","summary":"...","keyTerms":["...","..."]}]}`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 提取并解析 JSON；围栏与前后解释文字都容忍，找不到 JSON 一律 invalid-json。 */
export function parseStructureCards(raw: string): unknown {
  const cleaned = raw.replace(/```(?:json)?/gi, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new StructureCardError('invalid-json', '模型输出中找不到 JSON 对象')
  try {
    return JSON.parse(cleaned.slice(start, end + 1))
  } catch {
    throw new StructureCardError('invalid-json', '模型输出的 JSON 无法解析')
  }
}

class StructureCardValidationFailure extends Error {
  constructor(readonly reason: StructureFallbackReason, message: string) {
    super(message)
  }
}

export interface StructureCardValidation {
  ok: boolean
  cards?: StructureCard[]
  paper?: { title: string; summary: string }
  failure?: StructureFallbackReason
  message?: string
}

/**
 * 逐项校验（方案 §2.3）。「连续 + 覆盖恰好一次 + 有序」用一个游标 `expected` 表达：
 * 每张卡片的起点必须正好接上一张的终点 + 1，最后再要求覆盖到末尾。
 */
export function validateStructureCards(value: unknown, passages: Passage[]): StructureCardValidation {
  // 显式函数类型标注不可省：只有它能让 TS 把 `fail(...)` 当作 never 调用并在之后继续收窄
  // （推断出来的箭头函数类型没有这个效果，校验分支之后的字段访问会全部报 unknown）。
  const fail: (reason: StructureFallbackReason, message: string) => never = (reason, message) => {
    throw new StructureCardValidationFailure(reason, message)
  }
  try {
    if (!isPlainObject(value)) fail('invalid-structure', '输出不是 JSON 对象')
    const raw = value as Record<string, unknown>
    const rawSections = raw.sections
    if (!Array.isArray(rawSections)) fail('invalid-structure', '输出缺少 sections 数组')
    if (rawSections.length < MIN_STRUCTURE_CARDS || rawSections.length > MAX_STRUCTURE_CARDS) {
      fail('invalid-structure', `卡片数 ${rawSections.length} 不在 ${MIN_STRUCTURE_CARDS}–${MAX_STRUCTURE_CARDS} 之间`)
    }

    const orderById = new Map(passages.map(passage => [passage.id, passage.order]))
    const cards: StructureCard[] = []
    let expected = 0
    for (const section of rawSections as unknown[]) {
      if (!isPlainObject(section)) fail('invalid-structure', '卡片不是 JSON 对象')
      const { id, range, title, summary, keyTerms } = section as Record<string, unknown>
      if (typeof id !== 'string' || !id.trim()) fail('invalid-structure', '卡片 id 缺失')
      if (!Array.isArray(range) || range.length !== 2 || range.some(item => typeof item !== 'string')) {
        fail('invalid-structure', `卡片 ${id} 的 range 必须是两个段落 ID`)
      }
      const [startId, endId] = range as [string, string]
      const start = orderById.get(startId)
      const end = orderById.get(endId)
      if (start === undefined || end === undefined) fail('invalid-structure', `卡片 ${id} 引用了不存在的段落`)
      if (start !== expected) fail('invalid-structure', `卡片 ${id} 的 range 不连续或与上一张重叠/遗漏`)
      if (end < start) fail('invalid-structure', `卡片 ${id} 的 range 起止颠倒`)
      expected = end + 1
      if (typeof title !== 'string' || !title.trim()) fail('invalid-structure', `卡片 ${id} 缺少标题`)
      const trimmedTitle = title.trim()
      if (isGenericSectionLabel(trimmedTitle)) fail('invalid-structure', `卡片标题「${trimmedTitle}」是通用章节名`)
      if (typeof summary !== 'string') fail('invalid-structure', `卡片 ${id} 缺少 summary`)
      if (!Array.isArray(keyTerms) || keyTerms.length < MIN_KEY_TERMS || keyTerms.length > MAX_KEY_TERMS) {
        fail('invalid-structure', `卡片 ${id} 的 keyTerms 数量越界`)
      }
      if (keyTerms.some(term => typeof term !== 'string' || !term.trim())) {
        fail('invalid-structure', `卡片 ${id} 的 keyTerms 含空项`)
      }
      cards.push({
        id: id.trim(),
        range: [startId, endId],
        title: trimmedTitle,
        summary: summary.trim(),
        keyTerms: (keyTerms as string[]).map(term => term.trim()),
      })
    }
    if (expected !== passages.length) fail('invalid-structure', `段落覆盖不全：只覆盖到第 ${expected} 段，共 ${passages.length} 段`)

    let paper: { title: string; summary: string } | undefined
    if (isPlainObject(raw.paper)) {
      const { title, summary } = raw.paper as Record<string, unknown>
      if (typeof title === 'string' && typeof summary === 'string' && title.trim()) {
        paper = { title: title.trim(), summary: summary.trim() }
      }
    }
    return { ok: true, cards, ...(paper ? { paper } : {}) }
  } catch (error) {
    if (!(error instanceof StructureCardValidationFailure)) throw error
    return { ok: false, failure: error.reason, message: error.message }
  }
}

/** 回落卡片：按标题行划分小节，每小节一张只有标题的卡片（无 summary / keyTerms）。 */
export function buildTitleCards(passages: Passage[]): StructureCard[] {
  const cards: StructureCard[] = []
  let start = 0
  for (let i = 1; i <= passages.length; i++) {
    const atEnd = i === passages.length
    if (!atEnd && passages[i].subsection === passages[start].subsection) continue
    cards.push({
      id: `S${cards.length + 1}`,
      range: [passages[start].id, passages[i - 1].id],
      title: passages[start].subsection || '正文',
      summary: '',
      keyTerms: [],
    })
    start = i
  }
  return cards
}

/** 卡片 → `IndexNode` 树：根来自 paper，每张卡片一个叶节点（UI 与旧代码零改动）。 */
export function cardsToIndexNodes(
  cards: StructureCard[],
  passages: Passage[],
  opts: { title?: string; summary?: string } = {},
): IndexNode {
  const byId = new Map(passages.map(passage => [passage.id, passage]))
  const nodes: IndexNode[] = []
  for (const card of cards) {
    const first = byId.get(card.range[0])
    const last = byId.get(card.range[1])
    if (!first || !last) continue
    nodes.push({
      title: card.title,
      nodeId: card.id,
      startPage: first.pieces[0].page,
      endPage: last.pieces[last.pieces.length - 1].page,
      summary: card.summary,
      nodes: [],
    })
  }
  const endPage = nodes.length > 0 ? nodes[nodes.length - 1].endPage : 0
  return {
    title: opts.title || 'Paper',
    nodeId: 'root',
    startPage: nodes.length > 0 ? nodes[0].startPage : 0,
    endPage,
    summary: opts.summary ?? '',
    nodes,
  }
}

export interface StructureCardBuildOptions {
  maxInputChars?: number
  now?: () => number
}

/** 建卡片：恰好一次调用；失败抛 `StructureCardError`（带已发生成本），不重试不修补。 */
export async function buildStructureCards(
  passages: Passage[],
  llm: LLMFn,
  opts: StructureCardBuildOptions = {},
): Promise<StructureCardResult> {
  const now = opts.now ?? Date.now
  const maxInputChars = opts.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS
  if (passages.length === 0) throw new StructureCardError('no-passages', '论文没有可用段落')

  const prompt = buildStructureCardPrompt(passages)
  if (prompt.length > maxInputChars) {
    throw new StructureCardError('input-too-large', `卡片输入 ${prompt.length} 字符，超过上限 ${maxInputChars}；不截断补救`)
  }

  const startedAt = now()
  let raw: string
  try {
    raw = await llm(prompt)
  } catch (error) {
    throw new StructureCardError(
      'request-failed',
      error instanceof Error ? error.message : String(error),
      { llmCalls: 1, latencyMs: Math.max(0, now() - startedAt) },
    )
  }
  const latencyMs = Math.max(0, now() - startedAt)
  const cost: StructureCallCost = { llmCalls: 1, latencyMs }

  let parsed: unknown
  try {
    parsed = parseStructureCards(raw)
  } catch (error) {
    if (error instanceof StructureCardError) throw new StructureCardError(error.reason, error.message, cost)
    throw error
  }

  const validation = validateStructureCards(parsed, passages)
  if (!validation.ok || !validation.cards) {
    throw new StructureCardError(validation.failure ?? 'invalid-structure', validation.message ?? '结构卡片校验失败', cost)
  }
  return {
    cards: validation.cards,
    ...(validation.paper ? { paper: validation.paper } : {}),
    meta: { latencyMs, inputChars: prompt.length, llmCalls: 1 },
  }
}
