import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { extractPdfDocument, type ExtractedPdfDocument } from '../../../src/utils/pdfDocument'
import { PDF_QA_QUALITY_DEFINITION } from '../metrics/qaQuality'
import type { PdfStudySample, QaQuestion } from '../types'
import { benchPath } from '../paths'

// 惰性求值：不能用 new URL(...).pathname（百分号转义 / Vitest 改写缺陷），用共享 benchPath。
// 与冒烟集不同，本集的 annotations.json 与 PDF 直接位于 minibatch/，没有 papers/ 子目录。
const DEFAULT_DIR = () => benchPath(import.meta.url, '../../minibatch/')

/** 一篇论文的人工标注；evidencePages 为 1-based 页码，answers 为多参考答案。 */
export interface OutlineStudyAnnotation {
  file: string
  title?: string
  questions: Array<{ q: string; answers: string[]; evidencePages: number[] }>
}

export interface OutlineStudyDeps {
  extract?: (base64: string) => Promise<ExtractedPdfDocument>
}

/** 指纹方案版本：改动覆盖内容或顺序时必须递增，让旧指纹整体失效。 */
const MANIFEST_FINGERPRINT_VERSION = 'outline-study-manifest-v1'

/**
 * 每篇论文一个 SHA-256，按**固定顺序**覆盖：
 * ① 版本前缀；② 文件名；③ 原始 PDF 字节；④ 逐页文本数组；⑤ 该篇标注
 * （问题文本 + 参考答案 + evidence 页）；⑥ 目录 JSON 树。
 * 覆盖 PDF 字节是关键：同名换文件必须改变指纹。序列化全部走 `JSON.stringify`
 * （输入对象已是纯数组/对象），版本前缀让方案本身可演进。
 */
function fingerprintManifest(
  file: string,
  pdfBytes: Uint8Array,
  pages: string[],
  annotation: OutlineStudyAnnotation,
  outline: unknown,
): string {
  const hash = createHash('sha256')
  hash.update(MANIFEST_FINGERPRINT_VERSION)
  hash.update('\0')
  hash.update(file)
  hash.update('\0')
  hash.update(pdfBytes)
  hash.update('\0')
  hash.update(JSON.stringify(pages))
  hash.update('\0')
  hash.update(JSON.stringify(
    annotation.questions.map(question => ({
      q: question.q,
      answers: question.answers,
      evidencePages: question.evidencePages,
    })),
  ))
  hash.update('\0')
  hash.update(JSON.stringify(outline))
  return hash.digest('hex')
}

/**
 * 加载冻结的 PDF 大纲研究集。每篇论文只读一次字节、只 base64 一次、只解析一次
 * （方案 §7：A/B/C 各自只打开 PDF 一次，绝不按臂重复解析）。
 *
 * `deps.extract` 默认 `extractPdfDocument`，生产路径下会**读取原生目录**
 * （`readOutline` 缺省 true）；缺失或非法目录返回空数组而非抛错，只有 PDF/标注本身
 * 的问题才会让加载失败。
 */
export async function loadOutlineStudyDataset(
  dir: string = DEFAULT_DIR(),
  deps: OutlineStudyDeps = {},
): Promise<PdfStudySample[]> {
  const extract = deps.extract ?? extractPdfDocument
  const annotationsPath = join(dir, 'annotations.json')

  if (!existsSync(annotationsPath)) {
    throw new Error(
      `人工标注集标注文件不存在：${annotationsPath}。` +
      `请参考 bench/minibatch/annotations.json 准备 PDF 与标注。`,
    )
  }
  const annotations = JSON.parse(await readFile(annotationsPath, 'utf-8')) as OutlineStudyAnnotation[]

  const samples: PdfStudySample[] = []
  for (const ann of annotations) {
    // file 字段必须只写文件名：含路径分隔符或 .. 会越过 minibatch/ 读到目录外文件
    if (ann.file.includes('/') || ann.file.includes('\\') || ann.file.includes('..')) {
      throw new Error(`标注的 file 字段含路径分隔符：${ann.file}（应只写文件名）`)
    }
    const pdfPath = join(dir, ann.file)
    if (!existsSync(pdfPath)) {
      throw new Error(`标注引用的 PDF 不存在：${ann.file}（期望位于 ${dir}）`)
    }
    const pdfBytes = await readFile(pdfPath)
    const extracted = await extract(pdfBytes.toString('base64'))
    const pages = extracted.pages

    const questions: QaQuestion[] = ann.questions.map((q, i) => {
      if (!Array.isArray(q.answers) || q.answers.length === 0
        || q.answers.some(answer => typeof answer !== 'string' || answer.trim().length === 0)) {
        throw new Error(`${ann.file} 第 ${i + 1} 问的 answers 必须为非空字符串数组`)
      }
      const evidencePages = q.evidencePages.map(p => p - 1)  // 1-based → 0-based
      for (const p of evidencePages) {
        if (p < 0 || p >= pages.length) {
          throw new Error(
            `${ann.file} 第 ${i + 1} 问的 evidencePages 含越界页码 ${p + 1}` +
            `（该 PDF 共 ${pages.length} 页）`,
          )
        }
      }
      return {
        id: `${ann.file}#${i}`,
        question: q.q,
        answers: [...q.answers],
        evidencePages,
        unanswerable: false,
        qualityAnswers: [...q.answers],
        qualityDefinition: PDF_QA_QUALITY_DEFINITION,
      }
    })

    samples.push({
      paperId: ann.file,
      title: ann.title ?? ann.file,
      pages,
      questions,
      source: 'pdf-study',
      pdfPath,
      manifestFingerprint: fingerprintManifest(ann.file, pdfBytes, pages, ann, extracted.outline),
      pdfOutline: extracted.outline,
      ...(extracted.outlineResult ? { pdfOutlineResult: extracted.outlineResult } : {}),
    })
  }
  return samples
}
