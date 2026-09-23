import { describe, expect, it } from 'vitest'
import { aggregateQaQuality, finalizeQaQuality, QA_QUALITY_DEFINITION } from '../metrics/qaQuality'
import { qasperAnswerF1, qasperReference } from '../metrics/qasperQuality'
import type { PerSampleRecord, QaQuestion } from '../types'

const record = (
  id: string,
  generationStatus: PerSampleRecord['generationStatus'],
  score?: number,
): PerSampleRecord => ({
  id,
  paperId: 'p',
  source: 'qasper',
  metrics: score === undefined ? {} : { answerF1AllQuestions: score },
  generationStatus,
})

const question = (id: string, refs: string[]): QaQuestion => ({
  id,
  question: `${id}?`,
  answers: refs,
  evidencePages: [],
  unanswerable: false,
  qualityAnswers: refs,
  qualityDefinition: QA_QUALITY_DEFINITION,
})

describe('official QASPER answer quality', () => {
  it('converts every annotation type using the official precedence', () => {
    expect(qasperReference({ unanswerable: true, extractive_spans: ['ignored'], free_form_answer: 'ignored', yes_no: true })).toBe('Unanswerable')
    expect(qasperReference({ extractive_spans: ['first', 'second'], free_form_answer: 'ignored', yes_no: true })).toBe('first, second')
    expect(qasperReference({ extractive_spans: [], free_form_answer: 'free form', yes_no: true })).toBe('free form')
    expect(qasperReference({ extractive_spans: [], free_form_answer: '', yes_no: true })).toBe('Yes')
    expect(qasperReference({ extractive_spans: [], free_form_answer: '', yes_no: false })).toBe('No')
  })

  it('rejects annotations and reference lists with no valid answer', () => {
    expect(() => qasperReference({ extractive_spans: [], free_form_answer: '', yes_no: null })).toThrow(/reference/i)
    expect(() => qasperReference({ extractive_spans: ['   '], free_form_answer: '' })).toThrow(/reference/i)
    expect(() => qasperAnswerF1('answer', [])).toThrow(/reference/i)
    expect(() => qasperAnswerF1('answer', [''])).toThrow(/reference/i)
  })

  it('rejects malformed or blank extractive spans instead of dropping them', () => {
    expect(() => qasperReference({ extractive_spans: ['valid', 123] as unknown as string[] })).toThrow(/reference/i)
    expect(() => qasperReference({ extractive_spans: ['valid', '   '] })).toThrow(/reference/i)
    expect(() => qasperReference({ unanswerable: true, extractive_spans: [123] as unknown as string[] })).toThrow(/reference/i)
  })

  it('preserves valid reference text verbatim', () => {
    expect(qasperReference({ extractive_spans: [' first ', 'second'] })).toBe(' first , second')
    expect(qasperReference({ extractive_spans: [], free_form_answer: ' free form ' })).toBe(' free form ')
  })

  it('uses punctuation deletion, article removal, token multisets, and the best reference', () => {
    expect(qasperAnswerF1('State-of-the-art', ['stateoftheart'])).toBe(1)
    expect(qasperAnswerF1('the cat cat dog', ['cat dog dog'])).toBeCloseTo(2 / 3)
    expect(qasperAnswerF1('wrong', ['nope', 'wrong'])).toBe(1)
  })

  it('scores normalized-empty answers as zero even when both sides are empty', () => {
    expect(qasperAnswerF1('the', ['a'])).toBe(0)
    expect(qasperAnswerF1('!!!', ['...'])).toBe(0)
  })

  it('uses Unicode word boundaries when removing English articles', () => {
    expect(qasperAnswerF1('β', ['aβ'])).toBe(0)
    expect(qasperAnswerF1('ño', ['año'])).toBe(0)
    expect(qasperAnswerF1('β', ['the β'])).toBe(1)
    expect(qasperAnswerF1('answer', ['an answer'])).toBe(1)
  })
})

describe('all-question QA quality aggregation', () => {
  it('keeps failed questions in the denominator', () => {
    expect(aggregateQaQuality([
      record('p#0', 'completed', 0.8),
      record('p#1', 'failed', 0),
    ], ['p#0', 'p#1'])).toEqual({
      answerF1AllQuestions: 0.4,
      answerF1AllQuestionsSampleCount: 2,
      qaCompletionRate: 0.5,
    })
  })

  it('returns zero quality and completion when every question fails', () => {
    expect(aggregateQaQuality([
      record('p#0', 'failed', 0),
      record('p#1', 'skipped', 0),
    ], ['p#0', 'p#1'])).toEqual({
      answerF1AllQuestions: 0,
      answerF1AllQuestionsSampleCount: 2,
      qaCompletionRate: 0,
    })
  })

  it.each([
    ['empty expected ids', [record('p#0', 'completed', 1)], []],
    ['duplicate expected ids', [record('p#0', 'completed', 1)], ['p#0', 'p#0']],
    ['missing record', [record('p#0', 'completed', 1)], ['p#0', 'p#1']],
    ['duplicate record', [record('p#0', 'completed', 1), record('p#0', 'completed', 1)], ['p#0']],
    ['extra record', [record('p#0', 'completed', 1), record('p#1', 'completed', 1)], ['p#0']],
    ['unknown state', [{ ...record('p#0', 'completed', 1), generationStatus: undefined }], ['p#0']],
    ['missing score', [record('p#0', 'completed')], ['p#0']],
    ['NaN score', [record('p#0', 'completed', Number.NaN)], ['p#0']],
    ['failed nonzero', [record('p#0', 'failed', 0.2)], ['p#0']],
  ] as const)('rejects %s', (_name, records, ids) => {
    expect(() => aggregateQaQuality(records as unknown as PerSampleRecord[], [...ids])).toThrow()
  })

  it('scores completed answers, copies references, and zero-fills explicit failures', () => {
    const records = [
      { ...record('p#0', 'completed'), answer: 'The cat.' },
      record('p#1', 'failed'),
    ]
    const result = finalizeQaQuality(records, [
      question('p#0', ['cat']),
      question('p#1', ['dog']),
    ])

    expect(records[0]).toMatchObject({ referenceAnswers: ['cat'], metrics: { answerF1AllQuestions: 1 } })
    expect(records[1]).toMatchObject({ referenceAnswers: ['dog'], metrics: { answerF1AllQuestions: 0 } })
    expect(result).toEqual({
      metrics: {
        answerF1AllQuestions: 0.5,
        answerF1AllQuestionsSampleCount: 2,
        qaCompletionRate: 0.5,
      },
      meta: {
        qaQualityDefinition: QA_QUALITY_DEFINITION,
        qaExpectedQuestionIds: ['p#0', 'p#1'],
      },
    })
  })

  it('rejects malformed questions and completed records without an answer', () => {
    expect(() => finalizeQaQuality([record('p#0', 'completed')], [question('p#0', ['cat'])])).toThrow(/answer/i)
    expect(() => finalizeQaQuality([record('p#0', 'failed')], [{ ...question('p#0', ['cat']), qualityDefinition: undefined }])).toThrow(/definition/i)
    expect(() => finalizeQaQuality([record('p#0', 'failed')], [question('p#0', [])])).toThrow(/reference/i)
    expect(() => finalizeQaQuality([record('p#0', 'failed')], [question('p#0', ['cat']), question('p#0', ['dog'])])).toThrow(/duplicate/i)
  })
})
