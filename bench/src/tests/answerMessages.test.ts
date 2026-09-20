import { describe, expect, it, vi } from 'vitest'

// Node 环境缺 DOMMatrix，pageIndex 顶层会初始化 pdfjs worker
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: {},
  getDocument: vi.fn(),
}))

const { buildAnswerMessages, MATH_FORMAT_INSTRUCTION } =
  await import('../../../src/utils/ragPipeline')
const EXPECTED_MATH_FORMAT_INSTRUCTION =
  '数学公式请使用 LaTeX：行内公式使用 $...$，独立公式使用 $$...$$。不要使用 \\(...\\) 或 \\[...\\] 包裹公式。'

describe('answer messages benchmark contract', () => {
  it('pins the exact production math-format instruction bytes', () => {
    expect(MATH_FORMAT_INSTRUCTION).toBe(EXPECTED_MATH_FORMAT_INSTRUCTION)
  })

  it('uses the production builder for the exact final-answer prompt bytes', () => {
    expect(buildAnswerMessages('evidence', 'question', [], 'system')).toEqual([
      {
        role: 'system',
        content: `system\n\n${EXPECTED_MATH_FORMAT_INSTRUCTION}\n\n参考内容：\nevidence`,
      },
      { role: 'user', content: 'question' },
    ])
  })
})
