import { extractPdfDocument } from '../pdfDocument'
import type { Embedder } from '../embedder'
import { buildEk5Index, parseEk5Index, type Ek5Index } from './index'

/** Per-store cache. Records are replaced atomically only after a complete build. */
export function createEk5Store(getEmbedder: () => Promise<Embedder | undefined>) {
  const pending = new Map<string, Promise<{ index: Ek5Index; pages: string[] }>>()
  const cache = new Map<string, { raw: string; pagesJson: string; index: Ek5Index; pages: string[] }>()
  async function load(paperId: string, force = false): Promise<{ index: Ek5Index; pages: string[] }> {
    const existing = pending.get(paperId)
    if (existing) {
      if (!force) return existing
      // A user-requested rebuild must not be satisfied by an older in-flight load.
      await existing.catch(() => {})
      return load(paperId, true)
    }
    const job = (async () => {
      const embedder = await getEmbedder()
      if (!embedder) throw new Error('本地检索模型尚未加载成功。请联网后重试，首次使用需要下载模型。')
      const stored = await window.db.index.get(paperId)
      if (!force && stored) {
        const cached = cache.get(paperId)
        if (cached?.raw === stored.indexJson && cached.pagesJson === stored.pagesJson && cached.index.embedderId === embedder.id) return { index: cached.index, pages: cached.pages }
        try {
          const pages = JSON.parse(stored.pagesJson) as string[]
          const index = parseEk5Index(stored.indexJson, pages, embedder.id)
          if (index && index.paperId === paperId) {
            remember(paperId, stored.indexJson, stored.pagesJson, index, pages)
            return { index, pages }
          }
        } catch { /* Rebuild legacy or damaged records from the PDF. */ }
      }
      const base64 = await window.db.paper.readFile(paperId)
      if (!base64) throw new Error('论文文件缺失，请重新导入 PDF。')
      const doc = await extractPdfDocument(base64)
      const index = await buildEk5Index(paperId, doc, embedder)
      const raw = JSON.stringify(index), pagesJson = JSON.stringify(doc.pages)
      await window.db.index.set(paperId, raw, pagesJson)
      remember(paperId, raw, pagesJson, index, doc.pages)
      return { index, pages: doc.pages }
    })()
    pending.set(paperId, job)
    try { return await job } finally { pending.delete(paperId) }
  }
  function remember(id: string, raw: string, pagesJson: string, index: Ek5Index, pages: string[]) {
    cache.delete(id)
    cache.set(id, { raw, pagesJson, index, pages })
    if (cache.size > 8) cache.delete(cache.keys().next().value!)
  }
  return { load }
}
