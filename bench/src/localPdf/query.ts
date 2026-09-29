import { buildAnswerMessages } from '../../../src/utils/ragPipeline'
import type { StreamingLlmClient } from '../llmClient'
import type { FrozenQuestion, QueryRecord } from './types'
import type { PreparedMethod } from './methods'
import { safeError } from './errors'
export async function executeQuery(question: FrozenQuestion, prepared: PreparedMethod, deps: { client: StreamingLlmClient; now: () => number; systemPrompt: string }): Promise<QueryRecord> {
  const r: QueryRecord = {
    method: prepared.method, questionId: question.id, paperId: question.paperId,
    retrievalStatus: prepared.method === 'R' ? 'not-applicable' : 'failed', generationStatus: 'skipped',
    answer: '', evidence: null, context: '', trace: [], t0: deps.now(), tContextReady: null, tFirstAnswerToken: null,
    ...(prepared.fallbackReason ? { fallbackReason: prepared.fallbackReason } : {}),
  }
  if (prepared.method !== 'R') {
    try {
      const context = await prepared.retrieve!(question.question)
      r.context = context.text; r.trace = context.trace
      r.tContextReady = deps.now(); r.retrievalStatus = 'completed'
    } catch (error) { r.error = { stage: 'retrieve', message: safeError(error) }; return r }
  } else r.context = prepared.fullText!
  let partial = ''
  try {
    const messages = buildAnswerMessages(r.context, question.question, [], deps.systemPrompt)
    const completion = await deps.client.chatStream(messages, delta => {
      partial += delta
      if (delta.trim().length > 0 && r.tFirstAnswerToken === null) r.tFirstAnswerToken = deps.now()
    })
    if (!completion.content.trim() || r.tFirstAnswerToken === null) throw new Error('No visible answer in completed stream')
    r.answer = completion.content; r.generationStatus = 'completed'
  } catch (error) {
    r.generationStatus = 'failed'; r.partialAnswer = partial
    r.error = { stage: 'generate', message: safeError(error) }
  }
  return r
}
