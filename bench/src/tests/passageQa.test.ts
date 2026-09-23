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
import type { EvalSample } from '../types'
import type { ContextGroup } from '../../../src/utils/contextTrace'
import type { Passage } from '../../../src/utils/passages'
import type { PassageIndex } from '../../../src/utils/passageIndex'
import type { StructureCard } from '../../../src/utils/structureCards'
import type { QaTaskArgs } from '../runner/qa'

// Node 环境缺 DOMMatrix，pageIndex 顶层会初始化 pdfjs worker
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: {},
  getDocument: vi.fn(),
}))

const { runQaTask } = await import('../runner/qa')
const { materializeContext } = await import('../../../src/utils/contextTrace')
const { cardsToIndexNodes } = await import('../../../src/utils/structureCards')
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
      // hook 桩：把手工索引端到端送进**真实**检索（切段与建卡片不在本用例范围内）
      hook: async () => ({
        index,
        coldStart: { coldStartPassageMs: 0, coldStartPassageCount: passages.length, coldStartTotalMs: 0 },
        cacheHits: 0,
        cacheMisses: 0,
      }),
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
