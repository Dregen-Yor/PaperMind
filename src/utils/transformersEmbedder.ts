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
 */
export function vectorsFromOutput(output: FeatureExtractionOutput, batchLength: number): Float32Array[] {
  const width = output.dims.at(-1) ?? 0
  if (width <= 0 || output.data.length !== batchLength * width) throw new Error('向量输出维度异常')
  if (width !== BGE_SMALL_DIM) throw new Error(`向量维度 ${width} 与约定 ${BGE_SMALL_DIM} 不一致`)
  const vectors: Float32Array[] = []
  for (let i = 0; i < batchLength; i++) vectors.push(output.data.slice(i * width, (i + 1) * width))
  return vectors
}

export interface TransformersEmbedderOptions {
  model?: string
  revision?: string
  dtype?: string
  /** onnxruntime-web 的 wasm 资源目录；产品传 './ort/'，bench 走 node 后端时不传 */
  wasmPaths?: string
  /** 模型文件缓存；缺省用 IndexedDB */
  cache?: ModelFileCache
}

export async function createTransformersEmbedder(options: TransformersEmbedderOptions = {}): Promise<Embedder> {
  const model = options.model ?? BGE_SMALL_MODEL
  const revision = options.revision ?? BGE_SMALL_REVISION
  const dtype = options.dtype ?? BGE_SMALL_DTYPE

  const transformers = await import('@huggingface/transformers')
  const env = transformers.env as unknown as Record<string, unknown>
  env.useCustomCache = true
  env.customCache = options.cache ?? createModelFileCache(createIdbStore())

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
      vectors.push(...vectorsFromOutput(output, batch.length))
    }
    return vectors
  }
  return createEmbedder({ id: embedderId(model, revision, dtype), embed })
}
