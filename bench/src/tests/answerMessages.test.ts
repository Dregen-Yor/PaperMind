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
const EXPECTED_GROUNDING_INSTRUCTION =
  '涉及论文事实时，只依据参考内容作答；区分原文明确陈述与推断，不编造数据、方法或结论。先直接回答问题，再给出必要的证据与限定条件；结论必须与证据一致，并准确对应问题中的对象、范围和比较条件。参考内容不足以确定答案时，明确说明无法从当前参考内容确定；不要把“未提及”当作否定事实。按问题需要展开，避免重复问题或加入无关背景；用户要求详细解释时保留充分的论证。'

describe('answer messages benchmark contract', () => {
  it('pins the exact production math-format instruction bytes', () => {
    expect(MATH_FORMAT_INSTRUCTION).toBe(EXPECTED_MATH_FORMAT_INSTRUCTION)
  })

  it('pins the general evidence-grounding instruction for the prompt ablation', () => {
    expect(GROUNDING_INSTRUCTION).toBe(EXPECTED_GROUNDING_INSTRUCTION)
  })

  it('uses the production builder for the exact final-answer prompt bytes', () => {
    expect(buildAnswerMessages('evidence', 'question', [], 'system')).toEqual([
      {
        role: 'system',
        content: `system\n\n${EXPECTED_MATH_FORMAT_INSTRUCTION}\n\n${EXPECTED_GROUNDING_INSTRUCTION}\n\n参考内容：\nevidence`,
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
            + (context ? `\n\n${EXPECTED_GROUNDING_INSTRUCTION}\n\n参考内容：\n${context}` : ''),
        },
        ...originalHistory.slice(-19),
        { role: 'user', content: query },
      ])
      expect(history).toEqual(originalHistory)
    },
  )
})
