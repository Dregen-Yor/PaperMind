/**
 * 真 PDF 的 TOC+jev 端到端试跑：**打开真正的 PDF**，从文本层抽节结构建树，
 * 再让本地 jev 判定模型逐层挑证据。用于看速度与选择质量，不是基准。
 *
 * 用法：
 *   npx tsx bench/scripts/jevPdfTrial.ts <pdf路径>                    # 只看树结构
 *   npx tsx bench/scripts/jevPdfTrial.ts <pdf路径> "问题文本"          # 走完整遍历
 *   npx tsx bench/scripts/jevPdfTrial.ts <pdf路径> "问题" --alpha 0.7 --top-n 3
 *
 * **与 QASPER 路线（`jevSmoke.ts` / `jevProbe.ts`）的根本区别**：那两条走的是
 * QASPER 的 `section_name` 与 3000 字符伪页，从不打开 PDF；这条走 `extractPages` +
 * `extractPdfSections`，页是**真正的 PDF 页**。因此两者的绝对数字**不可互比**
 * ——伪页是数据集为评测做的切分，真 PDF 页里混着页眉、参考文献、排版噪声。
 *
 * **本脚本不产生指标**：真 PDF 没有 gold 证据页，`evidenceRecall` / `precision` 无从算起。
 * 它给的是**可人工核对的选择 + 真实耗时**。要指标得回 QASPER 那条路（Plan 2 的四条对照臂）。
 *
 * α/N 默认取 0.7 / 3：探针在 30 篇 66 题上的诊断显示这一格召回最高（meanRecall 54.2%），
 * 但那只是**诊断上的单臂最优**，没有对照臂，不代表它就是好的取值。
 */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extractPages } from '../../src/utils/pageIndex'
import { traverseWithJudge, tocNodePageSpan, type TocNode } from '../../src/utils/tocTree'
import { extractPdfSections } from '../src/toc/pdfSections'
import { buildQasperTree } from '../src/toc/qasperTree'
import { createMlxJudge } from '../src/jev/mlxJudge'

interface Args {
  pdfPath: string
  query: string | null
  alpha: number
  topN: number
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = []
  let alpha = 0.7
  let topN = 3
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--alpha') {
      alpha = Number(argv[++i])
      if (!Number.isFinite(alpha) || alpha <= 0 || alpha > 1) {
        // α>1 会让 θ = α·max 高于层内最高分，把整层滤空并触发 `emptySelectionFallback`，
        // 而那个标志的语义是「存活节点全无内容」——诊断会把成因指错。当场拒掉。
        throw new RangeError(`--alpha 必须在 (0, 1] 内，收到 ${arg} ${argv[i]}`)
      }
    } else if (arg === '--top-n') {
      topN = Number(argv[++i])
      if (!Number.isInteger(topN) || topN < 1) {
        throw new RangeError(`--top-n 必须是正整数，收到 ${arg} ${argv[i]}`)
      }
    } else {
      positional.push(arg)
    }
  }
  const [pdfPath, query] = positional
  if (!pdfPath) throw new Error('缺 PDF 路径。用法：jevPdfTrial.ts <pdf路径> ["问题文本"] [--alpha 0.7] [--top-n 3]')
  return { pdfPath, query: query ?? null, alpha, topN }
}

/** 按深度汇总树形，供人工判断「这棵树是不是真的分出了层级」。 */
function describeTree(tree: TocNode[]): { total: number; byDepth: Map<number, number>; withContent: number } {
  const byDepth = new Map<number, number>()
  let total = 0
  let withContent = 0
  const walk = (nodes: TocNode[]): void => {
    for (const node of nodes) {
      total += 1
      byDepth.set(node.depth, (byDepth.get(node.depth) ?? 0) + 1)
      if (node.pages.length > 0) withContent += 1
      walk(node.children)
    }
  }
  walk(tree)
  return { total, byDepth, withContent }
}

