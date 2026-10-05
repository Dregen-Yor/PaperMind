import type { ChatMessage } from './llm'
import type { ChatTurn } from './queryRewrite'

/** 数学公式格式约束，追加在 system 提示词之后。 */
export const MATH_FORMAT_INSTRUCTION =
  '数学公式请使用 LaTeX：行内公式使用 $...$，独立公式使用 $$...$$。不要使用 \\(...\\) 或 \\[...\\] 包裹公式。'

/** 有参考内容时，按问题需要展开，并约束结论、证据与不确定性表述。 */
export const GROUNDING_INSTRUCTION = `Answer the user's question using the reference content above.
- Give the smallest complete answer. For a fact, name, number, list, or yes/no question, provide the requested information and only qualifications needed for correctness. Do not add background, repeat the question, or quote passages unless requested. For explanations, comparisons, derivations, or explicit requests for detail, provide the necessary reasoning.
- Check the question's scope and all relevant evidence before stating the conclusion. A counterexample rules out an unqualified "all", "only", or "best" claim. The opening answer and its qualifications must agree.
- State paper-specific claims only when supported. If the available text cannot establish the answer, say that it cannot be determined from the provided content. Missing evidence is not evidence for "no"; do not fill gaps with general knowledge.`

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
        + (context ? `\n\n参考内容：\n${context}\n\n${GROUNDING_INSTRUCTION}` : ''),
    },
    ...history.slice(-GENERATE_HISTORY_WINDOW),
    { role: 'user', content: query },
  ]
}
