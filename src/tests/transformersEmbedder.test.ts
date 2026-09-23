// 真实模型藏在动态 import 之后：这个文件不加载它、不联网。
// 纯函数（批切分 / 输出切分 / 缓存与维度决策）直接测；
// createTransformersEmbedder 的接线用 mock 掉 '@huggingface/transformers' 的方式测，
// 因此「决策有没有真的写进 env、维度有没有真的传给断言」不必下载权重也能验。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BGE_SMALL_DIM, BGE_SMALL_DTYPE, BGE_SMALL_MODEL, BGE_SMALL_REVISION } from '../utils/embedder'

const { pipelineMock, envMock } = vi.hoisted(() => ({
  pipelineMock: vi.fn(),
  envMock: {} as Record<string, unknown>,
}))
vi.mock('@huggingface/transformers', () => ({ env: envMock, pipeline: pipelineMock }))

const {
  EMBED_BATCH_SIZE, batchTexts, vectorsFromOutput,
  resolveEmbedderCacheEnv, resolveEmbedderDim, createTransformersEmbedder,
} = await import('../utils/transformersEmbedder')

/** 元素值 = 它在批输出里的全局下标，错位（把某行当成另一行）会直接读出来。 */
function outputOf(rows: number, width = BGE_SMALL_DIM) {
  const data = Float32Array.from({ length: rows * width }, (_, index) => index)
  return { data, dims: [rows, width] }
}

/** 每个向量的 [长度, 首元素, 末元素]：能同时看出切分宽度与行顺序。 */
const shape = (vectors: Float32Array[]) => vectors.map(vector => [vector.length, vector[0], vector.at(-1)])

describe('batchTexts', () => {
  it('按 EMBED_BATCH_SIZE 切分，尾批为余数且不丢文本', () => {
    const texts = Array.from({ length: EMBED_BATCH_SIZE * 2 + 3 }, (_, index) => `t${index}`)
    const batches = batchTexts(texts)
    expect(batches.map(batch => batch.length)).toEqual([EMBED_BATCH_SIZE, EMBED_BATCH_SIZE, 3])
    expect(batches.flat()).toEqual(texts)
  })

  it('空输入不产生批次', () => {
    expect(batchTexts([])).toEqual([])
  })
})

describe('vectorsFromOutput', () => {
  it('整批：按宽度切分，向量顺序与批内文本一致', () => {
    expect(shape(vectorsFromOutput(outputOf(EMBED_BATCH_SIZE), EMBED_BATCH_SIZE))).toEqual(
      Array.from({ length: EMBED_BATCH_SIZE }, (_, row) => [
        BGE_SMALL_DIM,
        row * BGE_SMALL_DIM,
        (row + 1) * BGE_SMALL_DIM - 1,
      ]),
    )
  })

  it('短尾批：只按实际批长切分', () => {
    const vectors = vectorsFromOutput(outputOf(3), 3)
    expect(shape(vectors)).toEqual([
      [BGE_SMALL_DIM, 0, BGE_SMALL_DIM - 1],
      [BGE_SMALL_DIM, BGE_SMALL_DIM, 2 * BGE_SMALL_DIM - 1],
      [BGE_SMALL_DIM, 2 * BGE_SMALL_DIM, 3 * BGE_SMALL_DIM - 1],
    ])
  })

  it('宽度不是约定维度时抛错', () => {
    expect(() => vectorsFromOutput(outputOf(2, 128), 2)).toThrow(/384/)
  })

  it('元素个数与批长不符时抛错', () => {
    const data = Float32Array.from({ length: 5 }, (_, index) => index)
    expect(() => vectorsFromOutput({ data, dims: [4, BGE_SMALL_DIM] }, 4)).toThrow()
    expect(() => vectorsFromOutput({ data, dims: [] }, 4)).toThrow()
  })

  it('显式约定维度：非 384 的模型输出按自己的宽度切分（R44）', () => {
    // 断言写死 384 时这一行抛错，非默认模型的消融永远走不出稠密结果
    expect(shape(vectorsFromOutput(outputOf(2, 1024), 2, 1024))).toEqual([
      [1024, 0, 1023],
      [1024, 1024, 2047],
    ])
  })

  it('缺省约定维度仍是 384：1024 输出照旧被挡下', () => {
    expect(() => vectorsFromOutput(outputOf(2, 1024), 2)).toThrow(/384/)
    expect(() => vectorsFromOutput(outputOf(2, 1024), 2, BGE_SMALL_DIM)).toThrow(/384/)
  })

  it('断言对象是配置的约定值而不是模型实际宽度', () => {
    // 384 模型配 1024 约定：同样是「约定与输出不符」，报出的必须是约定的那个数
    expect(() => vectorsFromOutput(outputOf(1, 384), 1, 1024)).toThrow(/1024/)
  })
})

