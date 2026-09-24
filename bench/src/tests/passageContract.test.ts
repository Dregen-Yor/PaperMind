/**
 * 段落路径的跨侧 / 跨阶段契约（整支评审 finding 2 / 4 / 5 / 7 的回归用例）。
 *
 * 本文件刻意把三件「两个数字长得一样、却没有任何断言绑住它们」的事钉在同一条链上：
 *
 * 1. **上下文预算常数两侧同源**：产品的 `DEFAULT_HYBRID_OPTIONS.maxTokens` 与 bench 的
 *    `CONTEXT_BUDGET_TOKENS` 是两个独立常量。任何一侧单独上调，另一侧照旧把旧值当作
 *    「应用的口径」写进报表——跨方法差值会照常算出来，只是不可信。
 * 2. **hook 的指纹与它真正下发的切段参数同源**：`passageConfigHash` 由旋钮算出，
 *    改掉 `segmentation` 参数时哈希**不会自己变**，所以只断言哈希等于某个用旋钮重算的
 *    哈希是**恒真**的。这里同时断言真的切出来的段落等于用同一组旋钮重算的段落，
 *    两半合起来才能证明「指纹描述的就是这份切段」。
 * 3. **阶段①落盘记录属于哪一代卡片**：记录必须写下本轮的 `structureHash`，
 *    同时（语义安全）阶段①记录仍然必须触发卡片重做——`stage < 3` 与缺 `cards`
 *    是另外两项判定，哈希一致也不构成「卡片可用」。
 */
import { describe, expect, it } from 'vitest'
import { expandMatrix, loadConfigs, validatePaperMind } from '../config'
import { CONTEXT_BUDGET_TOKENS } from '../evaluationContract'
import { createPassageIndexHook, type HybridKnobs } from '../runner/passageIndexHook'
import type { LlmClient } from '../llmClient'
import type { EvalSample } from '../types'
import { DEFAULT_HYBRID_OPTIONS } from '../../../src/utils/passageRetrieval'
import {
  PASSAGE_INDEX_SCHEMA_VERSION, passageConfigHash, planPassageIndexRebuild,
} from '../../../src/utils/passageIndex'
import { startPassagePipeline } from '../../../src/utils/passageIndexBuilder'
import { buildPassages } from '../../../src/utils/passages'

/** 与受控物化同一口径的确定性分词器：空白切词、1 词 1 token，切段结果完全可预测。 */
const tokenizer = { tokenize: (text: string) => text.split(/\s+/).filter(Boolean).map(word => `▁${word}`) }
const countTokens = (text: string) => tokenizer.tokenize(text).length

/**
 * 三页、每页一个自然段（无标题行，故三段同属一个空小节标题）。
 * 这对切段参数敏感：`minTokens = 4` 时三段各自成段（7/6/7 token），
 * 而产品默认的 `minTokens = 120` 会把它们合成**一段**——改掉 hook 的 `segmentation`
 * 参数会立刻反映在段落数上（见下面第 2 组用例的说明）。
 */
const PAGES = [
  'We study ranking under a fixed budget.',
  'The baseline uses lexical retrieval only.',
  'Our fusion improves the recall at four.',
]

const KNOBS: HybridKnobs = {
  minTokens: 4,
  maxTokens: 30,
  maxInputChars: 120_000,
  rrfK: 60,
  sectionWeight: 0.5,
  neighbourFactor: 0.5,
  skipLimit: 20,
}

const PASSAGE_CONFIG = passageConfigHash({
  schemaVersion: PASSAGE_INDEX_SCHEMA_VERSION,
  segmentation: { minTokens: KNOBS.minTokens, maxTokens: KNOBS.maxTokens },
})
const STRUCTURE = 'structure-hash-of-this-generation'

/**
 * 卡片桩：从提示词里读出段落 ID（`[P01]` 独占一行），每段一片地产出**合法**卡片。
 * 段数随切段参数变化，桩必须跟着提示词走而不是硬编码 JSON——否则参数一变，
 * 卡片校验就会失败并回落标题卡片，第 2 组用例也就测不到「真的走到阶段③」。
 */
