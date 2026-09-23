import { describe, expect, it } from 'vitest'
import { expandMatrix, validatePaperMind } from '../config'

const baseConfig = {
  name: 'papermind-hybrid',
  kind: 'papermind',
  passage: { embedder: { model: 'Xenova/bge-small-en-v1.5', revision: 'main', dtype: 'q8', dim: 384 } },
  matrix: {
    topK: [4], minScore: [6], maxContextChars: [24000],
    minTokens: [120], maxTokens: [350], maxInputChars: [120000],
    rrfK: [60], sectionWeight: [0, 0.5, 1], neighbourFactor: [0.5], skipLimit: [20],
  },
}

describe('validatePaperMind（段落混合配置）', () => {
  it('合法配置通过，matrix 展开为 sectionWeight 的三个取值', () => {
    const configs = expandMatrix(validatePaperMind(baseConfig, 'test'))
    expect(configs).toHaveLength(3)
    expect(configs.map(c => (c as { sectionWeight?: number }).sectionWeight)).toEqual([0, 0.5, 1])
    for (const config of configs) expect(config.passage?.embedder.model).toBe('Xenova/bge-small-en-v1.5')
  })

  it('缺任一旋钮直接报错（配置即口径，不能默默用产品默认值）', () => {
    const { rrfK, ...matrix } = baseConfig.matrix
    expect(() => validatePaperMind({ ...baseConfig, matrix }, 'test')).toThrow(/rrfK/)
  })

  it('旋钮取值越界报错', () => {
    expect(() => validatePaperMind({ ...baseConfig, matrix: { ...baseConfig.matrix, sectionWeight: [-1] } }, 'test')).toThrow(/sectionWeight/)
    expect(() => validatePaperMind({ ...baseConfig, matrix: { ...baseConfig.matrix, rrfK: [0] } }, 'test')).toThrow(/rrfK/)
    expect(() => validatePaperMind({ ...baseConfig, matrix: { ...baseConfig.matrix, minTokens: [400], maxTokens: [350] } }, 'test')).toThrow(/minTokens/)
  })

  it('embedder 必须显式 pin 模型 / revision / 量化 / 维度', () => {
    const passage = { embedder: { model: 'm', revision: 'main', dtype: 'q8' } }
    expect(() => validatePaperMind({ ...baseConfig, passage }, 'test')).toThrow(/dim/)
  })

  it('无 passage 块的配置照旧（default.json 不受影响）', () => {
    const configs = expandMatrix(validatePaperMind({ name: 'default', matrix: { topK: [4] } }, 'test'))
    expect(configs).toHaveLength(1)
    expect(configs[0].passage).toBeUndefined()
  })

  it('顶层键拼错（passag）直接报错：名字照旧会静默跑成平铺管道，标错口径比崩掉更糟', () => {
    const { passage, ...rest } = baseConfig
    expect(() => validatePaperMind({ ...rest, passag: passage }, 'test')).toThrow(/的 passag 不是/)
  })
})
