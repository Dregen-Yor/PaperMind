import type { EmbeddingProvider, TextTokenizer } from './types'
import { applyHfEndpoint } from '../hub'

export function normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, n) => sum + n * n, 0))
  if (!Number.isFinite(norm) || norm === 0) throw new Error('embedding 向量范数为 0 或非有限数')
  return vector.map(n => n / norm)
}

/** 词表模型的最小形状；两个工厂都只需要 tokenize。 */
interface RawBgeM3Tokenizer {
  tokenize(text: string): string[]
}

/**
 * 词表级缓存：同一 model/revision 只向 hub（或本地缓存）加载一次词表。
 *
 * 一次跑批里同一次元会被反复索取——CLI 的受控物化器、分块、锚点检索、embedding pipeline
 * 各自都要 BGE-M3 tokenizer。重复加载既是无谓的 I/O，也让「本次运行到底用的是哪一份
 * tokenizer」难以自证（§5 要求 tokenizer 身份可追溯）。键只取 model+revision：
 * `cacheDir` 决定落盘位置、不改变词表内容，且所有调用点传的是同一个 bench 缓存目录，
 * 把它写进键只会让同一份词表因为路径写法不同而各自加载。
 * 代价要说清楚：本缓存按 model+revision 全局共享，若将来有调用点传**别的** `cacheDir`，
 * 它拿到的会是先到者那份目录里解析出来的实例（`transformers.env.cacheDir` 本身也是进程级
 * 全局可变状态），不会按自己的目录重新解析。
 *
 * 缓存的是 Promise：并发调用共享同一次加载，而不是各自打一次 hub。
 * 注意去重的只是**本工厂返回的** tokenizer：`pipeline()` 内部会自行构造一份自己的
 * tokenizer，不经此缓存，也不与这里的实例共享词表。
 */
const rawTokenizerCache = new Map<string, Promise<RawBgeM3Tokenizer>>()

async function loadRawBgeM3Tokenizer(model: string, revision: string, cacheDir?: string): Promise<RawBgeM3Tokenizer> {
  const key = `${model}\0${revision}`
  const cached = rawTokenizerCache.get(key)
  if (cached) return cached
  const pending = (async () => {
    const transformers = await import('@huggingface/transformers')
    applyHfEndpoint(transformers)
    if (cacheDir) (transformers.env as { cacheDir?: string }).cacheDir = cacheDir
    return await transformers.AutoTokenizer.from_pretrained(model, { revision }) as unknown as RawBgeM3Tokenizer
  })()
  // 失败的加载不得永久钉进缓存：首次失败通常是网络/端点问题，删键让下一次调用可重试；
  // 不删的话整个跑批会一直复用这个 rejected promise，把一次瞬时故障放大成整轮不可用
  pending.catch(() => rawTokenizerCache.delete(key))
  rawTokenizerCache.set(key, pending)
  return pending
}

export async function createBgeM3Tokenizer(options: { model: string; revision: string; cacheDir?: string }): Promise<TextTokenizer> {
  const tokenizer = await loadRawBgeM3Tokenizer(options.model, options.revision, options.cacheDir)
  return { tokenize: (text) => tokenizer.tokenize(text) }
}

/** 仅本文件接触 Transformers；动态导入避免非 cosine benchmark 加载大模型运行时。 */
export async function createBgeM3Provider(options: { model: string; revision: string; maxLength: number; cacheDir?: string }): Promise<{ provider: EmbeddingProvider; tokenizer: TextTokenizer }> {
  const transformers = await import('@huggingface/transformers')
  applyHfEndpoint(transformers)
  const env = transformers.env as { cacheDir?: string }
  if (options.cacheDir) env.cacheDir = options.cacheDir
  // 这里返回给调用方的 tokenizer 复用 createBgeM3Tokenizer 的那份缓存（同一次元不加载两遍）；
  // 但下面 pipeline() 自己另建一份内部 tokenizer，两者并不共享词表
  const tokenizer = await loadRawBgeM3Tokenizer(options.model, options.revision, options.cacheDir)
  const extractor = await transformers.pipeline('feature-extraction', options.model, { revision: options.revision })
  ;(extractor as unknown as { tokenizer: { model_max_length: number } }).tokenizer.model_max_length = options.maxLength
  return {
    tokenizer: { tokenize: (text) => tokenizer.tokenize(text) },
    provider: { async embed(texts) {
      if (!texts.length) return []
      // 一个 batch 一次前向传播；maxLength 必须真正传给 tokenizer/pipeline。
      const vectors: number[][] = []
      for (let start = 0; start < texts.length; start += 32) {
        const batch = texts.slice(start, start + 32)
        const output = await extractor(batch, { pooling: 'cls', normalize: false }) as unknown as { data: Float32Array | number[]; dims: number[] }
        const width = output.dims.at(-1)
        if (!width || output.data.length !== batch.length * width) throw new Error('embedding batch 输出维度异常')
        const data = Array.from(output.data)
        vectors.push(...batch.map((_, i) => data.slice(i * width, (i + 1) * width)))
      }
      return vectors
    } },
  }
}
