import type { ChatMessage } from './llm'
import type { ChatTurn } from './queryRewrite'

/** 数学公式格式约束，追加在 system 提示词之后。 */
export const MATH_FORMAT_INSTRUCTION =
  '数学公式请使用 LaTeX：行内公式使用 $...$，独立公式使用 $$...$$。不要使用 \\(...\\) 或 \\[...\\] 包裹公式。'

/** 有参考内容时，约束论文事实、证据一致性与信息不足时的表述。 */
export const GROUNDING_INSTRUCTION =
  '涉及论文事实时，只依据参考内容作答；区分原文明确陈述与推断，不编造数据、方法或结论。先直接回答问题，再给出必要的证据与限定条件；结论必须与证据一致，并准确对应问题中的对象、范围和比较条件。参考内容不足以确定答案时，明确说明无法从当前参考内容确定；不要把“未提及”当作否定事实。按问题需要展开，避免重复问题或加入无关背景；用户要求详细解释时保留充分的论证。'

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
        + (context ? `\n\n${GROUNDING_INSTRUCTION}\n\n参考内容：\n${context}` : ''),
    },
    ...history.slice(-GENERATE_HISTORY_WINDOW),
    { role: 'user', content: query },
  ]
}
