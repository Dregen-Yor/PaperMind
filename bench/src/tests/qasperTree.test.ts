import { describe, it, expect } from 'vitest'
import { sectionsToPages, PSEUDO_PAGE_CHARS } from '../datasets/qasper'
import { buildQasperTree, validateSections, MAX_TOC_DEPTH } from '../toc/qasperTree'
import type { TocNode } from '../../../src/utils/tocTree'

describe('sectionsToPages —— sectionPages 与 pages 同源', () => {
  it('节的页区间覆盖其内容真正落入的伪页', () => {
    const names = ['Intro', 'Method']
    // 每段 1200 字符：标题 + 两段共约 2415 字符 < 3000，两节都落在 p0
    const sections = [['x'.repeat(1200)], ['y'.repeat(1200)]]
    const { pages, sectionPages } = sectionsToPages(names, sections)
    expect(sectionPages).toHaveLength(2)
    for (const [i, touched] of sectionPages.entries()) {
      expect(touched.length).toBeGreaterThan(0)
      for (const page of touched) expect(page).toBeLessThan(pages.length)
      // 区间必须升序且不重复
      expect(touched).toEqual([...new Set(touched)].sort((a, b) => a - b))
    }
  })

  it('标题与其首段强制同页：sectionPages 的首元素等于该首段落的伪页号', () => {
    // 先塞一个几乎占满页的节，逼出封页，再验证下一节的标题没被孤立
    const names = ['Filler', 'Method']
    const sections = [
      ['f'.repeat(PSEUDO_PAGE_CHARS - 10)],
      ['z'.repeat(50)],
    ]
    const { paragraphToPage, sectionPages } = sectionsToPages(names, sections)
    // 第 2 节只有 1 段，对应 paragraphToPage[1]
    expect(sectionPages[1]).toEqual([paragraphToPage[1]])
  })

  it('无内容的节得到空数组', () => {
    const { pages, sectionPages } = sectionsToPages(['Empty', 'Real'], [[], ['body']])
    expect(sectionPages[0]).toEqual([])
    expect(sectionPages[1].length).toBeGreaterThan(0)
    expect(pages.join('\u0000')).toContain('Empty')
  })

  it('不改变既有输出：pages 与 paragraphToPage 对固定输入产出确定值', () => {
    // 必须拿**字面量**钉。比两次调用（`expect(f(x)).toBe(f(x))`）是拿函数与自己比，
    // 名字再像「逐字不变」也不可能失败。下面的期望值是本次改动前实现的实际输出。
    // 这份输入约 24 字符、全部落在单页，所以只钉得住**段落切片与标题拼接**的产物：
    // 切片改成从 0 开始、标题不再拼接等会让它变红。它**钉不住**封页条件
    //（`PSEUDO_PAGE_CHARS` 提到 10000、把 `>` 改成 `>=` 都照绿——封页另见下面的
    //「跨封页边界」用例），也钉不住「标题与首段同页」的耦合（拆成两次 append 输出不变）。
    const { pages, paragraphToPage } = sectionsToPages(['A', 'B', 'C'], [['a1', 'a2'], ['b1'], ['c1', 'c2', 'c3']])
    expect(paragraphToPage).toEqual([0, 0, 0, 0, 0, 0])
    expect(pages).toEqual(['A\n\na1\n\na2\n\nB\n\nb1\n\nC\n\nc1\n\nc2\n\nc3'])
  })

  it('跨封页边界时节号随之 +1（节区间与打包同源的关键场景）', () => {
    // 单页输入钉不住封页条件：`PSEUDO_PAGE_CHARS` 或 `bufferLen + text.length > …`
    // 被改动时单页 golden 照过。这里先顶满第一页，再验证第二节确实落到**第二页**。
    const names = ['Filler', 'Method']
    const sections = [['a'.repeat(PSEUDO_PAGE_CHARS - 100)], ['b'.repeat(200)]]
    const { pages, paragraphToPage, sectionPages } = sectionsToPages(names, sections)
    expect(pages).toHaveLength(2)
    expect(paragraphToPage).toEqual([0, 1])
    expect(sectionPages).toEqual([[0], [1]])
    expect(pages[1]).toBe(`Method\n\n${'b'.repeat(200)}`)
  })

  it('一节跨多页时记录完整页区间，不止首页或末页', () => {
    // 全文件只有这条用例让 sectionPages 的条目长度 > 1。若 note() 改造得只记首次
    // 或只记末次（例如 touched = [pages.length]），其余用例全绿——而「页区间」
    // 正是这个返回值的全部意义。
    const { pages, paragraphToPage, sectionPages } = sectionsToPages(['S'], [['x'.repeat(2000), 'y'.repeat(2000)]])
    expect(pages).toHaveLength(2)
    expect(paragraphToPage).toEqual([0, 1])
    expect(sectionPages).toEqual([[0, 1]])
  })
})

