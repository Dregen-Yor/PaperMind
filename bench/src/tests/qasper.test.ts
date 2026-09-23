import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { loadQasperDataset, paragraphsToPages, normalizeQasperEntry, PSEUDO_PAGE_CHARS, sectionsToPages } from '../datasets/qasper'
import { QA_QUALITY_DEFINITION } from '../metrics/qaQuality'

describe('paragraphsToPages', () => {
  it('段落按字符数聚成伪页，并记录段落到页的映射', () => {
    const long = 'x'.repeat(PSEUDO_PAGE_CHARS)
    const { pages, paragraphToPage } = paragraphsToPages([long, long, 'short'])
    expect(pages).toHaveLength(3)
    expect(paragraphToPage).toEqual([0, 1, 2])
  })

  it('短段落合并进同一伪页', () => {
    const { pages, paragraphToPage } = paragraphsToPages(['a', 'b', 'c'])
    expect(pages).toHaveLength(1)
    expect(paragraphToPage).toEqual([0, 0, 0])
  })

  it('空段落数组产出空页列表', () => {
    const { pages, paragraphToPage } = paragraphsToPages([])
    expect(pages).toEqual([])
    expect(paragraphToPage).toEqual([])
  })

  it('单个超长段落独占一页，不被切断', () => {
    const huge = 'y'.repeat(PSEUDO_PAGE_CHARS * 3)
    const { pages } = paragraphsToPages([huge])
    expect(pages).toHaveLength(1)
    expect(pages[0].length).toBe(huge.length)
  })

  it('section 标题与其首段保持在同一伪页', () => {
    const nearlyFull = 'x'.repeat(PSEUDO_PAGE_CHARS - 5)
    const { pages, paragraphToPage } = sectionsToPages(['Intro', 'Methods'], [[nearlyFull], ['first method paragraph']])
    expect(pages[1]).toContain('Methods\n\nfirst method paragraph')
    expect(paragraphToPage).toEqual([0, 1])
  })
})

