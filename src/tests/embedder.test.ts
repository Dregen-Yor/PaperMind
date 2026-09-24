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

  // 落盘格式一旦改变，已写入的索引就全读不出来了：用字面量把字节序与拼接顺序钉死。
  it('落盘字节固定为小端 float32 按向量顺序拼接', () => {
    expect(encodeVectors([new Float32Array([1, -0.5])])).toBe('AACAPwAAAL8=')
    expect(encodeVectors([new Float32Array([1, -0.5]), new Float32Array([0.25, 2])]))
      .toBe('AACAPwAAAL8AAIA+AAAAQA==')
    expect([...decodeVectors('AACAPwAAAL8AAIA+AAAAQA==', 2)![1]]).toEqual([0.25, 2])
  })

  it('空向量集编码为空串，并解码回空集', () => {
    expect(encodeVectors([])).toBe('')
    expect(decodeVectors('', 3)).toEqual([])
  })

  it('subarray 视图（byteOffset 非 0）只编码视图内的值', () => {
    const view = new Float32Array([9, 9, 1, -0.5, 9]).subarray(2, 4)
    expect(view.byteOffset).not.toBe(0)
    expect(encodeVectors([view])).toBe('AACAPwAAAL8=')
  })

  it('解码结果是独立副本：改写一个向量不影响别的向量，也不影响再次解码', () => {
    const payload = encodeVectors([new Float32Array([1, 2]), new Float32Array([3, 4])])
    const decoded = decodeVectors(payload, 2)!
    // 每个向量独占自己的 buffer（而非共享一整块被解码的内存）
    expect(decoded.map(vector => vector.buffer.byteLength)).toEqual([8, 8])
    decoded[0][0] = 99
    expect([...decoded[1]]).toEqual([3, 4])
    expect([...decodeVectors(payload, 2)![0]]).toEqual([1, 2])
  })

  it('长度与维度不符时解析失败', () => {
    expect(decodeVectors(encodeVectors([new Float32Array([1, 2])]), 3)).toBeUndefined()
  })

  it('非法 base64 解析失败', () => {
    expect(decodeVectors('not base64!!', 3)).toBeUndefined()
  })

  // 落盘格式没有每行长度：不等长的向量会被静默补零 / 覆盖，必须在编码前拦下。
  it('向量长度不一致时拒绝编码', () => {
    expect(() => encodeVectors([new Float32Array([1, 2]), new Float32Array([3])])).toThrow()
    expect(() => encodeVectors([new Float32Array([1, 2]), new Float32Array([3, 4, 5]), new Float32Array([6, 7])])).toThrow()
  })
})

describe('cardEmbedText', () => {
  it('拼接标题、摘要与 keyTerms', () => {
    expect(cardEmbedText({ title: 'Datasets', summary: 'Europarl.', keyTerms: ['data', 'corpora'] }))
      .toBe('Datasets. Europarl. Key terms: data, corpora')
  })
})

describe('defaultQueryInstruction', () => {
  it('bge v1.5 英文系列带检索指令，bge-m3 不带', async () => {
    const { defaultQueryInstruction, QUERY_INSTRUCTION } = await import('../utils/embedder')
    expect(defaultQueryInstruction('Xenova/bge-small-en-v1.5')).toBe(QUERY_INSTRUCTION)
    expect(defaultQueryInstruction('Xenova/bge-m3')).toBe('')
  })

  it('createEmbedder 按 queryInstruction 拼查询', async () => {
    const { createEmbedder } = await import('../utils/embedder')
    const seen: string[] = []
    const embedder = createEmbedder({ id: 'x', queryInstruction: '', embed: async texts => { seen.push(...texts); return [new Float32Array(1)] } })
    await embedder.embedQuery('q')
    expect(seen).toEqual(['q'])
  })
})
