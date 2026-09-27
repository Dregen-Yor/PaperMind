/**
 * 段落路径在 bench 层的旋钮转发（R42 / Task 14 的补充用例）。
 *
 * `QaTaskArgs.passage` 的四个融合旋钮必须真的走到检索（runQaTask → retrieveRagContext
 * → retrievePassageContext）；少了这段转发，CLI 的 sectionWeight 消融轴会产出多份逐字
 * 相同的数字而各自声称不同口径。这里刻意**不注入 `deps.retrieveContext`**：把它桩掉，
 * 本用例要证明的那段转发就永远不会被执行，用例也就恒绿。
 *
 * 断言落在物化器实际收到的组文本上（最终 prompt 的唯一来源），而不是检索内部的诊断字段——
 * 用例必须对「旋钮改变了进入 prompt 的原文」负责，而不是对某个内部字段的写法负责。
 */
import { describe, it, expect, vi } from 'vitest'
import type { EvalSample, PassageMode } from '../types'
import type { ContextGroup } from '../../../src/utils/contextTrace'
import type { Passage } from '../../../src/utils/passages'
import type { PassageIndex } from '../../../src/utils/passageIndex'
import type { StructureCard } from '../../../src/utils/structureCards'
import type { Embedder } from '../../../src/utils/embedder'
import type { QaTaskArgs } from '../runner/qa'
import type { PassageIndexHook, PassageIndexInfo } from '../runner/passageIndexHook'

// Node 环境缺 DOMMatrix，pageIndex 顶层会初始化 pdfjs worker
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: {},
  getDocument: vi.fn(),
}))

const { runQaTask } = await import('../runner/qa')
const { materializeContext } = await import('../../../src/utils/contextTrace')
const { buildTitleCards, cardsToIndexNodes } = await import('../../../src/utils/structureCards')
const { PASSAGE_INDEX_VERSION, passageConfigHash } = await import('../../../src/utils/passageIndex')
const { buildEvaluationContract } = await import('../evaluationContract')

/** 与受控物化同形态的确定性分词器：空白切词、1 词 1 token，预算与计数完全可预测。 */
const tokenizer = { tokenize: (text: string) => text.split(/\s+/).filter(Boolean).map(word => `▁${word}`) }
const countTokens = (text: string) => tokenizer.tokenize(text).length
/**
 * 把受控预算缩到「恰好放得下一段」：单段最多 6 token，任意两段至少 4 + 5 + 2 = 11 > 8，
 * 于是选段结果就是融合第一名的直接读数。CLI 上冻结的 4096 会让四段全进，读不出旋钮差异。
 */
const CONTEXT_BUDGET = 8

function passage(order: number, text: string, subsection: string): Passage {
  return {
    id: `P0${order + 1}`,
    order,
    pieces: [{ page: order, text }],
    text,
    searchText: text,
    // 与物化同一口径：tokenCount 由同一个分词器算出，填充的「放得下」判定才与物化一致
    tokenCount: countTokens(text),
    prevId: order > 0 ? `P0${order}` : null,
    nextId: order < 3 ? `P0${order + 2}` : null,
    subsection,
  }
}

/**
 * 手工索引（形态与 src/tests/ragPipeline.test.ts 的 sectionWeight 用例一致）：
 * 查询 'alpha' 的段落 BM25 名次为 P02 > P01 > P03 > P04（只有 P02 命中该词），
 * 卡片词法先验名次为 P01 > P03 > P04 > P02（卡片标题里 alpha 分别出现 3/1/1/0 次）。
 * sectionWeight=0 时卡片路不计权（等于关掉卡片先验）→ BM25 第一名 P02 胜出；
 * sectionWeight=1 时 P01 的卡片第 1 名压过 P02 的卡片第 4 名，把 BM25 第 2 名抬成融合第一。
 * 四段小节两两不同，neighbourFactor 的邻段扩展不会额外掺合进来。
 */
const passages = [
  passage(0, 'Overview of the ranking protocol.', 'Overview'),
  passage(1, 'We evaluate on the alpha dataset.', 'Evaluation'),
  passage(2, 'Notes on the evaluation metrics.', 'Metrics'),
  passage(3, 'Ablation details and caveats.', 'Ablation'),
]
const cards: StructureCard[] = [
  { id: 'S1', range: ['P01', 'P01'], title: 'Alpha alpha alpha retrieval', summary: '', keyTerms: [] },
  { id: 'S2', range: ['P03', 'P03'], title: 'Alpha notes', summary: '', keyTerms: [] },
  { id: 'S3', range: ['P04', 'P04'], title: 'Alpha caveats', summary: '', keyTerms: [] },
  { id: 'S4', range: ['P02', 'P02'], title: 'Beta baseline', summary: '', keyTerms: [] },
]
const index: PassageIndex = {
  version: PASSAGE_INDEX_VERSION,
  stage: 3,
  passages,
  cards,
  tree: cardsToIndexNodes(cards, passages),
  passageConfigHash: passageConfigHash({ schemaVersion: 2, segmentation: { minTokens: 1, maxTokens: 350 } }),
  separatorTokens: 2,
}