const build = (names: string[], pages: number[][]) =>
  buildQasperTree({ sectionNames: names, sectionPages: pages })

describe('buildQasperTree', () => {
  it('扁平节列表产出单层树', () => {
    const { tree } = build(['Introduction', 'Method', 'Conclusion'], [[0], [1], [2]])
    expect(tree.map(n => n.title)).toEqual(['Introduction', 'Method', 'Conclusion'])
    expect(tree.every(n => n.depth === 0 && n.children.length === 0)).toBe(true)
    expect(tree[1].pages).toEqual([1])
  })

  it(' ::: 还原父子关系，path 与 depth 正确', () => {
    const { tree } = build(
      ['Approach', 'Approach ::: Masked LM', 'Approach ::: Bridge LM', 'Experiments'],
      [[0], [1], [2], [3]],
    )
    expect(tree.map(n => n.title)).toEqual(['Approach', 'Experiments'])
    expect(tree[0].children.map(n => n.title)).toEqual(['Masked LM', 'Bridge LM'])
    expect(tree[0].children[0].path).toEqual(['Approach'])
    expect(tree[0].children[0].depth).toBe(1)
  })

  it('父节点缺条目时合成一个导航节点（pages 为空）', () => {
    const { tree, synthesizedParents } = build(
      ['Approach ::: Masked LM', 'Approach ::: Bridge LM'],
      [[1], [2]],
    )
    expect(tree.map(n => n.title)).toEqual(['Approach'])
    expect(tree[0].pages).toEqual([])
    expect(synthesizedParents).toBe(1)
    expect(tree[0].children.map(n => n.title)).toEqual(['Masked LM', 'Bridge LM'])
  })

  it('只有标题、没有子节点的节不计入 synthesizedParents', () => {
    // 加这条是为了钉住 children.length > 0 这个合取项：删掉它，这条会变成 1
    expect(build(['A'], [[]]).synthesizedParents).toBe(0)
  })

  it('父节点后出现自己的条目时，页合并不新建节点', () => {
    const { tree } = build(['Approach ::: Masked LM', 'Approach'], [[1], [0]])
    expect(tree).toHaveLength(1)
    expect(tree[0].pages).toEqual([0])
  })

  it('标题两端空白被 trim（实测存在尾随空格的节名）', () => {
    const { tree } = build(['  Dogmatism data  ', 'What is X? (R1)'], [[0], [1]])
    expect(tree.map(n => n.title)).toEqual(['Dogmatism data', 'What is X? (R1)'])
  })

  it('空标题的节被丢弃并计数', () => {
    const { tree, droppedSections } = build(['Introduction', '   ', ''], [[0], [1], [2]])
    expect(tree.map(n => n.title)).toEqual(['Introduction'])
    expect(droppedSections).toBe(2)
  })

  it('三层嵌套正确挂载', () => {
    const { tree } = build(
      ['Experiments ::: Setup ::: Datasets.', 'Experiments ::: Setup ::: Details.'],
      [[2], [3]],
    )
    const experiments = tree[0]
    const setup = experiments.children[0]
    expect([experiments.title, setup.title, experiments.depth, setup.depth]).toEqual(['Experiments', 'Setup', 0, 1])
    expect(setup.children.map(n => n.title)).toEqual(['Datasets.', 'Details.'])
    expect(setup.children[0].depth).toBe(2)
  })

  it('六层链路建树：depth / path / pages 逐层正确', () => {
    const name = Array.from({ length: MAX_TOC_DEPTH }, (_, i) => `L${i}`).join(' ::: ')
    const { tree, synthesizedParents } = build([name], [[0]])
    const chain: TocNode[] = []
    for (let node: TocNode | undefined = tree[0]; node; node = node.children[0]) chain.push(node)
    expect(chain.map(n => n.depth)).toEqual([0, 1, 2, 3, 4, 5])
    expect(chain.map(n => n.path)).toEqual([
      [], ['L0'], ['L0', 'L1'], ['L0', 'L1', 'L2'], ['L0', 'L1', 'L2', 'L3'], ['L0', 'L1', 'L2', 'L3', 'L4'],
    ])
    // 只有最深层那一节携带内容；五层祖先都是「有子节点、无 pages」的导航节点
    expect(chain.map(n => n.pages)).toEqual([[], [], [], [], [], [0]])
    expect(synthesizedParents).toBe(5)
  })

  it('自嵌套经建树入口同样被拒（校验在函数内部执行）', () => {
    expect(() => build(['A ::: A'], [[0]])).toThrow('invalid-section-structure: cyclic-path')
  })

  it('节点 id 按先序自 S000 编号，且每次调用都从头计数', () => {
    const names = ['A', 'A ::: B']
    const ids = () => build(names, [[0], [1]]).tree.flatMap(n => [n.id, ...n.children.map(c => c.id)])
    expect(ids()).toEqual(['S000', 'S001'])
    // 计数器必须是本次调用的局部量：若是模块级状态，第二次调用会接着数到 S002
    expect(ids()).toEqual(['S000', 'S001'])
  })

  it('空输入返回空树', () => {
    expect(build([], []).tree).toEqual([])
  })

  it('节结构非法时抛错，绝不产出带断层的树', () => {
    // 校验在 buildQasperTree 内部执行，调用方无法绕过
    expect(() => build(['Results', 'Methods', 'Results'], [[1], [2, 3, 4], [5]]))
      .toThrow('invalid-section-structure: non-adjacent-repeat')
    const deep = Array.from({ length: MAX_TOC_DEPTH + 1 }, (_, i) => `L${i}`).join(' ::: ')
    expect(() => build([deep], [[0]])).toThrow('invalid-section-structure: too-deep')
  })

  it('连续分隔符产生的空层名被剔除，不制造空节点', () => {
    // 输入用**两个空格**：`'A ::: ::: B'` 里两个分隔符共用中间那个空格、并不相邻，
    // split 出来是 ['A','::: B']（一个名为 `::: B` 的层），根本不含空层。真正的空层
    // 要两个相邻的 ` ::: `，此时中间层名是空串，被 pathOf 剔掉。
    const { tree } = build(['A :::  ::: B'], [[0]])
    expect(tree.map(n => n.title)).toEqual(['A'])
    expect(tree[0].children.map(n => n.title)).toEqual(['B'])
    expect(tree[0].children[0].depth).toBe(1)
    expect(tree[0].children[0].pages).toEqual([0])
  })

  it('兄弟顺序按首次出现决定，中间插入别的节也不改变它', () => {
    const { tree } = build(['A ::: B', 'C', 'A ::: D'], [[0], [1], [2]])
    expect(tree.map(n => n.title)).toEqual(['A', 'C'])
    expect(tree[0].children.map(n => n.title)).toEqual(['B', 'D'])
  })

  it('names 与 page-lists 长度不一致时立刻抛错，不静默产出无证据的树', () => {
    expect(() => build(['A', 'B', 'C'], [[0]])).toThrow(/section-pages-length-mismatch/)
  })
})

