import { describe, expect, it } from 'vitest'
import { createModelFileCache, type KeyValueStore } from '../utils/modelCache'

function memoryStore(): KeyValueStore & { size(): number } {
  const map = new Map<string, ArrayBuffer>()
  return {
    async get(key) { return map.get(key) },
    async put(key, value) { map.set(key, value) },
    size: () => map.size,
  }
}

describe('createModelFileCache', () => {
  it('未命中返回 undefined，命中返回可读的 Response', async () => {
    const cache = createModelFileCache(memoryStore())
    expect(await cache.match('https://example.com/model.onnx')).toBeUndefined()
    await cache.put('https://example.com/model.onnx', new Response(new Uint8Array([1, 2, 3])))
    const hit = await cache.match('https://example.com/model.onnx')
    expect(new Uint8Array(await hit!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('同一个 key 覆写后读回新内容', async () => {
    const cache = createModelFileCache(memoryStore())
    await cache.put('k', new Response(new Uint8Array([1])))
    await cache.put('k', new Response(new Uint8Array([2])))
    expect(new Uint8Array(await (await cache.match('k'))!.arrayBuffer())).toEqual(new Uint8Array([2]))
  })
})
