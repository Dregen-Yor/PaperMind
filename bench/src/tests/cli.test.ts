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
import type { PdfStudySample } from '../types'
import type { PdfOutlineEntry } from '../../../src/utils/pdfOutline'
import type { Embedder } from '../../../src/utils/embedder'
import type { StreamingLlmClient } from '../llmClient'

// Node 环境缺 DOMMatrix，pageIndex 顶层会初始化 pdfjs worker
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: {},
  getDocument: vi.fn(),
}))

const { runProductSweep } = await import('../runner/productSweep')
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