const sample: EvalSample = {
  paperId: 'p1',
  title: 'Paper 1',
  pages: passages.map(item => item.text),
  source: 'qasper',
  questions: [{
    id: 'p1#0', question: 'alpha', answers: ['P02'], evidencePages: [1], unanswerable: false,
    qualityAnswers: ['P02'], qualityDefinition: 'qasper-all-questions-v1',
  }],
}

/** 段落路径检索期零 LLM 调用：complete 一旦被调用即抛错，静默回落旧路径会被立刻抓住。 */
const client = {
  complete: vi.fn(async () => { throw new Error('段落路径不应调用 complete') }),
  chat: vi.fn(async () => 'P02'),
  stats: () => ({ hits: 0, misses: 0 }),
  latencies: () => [] as number[],
  requestTimings: () => [],
}

/**
 * 桩物化器：记下它收到的组文本（最终 prompt 的唯一来源），再交给真实物化器产出页序与
 * token 数——检索指标与固定分母不变量都读这两个字段，桩掉它们会让整轮无法完成。
 */
function capturingMaterialize() {
  const seen: string[][] = []
  const materialize: QaTaskArgs['materialize'] = groups => {
    seen.push(groups.map(group => group.pieces.map(piece => piece.text).join('')))
    return materializeContext(groups, tokenizer, CONTEXT_BUDGET)
  }
  return { seen, materialize }
}

/** B 臂（hybrid-raw）真产物：阶段① 的标题树在、段落向量齐全，但**没有**卡片。 */
const DENSE_DIM = 8
const DENSE_ID = 'dense@main#q8'

function denseEmbedder(): Embedder & { embedQuery: ReturnType<typeof vi.fn> } {
  return {
    id: DENSE_ID,
    embedQuery: vi.fn(async () => new Float32Array(DENSE_DIM).fill(1)),
    embedPassages: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(DENSE_DIM).fill(1))),
  } as Embedder & { embedQuery: ReturnType<typeof vi.fn> }
}

function denseIndex(embedderId: string | undefined = DENSE_ID): PassageIndex {
  return {
    version: PASSAGE_INDEX_VERSION,
    stage: 2,
    passages,
    tree: cardsToIndexNodes(buildTitleCards(passages), passages),
    passageVectors: passages.map(() => new Float32Array(DENSE_DIM).fill(1)),
    vectorDim: DENSE_DIM,
    ...(embedderId !== undefined ? { embedderId } : {}),
    passageConfigHash: passageConfigHash({ schemaVersion: 2, segmentation: { minTokens: 1, maxTokens: 350 } }),
    separatorTokens: 2,
  }
}

/** 意外降级形态：停在阶段①，没有段落向量（单篇向量计算失败的产物）。 */
function bareIndex(): PassageIndex {
  const { passageVectors, vectorDim, embedderId, ...rest } = denseIndex()
  return { ...rest, stage: 1 }
}

function infoFor(index: PassageIndex, extra: Partial<PassageIndexInfo> = {}): PassageIndexInfo {
  return {
    index,
    coldStart: { coldStartPassageMs: 0, coldStartPassageCount: passages.length, coldStartTotalMs: 0 },
    cacheHits: 0,
    cacheMisses: 0,
    ...extra,
  }
}

/** 与真实 hook 同形态的桩：lexicalReady 与 ready 都给同一份索引。 */
function stubHook(info: PassageIndexInfo): PassageIndexHook {
  return async () => ({ lexicalReady: info, ready: Promise.resolve(info) })
}

/**
 * 通用段落 args：唯一变量是 `mode` 与 hook 产出的索引 / embedder。
 * `legacy-llm` 刻意不写 `mode` 字段（既有口径的形态就是缺席）。
 */
function argsForMode(
  mode: PassageMode,
  hook: PassageIndexHook,
  embedder: Embedder | undefined,
  materialize: QaTaskArgs['materialize'],
  embedderUnavailable = false,
): QaTaskArgs {
  return {
    samples: [sample],
    config: { name: `papermind-${mode}`, ...(mode === 'legacy-llm' ? {} : { mode }) },
    client: client as never,
    systemPrompt: '系统提示词',
    gitSha: 'abc1234',
    model: 'test-model',
    materialize,
    evaluationContract: buildEvaluationContract([sample]),
    passage: {
      hook,
      embedder,
      countTokens,
      contextBudgetTokens: CONTEXT_BUDGET,
      rrfK: 60,
      sectionWeight: 0.5,
      neighbourFactor: 0.5,
      skipLimit: 20,
      embedderUnavailable,
    },
  }
}

