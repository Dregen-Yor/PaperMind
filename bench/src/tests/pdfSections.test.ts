/**
 * `extractPdfSections` 的节结构抽取。
 *
 * 页文本一律用合成的字符串而非真 PDF：本模块不 import `pageIndex`、不碰 pdfjs，
 * 所以测试也不该为了它背一个 `vi.mock('pdfjs-dist/...')`。真 PDF 那条路由
 * `bench/scripts/jevPdfTrial.ts` 端到端跑。
 */
import { describe, it, expect } from 'vitest'
import { extractPdfSections, TOC_PAGE_MIN_HEADINGS } from '../toc/pdfSections'
import { buildQasperTree } from '../toc/qasperTree'

/** 把若干行拼成一页；页与页之间用数组下标当页号。 */
const page = (...lines: string[]) => lines.join('\n')

describe('extractPdfSections 节区间', () => {
  it('相邻页重复出现的同一标题按运行页眉吸收，不碎成两节', () => {
    const pages = [
      page('PM-2026', '1 Introduction', '正文'),
      page('PM-2026', '1 Introduction', '续页正文'),
      page('PM-2026', '2 Methods', '方法正文'),
      page('PM-2026', '2 Methods', '方法续页'),
    ]
    const r = extractPdfSections(pages)
    expect(r.sectionNames).toEqual(['Introduction', 'Methods'])
    expect(r.sectionPages).toEqual([[0, 1], [2, 3]])
    expect(r.route).toBe('numbered')
  })

  it('节区间延伸到下一节起始页之前，中间的页不会被丢掉', () => {
    // 只认「标题重复出现的页」的话，p1–p3 会不属于任何节——静默丢内容且指标上看不出来。
    const pages = [
      page('1 Introduction'),
      page('正文一'), page('正文二'), page('正文三'),
      page('2 Methods'),
      page('正文四'),
    ]
    const r = extractPdfSections(pages)
    expect(r.sectionNames).toEqual(['Introduction', 'Methods'])
    expect(r.sectionPages).toEqual([[0, 1, 2, 3], [4, 5]])
  })

  it('编号推出层级，路径用父到子拼接', () => {
    const pages = [
      page('1 Introduction'),
      page('1.1 Background'),
      page('背景正文'),
      page('1.1.1 Details'),
      page('2 Methods'),
    ]
    const r = extractPdfSections(pages)
    expect(r.sectionNames).toEqual([
      'Introduction',
      'Introduction ::: Background',
      'Introduction ::: Background ::: Details',
      'Methods',
    ])
    expect(r.sectionPages).toEqual([[0], [1, 2], [3], [4]])
    expect(r.synthesizedAncestors).toEqual([])
  })

  it('父节条目排在子节之后时，父标题仍取自父节自己的条目', () => {
    // 边扫边算会让 `1.1` 的父标题先落成占位符 `1`，之后 `1 Method` 又改成 `Method`，
    // 同一路径出现两个名字 → 树里多出节点且页区间可能不连续。两趟收集正是为这个。
    const pages = [page('1.1 Data'), page('1 Method'), page('正文')]
    const r = extractPdfSections(pages)
    expect(r.sectionNames).toEqual(['Method ::: Data', 'Method'])
    expect(r.synthesizedAncestors).toEqual([])
  })

  it('祖先编号从未以标题出现时用编号占位，并如实计数', () => {
    const pages = [page('2.1 Data'), page('正文')]
    const r = extractPdfSections(pages)
    expect(r.sectionNames).toEqual(['2 ::: Data'])
    // 占位标题**不是论文的措辞**，会进入判定器输入，所以必须可用可核对。
    expect(r.synthesizedAncestors).toEqual(['2'])
  })

  it('同页出现父与子标题时，父节内容区间为空数组而不是负区间', () => {
    const pages = [page('1 Introduction', '1.1 Background'), page('正文')]
    const r = extractPdfSections(pages)
    expect(r.sectionNames).toEqual(['Introduction', 'Introduction ::: Background'])
    // 父节只导航、不携带内容，正是 traverseWithJudge 的「空内容过滤 + 父节点兜底」要处理的形态。
    expect(r.sectionPages).toEqual([[], [0, 1]])
  })
})

describe('extractPdfSections 异常页', () => {
  it('单页标题数达到阈值即整页跳过并记录页号', () => {
    const toc = page('1 A', '2 B', '3 C', '4 D', '5 E')
    expect(TOC_PAGE_MIN_HEADINGS).toBeLessThanOrEqual(5)
    const pages = [toc, page('1 A'), page('正文一'), page('2 B'), page('正文二')]
    const r = extractPdfSections(pages)
    expect(r.tocPages).toEqual([0])
    expect(r.sectionNames).toEqual(['A', 'B'])
    expect(r.sectionPages).toEqual([[1, 2], [3, 4]])
  })

  it('首个节之前的页记为前导页，且不被任何节认领', () => {
    const pages = [page('论文标题与摘要'), page('摘要续'), page('1 Introduction'), page('正文')]
    const r = extractPdfSections(pages)
    expect(r.preamblePages).toEqual([0, 1])
    // 前导页进不了任何节点 ⇒ 永远检索不到。这是**已知损失**，必须能被看见，不能靠推断。
    expect(r.sectionPages.every(span => !span.includes(0) && !span.includes(1))).toBe(true)
  })

  it('一个编号标题都没有时退化为平铺一层', () => {
    const pages = [page('Introduction'), page('正文'), page('Methods')]
    const r = extractPdfSections(pages)
    expect(r.route).toBe('flat')
    expect(r.sectionNames).toEqual(['Introduction', 'Methods'])
    expect(r.sectionPages).toEqual([[0, 1], [2]])
  })

  it('没有任何标题的文档返回空结构与全前导页，且不抛错', () => {
    const r = extractPdfSections([page('纯正文一'), page('纯正文二')])
    expect(r.sectionNames).toEqual([])
    expect(r.sectionPages).toEqual([])
    expect(r.route).toBe('flat')
    expect(r.preamblePages).toEqual([0, 1])
  })

  it('空页数组返回空结果', () => {
    const r = extractPdfSections([])
    expect(r.sectionNames).toEqual([])
    expect(r.preamblePages).toEqual([])
  })
})

describe('extractPdfSections 与 buildQasperTree 的接口约定', () => {
  it('输出可直接建树：路径分隔符与层级语义两侧一致', () => {
    // 这条是**交叉断言**，不是重复断言：`PATH_SEP` 在两个模块里各写了一份，
    // 只有真的喂进去建一次树，才能证明两份取值没漂移。靠注释互相提醒是防不住的。
    const pages = [
      page('1 Introduction'),
      page('1.1 Background'),
      page('背景正文'),
      page('1.1.1 Details'),
      page('2 Methods'),
    ]
    const { sectionNames, sectionPages } = extractPdfSections(pages)
    const { tree, droppedSections } = buildQasperTree({ sectionNames, sectionPages })

    expect(droppedSections).toBe(0)
    expect(tree.map(n => n.title)).toEqual(['Introduction', 'Methods'])
    expect(tree[0].pages).toEqual([0])
    expect(tree[0].children.map(n => n.title)).toEqual(['Background'])
    expect(tree[0].children[0].pages).toEqual([1, 2])
    expect(tree[0].children[0].children.map(n => n.title)).toEqual(['Details'])
    expect(tree[0].children[0].children[0].pages).toEqual([3])
    expect(tree[1].pages).toEqual([4])
  })
})
