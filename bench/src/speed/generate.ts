import { buildAnswerMessages } from '../../../src/utils/ragPipeline'
import type { ChatTurn } from '../../../src/utils/queryRewrite'
import type { ChatMessage } from '../../../src/utils/llm'
import type { StreamingLlmClient } from '../llmClient'
import type { PerSampleRecord, QueryTimeline } from '../types'
import type { SpeedRunContract } from './contract'

export interface SpeedRunnerOptions {
  contract: SpeedRunContract
  now?: () => number
  streamAnswer?: StreamingLlmClient['chatStream']
}

export interface GenerateSpeedAnswerArgs {
  context: string
  question: string
  history?: ChatTurn[]
  systemPrompt: string
  /** Prebuilt messages let generation-only runners place t0 after large prompt construction. */
  messages?: ChatMessage[]
  timeline: QueryTimeline
  client: StreamingLlmClient
  record: PerSampleRecord
  streamAnswer?: StreamingLlmClient['chatStream']
  /** Legacy PipelineTiming boundaries: after message construction, immediately around chatStream. */
  onStreamStarted?: () => void
  onStreamCompleted?: () => void
  /** Full-context is generation-only and therefore does not require Evidence Ready. */
  evidenceRequired?: boolean
}

/**
 * Shared final-answer stream for every speed runner. The runner owns retrieval and marks
 * Evidence Ready; this adapter owns the exact production messages, TTFT callback, t3/token
 * completion, and attachment of complete or partial speed observations to the sample record.
 */
export async function generateSpeedAnswer(args: GenerateSpeedAnswerArgs): Promise<string> {
  const streamAnswer = args.streamAnswer ?? args.client.chatStream
  const messages = args.messages ?? buildAnswerMessages(
    args.context,
    args.question,
    args.history ?? [],
    args.systemPrompt,
  )

  let completion: Awaited<ReturnType<StreamingLlmClient['chatStream']>>
  args.onStreamStarted?.()
  try {
    completion = await streamAnswer(messages, delta => {
      if (delta.length > 0) args.timeline.onVisibleText(delta)
    })
  } catch (error) {
    args.record.speed = args.timeline.partial(args.client.tokenSnapshot())
    throw error
  }
  args.onStreamCompleted?.()

  args.record.speed = args.timeline.complete(
    () => args.client.tokenSnapshot(),
    args.evidenceRequired ?? true,
  )
  return completion.content
}