describe('normalizeQasperEntry', () => {
  const entry = {
    title: 'Test Paper',
    abstract: 'the abstract',
    full_text: {
      section_name: ['Intro', 'Methods'],
      paragraphs: [['intro para one', 'intro para two'], ['methods para']],
    },
    qas: {
      question: ['Q1?', 'Q2?'],
      answers: [
        [{ answer: { free_form_answer: 'A1', extractive_spans: [], unanswerable: false, yes_no: null, evidence: ['methods para'] } }],
        [{ answer: { free_form_answer: '', extractive_spans: [], unanswerable: true, yes_no: null, evidence: [] } }],
      ],
    },
  }

  it('产出 EvalSample，source 为 qasper', () => {
    const s = normalizeQasperEntry('1234.5678', entry)
    expect(s.paperId).toBe('1234.5678')
    expect(s.title).toBe('Test Paper')
    expect(s.source).toBe('qasper')
    expect(s.referenceAbstract).toBe('the abstract')
  })

  it('把 evidence 原文反查回段落并映射到伪页', () => {
    const s = normalizeQasperEntry('p', entry)
    // 三个段落都很短，全在伪页 0
    expect(s.questions[0].evidencePages).toEqual([0])
  })

  it('把 section_name 注入伪页，同时 evidence 仍按原段落映射', () => {
    const s = normalizeQasperEntry('p', entry)
    expect(s.pages[0]).toContain('Intro')
    expect(s.pages[0]).toContain('Methods')
    expect(s.questions[0].evidencePages).toEqual([0])
    expect(s.questions[0].evidenceMapping).toBe('mapped')
  })

  it('重复或未映射 evidence 标记为不确定，且不扩大 gold set', () => {
    const s = normalizeQasperEntry('p', {
      ...entry,
      full_text: { section_name: ['A'], paragraphs: [['same', 'same']] },
      qas: { question: ['Q1?', 'Q2?'], answers: [
        [{ answer: { free_form_answer: 'x', extractive_spans: [], unanswerable: false, evidence: ['same'] } }],
        [{ answer: { free_form_answer: 'x', extractive_spans: [], unanswerable: false, evidence: ['missing'] } }],
      ] },
    })
    expect(s.questions[0]).toMatchObject({ evidenceMapping: 'ambiguous', evidencePages: [] })
    expect(s.questions[1]).toMatchObject({ evidenceMapping: 'unmapped', evidencePages: [] })
  })

  it('保留 unanswerable 标签，且该问题 answers 为空', () => {
    const s = normalizeQasperEntry('p', entry)
    expect(s.questions[1].unanswerable).toBe(true)
    expect(s.questions[1].answers).toEqual([])
  })

  it('free_form_answer 与 extractive_spans 都收作参考答案', () => {
    const s = normalizeQasperEntry('p', {
      ...entry,
      qas: {
        question: ['Q?'],
        answers: [[
          { answer: { free_form_answer: 'eight', extractive_spans: ['8 heads'], unanswerable: false, evidence: [] } },
        ]],
      },
    })
    expect(s.questions[0].answers).toEqual(['eight', '8 heads'])
  })

  it('多标注者的答案合并为多参考', () => {
    const s = normalizeQasperEntry('p', {
      ...entry,
      qas: {
        question: ['Q?'],
        answers: [[
          { answer: { free_form_answer: 'eight', extractive_spans: [], unanswerable: false, evidence: [] } },
          { answer: { free_form_answer: '8', extractive_spans: [], unanswerable: false, evidence: [] } },
        ]],
      },
    })
    expect(s.questions[0].answers).toEqual(['eight', '8'])
  })

  it('按标注者保留 unanswerable、extractive、free-form 与 yes/no 的版本化参考答案', () => {
    const s = normalizeQasperEntry('p', {
      ...entry,
      qas: {
        question: ['Q?'],
        answers: [[
          { answer: { free_form_answer: '', extractive_spans: [], unanswerable: true, yes_no: null, evidence: [] } },
          { answer: { free_form_answer: 'ignored', extractive_spans: ['span one', 'span two'], unanswerable: false, yes_no: true, evidence: [] } },
          { answer: { free_form_answer: 'free', extractive_spans: [], unanswerable: false, yes_no: null, evidence: [] } },
          { answer: { free_form_answer: '', extractive_spans: [], unanswerable: false, yes_no: false, evidence: [] } },
        ]],
      },
    })

    expect(s.questions[0].qualityDefinition).toBe(QA_QUALITY_DEFINITION)
    expect(s.questions[0].qualityAnswers).toEqual(['Unanswerable', 'span one, span two', 'free', 'No'])
  })

  it('rejects annotations with no valid versioned reference', () => {
    expect(() => normalizeQasperEntry('p', {
      ...entry,
      qas: {
        question: ['Q?'],
        answers: [[
          { answer: { free_form_answer: '', extractive_spans: [], unanswerable: false, yes_no: null, evidence: [] } },
        ]],
      },
    })).toThrow(/reference/i)
  })

  it('evidence 匹配不上任何段落时该问题 evidencePages 为空', () => {
    const s = normalizeQasperEntry('p', {
      ...entry,
      qas: {
        question: ['Q?'],
        answers: [[
          { answer: { free_form_answer: 'x', extractive_spans: [], unanswerable: false, evidence: ['不存在的段落'] } },
        ]],
      },
    })
    expect(s.questions[0].evidencePages).toEqual([])
  })

  it('问题 id 由 paperId 与序号组成', () => {
    const s = normalizeQasperEntry('1234.5678', entry)
    expect(s.questions[0].id).toBe('1234.5678#0')
  })

  it('rejects old normalized JSONL without versioned quality references', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qasper-quality-'))
    const path = join(dir, 'old.jsonl')
    const old = normalizeQasperEntry('p', entry)
    for (const q of old.questions) {
      delete q.qualityAnswers
      delete q.qualityDefinition
    }
    await writeFile(path, `${JSON.stringify(old)}\n`)

    await expect(loadQasperDataset(path)).rejects.toThrow(/重新运行.*fetch\.ts/)
  })
})