/** 两次运行的唯一变量是 sectionWeight；其余三个旋钮显式冻结，不吃默认值。 */
function argsWithSectionWeight(
  sectionWeight: number,
  materialize: QaTaskArgs['materialize'],
): QaTaskArgs {
  return {
    samples: [sample],
    config: { name: 'papermind-hybrid' },
    client: client as never,
    systemPrompt: '系统提示词',
    gitSha: 'abc1234',
    model: 'test-model',
    materialize,
    evaluationContract: buildEvaluationContract([sample]),
    passage: {
      // hook 桩：把手工索引端到端送进**真实**检索（切段与建卡片不在本用例范围内）。
      // 句柄形态：lexicalReady 与 ready 都给同一份索引（本用例不区分阶段）
      hook: async () => {
        const info = {
          index,
          coldStart: { coldStartPassageMs: 0, coldStartPassageCount: passages.length, coldStartTotalMs: 0 },
          cacheHits: 0,
          cacheMisses: 0,
        }
        return { lexicalReady: info, ready: Promise.resolve(info) }
      },
      // 无向量模型：本用例的差异必须只来自 sectionWeight，不允许 dense 路掺进来
      embedder: undefined,
      countTokens,
      contextBudgetTokens: CONTEXT_BUDGET,
      rrfK: 60,
      sectionWeight,
      neighbourFactor: 0.5,
      skipLimit: 20,
      embedderUnavailable: true,
    },
  }
}

async function runWithSectionWeight(sectionWeight: number) {
  const capture = capturingMaterialize()
  const result = await runQaTask(argsWithSectionWeight(sectionWeight, capture.materialize))
  return { captured: capture.seen, result }
}

describe('runQaTask 段落路径 — 融合旋钮的端到端转发', () => {
  it('sectionWeight 0/1 真的改变进入 prompt 的选段（R42 在 bench 层的补充）', async () => {
    // 删掉 qa.ts 里那四行转发时，两次运行都吃默认 sectionWeight=0.5 → 捕获文本相同，
    // 本用例的第一条内容断言即失败。
    const cardPriorOff = await runWithSectionWeight(0)
    const cardPriorOn = await runWithSectionWeight(1)

    // 两次都真的走完了检索 + 生成（桩掉的是物化与 LLM，不是 runner 自身）
    expect(cardPriorOff.result.meta.completed).toBe(1)
    expect(cardPriorOn.result.meta.completed).toBe(1)

    // 内容级断言：物化器收到的组文本就是最终 prompt 里那一段原文
    expect(cardPriorOff.captured).toEqual([['We evaluate on the alpha dataset.']])
    expect(cardPriorOn.captured).toEqual([['Overview of the ranking protocol.']])
    expect(cardPriorOn.captured).not.toEqual(cardPriorOff.captured)
  })
})

describe('runQaTask 段落路径 — 逐题降级判不可比', () => {
  it('模型整体可用但本篇没有向量（逐题走 bm25*）时整轮标为不可比', async () => {
    const args = argsWithSectionWeight(0.5, capturingMaterialize().materialize)
    args.passage!.embedderUnavailable = false
    const result = await runQaTask(args)
    expect(result.meta.comparisonEligible).toBe(false)
    expect(result.meta.comparisonIneligibleReason).toBe('passage-retrieval-degraded')
    expect(result.metrics.passageDegradedQuestionRate).toBe(1)
  })
})

/**
 * 方案 §221：A 的 bm25、B 的 bm25+dense、C 的 bm25+dense+outline 或预声明 outline-fallback
 * 都合法，不能因为没有某个词就判降级；意外向量失败仍必须可见。
 * 这组用例就是把「合法模式」与「真降级」两边的界线钉住——旧实现用 startsWith('bm25')
 * 判定，会把每一道 B 题都算成降级、把实验自己的基线臂排除出对照。
 */
