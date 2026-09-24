import { describe, expect, it } from 'vitest'
import { buildPassages, createEstimatingTokenCounter, hasPassagePartition } from '../utils/passages'
import { buildTitleCards, cardsToIndexNodes } from '../utils/structureCards'
import type { StructureFallbackReason } from '../utils/structureCards'
import { encodeVectors } from '../utils/embedder'
import {
  PASSAGE_INDEX_SCHEMA_VERSION, PASSAGE_INDEX_VERSION, planPassageIndexRebuild,
  parsePassageIndex, passageConfigHash, serializePassageIndex, structureHash,
} from '../utils/passageIndex'

const counter = createEstimatingTokenCounter()
const passages = buildPassages(['Abstract\nA short abstract.\n\nMethods\nWe use BM25.'], counter, { minTokens: 1 })
const tree = cardsToIndexNodes(buildTitleCards(passages), passages)

const baseIndex = {
  version: PASSAGE_INDEX_VERSION,
  stage: 1 as const,
  passages,
  tree,
  separatorTokens: 2,
  passageConfigHash: 'pcfg',
}

describe('serialize / parse', () => {
  it('第 1 阶段索引往返无损', () => {
    const parsed = parsePassageIndex(JSON.parse(JSON.stringify(serializePassageIndex(baseIndex))))
    expect(parsed?.passages).toHaveLength(passages.length)
    expect(parsed?.tree.nodes.length).toBe(tree.nodes.length)
    expect(parsed?.stage).toBe(1)
  })

  it('向量按 base64 往返，维度与段落数一致', () => {
    const vectors = passages.map((_, i) => new Float32Array([i, 1, 0]))
    const index = { ...baseIndex, stage: 3 as const, vectorDim: 3, passageVectors: vectors, cards: [{ id: 'S1', range: [passages[0].id, passages[1].id] as [string, string], title: 'Datasets', summary: '', keyTerms: [] }], cardVectors: [new Float32Array([1, 0, 0])], embedderId: 'fake@main#q8' }
    const parsed = parsePassageIndex(JSON.parse(JSON.stringify(serializePassageIndex(index))))
    expect(parsed?.passageVectors?.[1][0]).toBe(1)
    expect(parsed?.cardVectors?.[0][0]).toBe(1)
  })

  it('版本不符即视为过期（返回 undefined）', () => {
    expect(parsePassageIndex({ ...JSON.parse(JSON.stringify(serializePassageIndex(baseIndex))), version: 1 })).toBeUndefined()
    expect(parsePassageIndex({ version: 2, stage: 1 })).toBeUndefined()
    expect(parsePassageIndex('nope')).toBeUndefined()
  })

  it('分片与原文不一致的索引视为损坏', () => {
    const broken = JSON.parse(JSON.stringify(serializePassageIndex(baseIndex)))
    broken.passages[0].pieces[0].text = 'tampered'
    expect(hasPassagePartition(broken.passages[0])).toBe(false)
    expect(parsePassageIndex(broken)).toBeUndefined()
  })

  // R16：分片自洽不代表记录完整——`text` 是 `pieces` 拼接的定义产物，
  // 所以 `hasPassagePartition` 看不见丢失的非分片字段（如 `searchText`，BM25 的输入）。
  it('缺少打分字段的记录视为损坏', () => {
    const corruptions: Array<[string, (broken: any) => void]> = [
      ['searchText 缺失', broken => { delete broken.passages[0].searchText }],
      ['tokenCount 非整数', broken => { broken.passages[0].tokenCount = 1.5 }],
      ['subsection 非字符串', broken => { broken.passages[0].subsection = null }],
    ]
    for (const [name, corrupt] of corruptions) {
      const broken = JSON.parse(JSON.stringify(serializePassageIndex(baseIndex)))
      corrupt(broken)
      expect(hasPassagePartition(broken.passages[0]), name).toBe(true)
      expect(parsePassageIndex(broken), name).toBeUndefined()
    }
  })

  it('向量长度与段落数不符时丢弃向量但不丢索引', () => {
    const broken = JSON.parse(JSON.stringify(serializePassageIndex(baseIndex)))
    broken.stage = 2
    broken.embedderId = 'fake@main#q8'
    broken.vectorDim = 3
    broken.passageVectors = encodeVectors([new Float32Array([1, 0, 0])])  // 只有 1 个，段落数 > 1
    const parsed = parsePassageIndex(broken)
    expect(parsed).toBeDefined()
    expect(parsed?.passageVectors).toBeUndefined()
  })

  // `vectorDim` 描述的是「留下的向量有多宽」：两个数组都被丢掉时它描述的是不存在的维度，
  // 只看 `vectorDim` 判断「有没有向量」的调用方会被骗。
  it('两串向量都被丢弃时 vectorDim 也不挂', () => {
    const broken = JSON.parse(JSON.stringify(serializePassageIndex(baseIndex)))
    broken.stage = 2
    broken.embedderId = 'fake@main#q8'
    broken.vectorDim = 3
    broken.passageVectors = encodeVectors([new Float32Array([1, 0, 0])])  // 只有 1 个，段落数 > 1
    const parsed = parsePassageIndex(broken)
    expect(parsed).toBeDefined()
    expect(parsed?.passageVectors).toBeUndefined()
    expect(parsed?.vectorDim).toBeUndefined()
  })

  // 字段形态纪律此前只落在 passages 上：`paper` / `structureFallback` 会被原样当声明类型用
  // （`paper.summary: 42` 会走进推导出的树、未知 reason 会冒充 `StructureFallbackReason`），
  // `tree` 只查「是对象」会让 v1 语义路径读到 `nodes.length` 为 undefined。
  it('paper / 回落原因 / 树的形态不对视为损坏', () => {
    const corruptions: Array<[string, (broken: any) => void]> = [
      ['paper.summary 非字符串', broken => { broken.paper = { title: 'Title', summary: 42 } }],
      ['paper 非对象', broken => { broken.paper = 'Title' }],
      ['structureFallback.reason 未知', broken => { broken.structureFallback = { reason: 'made-up' } }],
      ['structureFallback.reason 缺失', broken => { broken.structureFallback = {} }],
      ['tree.nodes 非数组', broken => { broken.tree.nodes = 'x' }],
      ['tree.nodes 元素缺字段', broken => { broken.tree.nodes = [{}] }],
      ['tree 孙节点 nodes 非数组', broken => { broken.tree.nodes = [{ ...broken.tree.nodes[0], nodes: 'x' }] }],
    ]
    for (const [name, corrupt] of corruptions) {
      const broken = JSON.parse(JSON.stringify(serializePassageIndex(baseIndex)))
      corrupt(broken)
      expect(parsePassageIndex(broken), name).toBeUndefined()
    }
  })

  // 形态校验不能过紧：完整的 `paper` 与每一个回落原因都是合法记录，必须照常解析。
  // `Record<StructureFallbackReason, true>` 是给联合类型的编译期锚点：新增原因时这里编译
  // 不过，逼着同时更新测试与 `passageIndex.ts` 的白名单（只加联合不改白名单 → 下面的断言红）。
  const ALL_REASONS: Record<StructureFallbackReason, true> = {
    'request-failed': true, 'invalid-json': true, 'invalid-structure': true, 'input-too-large': true, 'no-passages': true,
  }
  it('形态完整的 paper 与全部回落原因照常解析', () => {
    const valid = JSON.parse(JSON.stringify(serializePassageIndex({ ...baseIndex, paper: { title: 'Title', summary: 'Two sentences.' } })))
    expect(parsePassageIndex(valid)?.paper).toEqual({ title: 'Title', summary: 'Two sentences.' })
    for (const reason of Object.keys(ALL_REASONS) as StructureFallbackReason[]) {
      const withFallback = JSON.parse(JSON.stringify(serializePassageIndex({ ...baseIndex, structureFallback: { reason } })))
      expect(parsePassageIndex(withFallback)?.structureFallback?.reason, reason).toBe(reason)
    }
  })

  // 卡片形态不对时只丢卡片（`cardVectors` 随之不挂），段落与向量照用；`cards` 缺席会让
  // `planPassageIndexRebuild` 只重做阶段③（对照：形态完整的同一份记录全部复用）。
  it('卡片元素形态不对时只丢卡片，不丢整份索引', () => {
    const withCards = {
      ...baseIndex,
      stage: 3 as const,
      structureHash: 'sh',
      embedderId: 'e1',
      vectorDim: 3,
      passageVectors: passages.map(() => new Float32Array([1, 2, 3])),
      cards: [{ id: 'S1', range: [passages[0].id, passages[1].id] as [string, string], title: 'Datasets', summary: '', keyTerms: [] }],
      cardVectors: [new Float32Array([1, 0, 0])],
    }
    const intact = parsePassageIndex(JSON.parse(JSON.stringify(serializePassageIndex(withCards))))
    expect(intact?.cards).toHaveLength(1)
    expect(planPassageIndexRebuild({ stored: intact, passageConfigHash: 'pcfg', structureHash: 'sh', embedderId: 'e1' }))
      .toEqual({ passages: false, vectors: false, structure: false })

    const broken = JSON.parse(JSON.stringify(serializePassageIndex(withCards)))
    delete broken.cards[0].range
    const parsed = parsePassageIndex(broken)
    expect(parsed).toBeDefined()
    expect(parsed?.cards).toBeUndefined()
    expect(parsed?.cardVectors).toBeUndefined()
    expect(parsed?.passageVectors).toHaveLength(passages.length)
    expect(planPassageIndexRebuild({ stored: parsed, passageConfigHash: 'pcfg', structureHash: 'sh', embedderId: 'e1' }))
      .toEqual({ passages: false, vectors: false, structure: true })
  })

  // 「只拒绝、不抛」对深嵌套同样成立：`JSON.parse` 能解析极深的树（迭代实现），形态校验
  // 若写成递归会在两万层上下 `RangeError` 抛出——那会从 `parsePassageIndex` 里漏出去。
  it('深嵌套的树不会让解析抛错', () => {
    const depth = 20000
    const level = '{"title":"t","nodeId":"n","startPage":0,"endPage":0,"summary":"s","nodes":['
    const record = {
      ...JSON.parse(JSON.stringify(serializePassageIndex(baseIndex))),
      tree: JSON.parse(level.repeat(depth) + ']}'.repeat(depth)),
    }
    expect(parsePassageIndex(record)).toBeDefined()
  })
})

