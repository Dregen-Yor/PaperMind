/**
 * Jev 判定冒烟：确认侧车能起、判定器真的被调用，并把选择打出来人工核对。
 *
 * **能证明的**：`laya_mlx` 能加载本地权重、协议往返通、`traverseWithJudge` 走到了判定器、返回的分数合法。
 * **不能证明的**：概率有区分度。上游第一篇论文（`fetchQasperRows(1)` 给的是 `1912.01214`，XLM 那篇）
 * 若与问题不搭，模型输出就是噪声——人工看输出分不出「判定器坏了」和「问题不属这篇论文」。
 * 所以这里**用论文自己的问题**（`qas.question[0]`），让「选中是否相关」成为一件可判断的事。
 * 区分度的判据是 Step 2 的合成节点对照，以及后续的 α/N 网格，不是本脚本。
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

async function main(): Promise<void> {
  const [row] = await fetchQasperRows(1)
  const { sectionPages } = sectionsToPages(row.full_text.section_name, row.full_text.paragraphs)
  const { tree } = buildQasperTree({ sectionNames: row.full_text.section_name, sectionPages })

  // 空树必须响亮失败：否则下面的 traverseWithJudge 会直接返回空选择，
  // 冒烟会在「判定器根本没跑」的情况下报绿——这正是本脚本最该防的假成功。
  if (tree.length === 0) throw new Error('建树结果为空：上游节结构字段可能变了，冒烟无法成立')

  // 用论文**自己的**问题。写死一个固定问题会与「第一篇论文」错配，使「选中是否相关」无从判断——
  // `qas.question` 与 `qas.answers` 同序并列，取第 0 个不需要 fetch.ts 那套 list-of-struct 转置。
  const query = row.qas.question[0]
  if (!query) throw new Error('该论文没有问题文本，冒烟无法成立')

  console.log(`论文: ${row.title.slice(0, 60)}（${row.id}）`)
  console.log(`问题: ${query}`)
  console.log(`树: 顶层 ${tree.length} 个节点`)

  const judge = createMlxJudge()
  try {
    const started = Date.now()
    // alpha=0.9 而非 0.5：这批概率被温度压得很窄，实测 α=0.5 时每层 survivors === candidates
    // （6/6、3/3、2/2），层内阈值一个都没滤掉、全是 top-N 在选。冒烟要真的走到阈值分支才有意义。
    // 0.9 只是冒烟取值，不是实验选定格点；α/N 网格属 Plan 2，见设计文档 §3.2。
    const sel = await traverseWithJudge(tree, query, judge, { alpha: 0.9, topN: 2 })
    console.log(`遍历耗时 ${Date.now() - started}ms`)
    // 这条其实是**冗余**的：树非空时 traverseWithJudge 必然至少 push 一层（tocTree.ts:162 只在
    // nodes 为空时短路）。留作双保险，但别把它当防线——防假绿的是上面那条 tree.length 断言。
    if (sel.layers.length === 0) throw new Error('遍历未调用判定器（layers 为空），冒烟不成立')
    console.log('逐层诊断:', JSON.stringify(sel.layers, null, 2))
    console.log('选中:', sel.selected.map(n => `${n.title} pages=[${n.pages.join(',')}]`))
  } finally {
    await judge.close()
  }
}

main().catch(error => { console.error(error); process.exit(1) })
