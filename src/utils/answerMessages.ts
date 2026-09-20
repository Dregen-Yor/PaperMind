import type { ChatMessage } from './llm'
import type { ChatTurn } from './queryRewrite'

/** 数学公式格式约束，追加在 system 提示词之后。 */
export const MATH_FORMAT_INSTRUCTION =
  '数学公式请使用 LaTeX：行内公式使用 $...$，独立公式使用 $$...$$。不要使用 \\(...\\) 或 \\[...\\] 包裹公式。'

/** 生成回答时携带的最近历史轮数（不含当前提问）。 */
const GENERATE_HISTORY_WINDOW = 19

export function buildAnswerMessages(
  context: string,
  query: string,
  history: ChatTurn[],
  systemPrompt: string,
): ChatMessage[] {
  return [
    {
      role: 'system',
      content: `${systemPrompt}\n\n${MATH_FORMAT_INSTRUCTION}`
        + (context ? `\n\n参考内容：\n${context}` : ''),
    },
    ...history.slice(-GENERATE_HISTORY_WINDOW),
    { role: 'user', content: query },
  ]
}
