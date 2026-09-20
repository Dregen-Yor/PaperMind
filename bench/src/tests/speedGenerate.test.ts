import { describe, expect, it, vi } from 'vitest'
import type { StreamingLlmClient } from '../llmClient'
import type { PerSampleRecord, QuerySpeedRecord, QueryTimeline } from '../types'

// Node environment lacks DOMMatrix; ragPipeline initializes pdfjs at module load.
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: {},
  getDocument: vi.fn(),
}))

const { generateSpeedAnswer } = await import('../speed/generate')

function sampleRecord(): PerSampleRecord {
  return { id: 'p#0', paperId: 'p', source: 'smoke', metrics: {} }
}

function streamingClient(snapshot = { totalTokens: 23, incompleteRequestCount: 0 }): StreamingLlmClient {
  return {
    complete: async () => '',
    chat: async () => '',
    chatStream: async () => ({ content: '' }),
    stats: () => ({ hits: 0, misses: 0 }),
    latencies: () => [],
    requestTimings: () => [],
    tokenSnapshot: () => snapshot,
    cacheEnabled: () => false,
  }
}

function timeline(
  completeRecord: QuerySpeedRecord,
  partialRecord: QuerySpeedRecord = { tokenAccountingComplete: false },
  events: string[] = [],
): QueryTimeline {
  return {
    markEvidenceReady: vi.fn(),
    onVisibleText: vi.fn(),
    complete: vi.fn(readAfter => {
      events.push('complete')
      readAfter()
      return completeRecord
    }),
    partial: vi.fn(() => partialRecord),
  }
}

describe('generateSpeedAnswer', () => {
  it('uses production messages, forwards visible deltas, and completes before judge', async () => {
    const completed: QuerySpeedRecord = {
      evidenceReadyLatencyMs: 5,
      timeToFirstTokenMs: 8,
      fullAnswerLatencyMs: 13,
      onlineTokenCount: 23,
      tokenAccountingComplete: true,
    }
    const events: string[] = []
    const queryTimeline = timeline(completed, undefined, events)
    const record = sampleRecord()
    const streamAnswer: StreamingLlmClient['chatStream'] = vi.fn(async (_messages, onVisibleText) => {
      events.push('stream')
      onVisibleText('provider ')
      onVisibleText('')
      onVisibleText(' ')
      return { content: 'provider final content' }
    })

    const answer = await generateSpeedAnswer({
      context: 'materialized evidence',
      question: 'What happened?',
      history: [{ role: 'assistant', content: 'Earlier answer' }],
      systemPrompt: 'System prompt',
      timeline: queryTimeline,
      client: streamingClient(),
      record,
      streamAnswer,
      onStreamStarted: () => events.push('legacy-start'),
      onStreamCompleted: () => events.push('legacy-end'),
    })
    events.push('judge')

    expect(streamAnswer).toHaveBeenCalledWith([
      {
        role: 'system',
        content: 'System prompt\n\n数学公式请使用 LaTeX：行内公式使用 $...$，独立公式使用 $$...$$。不要使用 \\(...\\) 或 \\[...\\] 包裹公式。\n\n参考内容：\nmaterialized evidence',
      },
      { role: 'assistant', content: 'Earlier answer' },
      { role: 'user', content: 'What happened?' },
    ], expect.any(Function))
    expect(queryTimeline.onVisibleText).toHaveBeenCalledTimes(2)
    expect(vi.mocked(queryTimeline.onVisibleText).mock.calls).toEqual([['provider '], [' ']])
    expect(answer).toBe('provider final content')
    expect(record.speed).toEqual(completed)
    expect(events).toEqual(['legacy-start', 'stream', 'legacy-end', 'complete', 'judge'])
  })

  it('attaches a partial record and rethrows when the stream fails', async () => {
    const partial: QuerySpeedRecord = {
      evidenceReadyLatencyMs: 5,
      timeToFirstTokenMs: 8,
      tokenAccountingComplete: false,
    }
    const queryTimeline = timeline({ tokenAccountingComplete: false }, partial)
    const record = sampleRecord()
    const client = streamingClient({ totalTokens: 31, incompleteRequestCount: 1 })
    const streamAnswer: StreamingLlmClient['chatStream'] = async (_messages, onVisibleText) => {
      onVisibleText('partial')
      throw new Error('stream disconnected')
    }

    await expect(generateSpeedAnswer({
      context: 'evidence',
      question: 'Question?',
      systemPrompt: 'System',
      timeline: queryTimeline,
      client,
      record,
      streamAnswer,
    })).rejects.toThrow('stream disconnected')

    expect(queryTimeline.complete).not.toHaveBeenCalled()
    expect(queryTimeline.partial).toHaveBeenCalledWith({ totalTokens: 31, incompleteRequestCount: 1 })
    expect(record.speed).toEqual(partial)
  })

  it('does not downgrade an invalid completed timeline to a partial record', async () => {
    const record = sampleRecord()
    const queryTimeline = timeline({ tokenAccountingComplete: false })
    vi.mocked(queryTimeline.complete).mockImplementation(() => {
      throw new Error('invalid completed timeline')
    })

    await expect(generateSpeedAnswer({
      context: 'evidence',
      question: 'Question?',
      systemPrompt: 'System',
      timeline: queryTimeline,
      client: streamingClient(),
      record,
      streamAnswer: async () => ({ content: 'answer' }),
    })).rejects.toThrow('invalid completed timeline')

    expect(queryTimeline.partial).not.toHaveBeenCalled()
    expect(record.speed).toBeUndefined()
  })

  it('uses prepared full-context messages and generation-only completion semantics', async () => {
    const completed: QuerySpeedRecord = {
      timeToFirstTokenMs: 8,
      fullAnswerLatencyMs: 13,
      tokenAccountingComplete: false,
    }
    const queryTimeline = timeline(completed)
    const record = sampleRecord()
    const preparedMessages = [
      { role: 'system' as const, content: 'prepared full paper framing' },
      { role: 'user' as const, content: 'prepared question' },
    ]
    const streamAnswer: StreamingLlmClient['chatStream'] = vi.fn(async (_messages, onVisibleText) => {
      onVisibleText('answer')
      return { content: 'answer' }
    })

    await expect(generateSpeedAnswer({
      context: 'must not be rebuilt',
      question: 'must not be rebuilt',
      systemPrompt: 'must not be rebuilt',
      messages: preparedMessages,
      timeline: queryTimeline,
      client: streamingClient(),
      record,
      streamAnswer,
      evidenceRequired: false,
    })).resolves.toBe('answer')

    expect(streamAnswer).toHaveBeenCalledWith(preparedMessages, expect.any(Function))
    expect(queryTimeline.complete).toHaveBeenCalledWith(expect.any(Function), false)
    expect(record.speed).toEqual(completed)
  })
})
