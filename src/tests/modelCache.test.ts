import { afterEach, describe, expect, it, vi } from 'vitest'
import { createIdbStore, createModelFileCache, type KeyValueStore } from '../utils/modelCache'

function memoryStore(): KeyValueStore & { size(): number } {
  const map = new Map<string, ArrayBuffer>()
  return {
    async get(key) { return map.get(key) },
    async put(key, value) { map.set(key, value) },
    size: () => map.size,
  }
}

/** 让 setTimeout(0) 的假事件跑完。 */
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

/**
 * jsdom 不带 IndexedDB，手搓一个最小实现，只覆盖 createIdbStore 用到的 API
 * （open / 建表 / 事务 / get / put）。内部刻意用 any 保持短小。
 * state 上的两个开关模拟真实故障：
 * - failNextOpen：下一次 open 触发 onerror；
 * - abortNextCommit：请求 onsuccess 之后事务才 abort —— 配额 / 磁盘耗尽正是这样，
 *   写入随之回滚（只有提交成功才落地）。
 */
function fakeIndexedDb() {
  const tables = new Map<string, Map<string, unknown>>()
  const state = {
    openCalls: 0,
    failNextOpen: false,
    abortNextCommit: false,
    commits: 0,
    database: null as any,
  }
  let upgraded = false

  const open = () => {
    state.openCalls++
    const request: any = {}
    let closed = false
    const database: any = {
      objectStoreNames: { contains: (name: string) => tables.has(name) },
      createObjectStore: (name: string) => tables.set(name, new Map()),
      close: () => { closed = true; setTimeout(() => database.onclose?.(), 0) },
      transaction: (name: string, mode: string) => {
        if (closed) throw new Error('数据库连接已关闭')
        const table = tables.get(name)
        if (!table) throw new Error(`对象仓库 ${name} 不存在`)
        const tx: any = { error: undefined }
        const settle = (read: () => unknown, commit?: () => void) => {
          const pending: any = {}
          setTimeout(() => {
            pending.result = read()
            pending.onsuccess?.()
            setTimeout(() => {
              if (state.abortNextCommit && mode === 'readwrite') {
                state.abortNextCommit = false
                tx.error = new Error('QuotaExceededError')
                tx.onabort?.()
              } else {
                commit?.()
                state.commits++
                tx.oncomplete?.()
              }
            }, 0)
          }, 0)
          return pending
        }
        tx.objectStore = () => ({
          get: (key: string) => settle(() => table.get(key)),
          put: (value: unknown, key: string) => settle(() => key, () => table.set(key, value)),
        })
        return tx
      },
    }
    state.database = database
    request.result = database
    const shouldFail = state.failNextOpen
    state.failNextOpen = false
    setTimeout(() => {
      if (shouldFail) {
        request.error = new Error('打开模型缓存失败')
        request.onerror?.()
      } else {
        if (!upgraded) {
          upgraded = true
          request.onupgradeneeded?.()
        }
        request.onsuccess?.()
      }
    }, 0)
    return request
  }

  return { indexedDB: { open }, state }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

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

  // transformers.js 下载后的二次确认 `await cache.match(cacheKey)` 没有 try/catch
  // （它的 tryCache 有）：这里抛出会让已下载好的模型直接加载失败。
  it('存储读取失败时退化为未命中并告警，不向上抛', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const cache = createModelFileCache({
      get: async () => { throw new Error('IndexedDB 不可用') },
      put: async () => {},
    })
    expect(await cache.match('k')).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('存储写入失败时只告警，本次推理照常继续', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const cache = createModelFileCache({
      get: async () => undefined,
      put: async () => { throw new Error('QuotaExceededError') },
    })
    await expect(cache.put('k', new Response(new Uint8Array([1])))).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('createIdbStore', () => {
  it('连接复用：多次读写只打开一次数据库', async () => {
    const { indexedDB, state } = fakeIndexedDb()
    vi.stubGlobal('indexedDB', indexedDB)
    const store = createIdbStore()

    await store.get('a')
    await store.put('b', new Uint8Array([1, 2, 3]).buffer)
    expect(state.openCalls).toBe(1)
  })

  it('put → get 往返，且 put 只在事务提交后才返回', async () => {
    const { indexedDB, state } = fakeIndexedDb()
    vi.stubGlobal('indexedDB', indexedDB)
    const store = createIdbStore()

    await store.put('model.onnx', new Uint8Array([1, 2, 3]).buffer)
    expect(state.commits).toBe(1)
    expect(new Uint8Array((await store.get('model.onnx'))!)).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('提交阶段 abort（配额 / 磁盘耗尽）时 put 必须失败', async () => {
    const { indexedDB, state } = fakeIndexedDb()
    vi.stubGlobal('indexedDB', indexedDB)
    const store = createIdbStore()

    state.abortNextCommit = true
    await expect(store.put('model.onnx', new ArrayBuffer(8))).rejects.toThrow('QuotaExceededError')
    // 提交失败的写入被回滚，不会被当成「已缓存」
    expect(await store.get('model.onnx')).toBeUndefined()
  })

  it('提交失败经缓存层降级为「本次不缓存」，不拖垮模型加载', async () => {
    const { indexedDB, state } = fakeIndexedDb()
    vi.stubGlobal('indexedDB', indexedDB)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const cache = createModelFileCache(createIdbStore())

    state.abortNextCommit = true
    await expect(cache.put('model.onnx', new Response(new Uint8Array([1, 2])))).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    // 读回按未命中处理：下次在线启动会重新下载，而不是用一份不存在的缓存
    expect(await cache.match('model.onnx')).toBeUndefined()
  })

  it('打开失败不被记住：下一次调用重新打开', async () => {
    const { indexedDB, state } = fakeIndexedDb()
    vi.stubGlobal('indexedDB', indexedDB)
    const store = createIdbStore()

    state.failNextOpen = true
    await expect(store.get('a')).rejects.toThrow('打开模型缓存失败')
    expect(await store.get('a')).toBeUndefined()
    expect(state.openCalls).toBe(2)
  })

  it('连接被关闭（如另一上下文升级版本）后丢弃句柄，下次调用重新打开', async () => {
    const { indexedDB, state } = fakeIndexedDb()
    vi.stubGlobal('indexedDB', indexedDB)
    const store = createIdbStore()

    await store.get('a')
    state.database.onversionchange()
    await tick()
    expect(await store.get('a')).toBeUndefined()
    expect(state.openCalls).toBe(2)
  })
})