function cardJsonFromPrompt(prompt: string): string {
  const ids = prompt.split('\n').map(line => line.trim()).filter(line => /^\[P\d+\]$/.test(line)).map(line => line.slice(1, -1))
  const sections = ids.map((id, index) => ({
    id: `S${index + 1}`,
    range: [id, id],
    title: `Taps tuning study ${index + 1}`,
    summary: `Section ${index + 1} covers the ranked taps experiment.`,
    keyTerms: ['taps', 'ranking'],
  }))
  return JSON.stringify({ paper: { title: 'Taps', summary: 'A study of ranked taps.' }, sections })
}

function stubClient(): LlmClient {
  return {
    complete: async (prompt: string) => cardJsonFromPrompt(prompt),
    chat: async () => cardJsonFromPrompt(''),
    stats: () => ({ hits: 0, misses: 0 }),
    latencies: () => [],
    requestTimings: () => [],
  } as unknown as LlmClient
}

const SAMPLE: EvalSample = {
  paperId: 'p1',
  title: 'Paper 1',
  pages: PAGES,
  source: 'qasper',
  questions: [],
}

describe('上下文预算常数：产品与 bench 同源（finding 4a）', () => {
  it('DEFAULT_HYBRID_OPTIONS.maxTokens === CONTEXT_BUDGET_TOKENS', () => {
    // 产品检索不传 maxTokens 时吃的就是这个默认值（`stores/chat.ts` 的 `passageDeps()`），
    // 而 bench 报表里的「应用口径」取的是 CONTEXT_BUDGET_TOKENS。两者放开不管，
    // 就有一天会出现「bench 按 4096 汇报、应用实际按 8192 填充」这种无人察觉的分叉。
    expect(DEFAULT_HYBRID_OPTIONS.maxTokens).toBe(CONTEXT_BUDGET_TOKENS)
  })
})

describe('createPassageIndexHook：指纹与真正下发的切段同源（finding 4b）', () => {
  it('索引的 passageConfigHash 与切出来的段落都等于同一组旋钮的产物', async () => {
    const hook = createPassageIndexHook({
      knobs: KNOBS,
      client: stubClient(),
      embedder: undefined,
      countTokens,
      modelIdentity: 'bench-model',
    })
    const { index } = await hook(SAMPLE)

    // 真的走到阶段③：卡片来自模型，不是标题回落（回落卡片只有标题，keyTerms 为空）
    expect(index.stage).toBe(3)
    expect(index.cards?.every(card => card.keyTerms.length === 2)).toBe(true)

    // 指纹这一半
    expect(index.passageConfigHash).toBe(PASSAGE_CONFIG)

    // 切段这一半：把 hook 的 `segmentation` 改成别的参数（例如不传、或用产品默认 120/350），
    // 上面那条哈希断言照样通过（哈希只读旋钮），只有这一条会失败——它才是「指纹描述的就是
    // 这份切段」的证据。删掉 hook 里那一行 `segmentation` 时，这里会拿到 1 段而不是 3 段。
    const expected = buildPassages(PAGES, countTokens, { minTokens: KNOBS.minTokens, maxTokens: KNOBS.maxTokens })
    expect(index.passages.map(passage => passage.text)).toEqual(expected.map(passage => passage.text))
    expect(index.passages).toHaveLength(3)
  })
})

describe('startPassagePipeline：阶段①记录带上本轮的 structureHash（finding 5）', () => {
  it('阶段①落盘即写下 structureHash，且复用判定仍要求重做卡片', async () => {
    const persisted: Array<{ stage: number; structureHash?: string }> = []
    const { index, rest } = await startPassagePipeline(
      PAGES,
      {
        llm: async prompt => cardJsonFromPrompt(prompt),
        countTokens,
        passageConfigHash: PASSAGE_CONFIG,
        structureHash: STRUCTURE,
        persist: (next, stage) => { persisted.push({ stage, structureHash: next.structureHash }) },
      },
      { force: true },
    )
    await rest

    // 阶段① 的记录（也就是阶段③ 写盘被代次守卫丢弃时唯一存活下来的那份）必须自报卡片代次，
    // 否则它对自己属于哪一代 structureHash 一无所知
    expect(persisted[0]).toEqual({ stage: 1, structureHash: STRUCTURE })
    expect(index.structureHash).toBe(STRUCTURE)

    // 语义安全：哈希一致**不**等于卡片可用。阶段① 记录 stage=1 且没有 cards，
    // 另两项判定必然要求重做卡片——写这个字段不会让任何记录被判成「卡片是新的」。
    expect(planPassageIndexRebuild({
      stored: index,
      passageConfigHash: PASSAGE_CONFIG,
      structureHash: STRUCTURE,
    })).toEqual({ passages: false, vectors: true, structure: true })
  })
})

