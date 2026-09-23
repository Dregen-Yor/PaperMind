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
    async match(request: string): Promise<Response | undefined> {
      const buffer = await store.get(request)
      if (!buffer) return undefined
      return new Response(buffer)
    },
    async put(request: string, response: Response): Promise<void> {
      await store.put(request, await response.arrayBuffer())
    },
  }
}

/** IndexedDB 后端；库/表不存在时自动创建。 */
export function createIdbStore(dbName = 'papermind-model-cache', storeName = 'files'): KeyValueStore {
  let dbPromise: Promise<IDBDatabase> | undefined
  const open = (): Promise<IDBDatabase> => {
    dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(dbName, 1)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName)
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('打开模型缓存失败'))
    })
    return dbPromise
  }
  const run = <T>(mode: IDBTransactionMode, request: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
    open().then(db => new Promise<T>((resolve, reject) => {
      const tx = db.transaction(storeName, mode)
      const pending = request(tx.objectStore(storeName))
      pending.onsuccess = () => resolve(pending.result)
      pending.onerror = () => reject(pending.error ?? new Error('模型缓存读写失败'))
    }))

  return {
    get: key => run<ArrayBuffer | undefined>('readonly', store => store.get(key) as IDBRequest<ArrayBuffer | undefined>),
    put: (key, value) => run<IDBValidKey>('readwrite', store => store.put(value, key)).then(() => undefined),
  }
}
