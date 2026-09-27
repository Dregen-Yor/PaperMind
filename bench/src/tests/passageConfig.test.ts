import { describe, expect, it } from 'vitest'
import { expandMatrix, loadConfigs, resolvePassageMode, validatePaperMind } from '../config'
import type { PaperMindConfig } from '../types'

/** 这些配置都是 PaperMind 形态；`loadConfigs` 返回联合类型，这里收窄以便读 mode/passage/旋钮。 */
async function loadPaperMind(name: string): Promise<PaperMindConfig[]> {
  return await loadConfigs(name) as PaperMindConfig[]
}

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

/**
 * A/B/C 三个零生成式臂（方案 §3.0）：`mode` 是顶层标量、与 `kind` 同级，
 * 缺席即 `legacy-llm`。lexical 不加载嵌入器，hybrid-raw / hybrid-outline 要求
 * 与 B 侧逐字相同的嵌入器身份——身份不同源就不是同一个 B/C 对照。
 */
describe('段落构建模式（结构实验 A/B/C）', () => {
  const KNOBS = {
    minTokens: [120], maxTokens: [350], maxInputChars: [120_000],
    rrfK: [60], sectionWeight: [0.5], neighbourFactor: [0.5], skipLimit: [20],
  }
  const EMBEDDER = { embedder: { model: 'Xenova/bge-small-en-v1.5', revision: 'main', dtype: 'q8', dim: 384 } }

  it('三个新配置各自校验通过并展开为单臂', async () => {
    await expect(loadConfigs('structure-lexical')).resolves.toHaveLength(1)
    await expect(loadConfigs('structure-hybrid-raw')).resolves.toHaveLength(1)
    await expect(loadConfigs('structure-hybrid-outline')).resolves.toHaveLength(1)
  })

  it('mode 原样穿过 expandMatrix；legacy 配置缺席 mode 解析为 legacy-llm', async () => {
    const [lexical] = await loadPaperMind('structure-lexical')
    const [raw] = await loadPaperMind('structure-hybrid-raw')
    const [outline] = await loadPaperMind('structure-hybrid-outline')
    expect(lexical.mode).toBe('lexical')
    expect(raw.mode).toBe('hybrid-raw')
    expect(outline.mode).toBe('hybrid-outline')

    const [legacy] = await loadPaperMind('papermind-hybrid')
    expect(legacy.mode).toBeUndefined()
    expect(resolvePassageMode(legacy)).toBe('legacy-llm')
    expect(resolvePassageMode(lexical)).toBe('lexical')
  })

  it('lexical 拒绝声明 passage.embedder（A 臂本就不加载嵌入器）', () => {
    expect(() => validatePaperMind(
      { name: 'x', kind: 'papermind', mode: 'lexical', passage: EMBEDDER, matrix: KNOBS }, 'test',
    )).toThrow(/lexical/)
  })

  it('hybrid-raw / hybrid-outline 要求完整 embedder', () => {
    expect(() => validatePaperMind(
      { name: 'x', kind: 'papermind', mode: 'hybrid-raw', matrix: KNOBS }, 'test',
    )).toThrow(/hybrid-raw/)
    expect(() => validatePaperMind(
      { name: 'x', kind: 'papermind', mode: 'hybrid-outline', matrix: KNOBS }, 'test',
    )).toThrow(/hybrid-outline/)
    // 声明了但字段不完整：仍必须在配置期被拒
    expect(() => validatePaperMind(
      { name: 'x', kind: 'papermind', mode: 'hybrid-raw', passage: { embedder: { model: 'm', revision: 'main' } }, matrix: KNOBS }, 'test',
    )).toThrow(/dim|dtype/)
  })

  it('未知 mode 直接报错，绝不静默当成 legacy-llm', () => {
    expect(() => validatePaperMind({ name: 'x', kind: 'papermind', mode: 'bogus', matrix: {} }, 'test')).toThrow(/bogus/)
  })

  it('B / C 的嵌入器身份逐字相同（同源是 B/C 对照成立的前提）', async () => {
    const [raw] = await loadPaperMind('structure-hybrid-raw')
    const [outline] = await loadPaperMind('structure-hybrid-outline')
    expect(JSON.stringify(raw.passage?.embedder)).toBe(JSON.stringify(outline.passage?.embedder))
    expect(raw.passage?.embedder.model).toBe('Xenova/bge-small-en-v1.5')
  })

  it('lexical 配置不带 passage 块，但旋钮齐全（切段口径与 B/C 一致）', async () => {
    const [lexical] = await loadPaperMind('structure-lexical')
    expect(lexical.passage).toBeUndefined()
    expect(lexical.minTokens).toBe(120)
    expect(lexical.maxTokens).toBe(350)
  })

  it('lexical（A 臂）的旋钮同样过范围校验：有旋钮、无 passage 块不是免检牌', () => {
    // 越界的 sectionWeight 与 maxTokens < minTokens 都必须在配置期被拒。
    // 旧实现把整段旋钮范围校验门控在 `if (!config.passage)`，lexical 因此只过类型、不过范围。
    expect(() => validatePaperMind(
      { name: 'x', kind: 'papermind', mode: 'lexical', matrix: { ...KNOBS, sectionWeight: [-0.5] } }, 'test',
    )).toThrow(/sectionWeight/)
    expect(() => validatePaperMind(
      { name: 'x', kind: 'papermind', mode: 'lexical', matrix: { ...KNOBS, minTokens: [400], maxTokens: [350] } }, 'test',
    )).toThrow(/minTokens/)
  })

  it('legacy 配置（无 mode）展开后仍不带 mode 字段', () => {
    const configs = expandMatrix(validatePaperMind(baseConfig, 'test'))
    expect(configs).toHaveLength(3)
    for (const config of configs) expect(config.mode).toBeUndefined()
  })
})
