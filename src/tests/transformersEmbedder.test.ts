// 只测纯函数：真实模型藏在动态 import 之后，这个文件不加载它、不联网。
import { describe, expect, it } from 'vitest'
import { BGE_SMALL_DIM } from '../utils/embedder'
import { EMBED_BATCH_SIZE, batchTexts, vectorsFromOutput } from '../utils/transformersEmbedder'

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
})
