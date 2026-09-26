/**
 * 用真实 QASPER **原始**数据建树并打印结构，人工核对。不属于单测。
 *
 * **刻意不读 bench/datasets/qasper/qasper.jsonl**：那是已归一化的旧产物、不含节结构
 * 字段（loadQasperDataset 只做 JSON 解析与题目字段校验，不重跑 normalizeQasperEntry），且被
 * .gitignore 忽略、无从恢复；重跑 fetch.ts 会覆写它，那是全部既有基线结果所依据的语料。
 *
 * 因此这里只从上游**只读**取 full_text，不写任何文件。建树只需要 section_name 与
 * paragraphs，直接调 sectionsToPages 即可：既不必复刻 fetch.ts 里的 qas 转置，
 * 也**不能** import fetch.ts——它有顶层副作用，一 import 就会拉取并覆写数据集。
 */
import { sectionsToPages } from '../src/datasets/qasper'
import { buildQasperTree } from '../src/toc/qasperTree'
import { fetchQasperRows } from '../src/toc/qasperRows'
import type { TocNode } from '../../src/utils/tocTree'

const LIMIT = Number(process.env.QASPER_LIMIT ?? '60')

function print(nodes: TocNode[], indent: string): void {
  for (const node of nodes) {
    console.log(`${indent}${node.title}  pages=[${node.pages.join(',')}]`)
    print(node.children, `${indent}  `)
  }
}

/** 返回最大 `TocNode.depth`，即**0-based 深度索引**；层数 = 返回值 + 1。把两者混用会把三层树报成两层。 */
const depthOf = (node: TocNode): number =>
  node.children.length === 0 ? node.depth : Math.max(...node.children.map(depthOf))

interface Built {
  id: string
  sectionCount: number
  tree: TocNode[]
  synthesizedParents: number
  droppedSections: number
}

async function main(): Promise<void> {
  const rows = await fetchQasperRows(LIMIT)

  let withSections = 0
  let maxLevels = 0
  let synthesized = 0
  let dropped = 0
  const invalid: string[] = []
  const built: Built[] = []
  for (const row of rows) {
    const names = row.full_text.section_name
    if (names.length > 0) withSections += 1
    // sectionsToPages 刻意留在 try **之外**：它出错是调用方的编程错误，不是论文的数据属性，
    // 把它算进下面的「节结构非法」就等于把这个逐篇结论栽赃成论文的锅。
    const { sectionPages } = sectionsToPages(names, row.full_text.paragraphs)
    // 节结构非法是**设计内**的结果（整篇作废、不修补），真实论文里出现非相邻的
    // 同名节完全可能。冒烟脚本必须把它统计出来而不是崩掉：这个数字直接决定树路由
    // 在多少篇上根本用不上——那些篇会整篇回落平面检索，是结论的一部分。
    try {
      const result = buildQasperTree({ sectionNames: names, sectionPages })
      synthesized += result.synthesizedParents
      dropped += result.droppedSections
      for (const node of result.tree) maxLevels = Math.max(maxLevels, depthOf(node) + 1)
      built.push({
        id: row.id, sectionCount: names.length, tree: result.tree,
        synthesizedParents: result.synthesizedParents, droppedSections: result.droppedSections,
      })
    } catch (error) {
      invalid.push(`${row.id}: ${(error as Error).message}`)
    }
  }
  console.log(`样本 ${rows.length} 篇，带节结构 ${withSections}/${rows.length}`)
  console.log(`最深 ${maxLevels} 层，合成父节点 ${synthesized}，丢弃节 ${dropped}`)
  console.log(`节结构非法 ${invalid.length} 篇（这些篇整篇回落平面检索）`)
  for (const line of invalid.slice(0, 10)) console.log(`  ${line}`)

  // 从**已建成的**里取前 3 篇：头 3 篇里若有一篇结构非法，未过滤就会让整个冒烟崩掉
  for (const entry of built.slice(0, 3)) {
    console.log(`\n--- ${entry.id}（节 ${entry.sectionCount}）`)
    print(entry.tree, '  ')
    console.log(`  合成父节点 ${entry.synthesizedParents}，丢弃节 ${entry.droppedSections}`)
  }
}

main().catch(error => { console.error(error); process.exit(1) })
