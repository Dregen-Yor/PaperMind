/**
 * 词法分词（自 `bench/src/traditionalRag/lexicalTokenizer.ts` 移入）：产品与传统 RAG
 * 基线必须共用同一份分词口径，否则 BM25 的分数不可比。
 *
 * 分词口径是 BM25 数值的一部分：locale 与 NFKC 归一化都不得改动，否则 bench 里
 * 已记录的分数会被静默重标定。
 */
let segmenter: Intl.Segmenter | undefined

/** 词法 token 化：`Intl.Segmenter` 切词 + 只保留词元 + NFKC 归一化 + 小写化。 */
export function lexicalTokenize(text: string): string[] {
  if (typeof Intl.Segmenter !== 'function') throw new Error('当前环境不支持 Intl.Segmenter，词法检索无法运行')
  segmenter ??= new Intl.Segmenter('und', { granularity: 'word' })
  return [...segmenter.segment(text)].filter(x => x.isWordLike).map(x => x.segment.normalize('NFKC').toLocaleLowerCase('und'))
}
