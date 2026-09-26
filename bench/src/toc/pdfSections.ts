/**
 * 从**真实 PDF 的文本层**提取节结构，产出 `buildQasperTree` 能直接吃的
 * `{ sectionNames, sectionPages }`。
 *
 * 这是 `qasperTree.ts` docstring 预告的「兄弟模块」：QASPER 的节结构来自标注者的
 * `section_name`（` ::: ` 编码层级），这里改从 PDF 正文里的**编号标题**推断层级。
 * 两者输出形态相同，因此 `src/utils/tocTree.ts` 一行不改。
 *
 * **与 `getOutline()` 的区别**（这是路线选择的实质）：内嵌目录要求 PDF 真的嵌了目录，
 * 大量会议投稿模板没有；本模块只依赖文本层里看得见的编号。代价是层级**靠编号推断**
 * （`3.1.2` → 三层），没有编号的论文只能退化成平铺的一层。所以返回结果带 `route`
 * 标记，让调用方知道拿到的是哪一种，而不是拿到树就当成同一件事。
 *
 * **标题判定本身不在这里**：一律经 `src/utils/sectionHeadings.ts` 的 `isHeadingLine`，
 * 与段落切分、长章节基线共用同一份规则。本模块只额外做两件它不做的事：
 * 1. 从原始行里**取回被它剥掉的编号**（`isHeadingLine` 对编号标题返回的是去掉编号的正文）；
 * 2. 把「同一标题在相邻页重复出现」识别为**运行页眉**而非新节——否则两页的节会碎成四个。
 */
import { isHeadingLine } from '../../../src/utils/sectionHeadings'

/** 与 `isHeadingLine` 的编号规则同源；这里只用于**取回**编号，不用于判定是不是标题。 */
const NUMBERED_HEADING = /^(\d+(?:\.\d+)*)\.?\s+(.+)$/

/**
 * 父路径连接符。**必须与 `qasperTree.ts` 的 `PATH_SEP` 逐字相同**——两处各写一份是
 * 漂移风险，故 `pdfSections.test.ts` 用一条「喂进 `buildQasperTree` 再断言树形」的
 * 交叉测试把这份约定钉死，而不是靠注释互相提醒。
 */
const PATH_SEP = ' ::: '

/**
 * 单页标题数达到这个值即判为**目录页**并整页跳过。
 *
 * 为什么必须跳过：一页印刷目录会把全部节名列在同一页，于是每个节路径都会多出一段
 * 「第 N 页」的页区间。`buildQasperTree` 的 `mergedRunsAreContiguous` 随即以
 * `non-adjacent-repeat` 拒绝整篇——树是没了，但**拒绝理由是错的**（真实成因是目录页，
 * 不是节结构非法），排查会往错的方向走。5 是保守取值：正文页极少一页出现 5 个标题。
 */
export const TOC_PAGE_MIN_HEADINGS = 5

export type SectionRoute =
  /** 正文里有编号标题，层级由编号推出 */
  | 'numbered'
  /** 一个编号标题都没有，退化成平铺一层（标题来自 `isHeadingLine` 的无编号规则） */
  | 'flat'

export interface PdfSectionExtraction {
  sectionNames: string[]
  sectionPages: number[][]
  route: SectionRoute
  /**
   * 编号里出现过、但正文中**从未以标题形式出现**的祖先，其标题用编号本身占位
   * （如只见到 `2.1`、没见到 `2`，则造出名为 `2` 的父节点）。这些标题**不是论文的措辞**，
   * 会直接进入判定器的输入，故如实计数而不是悄悄合成。
   */
  synthesizedAncestors: string[]
  /** 被判为目录页而整页跳过的页号（0-based） */
  tocPages: number[]
  /**
   * 首个节起始页**之前**的页号。这些页不属任何节、进不了任何节点，因而**永远不可能被检索到**。
   * 刻意不造一个前导节点：`buildQasperTree` 会丢弃空标题的节，要造就得编一个论文里没有的
   * 标题，而标题会进入判定器输入、可能误导判定。所以这里只如实报告，把损失摆在明面上。
   */
  preamblePages: number[]
}

interface Occurrence {
  number: string | null
  title: string
  page: number
}

/**
 * 判定一行是不是标题，并**取回**编号。判定完全交给 `isHeadingLine`，
 * 这里只用 `NUMBERED_HEADING` 从原始行里读编号——两处若各自判一次，同一条标题
 * 会在两个地方得到不同结论。
 */
