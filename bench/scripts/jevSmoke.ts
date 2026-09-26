/**
 * Jev 判定冒烟：用真实 QASPER 论文确认本地权重可用、概率有区分度。
 *
 * **刻意不走 `loadQasperDataset` 取节结构**：冻结数据集不含节结构字段（见 `qasperRows.ts` 的说明），
 * 拿到的会是 `undefined`，`?? []` 会静默建出空树，而空树在 `tocTree.ts:162` 就返回——
 * 判定器一次都不会被调用，脚本却会以 `exit 0` 通过。所以节结构与 `tocSmoke.ts` 一样从上游只读取。
 *
 * 全部逻辑包在 main() 里，只为失败时有一个明确的 exit 1——**不是**为了绕开转译限制：
 * 顶层 await 在 bench/ 下是可用的（bench/package.json 是 "type": "module"）。
 */
import { fetchQasperRows } from '../src/toc/qasperRows'
import { sectionsToPages } from '../src/datasets/qasper'
import { createMlxJudge } from '../src/jev/mlxJudge'
import { buildQasperTree } from '../src/toc/qasperTree'
import { traverseWithJudge } from '../../src/utils/tocTree'

/** 固定问题（不用数据集里的）：探针已确认 Transformer 论文的 Multi-Head Attention 节排第一，期望因此是确定的。 */
const QUERY = 'How many attention heads does the Transformer use?'

async function main(): Promise<void> {
  const [row] = await fetchQasperRows(1)
  const { sectionPages } = sectionsToPages(row.full_text.section_name, row.full_text.paragraphs)
  const { tree } = buildQasperTree({ sectionNames: row.full_text.section_name, sectionPages })

  // 空树必须响亮失败：否则下面的 traverseWithJudge 会直接返回空选择，
  // 冒烟会在「判定器根本没跑」的情况下报绿——这正是本脚本最该防的假成功。
  if (tree.length === 0) throw new Error('建树结果为空：上游节结构字段可能变了，冒烟无法成立')

  console.log(`论文: ${row.id}`)
  console.log(`问题: ${QUERY}`)
  console.log(`树: 顶层 ${tree.length} 个节点`)

  const judge = createMlxJudge()
  try {
    const started = Date.now()
    // alpha=0.5 只是冒烟取值，不是实验选定格点；真的 α 网格见设计文档 §3.2。
    const sel = await traverseWithJudge(tree, QUERY, judge, { alpha: 0.5, topN: 2 })
    console.log(`遍历耗时 ${Date.now() - started}ms`)
    // layers 为空 == 判定器一次都没被调用（traverseWithJudge 对空节点直接返回）。
    // 这条断言是本脚本的承重墙：没有它，上面所有打印都可能在「没跑模型」时照常出现。
    if (sel.layers.length === 0) throw new Error('遍历未调用判定器（layers 为空），冒烟不成立')
    console.log('逐层诊断:', JSON.stringify(sel.layers, null, 2))
    console.log('选中:', sel.selected.map(n => `${n.title} pages=[${n.pages.join(',')}]`))
  } finally {
    await judge.close()
  }
}

main().catch(error => { console.error(error); process.exit(1) })
