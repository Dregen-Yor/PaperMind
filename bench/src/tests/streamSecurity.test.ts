import { describe, expect, it, vi } from 'vitest'
import { MAX_SERVICE_JSON_BYTES } from '../../../src/utils/serviceSecurity'
import { parseOpenAiSse } from '../streaming/openaiSse'
import { parseOllamaNdjson } from '../streaming/ollamaNdjson'

describe('stream response limits', () => {
  it.each([parseOpenAiSse, parseOllamaNdjson])('cancels oversized input before parsing incomplete records', async parse => {
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(MAX_SERVICE_JSON_BYTES + 1)) },
      cancel,
    })
    await expect(parse(stream, () => {})).rejects.toThrow('大小上限')
    expect(cancel).toHaveBeenCalledOnce()
    expect(stream.locked).toBe(false)
  })
})