describe('runQaTask 段落路径 — 各臂预期模式与真降级的界线（方案 §221）', () => {
  it('B（hybrid-raw）真段落向量：bm25+dense 是预期模式，不判降级、不排除出对照', async () => {
    const embedder = denseEmbedder()
    const result = await runQaTask(argsForMode(
      'hybrid-raw', stubHook(infoFor(denseIndex(embedder.id))), embedder, capturingMaterialize().materialize,
    ))
    expect(result.perSample[0].retrievalMode).toBe('bm25+dense')
    expect(result.metrics.passageDegradedQuestionRate).toBe(0)
    expect(result.meta.comparisonEligible).not.toBe(false)
    expect(result.meta.comparisonIneligibleReason).toBeUndefined()
  })

  it('C（hybrid-outline）目录缺失的预声明回落：bm25+dense 合法，不算降级', async () => {
    const embedder = denseEmbedder()
    const result = await runQaTask(argsForMode(
      'hybrid-outline',
      stubHook(infoFor(denseIndex(embedder.id), {
        outline: { nodes: [], available: false, fallbackReason: 'missing-outline', nodeVectors: new Map(), elapsedMs: 3 },
      })),
      embedder,
      capturingMaterialize().materialize,
    ))
    expect(result.perSample[0].retrievalMode).toBe('bm25+dense')
    expect(result.metrics.passageDegradedQuestionRate).toBe(0)
    expect(result.meta.comparisonEligible).not.toBe(false)
  })

  it('B 意外没有段落向量：bm25 是降级，仍标不可比', async () => {
    const embedder = denseEmbedder()
    const result = await runQaTask(argsForMode(
      'hybrid-raw', stubHook(infoFor(bareIndex())), embedder, capturingMaterialize().materialize,
    ))
    expect(result.perSample[0].retrievalMode).toBe('bm25')
    expect(result.metrics.passageDegradedQuestionRate).toBe(1)
    expect(result.meta.comparisonEligible).toBe(false)
    expect(result.meta.comparisonIneligibleReason).toBe('passage-retrieval-degraded')
  })

  it('B 查询向量失败：模式回落 bm25，同样计入降级（真信号不被修掉）', async () => {
    const embedder = denseEmbedder()
    embedder.embedQuery.mockRejectedValue(new Error('query embed down'))
    const result = await runQaTask(argsForMode(
      'hybrid-raw', stubHook(infoFor(denseIndex(embedder.id))), embedder, capturingMaterialize().materialize,
    ))
    expect(result.perSample[0].retrievalMode).toBe('bm25')
    expect(result.metrics.passageDegradedQuestionRate).toBe(1)
    expect(result.meta.comparisonIneligibleReason).toBe('passage-retrieval-degraded')
  })

  it('C 臂逐篇目录事实进入 perPaper：可用篇 / 失败篇 / B 式无目录篇三者可区分', async () => {
    const nodes = [{
      id: '0', title: 'Introduction', path: [] as string[], depth: 0,
      startPage: 0, endPage: 0, passageOrders: [0], children: [],
    }]
    const ok = await runQaTask(argsForMode(
      'hybrid-outline',
      stubHook(infoFor(denseIndex(), {
        outline: { nodes, available: true, nodeVectors: new Map([['0', new Float32Array(DENSE_DIM).fill(1)]]), elapsedMs: 42 },
      })),
      denseEmbedder(),
      capturingMaterialize().materialize,
    ))
    expect(ok.perPaper?.[0].coldStartOutlineAvailable).toBe(1)
    expect(ok.perPaper?.[0].coldStartOutlineNodeCount).toBe(1)
    expect(ok.perPaper?.[0].coldStartOutlineMs).toBe(42)
    expect(ok.perPaper?.[0].coldStartOutlineFallback).toBeUndefined()
    expect(ok.metrics.outlineAvailabilityRate).toBe(1)

    const failed = await runQaTask(argsForMode(
      'hybrid-outline',
      stubHook(infoFor(denseIndex(), {
        outline: { nodes: [], available: false, fallbackReason: 'outline-embed-failed', nodeVectors: new Map(), elapsedMs: 5 },
      })),
      denseEmbedder(),
      capturingMaterialize().materialize,
    ))
    expect(failed.perPaper?.[0].coldStartOutlineAvailable).toBe(0)
    expect(failed.perPaper?.[0].coldStartOutlineNodeCount).toBe(0)
    expect(failed.perPaper?.[0].coldStartOutlineFallback).toBe('outline-embed-failed')
    expect(failed.metrics.outlineAvailabilityRate).toBe(0)

    // B 式（hook 不产出 outline）：这些字段整体缺席，不会被填 0 冒充「目录失败」
    const raw = await runQaTask(argsForMode(
      'hybrid-raw', stubHook(infoFor(denseIndex())), denseEmbedder(), capturingMaterialize().materialize,
    ))
    expect(raw.perPaper?.[0].coldStartOutlineAvailable).toBeUndefined()
    expect(raw.metrics.outlineAvailabilityRate).toBeUndefined()
  })
})
