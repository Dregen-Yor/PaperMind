import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import type { EvalSample, QaQuestion } from '../types'
import { benchPath } from '../paths'
import { QA_QUALITY_DEFINITION } from '../metrics/qaQuality'
import { qasperReference } from '../metrics/qasperQuality'

/** 伪页大小：约等于一页学术论文的字符数。 */
export const PSEUDO_PAGE_CHARS = 3000

// DEFAULT_PATH 必须走 bench/src/paths.ts 的 benchPath（fileURLToPath），
// 不能用 new URL(...).pathname——后者保留百分号转义，路径含空格时静默失效（Task 2 I-5 的教训）
const DEFAULT_PATH = () => benchPath(import.meta.url, '../../datasets/qasper/qasper.jsonl')

/** QASPER 原始条目（HuggingFace allenai/qasper 的字段布局）。 */
export interface QasperEntry {
  title: string
  abstract: string
  full_text: {
    section_name: string[]
    paragraphs: string[][]
  }
  qas: {
    question: string[]
    answers: Array<Array<{
      answer: {
        free_form_answer: string
        extractive_spans: string[]
        unanswerable: boolean
        yes_no?: boolean | null
        evidence: string[]
      }
    }>>
  }
}

/**
 * 段落按累计字符数聚成伪页。段落不切断——切断会让 evidence 跨页归属含糊。
 * 返回每个段落所属的伪页号，供 evidence 映射使用。
 */
export function paragraphsToPages(paragraphs: string[]): {
  pages: string[]
  paragraphToPage: number[]
} {
  const pages: string[] = []
  const paragraphToPage: number[] = []
  let buffer: string[] = []
  let bufferLen = 0

  for (const para of paragraphs) {
    // 当前页已有内容且加上这段会超限 → 先封页
    if (bufferLen > 0 && bufferLen + para.length > PSEUDO_PAGE_CHARS) {
      pages.push(buffer.join('\n\n'))
      buffer = []
      bufferLen = 0
    }
    paragraphToPage.push(pages.length)
    buffer.push(para)
    bufferLen += para.length
  }
  if (buffer.length > 0) pages.push(buffer.join('\n\n'))

  return { pages, paragraphToPage }
}

/** Like paragraphsToPages, but injects each original section heading before its first paragraph. */
export function sectionsToPages(sectionNames: string[], sections: string[][]): {
  pages: string[]
  paragraphToPage: number[]
  /**
   * 每节内容实际落到的伪页号，升序。与 sectionNames 同序同长。空数组表示该节没有可归属的
   * 内容页：既包括「只有标题、没有段落」的导航节点，也包括标题为空白且段落少于两段的节
   * （标题为空时两个标题分支都不执行，段落循环又从下标 1 开始，整节既不产文本也不记页；
   * 标题为空、段落 ≥2 的节则只静默丢掉首段）。这是既有的边界行为，本次改动未涉及。
   * 由下面这段打包循环**顺手记录**，不另起一套实现——两套实现会在封页边界上错开一页，
   * 而指标照常输出数字，是静默失真。
   */
  sectionPages: number[][]
} {
  const pages: string[] = []
  const paragraphToPage: number[] = []
  const sectionPages: number[][] = []
  let buffer: string[] = []
  let bufferLen = 0
  const append = (text: string) => {
    if (bufferLen > 0 && bufferLen + text.length > PSEUDO_PAGE_CHARS) {
      pages.push(buffer.join('\n\n'))
      buffer = []
      bufferLen = 0
    }
    buffer.push(text)
    bufferLen += text.length
  }
  // 必须在每次 append **之后**调用：append 可能先封页，此时 pages.length 才是
  // 这份内容真正落到的页号。封页前后的 pages.length 不同；顺序错了，跨封页边界的
  // 那些记录会偏一页。
  const note = (touched: number[]) => {
    const page = pages.length
    if (touched[touched.length - 1] !== page) touched.push(page)
  }
  for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
    const heading = sectionNames[sectionIndex]?.trim()
    const paragraphs = sections[sectionIndex]
    const firstParagraph = paragraphs[0]
    const touched: number[] = []
    // Keep a heading and its first paragraph on the same pseudo page. Otherwise a
    // nearly full preceding page can strand the heading from the content it labels.
    if (heading && firstParagraph !== undefined) {
      append(`${heading}\n\n${firstParagraph}`)
      note(touched)
      paragraphToPage.push(pages.length)
    } else if (heading) {
      // 只带标题、没有段落的节是**导航节点**：标题照样进页面正文，但本节不记为
      // 「携带内容」——sectionPages 留空数组，后面的建树任务据此把它建成 pages: [] 的节点。
      // 这里刻意**不**调 note()：note 会把该页记成本节的内容页，空节就变成有内容的
      // 节点，于是只有标题的节会把整页当成自己的证据。
      append(heading)
    }
    for (const paragraph of paragraphs.slice(firstParagraph === undefined ? 0 : 1)) {
      append(paragraph)
      note(touched)
      paragraphToPage.push(pages.length)
    }
    sectionPages.push(touched)
  }
  if (buffer.length > 0) pages.push(buffer.join('\n\n'))
  return { pages, paragraphToPage, sectionPages }
}

