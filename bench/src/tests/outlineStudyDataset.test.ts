import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EvalSample, PdfStudySample } from '../types'
import type { ExtractedPdfDocument } from '../../../src/utils/pdfDocument'
import { PDF_QA_QUALITY_DEFINITION } from '../metrics/qaQuality'

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: {},
  getDocument: vi.fn(),
}))

const { loadOutlineStudyDataset } = await import('../datasets/outlineStudy')

/** 20 页、无目录的确定性抽取结果；页码上界远超 fixture 标注的最大页码。 */
const extractPages20 = async (): Promise<ExtractedPdfDocument> => ({
  pages: Array.from({ length: 20 }, (_, i) => `page ${i}`),
  outline: [],
})

const ATTENTION = '01-method-attention-is-all-you-need.pdf'
const DEEP_SETS = '02-theory-deep-sets.pdf'
const BERT = '03-experiments-bert.pdf'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bench-outline-study-'))
  writeFileSync(join(dir, 'a.pdf'), 'fake-pdf-bytes')
  writeFileSync(join(dir, 'annotations.json'), JSON.stringify([
    {
      file: 'a.pdf',
      title: 'Paper A',
      questions: [{ q: '几个头？', answers: ['8', 'eight heads'], evidencePages: [4] }],
    },
  ]))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('loadOutlineStudyDataset（仓库自带冻结 fixture）', () => {
  it('加载 3 篇论文共 12 问，来源一律为 pdf-study', async () => {
    const samples = await loadOutlineStudyDataset(undefined, { extract: extractPages20 })
    expect(samples).toHaveLength(3)
    expect(samples.flatMap(sample => sample.questions)).toHaveLength(12)
    expect(samples.map(sample => sample.paperId).sort()).toEqual([ATTENTION, BERT, DEEP_SETS].sort())
    expect(samples.every(sample => sample.source === 'pdf-study')).toBe(true)
    expect(samples.map(sample => sample.paperId)).toContain(ATTENTION)
    expect(samples.map(sample => sample.paperId)).toContain(BERT)
  })

  it('每问都带非空 qualityAnswers、定义与 <file>#<i> 形式的 id', async () => {
    const samples = await loadOutlineStudyDataset(undefined, { extract: extractPages20 })
    for (const sample of samples) {
      sample.questions.forEach((question, i) => {
        expect(question.id).toBe(`${sample.paperId}#${i}`)
        expect(question.qualityDefinition).toBe(PDF_QA_QUALITY_DEFINITION)
        expect(question.qualityAnswers?.length ?? 0).toBeGreaterThan(0)
        expect(question.answers).toEqual(question.qualityAnswers)
        expect(question.unanswerable).toBe(false)
      })
    }
  })

  it('把标注的 1-based 页码转为 0-based，含多页 evidencePages', async () => {
    const samples = await loadOutlineStudyDataset(undefined, { extract: extractPages20 })
    const attention = samples.find(sample => sample.paperId === ATTENTION)!
    expect(attention.questions[1].evidencePages).toEqual([0, 7])  // [1,8]
    const deepSets = samples.find(sample => sample.paperId === DEEP_SETS)!
    expect(deepSets.questions[0].evidencePages).toEqual([1, 13])  // [2,14]
  })

  it('保留运行期元数据：pdfPath 与 manifestFingerprint', async () => {
    const samples = await loadOutlineStudyDataset(dir, { extract: extractPages20 })
    expect(samples[0].pdfPath).toBe(join(dir, 'a.pdf'))
    expect(samples[0].manifestFingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(samples[0].pdfOutline).toEqual([])
  })

  it('PdfStudySample 可赋值给 EvalSample（运行期字段只增不减）', () => {
    const assignable: EvalSample = (null as unknown) as PdfStudySample
    expect(assignable).toBeNull()
  })
})

describe('loadOutlineStudyDataset 的 manifestFingerprint', () => {
  it('同一 fixture 两次加载稳定', async () => {
    const first = await loadOutlineStudyDataset(undefined, { extract: extractPages20 })
    const second = await loadOutlineStudyDataset(undefined, { extract: extractPages20 })
    expect(first.map(sample => sample.manifestFingerprint))
      .toEqual(second.map(sample => sample.manifestFingerprint))
  })

  it('PDF 字节改变时指纹改变（同名换文件必须失效）', async () => {
    writeFileSync(join(dir, 'a.pdf'), 'bytes-one')
    const first = await loadOutlineStudyDataset(dir, { extract: extractPages20 })
    writeFileSync(join(dir, 'a.pdf'), 'bytes-two')
    const second = await loadOutlineStudyDataset(dir, { extract: extractPages20 })
    expect(first[0].manifestFingerprint).not.toBe(second[0].manifestFingerprint)
  })

  it('仅改标注标题时指纹改变（标题属于标注内容）', async () => {
    const annotation = (title: string) => JSON.stringify([
      { file: 'a.pdf', title, questions: [{ q: 'x', answers: ['y'], evidencePages: [1] }] },
    ])
    writeFileSync(join(dir, 'annotations.json'), annotation('Title One'))
    const first = await loadOutlineStudyDataset(dir, { extract: extractPages20 })
    writeFileSync(join(dir, 'annotations.json'), annotation('Title Two'))
    const second = await loadOutlineStudyDataset(dir, { extract: extractPages20 })
    expect(first[0].manifestFingerprint).not.toBe(second[0].manifestFingerprint)
  })
})

describe('loadOutlineStudyDataset 的失败路径', () => {
  it('标注引用的 PDF 缺失时抛出带文件名的错误', async () => {
    writeFileSync(join(dir, 'annotations.json'), JSON.stringify([
      { file: 'missing.pdf', questions: [] },
    ]))
    await expect(loadOutlineStudyDataset(dir, { extract: extractPages20 })).rejects.toThrow(/missing\.pdf/)
  })

  it('annotations.json 不存在时抛出可诊断的错误', async () => {
    rmSync(join(dir, 'annotations.json'))
    await expect(loadOutlineStudyDataset(dir, { extract: extractPages20 })).rejects.toThrow(/annotations\.json/)
  })

  it('evidence 页码越界时抛错并点名文件与题号', async () => {
    writeFileSync(join(dir, 'annotations.json'), JSON.stringify([
      { file: 'a.pdf', questions: [{ q: 'x', answers: ['y'], evidencePages: [99] }] },
    ]))
    const promise = loadOutlineStudyDataset(dir, { extract: extractPages20 })
    await expect(promise).rejects.toThrow(/a\.pdf/)
    await expect(loadOutlineStudyDataset(dir, { extract: extractPages20 })).rejects.toThrow(/第 1 问/)
  })

  it('缺失 evidencePages 时抛错（不是裸 TypeError），并点名文件与题号', async () => {
    writeFileSync(join(dir, 'annotations.json'), JSON.stringify([
      { file: 'a.pdf', questions: [{ q: 'x', answers: ['y'] }] },
    ]))
    await expect(loadOutlineStudyDataset(dir, { extract: extractPages20 })).rejects.toThrow(/a\.pdf/)
    await expect(loadOutlineStudyDataset(dir, { extract: extractPages20 })).rejects.toThrow(/第 1 问/)
  })

  it('evidencePages 非数组时抛错并点名文件与题号', async () => {
    writeFileSync(join(dir, 'annotations.json'), JSON.stringify([
      { file: 'a.pdf', questions: [{ q: 'x', answers: ['y'], evidencePages: 7 }] },
    ]))
    await expect(loadOutlineStudyDataset(dir, { extract: extractPages20 })).rejects.toThrow(/a\.pdf/)
    await expect(loadOutlineStudyDataset(dir, { extract: extractPages20 })).rejects.toThrow(/第 1 问/)
  })

  it('evidencePages 含非整数页码时抛错，不让小数页号漏进 evidencePages', async () => {
    writeFileSync(join(dir, 'annotations.json'), JSON.stringify([
      { file: 'a.pdf', questions: [{ q: 'x', answers: ['y'], evidencePages: [1.5] }] },
    ]))
    await expect(loadOutlineStudyDataset(dir, { extract: extractPages20 })).rejects.toThrow(/a\.pdf/)
    await expect(loadOutlineStudyDataset(dir, { extract: extractPages20 })).rejects.toThrow(/第 1 问/)
  })

  it('answers 为空数组时抛错并点名文件与题号', async () => {
    writeFileSync(join(dir, 'annotations.json'), JSON.stringify([
      { file: 'a.pdf', questions: [{ q: 'x', answers: [], evidencePages: [1] }] },
    ]))
    await expect(loadOutlineStudyDataset(dir, { extract: extractPages20 })).rejects.toThrow(/a\.pdf/)
    await expect(loadOutlineStudyDataset(dir, { extract: extractPages20 })).rejects.toThrow(/第 1 问/)
  })

  it('answers 含空白字符串时抛错', async () => {
    writeFileSync(join(dir, 'annotations.json'), JSON.stringify([
      { file: 'a.pdf', questions: [{ q: 'x', answers: ['  '], evidencePages: [1] }] },
    ]))
    await expect(loadOutlineStudyDataset(dir, { extract: extractPages20 })).rejects.toThrow(/answers/)
  })

  it('拒绝含路径分隔符的 file 字段', async () => {
    writeFileSync(join(dir, 'annotations.json'), JSON.stringify([
      { file: '../escape.pdf', questions: [] },
    ]))
    await expect(loadOutlineStudyDataset(dir, { extract: extractPages20 })).rejects.toThrow(/路径分隔符/)
  })
})