describe('三个指纹', () => {
  it('切段参数变化 → passageConfigHash 变化', () => {
    const a = passageConfigHash({ schemaVersion: PASSAGE_INDEX_SCHEMA_VERSION, segmentation: { minTokens: 120, maxTokens: 350 } })
    const b = passageConfigHash({ schemaVersion: PASSAGE_INDEX_SCHEMA_VERSION, segmentation: { minTokens: 100, maxTokens: 350 } })
    expect(a).not.toBe(b)
  })

  it('模型端点或提示词版本变化 → structureHash 变化，切段参数不变则 passageConfigHash 不变', () => {
    const cfg = { schemaVersion: PASSAGE_INDEX_SCHEMA_VERSION, segmentation: { minTokens: 120, maxTokens: 350 } }
    const base = { schemaVersion: PASSAGE_INDEX_SCHEMA_VERSION, passageConfigHash: passageConfigHash(cfg), promptVersion: 'v1', maxInputChars: 120000, model: 'openai/gpt-4o' }
    expect(structureHash(base)).toBe(structureHash({ ...base }))
    expect(structureHash(base)).not.toBe(structureHash({ ...base, model: 'openai/gpt-4o-mini' }))
    expect(structureHash(base)).not.toBe(structureHash({ ...base, promptVersion: 'v2' }))
  })
})

