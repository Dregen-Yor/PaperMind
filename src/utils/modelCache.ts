/**
 * 提供给 transformers.js 的自定义文件缓存（`env.useCustomCache`）。
 * 默认的浏览器 Cache API 在打包后的 `file://` 页面不保证可用，而「首次下载后离线可用」
 * 是阶段②③ 的前提；IndexedDB 在 Electron 的 file:// 页面下可用。
 */
export interface KeyValueStore {
  get(key: string): Promise<ArrayBuffer | undefined>
  put(key: string, value: ArrayBuffer): Promise<void>
}

export interface ModelFileCache {
  match(request: string): Promise<Response | undefined>
  put(request: string, response: Response): Promise<void>
}

/** transformers.js 的 `env.customCache` 形态（match / put 语义同 Web Cache API）。 */
export function createModelFileCache(store: KeyValueStore): ModelFileCache {
  return {
    // 缓存故障必须退化成「未命中」而不是向上抛：transformers.js 下载后用
    // `await cache.match(cacheKey)` 二次确认是否已缓存，那一处没有 try/catch
    // （它的 tryCache 有），一次瞬时读取失败会让已下载好的模型直接加载失败。
    async match(request: string): Promise<Response | undefined> {
      let buffer: ArrayBuffer | undefined
      try {
        buffer = await store.get(request)
      } catch (error) {
        console.warn('模型文件缓存读取失败，按未命中处理', error)
        return undefined
      }
      if (!buffer) return undefined
      return new Response(buffer)
    },
    async put(request: string, response: Response): Promise<void> {
      try {
        await store.put(request, await response.arrayBuffer())
      } catch (error) {
        // 写缓存失败（配额 / 磁盘耗尽）只损失「本次没缓存」：本次推理照常继续，
        // 与 transformers.js 自身对 cache.put 失败的告警处理一致。
        console.warn('模型文件缓存写入失败，本次不缓存', error)
      }
    },
  }
}

/** IndexedDB 后端；库/表不存在时自动创建。 */
export function createIdbStore(dbName = 'papermind-model-cache', storeName = 'files'): KeyValueStore {
  let dbPromise: Promise<IDBDatabase> | undefined
  const open = (): Promise<IDBDatabase> => {
    if (!dbPromise) {
      const created = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(dbName, 1)
        request.onupgradeneeded = () => {
          const db = request.result
          if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName)
        }
        request.onsuccess = () => {
          const db = request.result
          // 连接被关闭（存储压力 / 另一个上下文升级版本）后丢弃句柄，下次调用重新打开
          db.onclose = () => {
            if (dbPromise === created) dbPromise = undefined
          }
          db.onversionchange = () => db.close()
          resolve(db)
        }
        request.onerror = () => reject(request.error ?? new Error('打开模型缓存失败'))
      })
      // 打开失败不留在缓存里：一次瞬时失败不该让这个 store 永久不可用
      created.catch(() => {
        if (dbPromise === created) dbPromise = undefined
      })
      dbPromise = created
    }
    return dbPromise
  }
  const run = <T>(mode: IDBTransactionMode, request: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
    open().then(db => new Promise<T>((resolve, reject) => {
      const tx = db.transaction(storeName, mode)
      const pending = request(tx.objectStore(storeName))
      let result: T | undefined
      let failure: DOMException | Error | null = null
      pending.onsuccess = () => { result = pending.result }
      // 请求级错误只用来取错误对象，成败判定统一交给事务（见下）
      pending.onerror = () => { failure = pending.error ?? new Error('模型缓存读写失败') }
      // 请求成功不代表落盘：配额 / 磁盘耗尽会让事务在提交阶段 abort，
      // 若在这里按请求成功就 resolve，模型会被当成「已缓存」，
      // 而缺失要到下一次离线启动才暴露。
      tx.oncomplete = () => resolve(result as T)
      tx.onabort = () => reject(failure ?? tx.error ?? new Error('模型缓存事务被中止'))
      tx.onerror = () => reject(failure ?? tx.error ?? new Error('模型缓存事务失败'))
    }))

  return {
    get: key => run<ArrayBuffer | undefined>('readonly', store => store.get(key) as IDBRequest<ArrayBuffer | undefined>),
    put: (key, value) => run<IDBValidKey>('readwrite', store => store.put(value, key)).then(() => undefined),
  }
}