function matchHeading(line: string): { number: string | null; title: string } | null {
  const title = isHeadingLine(line)
  if (title === null) return null
  const numbered = NUMBERED_HEADING.exec(line.trim())
  return { number: numbered ? numbered[1] : null, title }
}

/** 编号 `3.1.2` → `['3','3.1','3.1.2']`（逐级前缀）。 */
const prefixesOf = (number: string): string[] =>
  number.split('.').map((_, i, parts) => parts.slice(0, i + 1).join('.'))

export function extractPdfSections(pages: string[]): PdfSectionExtraction {
  // ---- 第一趟：逐页扫标题，顺带剔掉目录页 ----
  const occurrences: Occurrence[] = []
  const tocPages: number[] = []

  for (let page = 0; page < pages.length; page++) {
    const onThisPage: Occurrence[] = []
    for (const raw of pages[page].split(/\r?\n/)) {
      const line = raw.trim()
      if (!line) continue
      const matched = matchHeading(line)
      if (matched) onThisPage.push({ ...matched, page })
    }
    if (onThisPage.length >= TOC_PAGE_MIN_HEADINGS) {
      tocPages.push(page)
      continue
    }
    occurrences.push(...onThisPage)
  }

  // ---- 第二趟的预备：先把**所有**编号 → 标题收齐，再算路径 ----
  // 顺序很要紧：若 `3.1 Data` 排在 `3 Method` 之前（论文里常见，父节条目后置），
  // 边扫边算会让 `3.1` 的父标题先落成占位符 `3`，之后 `3 Method` 又把它改成 `Method`，
  // 同一路径就出现两个名字 → `buildQasperTree` 会建成两个节点，且页区间很可能不连续。
  const titleByNumber = new Map<string, string>()
  for (const occ of occurrences) {
    if (occ.number !== null) titleByNumber.set(occ.number, occ.title)
  }

  const synthesizedAncestors: string[] = []
  const pathOf = (occ: Occurrence): string[] => {
    if (occ.number === null) return [occ.title]
    const prefixes = prefixesOf(occ.number)
    return prefixes.map((prefix, i) => {
      if (i === prefixes.length - 1) return occ.title
      const known = titleByNumber.get(prefix)
      if (known !== undefined) return known
      // 只记一次：同一缺失祖先会被多个子节反复引用
      if (!synthesizedAncestors.includes(prefix)) synthesizedAncestors.push(prefix)
      return prefix
    })
  }

  // ---- 第二趟：合并运行页眉，得到「真正的节起始」序列 ----
  const starts: Array<{ path: string[]; page: number }> = []
  for (const occ of occurrences) {
    const path = pathOf(occ)
    const key = path.join(PATH_SEP)
    // 与上一个起始同路径 ⇒ 这是跨页的运行页眉，不是新节。
    // **只比较相邻的一个**：非相邻的重复路径不在这里吸收，而是留给
    // `buildQasperTree` 的连续性校验去拒绝——那说明文档结构本身可疑，不该猜。
    if (starts.length > 0 && starts[starts.length - 1].path.join(PATH_SEP) === key) continue
    starts.push({ path, page: occ.page })
  }

  const sectionNames: string[] = []
  const sectionPages: number[][] = []
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i].page
    // 节的内容区间一直延伸到**下一个节的起始页之前**，而不是只到标题重复出现的末页。
    // 只认重复页眉的话，`Introduction` 在 p0–p1 有页眉、下一节在 p5 开始时，
    // p2–p4 会不属于任何节——静默丢内容，且指标上完全看不出来。
    const end = i + 1 < starts.length ? starts[i + 1].page - 1 : pages.length - 1
    sectionNames.push(starts[i].path.join(PATH_SEP))
    sectionPages.push(end < start ? [] : Array.from({ length: end - start + 1 }, (_, k) => start + k))
  }

  const firstStart = starts.length > 0 ? starts[0].page : pages.length
  const preamblePages = Array.from({ length: firstStart }, (_, i) => i)

  return {
    sectionNames,
    sectionPages,
    route: occurrences.some(o => o.number !== null) ? 'numbered' : 'flat',
    synthesizedAncestors,
    tocPages,
    preamblePages,
  }
}
