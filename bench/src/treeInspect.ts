/**
 * 语义树人工结构检查（方案 §阶段 E 第 4 步）。
 *
 * 自动指标只能回答「树有多大、覆盖多少块」，回答不了「树是不是把目录换了个说法」。
 * 这里把树按层打印成 Markdown，连同每个节点引用的原文片段一起给出，
 * 让检查者能直接判断节点是不是论文特有的语义与论证关系。
 */
import type { EvidenceBlock } from '../../src/utils/evidenceBlock'
import type { SemanticTree } from '../../src/utils/semanticTree'
import type { Passage } from '../../src/utils/passages'
import type { StructureCard } from '../../src/utils/structureCards'

const MAX_QUOTE_CHARS = 160

/** 原文片段压成一行并截断：检查者只需要认出「这是哪一段」，不需要读全文。 */
function quote(block: EvidenceBlock | undefined, id: string): string {
  if (!block) return `[${id}] ⚠ 引用的证据块不存在`
  const oneLine = block.rawText.replace(/\s+/g, ' ').trim()
  const clipped = oneLine.length > MAX_QUOTE_CHARS ? `${oneLine.slice(0, MAX_QUOTE_CHARS)}…` : oneLine
  const pages = block.startPage === block.endPage ? `p.${block.startPage + 1}` : `p.${block.startPage + 1}–${block.endPage + 1}`
  return `[${id}] ${pages} ${clipped}`
}

/** 单棵树的 Markdown 大纲；页码一律用原始 1-based，与 PDF 直接对上。 */
export function renderTreeOutline(tree: SemanticTree, blocks: EvidenceBlock[]): string {
  const byId = new Map(blocks.map(b => [b.id, b]))
  const lines: string[] = []
  const walk = (node: SemanticTree['root'], depth: number) => {
    const indent = '  '.repeat(depth)
    const relation = node.relationToParent ? ` —${node.relationToParent}→ ` : ''
    lines.push(`${indent}- **${node.label}**${relation}`)
    // 描述只是导航元数据（§4）：回答必须回到下面的原文，不能拿它当事实依据
    lines.push(`${indent}  ${node.description}（导航元数据，非事实依据）`)
    for (const ref of node.evidenceRefs) lines.push(`${indent}  - ${quote(byId.get(ref), ref)}`)
    for (const child of node.children) walk(child, depth + 1)
  }
  walk(tree.root, 0)
  return lines.join('\n')
}

export interface TreeInspectionEntry {
  paperId: string
  /** 建树成功时的树与证据块 */
  outcome?: { tree: SemanticTree; blocks: EvidenceBlock[] }
  /** 建树失败的原因；与 outcome 互斥 */
  failure?: string
}

/** 多篇论文的检查报告。 */
export function renderTreeReport(entries: TreeInspectionEntry[]): string {
  const lines: string[] = ['# 语义树结构人工检查', '']
  for (const entry of entries) {
    lines.push(`## ${entry.paperId}`, '')
    if (!entry.outcome) {
      lines.push(`建树失败：\`${entry.failure ?? 'unknown'}\`（该篇问答回落平面检索）`, '')
      continue
    }
    lines.push(renderTreeOutline(entry.outcome.tree, entry.outcome.blocks), '')
  }
  return lines.join('\n')
}

export interface CardInspectEntry {
  paperId: string
  title: string
  passages: Passage[]
  cards: StructureCard[]
  /** 卡片回落原因；未回落则不传 */
  fallback?: string
  paper?: { title: string; summary: string }
}

/**
 * 卡片划分的人工核对报告（方案 §7「结构抽查」）：范围、标题、keyTerms 逐张列出，
 * 供人工判断「主题划分是否合理」——这一步无法由程序校验。
 */
export function renderCardReport(entry: CardInspectEntry): string {
  const byId = new Map(entry.passages.map(passage => [passage.id, passage]))
  const lines: string[] = []
  lines.push(`## ${entry.title}（${entry.paperId}）`)
  lines.push('')
  if (entry.fallback) lines.push(`> 卡片回落：\`${entry.fallback}\`（标题卡片，无 summary / keyTerms）`)
  if (entry.paper) {
    lines.push(`- 论文标题：${entry.paper.title}`)
    lines.push(`- 论文摘要：${entry.paper.summary}`)
  }
  lines.push(`- 段落数：${entry.passages.length}，卡片数：${entry.cards.length}`)
  lines.push('')
  lines.push('| 卡片 | 范围 | 页区间 | 标题 | keyTerms |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const card of entry.cards) {
    const first = byId.get(card.range[0])
    const last = byId.get(card.range[1])
    // 页区间用原始 1-based（与 `pageIndex.formatSource` 的「Pages N–N」同一口径、同一个 en dash），
    // 人工核对时与 PDF 页码直接对上
    const pages = first && last ? `${first.pieces[0].page + 1}–${last.pieces[last.pieces.length - 1].page + 1}` : '—'
    lines.push(`| ${card.id} | ${card.range[0]}–${card.range[1]} | ${pages} | ${card.title} | ${card.keyTerms.join(', ') || '—'} |`)
  }
  lines.push('')
  return lines.join('\n')
}
