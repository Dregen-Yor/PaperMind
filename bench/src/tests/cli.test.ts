/**
 * 产品实验端到端接线测试（Task 8 Step 1）——用假 embedder 与假流式客户端在**同一命令**
 * （`runProductSweep`）里跑 A/B/C/R 四臂，验证「outline-study 产品 sweep」真的接线：
 *
 * - A（lexical）/ B（hybrid-raw）/ C（hybrid-outline）在**同一批 3 篇 PDF** 上各跑一遍；
 * - C 臂的无效/缺失目录论文**仍留在全 PDF 分母**里，按 B 的 bm25+dense 回落；
 * - R 用 full-context 模式跑同一份 sample/question manifest；
 * - 6 条冷首问（3 臂 × 2 策略）也一并产出；
 * - 结果元数据钉住 PDF/outline/manifest 指纹与目录 valid/fallback 计数。
 *
 * 不发起任何真实模型 / embedder / 网络调用：假 embedder 返回全 1 向量，假流式客户端直接
 * 吐固定 token；BGE-M3 tokenizer 用空白切词的确定性替身。
 */
import { describe, expect, it, vi } from 'vitest'
import type { BenchResult, ColdFirstQueryResult, PdfStudySample } from '../types'
import type { PdfOutlineEntry } from '../../../src/utils/pdfOutline'
import type { Embedder } from '../../../src/utils/embedder'
import type { StreamingLlmClient } from '../llmClient'
import type { ProductSweepArgs } from '../runner/productSweep'
import type { QConfig } from '../scoring/qScore'
import { qFixture, qConfig } from './qFixture'

// Node 环境缺 DOMMatrix，pageIndex 顶层会初始化 pdfjs worker
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: {},
  getDocument: vi.fn(),
}))

const { runProductSweep, hasHarnessFailure, finalizeProductSweep } = await import('../runner/productSweep')
const { buildEvaluationContract, composeBaseSystemPrompt } = await import('../evaluationContract')
const { buildSpeedRunContract } = await import('../speed/contract')
const { executedQuestions } = await import('../evaluationContract')

const ENGLISH_ANSWER_INSTRUCTION = 'Please answer in the paper language (English).'

/** 与受控物化同形态的确定性分词器：空白切词、1 词 1 token。 */
const tokenizer = { tokenize: (text: string) => text.split(/\s+/).filter(Boolean).map(word => `▁${word}`) }

const DENSE_DIM = 8
const DENSE_ID = 'fake-embedder@main#q8'

function fakeEmbedder(): Embedder & { embedQuery: ReturnType<typeof vi.fn>; embedPassages: ReturnType<typeof vi.fn> } {
  return {
    id: DENSE_ID,
    embedQuery: vi.fn(async () => new Float32Array(DENSE_DIM).fill(1)),
    embedPassages: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(DENSE_DIM).fill(1))),
  } as Embedder & { embedQuery: ReturnType<typeof vi.fn>; embedPassages: ReturnType<typeof vi.fn> }
}

function streamingClient(): StreamingLlmClient {
  let totalTokens = 0
  const complete = vi.fn(async () => '')
  return {
    complete,
    chat: vi.fn(async () => 'answer'),
    chatStream: vi.fn(async (_messages: unknown, onVisibleText: (delta: string) => void) => {
      onVisibleText('answer')
      return { content: 'answer' }
    }),
    stats: () => ({ hits: 0, misses: 0 }),
    latencies: () => [],
    requestTimings: () => [],
    tokenSnapshot: () => ({ totalTokens: (totalTokens += 5), incompleteRequestCount: 0 }),
    cacheEnabled: () => false,
  } as unknown as StreamingLlmClient
}

/** 每页 ~300 词：在配置 minTokens=120 / maxTokens=350 下每页独立成一段，检索口径可预测。 */
function pageText(seed: string, page: number): string {
  const sentence = `${seed} page ${page} sentence about local passage retrieval with many tokens. `
  return sentence.repeat(24)
}

