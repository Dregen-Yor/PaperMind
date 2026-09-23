/**
 * 真实向量模型：`Xenova/bge-small-en-v1.5`（int8 量化，384 维）。
 *
 * 与 bench 共用同一份权重与接口：渲染层由 Vite 解析到 web 构建（WASM），
 * bench 在 Node 下解析到 node 构建（onnxruntime-node）。
 * 动态 import 让 jsdom 单测永远不加载这个模块。
 */
import type { DataType } from '@huggingface/transformers'
import {
  BGE_SMALL_DIM, BGE_SMALL_DTYPE, BGE_SMALL_MODEL, BGE_SMALL_REVISION,
  createEmbedder, embedderId, type Embedder,
} from './embedder'
import { createIdbStore, createModelFileCache, type ModelFileCache } from './modelCache'

/** 单批前向传播的文本数：WASM 下单批过大会陡增内存占用。 */
export const EMBED_BATCH_SIZE = 16

/** 按批切分文本（尾批是余数）；空输入不产生批次。 */
export function batchTexts(texts: string[], batchSize = EMBED_BATCH_SIZE): string[][] {
  const batches: string[][] = []
  for (let start = 0; start < texts.length; start += batchSize) {
    batches.push(texts.slice(start, start + batchSize))
  }
  return batches
}

/** `pipeline('feature-extraction')` 的输出：行优先展平的 `data` + `dims`。 */
export interface FeatureExtractionOutput {
  data: Float32Array
  dims: number[]
}

/**
 * 批输出 → 与批内文本一一对应的向量。
 * 宽度或元素个数不符时抛错：宁可整体失败，也不能把某一行的向量配给另一行文本。
 *
 * 期望宽度由调用方按**本次要用的模型**给出（缺省仍是产品 bge-small 的 384）：
 * 断言写死 384 时，配置 pin 了非默认模型（如 bge-m3 1024）会在第一趟前向传播就抛错，
 * 而配置里的 `dim` 又没有任何执行路径去读它——两侧各说各话，谁都拦不住这种错配。
 */
export function vectorsFromOutput(
  output: FeatureExtractionOutput,
  batchLength: number,
  expectedDim: number = BGE_SMALL_DIM,
): Float32Array[] {
  const width = output.dims.at(-1) ?? 0
  if (width <= 0 || output.data.length !== batchLength * width) throw new Error('向量输出维度异常')
  if (width !== expectedDim) throw new Error(`向量维度 ${width} 与约定 ${expectedDim} 不一致`)
  const vectors: Float32Array[] = []
  for (let i = 0; i < batchLength; i++) vectors.push(output.data.slice(i * width, (i + 1) * width))
  return vectors
}

export interface TransformersEmbedderOptions {
  model?: string
  revision?: string
  dtype?: string
  /**
   * 期望的向量宽度；缺省 384（产品 bge-small）。非 384 维模型必须由调用方
   * 按配置 pin 显式给出（bench 的 m3 消融传 `passage.embedder.dim`），
   * 输出宽度与它不符即抛错，pin 才真的是一道断言而不是一行说明。
   */
  dim?: number
  /** onnxruntime-web 的 wasm 资源目录；产品传 './ort/'，bench 走 node 后端时不传 */
  wasmPaths?: string
  /** 模型文件缓存；缺省用 IndexedDB */
  cache?: ModelFileCache
  /**
   * 权重落盘目录（bench/Node）：给出时改用 transformers.js **自带的文件系统缓存**，
   * 且不启用 `useCustomCache`。浏览器（产品）路径不传，行为保持 IndexedDB 自定义缓存不变。
   */
  cacheDir?: string
}

/** 缓存模式：要写进 transformers `env` 的字段（决策与库加载解耦，纯函数可单测）。 */
export interface EmbedderCacheEnv {
  useCustomCache: boolean
  cacheDir?: string
  customCache?: ModelFileCache
}

/**
 * 缓存决策（纯函数，不加载 transformers）：
 * - 给出 `cacheDir`：用库自带的文件系统缓存，**必须**同时关掉 `useCustomCache`——
 *   后者会让库读写权重时完全绕开 `env.cacheDir`（Node 下没有 indexedDB，
 *   自定义后端只会静默全部未命中，于是每次运行都重新下载、离线直接不可用）。
 * - 未给出：维持产品的自定义缓存（`cache` 优先，缺省 IndexedDB），逐字不变。
 */
export function resolveEmbedderCacheEnv(
  options: Pick<TransformersEmbedderOptions, 'cache' | 'cacheDir'> = {},
): EmbedderCacheEnv {
  if (options.cacheDir !== undefined) return { useCustomCache: false, cacheDir: options.cacheDir }
  return { useCustomCache: true, customCache: options.cache ?? createModelFileCache(createIdbStore()) }
}

/** 期望维度：缺省 384；显式给出时必须为正整数（0 / 小数会让每次断言都报「维度不一致」）。 */
export function resolveEmbedderDim(dim?: number): number {
  const resolved = dim ?? BGE_SMALL_DIM
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new Error(`向量维度约定必须为正整数，得到 ${dim}`)
  }
  return resolved
}

export async function createTransformersEmbedder(options: TransformersEmbedderOptions = {}): Promise<Embedder> {
  const model = options.model ?? BGE_SMALL_MODEL
  const revision = options.revision ?? BGE_SMALL_REVISION
  const dtype = options.dtype ?? BGE_SMALL_DTYPE
  const dim = resolveEmbedderDim(options.dim)

  const transformers = await import('@huggingface/transformers')
  const env = transformers.env as unknown as Record<string, unknown>
  Object.assign(env, resolveEmbedderCacheEnv(options))

  const wasm = (env.backends as { onnx?: { wasm?: { wasmPaths?: string; numThreads?: number; proxy?: boolean } } } | undefined)?.onnx?.wasm
  if (wasm && options.wasmPaths) {
    // 资源随包发布在 ./ort/（vite.config.ts 启动时拷贝）：打包后是 file:// 页面，不能走 CDN
    wasm.wasmPaths = options.wasmPaths
    // 多线程 wasm 需要 SharedArrayBuffer，而页面没有 crossOriginIsolated；强制单线程
    wasm.numThreads = 1
  }

  const extractor = await transformers.pipeline('feature-extraction', model, { revision, dtype: dtype as DataType })
  const embed = async (texts: string[]): Promise<Float32Array[]> => {
    const vectors: Float32Array[] = []
    for (const batch of batchTexts(texts)) {
      const output = await extractor(batch, { pooling: 'cls', normalize: true }) as unknown as FeatureExtractionOutput
      vectors.push(...vectorsFromOutput(output, batch.length, dim))
    }
    return vectors
  }
  return createEmbedder({ id: embedderId(model, revision, dtype), embed })
}
