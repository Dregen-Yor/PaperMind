/**
 * BM25 打分（自 `bench/src/traditionalRag/bm25.ts` 移入）。参数固定 k1=1.2 / b=0.75
 * （方案 §4.2），因此不暴露到配置之外。
 */
import { lexicalTokenize } from './lexicalTokenizer'

export interface ScoredDoc {
  /** 传入文本数组时的下标，调用方据此回填候选 */
  id: number
  score: number
}

export interface Bm25Options {
  k1?: number
  b?: number
}

/**
 * 返回一个查询函数：对给定 query 给**全部文档**打分（不做截断，
 * 名次由融合层决定）。统计量现算不落盘（方案 §4.2）。
 */
export function buildBm25Scorer(texts: string[], options: Bm25Options = {}): (query: string) => ScoredDoc[] {
  const k1 = options.k1 ?? 1.2
  const b = options.b ?? 0.75
  const docs = texts.map(text => lexicalTokenize(text))
  const lengths = docs.map(doc => doc.length)
  const docCount = docs.length
  const avgdl = docCount > 0 ? lengths.reduce((sum, length) => sum + length, 0) / docCount : 0
  const termFreqs = docs.map(doc => {
    const frequencies = new Map<string, number>()
    for (const token of doc) frequencies.set(token, (frequencies.get(token) ?? 0) + 1)
    return frequencies
  })
  const docFreqs = new Map<string, number>()
  for (const frequencies of termFreqs) {
    for (const token of frequencies.keys()) docFreqs.set(token, (docFreqs.get(token) ?? 0) + 1)
  }

  return (query: string): ScoredDoc[] => {
    const terms = lexicalTokenize(query)
    return texts.map((_, index) => {
      let score = 0
      for (const term of terms) {
        const tf = termFreqs[index].get(term) ?? 0
        if (tf === 0 || avgdl === 0) continue
        const n = docFreqs.get(term) ?? 0
        const idf = Math.log(1 + (docCount - n + 0.5) / (n + 0.5))
        score += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * lengths[index]) / avgdl))
      }
      return { id: index, score: Number.isFinite(score) ? score : 0 }
    })
  }
}
