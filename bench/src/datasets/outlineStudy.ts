import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
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

/**
 * 本地是否存在可用的完整 fixture：`annotations.json` 存在且其中每篇论文引用的 PDF 都在。
 * 只有 `annotations.json` 入库，PDF 字节刻意不入库（体积大、且属「不得提交」清单），
 * 故全新 clone 上应为 false——依赖真实 PDF 的用例据此跳过而非报错（仓库 hermeticity 约定）。
 * 自建临时 fixture 的用例不走这里，永远无条件运行。
 */
export function hasOutlineStudyFixture(dir: string = DEFAULT_DIR()): boolean {
  const annotationsPath = join(dir, 'annotations.json')
  if (!existsSync(annotationsPath)) return false
  let annotations: OutlineStudyAnnotation[]
  try {
    annotations = JSON.parse(readFileSync(annotationsPath, 'utf-8')) as OutlineStudyAnnotation[]
  } catch {
    return false
  }
  if (!Array.isArray(annotations) || annotations.length === 0) return false
  return annotations.every(ann =>
    ann !== null && typeof ann === 'object'
    && typeof ann.file === 'string'
    && !ann.file.includes('/') && !ann.file.includes('\\') && !ann.file.includes('..')
    && existsSync(join(dir, ann.file)))
}

/**
 * 指纹方案版本：改动覆盖内容或顺序时必须递增，让旧指纹整体失效。
 * v2 相对 v1 在文件名与原始 PDF 字节之间插入了标注 `title`——同一 PDF 加同一标注
 * 在 v1 与 v2 下产出不同摘要，标签若停滞在 v1 会误导后续读者以为 v1 口径稳定
 * （Task 8 起 manifest 哈希会写进结果元数据，静默改口径将无声地破坏跨轮比较）。
 */
const MANIFEST_FINGERPRINT_VERSION = 'outline-study-manifest-v2'

/**
 * 每篇论文一个 SHA-256，按**固定顺序**覆盖：
 * ① 版本前缀；② 文件名；③ 标题；④ 原始 PDF 字节；⑤ 逐页文本数组；⑥ 该篇标注
 * （问题文本 + 参考答案 + evidence 页）；⑦ 目录 JSON 树。标题与 PDF 字节都必须覆盖：
 * 只改标题、或同名换文件，都必须改变指纹。序列化全部走 `JSON.stringify`
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
  // 标题缺省时用空串占位，保证「无标题」也是确定值
  hash.update(annotation.title ?? '')
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

/** 单轴指纹：原始 PDF 字节（Task 8 把 PDF 与 outline 从 manifest 里拆开各自 pin）。 */
function fingerprintPdfBytes(pdfBytes: Uint8Array): string {
  return createHash('sha256')
    .update('outline-study-pdf-v1')
    .update('\0')
    .update(pdfBytes)
    .digest('hex')
}

/** 单轴指纹：目录 JSON 树（缺失/非法时为空数组，仍是确定值）。 */
function fingerprintOutline(outline: unknown): string {
  return createHash('sha256')
    .update('outline-study-outline-v1')
    .update('\0')
    .update(JSON.stringify(outline))
    .digest('hex')
}

/**
 * 加载冻结的 PDF 大纲研究集。每篇论文只读一次字节、只 base64 一次、只解析一次
 * （方案 §7：A/B/C 各自只打开 PDF 一次，绝不按臂重复解析）。
 *
 * `deps.extract` 默认 `extractPdfDocument`，其缺省 `readOutline: true` 会**读取原生目录**
 * （注意：这不是 PaperMind 产品默认路径——产品走 `extractPages` 且显式传 `readOutline: false`）；
 * 缺失或非法目录返回空数组而非抛错，只有 PDF/标注本身的问题才会让加载失败。
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
      // 先校验形态再 map：缺失/非数组会在 .map 上抛裸 TypeError（无文件名无题号），
      // 非整数（如 1.5）会漏过越界检查并把小数页号写进 evidencePages
      if (!Array.isArray(q.evidencePages) || q.evidencePages.length === 0
        || q.evidencePages.some(p => !Number.isInteger(p) || p <= 0)) {
        throw new Error(`${ann.file} 第 ${i + 1} 问的 evidencePages 必须为非空正整数数组`)
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
      pdfFingerprint: fingerprintPdfBytes(pdfBytes),
      outlineFingerprint: fingerprintOutline(extracted.outline),
      pdfOutline: extracted.outline,
      ...(extracted.outlineResult ? { pdfOutlineResult: extracted.outlineResult } : {}),
    })
  }
  return samples
}