export function normalizeQasperEntry(paperId: string, entry: QasperEntry): EvalSample {
  const flatParagraphs = entry.full_text.paragraphs.flat()
  const { pages, paragraphToPage, sectionPages } = sectionsToPages(entry.full_text.section_name, entry.full_text.paragraphs)

  // evidence 是段落原文字符串，建索引以便反查段落下标
  const paragraphIndex = new Map<string, number[]>()
  flatParagraphs.forEach((p, i) => {
    const indexes = paragraphIndex.get(p) ?? []
    indexes.push(i)
    paragraphIndex.set(p, indexes)
  })

  const questions: QaQuestion[] = entry.qas.question.map((question, i) => {
    const annotations = entry.qas.answers[i] ?? []
    const unanswerable = annotations.length > 0 && annotations.every(a => a.answer.unanswerable)
    const qualityAnswers = annotations.map(({ answer }) => qasperReference(answer))
    if (qualityAnswers.length === 0) {
      throw new Error(`QASPER question ${paperId}#${i} has no versioned reference answers`)
    }

    const answers: string[] = []
    const evidencePages = new Set<number>()
    let evidenceMapping: QaQuestion['evidenceMapping'] = 'mapped'
    let hasEvidence = false
    for (const { answer } of annotations) {
      if (answer.unanswerable) continue
      if (answer.free_form_answer) answers.push(answer.free_form_answer)
      answers.push(...answer.extractive_spans)
      for (const ev of answer.evidence) {
        hasEvidence = true
        const paragraphIndexes = paragraphIndex.get(ev)
        if (!paragraphIndexes) {
          evidenceMapping = 'unmapped'
        } else if (paragraphIndexes.length === 1) {
          evidencePages.add(paragraphToPage[paragraphIndexes[0]])
        } else if (evidenceMapping !== 'unmapped') {
          evidenceMapping = 'ambiguous'
        }
      }
    }
    if (!hasEvidence) evidenceMapping = 'unmapped'

    return {
      id: `${paperId}#${i}`,
      question,
      answers,
      evidencePages: [...evidencePages].sort((a, b) => a - b),
      unanswerable,
      qualityAnswers,
      qualityDefinition: QA_QUALITY_DEFINITION,
      ...(unanswerable ? {} : { evidenceMapping }),
    }
  })

  return {
    paperId,
    title: entry.title,
    pages,
    questions,
    referenceAbstract: entry.abstract,
    sectionNames: entry.full_text.section_name,
    sectionPages,
    source: 'qasper',
  }
}

/** 加载 fetch.ts 归一化后的 jsonl（每行一个 EvalSample）。 */
export async function loadQasperDataset(path: string = DEFAULT_PATH()): Promise<EvalSample[]> {
  if (!existsSync(path)) {
    throw new Error(
      `QASPER 数据集不存在：${path}。` +
      `先运行 npx tsx bench/datasets/qasper/fetch.ts 拉取并归一化。`,
    )
  }
  const content = await readFile(path, 'utf-8')
  const samples = content
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as EvalSample)
  for (const sample of samples) {
    for (const question of sample.questions) {
      if (!question.unanswerable && question.evidenceMapping === undefined) {
        throw new Error('QASPER 数据集缺少 evidenceMapping；请重新运行 fetch.ts 以生成当前格式的数据集。')
      }
      if (question.qualityDefinition !== QA_QUALITY_DEFINITION
        || !Array.isArray(question.qualityAnswers)
        || question.qualityAnswers.length === 0
        || question.qualityAnswers.some(answer => typeof answer !== 'string' || answer.trim().length === 0)) {
        throw new Error('QASPER 数据集缺少版本化参考答案；请重新运行 fetch.ts 以生成当前格式的数据集。')
      }
    }
  }
  return samples
}