describe('validateSections', () => {
  it('接受扁平与合法嵌套', () => {
    expect(validateSections({ sectionNames: ['A', 'A ::: B'], sectionPages: [[0], [1]] })).toEqual({ ok: true })
  })

  it('拒绝超过深度上限', () => {
    const deep = Array.from({ length: MAX_TOC_DEPTH + 1 }, (_, i) => `L${i}`).join(' ::: ')
    expect(validateSections({ sectionNames: [deep], sectionPages: [[0]] }))
      .toEqual({ ok: false, reason: 'too-deep' })
  })

  it('恰好 MAX_TOC_DEPTH 层是合法的（上限取 > 而非 >=）', () => {
    // 各层名必须互不相同：重复层名会被 cyclic-path 拦下，那样测的就是另一条规则了
    const deepest = Array.from({ length: MAX_TOC_DEPTH }, (_, i) => `L${i}`).join(' ::: ')
    expect(validateSections({ sectionNames: [deepest], sectionPages: [[0]] })).toEqual({ ok: true })
  })

  it('拒绝同一路径内重复的层名（自嵌套）', () => {
    expect(validateSections({ sectionNames: ['A ::: A'], sectionPages: [[0]] }))
      .toEqual({ ok: false, reason: 'cyclic-path' })
  })

  it('空标题不算非法：由建树阶段丢弃计数', () => {
    expect(validateSections({ sectionNames: ['  '], sectionPages: [[0]] })).toEqual({ ok: true })
  })

  it('拒绝同一路径分两处出现且页区间断开（中间隔着别的节）', () => {
    // `Results` 在页 1 与页 5 各出现一次，中间夹着 Methods 的 2–4 页。
    // 并集 [1,5] 断开——拼出来的文本与连续两页没有区别，中间三页会被无声吞掉。
    expect(validateSections({
      sectionNames: ['Results', 'Methods', 'Results'],
      sectionPages: [[1], [2, 3, 4], [5]],
    })).toEqual({ ok: false, reason: 'non-adjacent-repeat' })
  })

  it('接受同一路径连续两节出现且页区间相接', () => {
    // 真正相邻的重复节：页区间首尾相接，并集连续，不会造出断层
    expect(validateSections({ sectionNames: ['Results', 'Results'], sectionPages: [[1], [2]] }))
      .toEqual({ ok: true })
    expect(validateSections({ sectionNames: ['Results', 'Results'], sectionPages: [[3], [3]] }))
      .toEqual({ ok: true })
  })
})