function questionsFor(paperId: string): PdfStudySample['questions'] {
  return Array.from({ length: 4 }, (_, i) => ({
    id: `${paperId}#${i}`,
    question: `What does ${paperId} page ${i} claim about retrieval?`,
    answers: [`answer ${i}`],
    evidencePages: [i % 3],
    unanswerable: false,
    qualityAnswers: [`answer ${i}`],
    qualityDefinition: 'pdf-qa-all-questions-v1' as const,
  }))
}

/** 目录：两篇带原生目录，一篇（BERT 式）刻意无目录——验证「无目录即回落 B 且留在分母」。 */
function outlineFor(paperId: string, pages: number): PdfOutlineEntry[] {
  if (paperId === 'no-outline.pdf') return []
  return [
    { id: '0', title: 'Introduction', page: 0, children: [] },
    { id: '1', title: 'Methods', page: Math.min(1, pages - 1), children: [] },
  ]
}

function pdfSample(paperId: string, pages: number): PdfStudySample {
  const pageTexts = Array.from({ length: pages }, (_, i) => pageText(paperId, i))
  return {
    paperId,
    title: paperId,
    pages: pageTexts,
    questions: questionsFor(paperId),
    source: 'pdf-study',
    pdfPath: `/tmp/${paperId}`,
    manifestFingerprint: `manifest-${paperId}`,
    pdfFingerprint: `pdf-${paperId}`,
    outlineFingerprint: paperId === 'no-outline.pdf' ? 'outline-empty' : `outline-${paperId}`,
    pdfOutline: outlineFor(paperId, pages),
  }
}

const samples = [
  pdfSample('01-attention.pdf', 3),
  pdfSample('02-deep-sets.pdf', 3),
  pdfSample('no-outline.pdf', 3),
]

