import { describe, expect, it, vi } from 'vitest'
import {
  QUERY_INSTRUCTION, cosineSimilarity, createEmbedder, decodeVectors, embedderId, encodeVectors,
} from '../utils/embedder'
import { cardEmbedText } from '../utils/embedder'

describe('createEmbedder', () => {
  it('查询侧加 bge 指令前缀，段落侧不加', async () => {
    const embed = vi.fn(async (texts: string[]) => texts.map(() => new Float32Array([1, 0])))
    const embedder = createEmbedder({ id: 'fake', embed })
    await embedder.embedQuery('what datasets?')
    expect(embed).toHaveBeenCalledWith([`${QUERY_INSTRUCTION}what datasets?`])
    await embedder.embedPassages(['raw passage'])
    expect(embed).toHaveBeenLastCalledWith(['raw passage'])
  })

  it('空段落数组不发请求', async () => {
    const embed = vi.fn(async (texts: string[]) => texts.map(() => new Float32Array([1])))
    const embedder = createEmbedder({ id: 'fake', embed })
    expect(await embedder.embedPassages([])).toEqual([])
    expect(embed).not.toHaveBeenCalled()
  })

  it('模型返回空结果时查询向量视为缺失', async () => {
    const embedder = createEmbedder({ id: 'fake', embed: async () => [] })
    await expect(embedder.embedQuery('x')).rejects.toThrow()
  })
})

describe('embedderId', () => {
  it('包含模型 / revision / 量化，任一变化即换身份', () => {
    expect(embedderId('Xenova/bge-small-en-v1.5', 'main', 'q8')).toBe('Xenova/bge-small-en-v1.5@main#q8')
    expect(embedderId('Xenova/bge-small-en-v1.5', 'main', 'fp32')).not.toBe(embedderId('Xenova/bge-small-en-v1.5', 'main', 'q8'))
  })
})

describe('cosineSimilarity', () => {
  it('同向为 1、正交为 0、反向为 -1', () => {
    expect(cosineSimilarity(new Float32Array([1, 1]), new Float32Array([2, 2]))).toBeCloseTo(1)
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBeCloseTo(0)
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([-1, 0]))).toBeCloseTo(-1)
  })

  it('零向量得 0 而不 NaN', () => {
    expect(cosineSimilarity(new Float32Array([0, 0]), new Float32Array([1, 1]))).toBe(0)
  })

  it('维度不一致直接抛错', () => {
    expect(() => cosineSimilarity(new Float32Array([1]), new Float32Array([1, 2]))).toThrow()
  })
})

describe('向量编解码', () => {
  it('encode → decode 逐值还原', () => {
    const vectors = [new Float32Array([1, -0.5, 0.25]), new Float32Array([0, 0, 0])]
    const decoded = decodeVectors(encodeVectors(vectors), 3)
    expect(decoded).toHaveLength(2)
    expect([...decoded![1]]).toEqual([0, 0, 0])
    expect(decoded![0][1]).toBeCloseTo(-0.5)
  })

  it('长度与维度不符时解析失败', () => {
    expect(decodeVectors(encodeVectors([new Float32Array([1, 2])]), 3)).toBeUndefined()
  })
})

describe('cardEmbedText', () => {
  it('拼接标题、摘要与 keyTerms', () => {
    expect(cardEmbedText({ title: 'Datasets', summary: 'Europarl.', keyTerms: ['data', 'corpora'] }))
      .toBe('Datasets. Europarl. Key terms: data, corpora')
  })
})