async function main(): Promise<void> {
  const { pdfPath, query, alpha, topN } = parseArgs(process.argv.slice(2))
  if (!existsSync(pdfPath)) throw new Error(`PDF 不存在：${pdfPath}`)

  // ---- 抽取页文本 ----
  const extractStarted = Date.now()
  const base64 = (await readFile(pdfPath)).toString('base64')
  const pages = await extractPages(base64)
  const extractMs = Date.now() - extractStarted
  console.log(`PDF: ${pdfPath}`)
  console.log(`页数: ${pages.length}（抽取耗时 ${extractMs}ms）`)
  if (pages.length === 0) throw new Error('抽取到 0 页，无法继续')

  // ---- 抽节结构并建树 ----
  const buildStarted = Date.now()
  const sections = extractPdfSections(pages)
  console.log(`\n节结构: route=${sections.route}，节数 ${sections.sectionNames.length}`)
  if (sections.tocPages.length > 0) console.log(`  目录页（整页跳过）: [${sections.tocPages.join(', ')}]`)
  if (sections.synthesizedAncestors.length > 0) {
    // 这些标题不是论文里的措辞，是编号占位，会进判定器的输入——必须可见。
    console.log(`  合成祖先（标题用了编号占位，非论文措辞）: [${sections.synthesizedAncestors.join(', ')}]`)
  }
  if (sections.preamblePages.length > 0) {
    // 前导页不属于任何节 ⇒ 永远检索不到。这是真实损失，不是统计口径。
    console.log(`  前导页（不属任何节，永远检索不到）: [${sections.preamblePages.join(', ')}]`)
  }

  if (sections.sectionNames.length === 0) {
    throw new Error(
      '没抽到任何节标题。该 PDF 的文本层里既没有编号标题、也没有可识别的通用章节名——' +
      '这条路（文本层推断）走不通，得改走 pdf.js 的 getOutline() 读内嵌目录。',
    )
  }

  const { tree, synthesizedParents, droppedSections } = buildQasperTree({
    sectionNames: sections.sectionNames,
    sectionPages: sections.sectionPages,
  })
  process.stdout.write('\n树:\n')
  const printTree = (nodes: TocNode[], indent: string): void => {
    for (const node of nodes) {
      const span = node.pages.length > 0 ? `pages=[${node.pages.join(',')}]` : 'pages=[]（只导航）'
      console.log(`${indent}${node.title}  ${span}`)
      printTree(node.children, `${indent}  `)
    }
  }
  printTree(tree, '  ')
  const shape = describeTree(tree)
  console.log(
    `  合计 ${shape.total} 节点 / ${shape.withContent} 带内容，` +
    `按深度 ${[...shape.byDepth.entries()].sort((a, b) => a[0] - b[0]).map(([d, n]) => `d${d}:${n}`).join(' ')}，` +
    `空父节点 ${synthesizedParents}，丢弃空标题节 ${droppedSections}（建树耗时 ${Date.now() - buildStarted}ms）`,
  )

  if (query === null) {
    console.log('\n（未给问题，只建树。补一个问题文本即可跑完整遍历。）')
    return
  }

  // ---- 逐层判定 ----
  console.log(`\n问题: ${query}`)
  const judge = createMlxJudge()
  try {
    // 先热身一次，把**权重载入**从遍历里摘出去：侧车首次 `judge` 才载入模型（实测 ~0.44s），
    // 算进遍历会得出「每节点 260ms」这种差一个数量级的假读数（真实约 14ms/节点）。
    // 热身本身也真实发生（多一次侧车往返），所以照实打印它的耗时，不藏。
    const warmStarted = Date.now()
    await judge.judge({ query: 'warmup', nodes: [{ id: 'warmup', title: 'warmup', path: [] }] })
    console.log(`判定器载入（热身一次，含权重）${Date.now() - warmStarted}ms`)

    // 空候选短路在 traverseWithJudge 内部，这里量不到「空跑」——但真实规模下层内候选恒 >0。
    const started = Date.now()
    const selection = await traverseWithJudge(tree, query, judge, { alpha, topN })
    const traverseMs = Date.now() - started
    console.log(`遍历耗时 ${traverseMs}ms（不含权重载入）`)

    if (selection.layers.length === 0) throw new Error('遍历未调用判定器（layers 为空），试跑不成立')
    const candidates = selection.layers.reduce((sum, l) => sum + l.candidates, 0)
    console.log(`逐层诊断（α=${alpha}, topN=${topN}）: ${JSON.stringify(selection.layers)}`)
    if (candidates > 0) {
      console.log(`判定节点数 ${candidates}，平均 ${(traverseMs / candidates).toFixed(1)}ms/节点`)
    }
    console.log(`空内容跳过 ${selection.emptyContentSkipped}，空选择回落 ${selection.emptySelectionFallback}`)
    if (selection.emptySelectionFallback) {
      // 这不是「检索成功」，是「什么都没选中、只好退回首个非空节点」。指出来，别让人当成一次命中。
      console.warn('⚠ 触发了空选择回落：本次的“选中”不是判定器选出来的结果。')
    }

    console.log('\n选中:')
    for (const node of selection.selected) {
      console.log(`  ${node.path.concat(node.title).join(' > ')}  pages=[${node.pages.join(',')}]`)
    }
    const preview = selection.selected
      .flatMap(node => tocNodePageSpan(node, pages))
      .slice(0, 2)
      .map(piece => `--- p${piece.page} ---\n${piece.text.slice(0, 400)}`)
      .join('\n')
    console.log(`\n选中原文前两片:\n${preview}`)
  } finally {
    await judge.close()
  }
}

main().catch(error => {
  console.error(`\n试跑失败: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