describe('validatePaperMind：七项旋钮与 passage 块共现（finding 2）', () => {
  const EMBEDDER_BLOCK = { embedder: { model: 'Xenova/bge-small-en-v1.5', revision: 'main', dtype: 'q8', dim: 384 } }
  const KNOB_MATRIX = {
    minTokens: [120], maxTokens: [350], maxInputChars: [120_000],
    rrfK: [60], sectionWeight: [0, 1], neighbourFactor: [0.5], skipLimit: [20],
  }

  it('只写旋钮而不写 passage 块 → 报错；两者都缺席照旧合法', async () => {
    // 评审实测的形态：旋钮没拼错、`passage` 整块漏掉 → 此前会静默展开成两个平铺臂，
    // 名字却叫 papermind-hybrid（量出来的数字标着混合检索，一条 passage 参数都没下发）
    expect(() => validatePaperMind({
      name: 'papermind-hybrid', kind: 'papermind', matrix: { sectionWeight: [0, 1], rrfK: [60] },
    }, 'test')).toThrow(/passage/)

    // 同一个洞的另一种写法：七项旋钮齐全、块缺席
    expect(() => validatePaperMind({ name: 'papermind-hybrid', kind: 'papermind', matrix: KNOB_MATRIX }, 'test')).toThrow(/passage/)

    // 反向：块在、旋钮全缺（此前由 validateHybridKnobs 的 require 兜住，报错文本仍点名缺的旋钮）
    expect(() => validatePaperMind({
      name: 'papermind-hybrid', kind: 'papermind', passage: EMBEDDER_BLOCK, matrix: { topK: [4] },
    }, 'test')).toThrow(/minTokens/)

    // 两者都缺席是合法的纯平铺配置（bench/configs/default.json 一类）
    expect(expandMatrix(validatePaperMind({ name: 'default', matrix: { topK: [4] } }, 'test'))).toHaveLength(1)

    // 出厂配置逐份过一遍新规则：两个 hybrid 配置与纯平铺的 default 都必须照旧可加载
    await expect(loadConfigs('papermind-hybrid')).resolves.toHaveLength(3)
    await expect(loadConfigs('papermind-hybrid-m3')).resolves.toHaveLength(1)
    await expect(loadConfigs('default')).resolves.toHaveLength(1)
  })

  it('各臂共享的 passage 块被深冻结：未来的按臂改写在严格模式下当场抛错（finding 7）', () => {
    const configs = expandMatrix(validatePaperMind({
      name: 'papermind-hybrid', kind: 'papermind', passage: EMBEDDER_BLOCK, matrix: KNOB_MATRIX,
    }, 'test'))
    expect(configs).toHaveLength(2)
    // 三个 sectionWeight 臂共享同一个对象：任何人都不能就地改写它，
    // 否则会「把三个臂的嵌入器身份一起改掉、却仍各自声称不同的旋钮」
    expect(Object.isFrozen(configs[0].passage)).toBe(true)
    expect(Object.isFrozen(configs[0].passage?.embedder)).toBe(true)
    expect(configs[0].passage).toBe(configs[1].passage)
    expect(() => {
      (configs[0].passage as { embedder: { dim: number } }).embedder.dim = 512
    }).toThrow(TypeError)
    // 展开也不依赖调用方那份对象的后续改动（这里是克隆一次的语义）
    expect(configs[0].passage?.embedder.dim).toBe(384)
  })
})