describe('planPassageIndexRebuild', () => {
  const config = { schemaVersion: PASSAGE_INDEX_SCHEMA_VERSION, segmentation: { minTokens: 120, maxTokens: 350 } }
  const passageConfig = passageConfigHash(config)
  const structure = structureHash({ schemaVersion: PASSAGE_INDEX_SCHEMA_VERSION, passageConfigHash: passageConfig, promptVersion: 'v1', maxInputChars: 120000, model: 'm' })
  const stored = { version: PASSAGE_INDEX_VERSION, stage: 3 as const, passages, tree, separatorTokens: 2, passageConfigHash: passageConfig, structureHash: structure, embedderId: 'e1', vectorDim: 3, passageVectors: passages.map(() => new Float32Array([0, 0, 0])), cards: buildTitleCards(passages) }

  it('完全匹配且已到阶段③时全部复用', () => {
    expect(planPassageIndexRebuild({ stored, passageConfigHash: passageConfig, structureHash: structure, embedderId: 'e1' }))
      .toEqual({ passages: false, vectors: false, structure: false })
  })

  it('embedderId 变化只重算向量', () => {
    expect(planPassageIndexRebuild({ stored, passageConfigHash: passageConfig, structureHash: structure, embedderId: 'e2' }))
      .toEqual({ passages: false, vectors: true, structure: false })
  })

  it('structureHash 变化只重做卡片', () => {
    expect(planPassageIndexRebuild({ stored, passageConfigHash: passageConfig, structureHash: 'other', embedderId: 'e1' }))
      .toEqual({ passages: false, vectors: false, structure: true })
  })

  it('passageConfigHash 变化触发全部重建', () => {
    expect(planPassageIndexRebuild({ stored, passageConfigHash: 'other', structureHash: structure, embedderId: 'e1' }))
      .toEqual({ passages: true, vectors: true, structure: true })
  })

  it('没有存量索引时全部重建', () => {
    expect(planPassageIndexRebuild({ stored: undefined, passageConfigHash: passageConfig, structureHash: structure, embedderId: 'e1' }))
      .toEqual({ passages: true, vectors: true, structure: true })
  })

  it('阶段未到③时卡片要重做', () => {
    const partial = { ...stored, stage: 2 as const }
    expect(planPassageIndexRebuild({ stored: partial, passageConfigHash: passageConfig, structureHash: structure, embedderId: 'e1' }).structure).toBe(true)
  })
})
