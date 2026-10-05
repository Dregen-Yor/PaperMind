import { describe, expect, it, vi } from 'vitest'
import type { ChatTurn } from '../../../src/utils/queryRewrite'

// Node 环境缺 DOMMatrix，pageIndex 顶层会初始化 pdfjs worker
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: {},
  getDocument: vi.fn(),
}))

const { buildAnswerMessages, MATH_FORMAT_INSTRUCTION } =
  await import('../../../src/utils/ragPipeline')
const { GROUNDING_INSTRUCTION } = await import('../../../src/utils/answerMessages')
const EXPECTED_MATH_FORMAT_INSTRUCTION =
  '数学公式请使用 LaTeX：行内公式使用 $...$，独立公式使用 $$...$$。不要使用 \\(...\\) 或 \\[...\\] 包裹公式。'
const EXPECTED_GROUNDING_INSTRUCTION = `Answer the user's question using the reference content above.
- Give the smallest complete answer. For a fact, name, number, list, or yes/no question, provide the requested information and only qualifications needed for correctness. Do not add background, repeat the question, or quote passages unless requested. For explanations, comparisons, derivations, or explicit requests for detail, provide the necessary reasoning.
- Check the question's scope and all relevant evidence before stating the conclusion. A counterexample rules out an unqualified "all", "only", or "best" claim. The opening answer and its qualifications must agree.
- State paper-specific claims only when supported. If the available text cannot establish the answer, say that it cannot be determined from the provided content. Missing evidence is not evidence for "no"; do not fill gaps with general knowledge.`

describe('answer messages benchmark contract', () => {
  it('pins the exact production math-format instruction bytes', () => {
    expect(MATH_FORMAT_INSTRUCTION).toBe(EXPECTED_MATH_FORMAT_INSTRUCTION)
  })

  it('pins the general evidence-grounding instruction for the prompt ablation', () => {
    expect(GROUNDING_INSTRUCTION).toBe(EXPECTED_GROUNDING_INSTRUCTION)
  })

  it('places the adaptive-detail instruction after reference content in the exact production prompt', () => {
    expect(buildAnswerMessages('evidence', 'question', [], 'system')).toEqual([
      {
        role: 'system',
        content: `system\n\n${EXPECTED_MATH_FORMAT_INSTRUCTION}\n\n参考内容：\nevidence\n\n${EXPECTED_GROUNDING_INSTRUCTION}`,
      },
      { role: 'user', content: 'question' },
    ])
  })

  it('keeps the original message bytes when no reference content exists', () => {
    expect(buildAnswerMessages('', 'question', [], 'system')).toEqual([
      { role: 'system', content: `system\n\n${EXPECTED_MATH_FORMAT_INSTRUCTION}` },
      { role: 'user', content: 'question' },
    ])
  })

  it.each(['', '  First passage\r\n第二段 $x$\t\n', ' \t\n'])(
    'preserves custom prompt, reference, recent history and question bytes for context %j',
    (context) => {
      const systemPrompt = '  Custom instructions\r\n请用英文作答。\t'
      const query = '  Explain the comparison in detail.\r\n请保留论证。\t'
      const history: ChatTurn[] = Array.from({ length: 21 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `  turn-${index}\r\n$y$\t`,
      }))
      const originalHistory = history.map(turn => ({ ...turn }))

      expect(buildAnswerMessages(context, query, history, systemPrompt)).toEqual([
        {
          role: 'system',
          content: `${systemPrompt}\n\n${EXPECTED_MATH_FORMAT_INSTRUCTION}`
            + (context ? `\n\n参考内容：\n${context}\n\n${EXPECTED_GROUNDING_INSTRUCTION}` : ''),
        },
        ...originalHistory.slice(-19),
        { role: 'user', content: query },
      ])
      expect(history).toEqual(originalHistory)
    },
  )
})