describe('outline-study product sweep（Task 8）', () => {
  it('一条命令跑 A/B/C/R：C 无目录论文回落 B 且留在全 PDF 分母，R 走 full-context', async () => {
    const client = streamingClient()
    const embedder = fakeEmbedder()
    const evaluationContract = buildEvaluationContract(samples)
    const speedContract = buildSpeedRunContract({
      datasetFingerprint: evaluationContract.datasetFingerprint,
      executedQuestionIds: executedQuestions(samples).map(({ question }) => question.id),
      provider: 'openai',
      model: 'fake-model',
      baseUrl: 'https://fake.example/v1',
      retryAttempts: 0,
      answerSystemPrompt: composeBaseSystemPrompt('system', ENGLISH_ANSWER_INSTRUCTION),
      generationSettings: { temperature: 0, maxTokens: 4096 },
      environment: { platform: 'darwin', arch: 'arm64', nodeVersion: 'v22' },
    })

    let clock = 0
    const result = await runProductSweep({
      samples,
      gitSha: 'abc1234',
      model: 'fake-model',
      systemPrompt: 'system',
      answerLanguageInstruction: ENGLISH_ANSWER_INSTRUCTION,
      tokenizer,
      contextBudgetTokens: 4096,
      client,
      embedder,
      speedContract,
      readPdf: async sample => sample.pages,
      now: () => (clock += 1),
    })

    // 四条热结果：lexical / hybrid-raw / hybrid-outline / full-context（R）
    expect(result.hot).toHaveLength(4)
    const [lexical, hybridRaw, hybridOutline, fullContext] = result.hot
    expect(lexical.config.name).toBe('structure-lexical')
    expect(hybridRaw.config.name).toBe('structure-hybrid-raw')
    expect(hybridOutline.config.name).toBe('structure-hybrid-outline')
    expect(fullContext.meta.mode).toBe('full-context')

    // 每臂跑满同一批 3 篇 PDF / 12 题
    for (const hot of result.hot) {
      expect(hot.meta.total).toBe(12)
      expect(hot.meta.completed).toBe(12)
    }

    // A 全部 bm25；B 全部 bm25+dense
    expect(lexical.perSample.map(record => record.retrievalMode)).toEqual(Array(12).fill('bm25'))
    expect(hybridRaw.perSample.map(record => record.retrievalMode)).toEqual(Array(12).fill('bm25+dense'))

    // C：两篇带目录的论文走 bm25+dense+outline，无目录论文走 bm25+dense（预声明回落），全部留在分母
    const outlineModes = hybridOutline.perSample.map(record => record.retrievalMode)
    expect(outlineModes.filter(mode => mode === 'bm25+dense+outline')).toHaveLength(8)
    expect(outlineModes.filter(mode => mode === 'bm25+dense')).toHaveLength(4)
    expect(hybridOutline.meta.total).toBe(12)

    // 目录 valid/fallback 计数：2 篇可用、1 篇回落
    expect(hybridOutline.metrics.outlineAvailableCount).toBe(2)
    expect(hybridOutline.metrics.outlineFallbackCount).toBe(1)
    expect(hybridOutline.metrics.outlineAvailabilityRate).toBeCloseTo(2 / 3)

    // 目录使用率：只有两篇可用目录论文的 8 题真正用上目录先验
    expect(hybridOutline.metrics.outlineUsedRate).toBeCloseTo(8 / 12)

    // 结果元数据钉住 manifest 指纹（pdf-study 质量协议既有键），且 PDF/outline 指纹也落盘
    expect(fullContext.meta.qaQualityManifestFingerprint).toBeTypeOf('string')
    expect((fullContext.meta.qaQualityManifestFingerprint as string).length).toBe(64)
    expect(hybridOutline.meta.pdfStudyPdfFingerprint).toBeTypeOf('string')
    expect(hybridOutline.meta.pdfStudyOutlineFingerprint).toBeTypeOf('string')

    // A/B/C 索引阶段零生成式 LLM 调用（`complete` 从未被调用）
    expect((client.complete as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)

    // 六条冷首问：3 臂 × 2 策略
    expect(result.cold).toHaveLength(6)
    const coldModes = result.cold.map(cold => cold.mode)
    expect(coldModes.filter(mode => mode === 'lexical')).toHaveLength(2)
    expect(coldModes.filter(mode => mode === 'hybrid-raw')).toHaveLength(2)
    expect(coldModes.filter(mode => mode === 'hybrid-outline')).toHaveLength(2)
    for (const cold of result.cold) {
      expect(cold.records).toHaveLength(3)
      expect(cold.records.every(record => record.completionStatus === 'completed')).toBe(true)
    }
  })
})

/** 上一条用例之外的 sweep 参数：同一条契约、假 embedder/假客户端、确定性时钟。 */
function sweepArgs(overrides: Partial<ProductSweepArgs> = {}): ProductSweepArgs {
  const evaluationContract = buildEvaluationContract(samples)
  const speedContract = buildSpeedRunContract({
    datasetFingerprint: evaluationContract.datasetFingerprint,
    executedQuestionIds: executedQuestions(samples).map(({ question }) => question.id),
    provider: 'openai',
    model: 'fake-model',
    baseUrl: 'https://fake.example/v1',
    retryAttempts: 0,
    answerSystemPrompt: composeBaseSystemPrompt('system', ENGLISH_ANSWER_INSTRUCTION),
    generationSettings: { temperature: 0, maxTokens: 4096 },
    environment: { platform: 'darwin', arch: 'arm64', nodeVersion: 'v22' },
  })
  let clock = 0
  return {
    samples,
    gitSha: 'abc1234',
    model: 'fake-model',
    systemPrompt: 'system',
    answerLanguageInstruction: ENGLISH_ANSWER_INSTRUCTION,
    tokenizer,
    contextBudgetTokens: 4096,
    client: streamingClient(),
    embedder: fakeEmbedder(),
    speedContract,
    readPdf: async sample => sample.pages,
    now: () => (clock += 1),
    ...overrides,
  }
}

describe('sweep 逐臂回调与退出码口径（Issue 1/2 修复）', () => {
  it('每完成一臂即回调 onHot / onCold，顺序与臂序一致（落盘发生在臂内，不是整批）', async () => {
    const onHot = vi.fn()
    const onCold = vi.fn()
    await runProductSweep({ ...sweepArgs(), onHot, onCold })

    expect(onHot.mock.calls.map(([result]) => result.config.name)).toEqual([
      'structure-lexical', 'structure-hybrid-raw', 'structure-hybrid-outline', 'full-context',
    ])
    expect(onCold).toHaveBeenCalledTimes(6)
    expect(onCold.mock.calls.map(([cold]) => cold.mode)).toEqual([
      'lexical', 'lexical', 'hybrid-raw', 'hybrid-raw', 'hybrid-outline', 'hybrid-outline',
    ])
  })

  it('某臂抛错时，已完成的臂仍经回调交付（不再整批丢弃）', async () => {
    const delivered: string[] = []
    const onHot = (result: BenchResult) => {
      delivered.push(result.config.name)
      if (delivered.length === 2) throw new Error('arm boom')
    }
    await expect(runProductSweep({ ...sweepArgs(), onHot })).rejects.toThrow('arm boom')
    // 第一臂已在第二臂抛错前交付——正是「逐臂落盘」要保住的东西
    expect(delivered).toEqual(['structure-lexical', 'structure-hybrid-raw'])
  })
})

describe('sweep 冷首问本地模型初始化计时（Fix 2）', () => {
  it('冷首问各自懒加载一份全新 embedder：localModelInitMs 记真实初始化成本而非复用热臂实例', async () => {
    let clock = 0
    // 注入的工厂每被调用一次即模拟 100ms 真实模型初始化成本
    const initColdEmbedder = vi.fn(async () => {
      clock += 100
      return fakeEmbedder()
    })
    const result = await runProductSweep({
      ...sweepArgs({ initColdEmbedder }),
      now: () => (clock += 1),
    })

    // 只有 hybrid 臂加载稠密模型：hybrid-raw / hybrid-outline × 2 策略，各轮首篇付一次真实加载
    expect(initColdEmbedder).toHaveBeenCalledTimes(4)

    const hybridColds = result.cold.filter(cold => cold.mode !== 'lexical')
    expect(hybridColds).toHaveLength(4)
    for (const cold of hybridColds) {
      // 首篇计入注入的初始化成本（>= 100ms），而不是复用热臂已预热实例的 ~0
      expect(cold.records[0].localModelInitMs).toBeGreaterThanOrEqual(100)
      // 后续篇命中本轮已加载实例，不再重复付加载成本
      expect(cold.records.slice(1).every(record => record.localModelInitMs < 100)).toBe(true)
    }
  })
})

describe('hasHarnessFailure（sweep 与主路径共用的退出码判定）', () => {
  const counts = (completed: number, total: number): BenchResult => ({
    task: 'qa', config: { name: 'x' }, metrics: {}, perSample: [], errors: [],
    meta: { model: 'm', timestamp: 't', gitSha: 's', completed, total },
  })

  /** 冷首问结果 fixture：只有 completionStatus 序列是可变量，其余字段取稳定值。 */
  const cold = (statuses: Array<'completed' | 'failed' | 'skipped'>): ColdFirstQueryResult => ({
    definition: 'cold-first-query-v1',
    mode: 'hybrid-raw',
    strategy: 'ready-before-query',
    records: statuses.map((completionStatus, i) => ({
      id: `p${i}#0`,
      paperId: `p${i}`,
      strategy: 'ready-before-query',
      inputKind: 'pdf-bytes',
      pdfLoadMs: 1,
      localModelInitMs: 1,
      lexicalReadyMs: 1,
      actualPassageStage: 1,
      completionStatus,
    })),
    metrics: {},
  })

  it('整轮零完成 → true（exit 1）；有任何完成 → false（exit 0）', () => {
    // API key 配错的整轮零完成：判为 harness 故障
    expect(hasHarnessFailure([counts(0, 12), counts(0, 12)])).toBe(true)
    // 与主路径同一口径（some）：任一结果 completed=0 即整轮失败
    expect(hasHarnessFailure([counts(0, 12), counts(12, 12)])).toBe(true)
    expect(hasHarnessFailure([counts(12, 12), counts(12, 12)])).toBe(false)
    expect(hasHarnessFailure([])).toBe(false)
  })

  it('冷首问整轮零完成 → true；部分完成 → false；空记录 → false', () => {
    // 全部失败 / 全部跳过 = 零完成，判为 harness 故障（exit 1）
    expect(hasHarnessFailure([cold(['failed', 'failed']), cold(['skipped', 'failed'])])).toBe(true)
    // 有任何一篇完成即部分完成，是正常数据点（exit 0）
    expect(hasHarnessFailure([cold(['completed', 'failed']), cold(['completed'])])).toBe(false)
    expect(hasHarnessFailure([cold([])])).toBe(false)
    // 热冷混合：任一零完成即整轮失败
    expect(hasHarnessFailure([counts(0, 12), cold(['completed'])])).toBe(true)
  })
})

/** 产品三表 fixture：与 report.test.ts 的 pdfStudyFixture 同形（补 Q 需要的身份字段）。 */
function productFixture(name: string, mode: 'rag' | 'full-context' = 'rag'): BenchResult {
  const fixture = qFixture(name, mode)
  fixture.meta.qaQualityDefinition = 'pdf-qa-all-questions-v1'
  fixture.meta.qaQualitySource = 'pdf-study'
  fixture.meta.qaQualityManifestFingerprint = 'manifest-pdf'
  fixture.meta.pdfStudyPdfFingerprint = 'pdf-fp'
  fixture.meta.pdfStudyOutlineFingerprint = 'outline-fp'
  for (const row of fixture.perSample) row.source = 'pdf-study'
  return fixture
}

/** 速度优先 Q 权重（`configs/scoring/q-speed-first.json` 的口径）。 */
const qSpeedConfig: QConfig = {
  schemaVersion: 1, formula: 'weighted-geometric-relative-v1', baselineMode: 'full-context',
  weights: { answerF1: 0.2, ttftP50: 0.4, ttftP95: 0.4 },
}

describe('finalizeProductSweep（Issue 2：meta 定格 + 三表装配）', () => {
  it('定格 cacheMode/mode，并按有无参考把 Q 列渲染成数字或 —', () => {
    const reference = productFixture('full-context', 'full-context')
    const arm = productFixture('structure-lexical')
    const { hot, report } = finalizeProductSweep([arm, reference], [], { qDefault: qConfig, qSpeed: qSpeedConfig })

    // 非 full-context 臂一律标 rag；R 保持 full-context；两条都跳过读缓存
    expect(hot[0].meta.mode).toBe('rag')
    expect(hot[0].meta.cacheMode).toBe('bypass')
    expect(hot[1].meta.mode).toBe('full-context')
    expect(hot[1].meta.cacheMode).toBe('bypass')
    // 候选与参考逐字相同 → 两套权重下 Q 都是 100.00（Q 单元格渲染出数字）
    expect(report).toContain('| 100.00 | 100.00 |')

    // 无 full-context 参考 → 不硬造 Q，两列渲染 —
    const noRef = finalizeProductSweep([productFixture('structure-lexical')], [], { qDefault: qConfig, qSpeed: qSpeedConfig })
    expect(noRef.report).toContain('| — | — |')
  })
})
