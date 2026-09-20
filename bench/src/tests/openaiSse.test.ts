import { describe, expect, it } from 'vitest'
import { parseOpenAiSse } from '../streaming/openaiSse'

const encoder = new TextEncoder()

function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

function terminalThenNeverCloses(text: string): {
  stream: ReadableStream<Uint8Array>
  cancelled: () => boolean
  cleanup: () => void
} {
  let wasCancelled = false
  let timeout: ReturnType<typeof setTimeout> | undefined
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text))
      timeout = setTimeout(() => controller.error(new Error('test transport remained open')), 50)
    },
    cancel() {
      wasCancelled = true
      if (timeout !== undefined) clearTimeout(timeout)
    },
  })
  return {
    stream,
    cancelled: () => wasCancelled,
    cleanup: () => {
      if (timeout !== undefined) clearTimeout(timeout)
    },
  }
}

function chunksAt(text: string, boundaries: number[]): Uint8Array[] {
  const bytes = encoder.encode(text)
  const starts = [0, ...boundaries, bytes.length]
  return starts.slice(0, -1)
    .map((start, index) => bytes.slice(start, starts[index + 1]))
    .filter(chunk => chunk.length > 0)
}

function randomizedChunks(text: string, seed: number): Uint8Array[] {
  const bytes = encoder.encode(text)
  const boundaries: number[] = []
  let state = seed
  let offset = 0
  while (offset < bytes.length) {
    state = (state * 1103515245 + 12345) >>> 0
    offset += 1 + (state % 11)
    if (offset < bytes.length) boundaries.push(offset)
  }
  return chunksAt(text, boundaries)
}

const fixture = [
  'data: {"choices":[{"delta":{"role":"assistant"}}]}\r\n\r\n',
  'data:\r\n\r\n',
  'data: {"choices":[{"delta":{"reasoning_content":"hidden"}}]}\r\n\r\n',
  'data: {"choices":[{"delta":{"content":""}}]}\r\n\r\n',
  'data: {"choices":[{"delta":{"content":"Hello"}}]}\r\n\r\n',
  'data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}\r\n\r\n',
  'data: {"choices":[],"usage":{"prompt_tokens":13,"completion_tokens":2}}\r\n\r\n',
  'data: [DONE]\r\n\r\n',
].join('')

describe('OpenAI-compatible SSE parser', () => {
  it.each([
    ['one chunk', [encoder.encode(fixture)]],
    ['byte-by-byte chunks', Array.from(encoder.encode(fixture), byte => new Uint8Array([byte]))],
    ['line-boundary chunks', chunksAt(fixture, Array.from(encoder.encode(fixture)).flatMap((byte, index) => byte === 10 ? [index + 1] : []))],
    ['deterministic randomized chunks', randomizedChunks(fixture, 12345)],
  ])('parses visible deltas and usage across %s', async (_name, chunks) => {
    const visible: string[] = []

    await expect(parseOpenAiSse(streamFromChunks(chunks), delta => visible.push(delta))).resolves.toEqual({
      content: 'Hello world',
      usage: { inputTokens: 13, outputTokens: 2 },
    })
    expect(visible).toEqual(['Hello', ' world'])
  })

  it('rejects malformed non-empty event payloads', async () => {
    const stream = streamFromChunks([encoder.encode('data: not-json\n\n')])

    await expect(parseOpenAiSse(stream, () => {})).rejects.toThrow(/malformed OpenAI SSE payload/)
  })

  it('rejects an incomplete trailing event after visible content', async () => {
    const stream = streamFromChunks([encoder.encode([
      'data: {"choices":[{"delta":{"content":"answer"}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"lost"}}]}',
    ].join('\n'))])

    await expect(parseOpenAiSse(stream, () => {})).rejects.toThrow(/incomplete OpenAI SSE event/)
  })

  it('rejects clean transport EOF without the required [DONE] marker', async () => {
    const stream = streamFromChunks([encoder.encode(
      'data: {"choices":[{"delta":{"content":"truncated"}}]}\n\n',
    )])

    await expect(parseOpenAiSse(stream, () => {})).rejects.toThrow(/\[DONE\].*terminal marker/i)
  })

  it('stops and cancels a transport that remains open after [DONE]', async () => {
    const transport = terminalThenNeverCloses([
      'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n',
      'data: [DONE]\n\n',
    ].join(''))

    try {
      await expect(parseOpenAiSse(transport.stream, () => {})).resolves.toEqual({
        content: 'answer',
        usage: { inputTokens: 3, outputTokens: 1 },
      })
      expect(transport.cancelled()).toBe(true)
    } finally {
      transport.cleanup()
    }
  })

  it('preserves multibyte UTF-8 text split at every byte boundary', async () => {
    const text = [
      'data: {"choices":[{"delta":{"content":"你好，世界"}}]}\n\n',
      'data: [DONE]\n\n',
    ].join('')
    const chunks = Array.from(encoder.encode(text), byte => new Uint8Array([byte]))
    const visible: string[] = []

    await expect(parseOpenAiSse(streamFromChunks(chunks), delta => visible.push(delta))).resolves.toEqual({
      content: '你好，世界',
    })
    expect(visible).toEqual(['你好，世界'])
  })

  it('rejects records already buffered after [DONE]', async () => {
    const stream = streamFromChunks([encoder.encode([
      'data: {"choices":[{"delta":{"content":"answer"}}]}',
      '',
      'data: [DONE]',
      '',
      'data: {"choices":[{"delta":{"content":"late"}}]}',
      '',
      '',
    ].join('\n'))])

    await expect(parseOpenAiSse(stream, () => {})).rejects.toThrow(/after.*\[DONE\]/i)
  })

  it('rejects scalar records after visible content', async () => {
    const stream = streamFromChunks([encoder.encode([
      'data: {"choices":[{"delta":{"content":"answer"}}]}',
      '',
      'data: 1',
      '',
      '',
    ].join('\n'))])

    await expect(parseOpenAiSse(stream, () => {})).rejects.toThrow(/malformed OpenAI SSE record/)
  })

  it('rejects a normally ended stream without visible answer content', async () => {
    const stream = streamFromChunks([encoder.encode('data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":0}}\n\ndata: [DONE]\n\n')])

    await expect(parseOpenAiSse(stream, () => {})).rejects.toThrow(/empty final content/)
  })
})