describe('resolveEmbedderCacheEnv', () => {
  it('缺省：自定义缓存（IndexedDB 后端），不设 cacheDir——产品行为不变', () => {
    const plan = resolveEmbedderCacheEnv()
    expect(plan.useCustomCache).toBe(true)
    expect(plan.cacheDir).toBeUndefined()
    expect(typeof plan.customCache?.match).toBe('function')
    expect(typeof plan.customCache?.put).toBe('function')
  })

  it('显式传入 cache 时用它作后端', () => {
    const cache = { match: vi.fn(), put: vi.fn() }
    expect(resolveEmbedderCacheEnv({ cache })).toStrictEqual({ useCustomCache: true, customCache: cache })
  })

  it('给出 cacheDir 时改用库自带文件系统缓存，且不启用自定义缓存（R43）', () => {
    // 两者必须互斥：useCustomCache 会让 transformers.js 完全绕开 env.cacheDir
    const plan = resolveEmbedderCacheEnv({ cacheDir: '/tmp/bench-models', cache: { match: vi.fn(), put: vi.fn() } })
    expect(plan).toStrictEqual({ useCustomCache: false, cacheDir: '/tmp/bench-models' })
  })
})

describe('resolveEmbedderDim', () => {
  it('缺省为产品默认 384', () => {
    expect(resolveEmbedderDim()).toBe(BGE_SMALL_DIM)
  })

  it('显式维度按配置 pin 透传', () => {
    expect(resolveEmbedderDim(1024)).toBe(1024)
  })

  it('非法维度立即抛错（0 / 小数不可能对得上任何模型输出）', () => {
    expect(() => resolveEmbedderDim(0)).toThrow(/正整数/)
    expect(() => resolveEmbedderDim(1.5)).toThrow(/正整数/)
  })
})

describe('createTransformersEmbedder 的环境接线（mock 掉 transformers，不加载真库）', () => {
  /** 假 extractor：宽度由参数决定，行数跟随当批文本数。 */
  const extractorOf = (width: number) => vi.fn(async (texts: string[]) => outputOf(texts.length, width))

  beforeEach(() => {
    delete envMock.useCustomCache
    delete envMock.cacheDir
    delete envMock.customCache
    pipelineMock.mockReset()
  })

  it('cacheDir：写进 env.cacheDir 且关掉自定义缓存', async () => {
    // 模拟同进程里更早的调用已把 useCustomCache 置 true（产品/上一次 embedder 的残留）
    envMock.useCustomCache = true
    envMock.customCache = { match: vi.fn(), put: vi.fn() }
    pipelineMock.mockResolvedValue(extractorOf(BGE_SMALL_DIM))
    await createTransformersEmbedder({ cacheDir: '/tmp/bench-model-cache' })
    expect(envMock.cacheDir).toBe('/tmp/bench-model-cache')
    expect(envMock.useCustomCache).toBe(false)
    expect(pipelineMock).toHaveBeenCalledWith('feature-extraction', BGE_SMALL_MODEL, { revision: BGE_SMALL_REVISION, dtype: BGE_SMALL_DTYPE })
  })

  it('缺省：写回 IndexedDB 自定义缓存，不设 cacheDir', async () => {
    pipelineMock.mockResolvedValue(extractorOf(BGE_SMALL_DIM))
    await createTransformersEmbedder()
    expect(envMock.useCustomCache).toBe(true)
    expect(envMock.cacheDir).toBeUndefined()
    expect(typeof (envMock.customCache as { match?: unknown })?.match).toBe('function')
  })

  it('dim：非默认模型的输出按配置宽度切分，模型 pin 原样传给 pipeline（R44）', async () => {
    pipelineMock.mockResolvedValue(extractorOf(1024))
    const embedder = await createTransformersEmbedder({ model: 'BAAI/bge-m3', dim: 1024 })
    const vectors = await embedder.embedPassages(['a', 'b'])
    expect(vectors.map(vector => vector.length)).toEqual([1024, 1024])
    expect(pipelineMock).toHaveBeenCalledWith('feature-extraction', 'BAAI/bge-m3', { revision: BGE_SMALL_REVISION, dtype: BGE_SMALL_DTYPE })
  })

  it('dim 缺省仍是 384：同一次 1024 输出照旧抛错', async () => {
    pipelineMock.mockResolvedValue(extractorOf(1024))
    const embedder = await createTransformersEmbedder()
    await expect(embedder.embedPassages(['a', 'b'])).rejects.toThrow(/384/)
  })
})
