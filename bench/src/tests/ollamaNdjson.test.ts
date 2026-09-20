import { describe, expect, it } from 'vitest'
import { parseOllamaNdjson } from '../streaming/ollamaNdjson'

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

describe('Ollama NDJSON parser', () => {
  it('parses split objects, multiple lines, and a trailing final line', async () => {
    const first = '{"message":{"content":"Hel'
    const rest = 'lo"},"done":false}\r\n{"message":{"content":" world"},"done":false}\r\n{"done":true,"prompt_eval_count":8,"eval_count":2}'
    const visible: string[] = []

    await expect(parseOllamaNdjson(streamFromChunks([
      encoder.encode(first),
      encoder.encode(rest),
    ]), delta => visible.push(delta))).resolves.toEqual({
      content: 'Hello world',
      usage: { inputTokens: 8, outputTokens: 2 },
    })
    expect(visible).toEqual(['Hello', ' world'])
  })

  it('does not treat empty or metadata-only records as visible text', async () => {
    const stream = streamFromChunks([encoder.encode([
      '{"message":{"role":"assistant","content":""},"done":false}',
      '{"thinking":"hidden","done":false}',
      '{"done":true,"prompt_eval_count":4,"eval_count":0}',
      '',
    ].join('\n'))])

    await expect(parseOllamaNdjson(stream, () => {})).rejects.toThrow(/empty final content/)
  })

  it('rejects malformed non-empty NDJSON records', async () => {
    const stream = streamFromChunks([encoder.encode('{"message":\n')])

    await expect(parseOllamaNdjson(stream, () => {})).rejects.toThrow(/malformed Ollama NDJSON payload/)
  })

  it('rejects clean transport EOF without the required done:true marker', async () => {
    const stream = streamFromChunks([encoder.encode(
      '{"message":{"content":"truncated"},"done":false}\n',
    )])

    await expect(parseOllamaNdjson(stream, () => {})).rejects.toThrow(/done:true.*terminal marker/i)
  })

  it('stops and cancels a transport that remains open after done:true', async () => {
    const transport = terminalThenNeverCloses([
      '{"message":{"content":"answer"},"done":false}',
      '{"done":true,"prompt_eval_count":3,"eval_count":1}',
      '',
    ].join('\n'))

    try {
      await expect(parseOllamaNdjson(transport.stream, () => {})).resolves.toEqual({
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
      '{"message":{"content":"你好，世界"},"done":false}',
      '{"done":true}',
      '',
    ].join('\n')
    const chunks = Array.from(encoder.encode(text), byte => new Uint8Array([byte]))
    const visible: string[] = []

    await expect(parseOllamaNdjson(streamFromChunks(chunks), delta => visible.push(delta))).resolves.toEqual({
      content: '你好，世界',
    })
    expect(visible).toEqual(['你好，世界'])
  })

  it('rejects scalar records after visible content', async () => {
    const stream = streamFromChunks([encoder.encode([
      '{"message":{"content":"answer"},"done":false}',
      'true',
      '',
    ].join('\n'))])

    await expect(parseOllamaNdjson(stream, () => {})).rejects.toThrow(/malformed Ollama NDJSON record/)
  })

  it('rejects a scalar record delivered after done', async () => {
    const stream = streamFromChunks([encoder.encode([
      '{"message":{"content":"answer"},"done":false}',
      '{"done":true}',
      'true',
      '',
    ].join('\n'))])

    await expect(parseOllamaNdjson(stream, () => {})).rejects.toThrow(/after.*done:true/i)
  })
})
