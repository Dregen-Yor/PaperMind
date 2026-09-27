/**
 * 冷首问 runner（Task 7 Step 1）——受控 Promise 测试。
 *
 * 这里的核心是**时序证明**，不是「mock 被调用过」：
 * - `ask-at-lexical-ready` 必须在向量/目录就绪 Promise 仍 pending 时，就以阶段① 词法快照
 *   开始检索与流式回答（阶段① 无向量 ⇒ 检索模式为 bm25）；
 * - `ready-before-query` 必须等到请求的就绪阶段完成才碰检索/流式；
 * - 下一篇论文必须在前一篇的后台就绪 settle 之后才开始（冷启动互不污染）。
 */
import { describe, expect, it, vi } from 'vitest'

// Node 环境缺 DOMMatrix，pageIndex 顶层会初始化 pdfjs worker
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: {},
  getDocument: vi.fn(),
}))

const { runColdFirstQuery } = await import('../runner/coldFirstQuery')
const { materializeContext } = await import('../../../src/utils/contextTrace')
const { buildTitleCards, cardsToIndexNodes } = await import('../../../src/utils/structureCards')
const { PASSAGE_INDEX_VERSION, passageConfigHash } = await import('../../../src/utils/passageIndex')

import type { PdfStudySample } from '../types'
import type { PassageIndex } from '../../../src/utils/passageIndex'
import type { Passage } from '../../../src/utils/passages'
import type { Embedder } from '../../../src/utils/embedder'
import type { ContextGroup } from '../../../src/utils/contextTrace'
import type { PassageIndexHook, PassageIndexInfo } from '../runner/passageIndexHook'
import type { StreamingLlmClient } from '../llmClient'

/** 与受控物化同形态的确定性分词器：空白切词、1 词 1 token。 */
const tokenizer = { tokenize: (text: string) => text.split(/\s+/).filter(Boolean).map(word => `▁${word}`) }
const countTokens = (text: string) => tokenizer.tokenize(text).length
const CONTEXT_BUDGET = 4096

function passage(order: number, text: string, subsection: string): Passage {
  return {
    id: `P0${order + 1}`,
    order,
    pieces: [{ page: order, text }],
    text,
    searchText: text,
    tokenCount: countTokens(text),
    prevId: order > 0 ? `P0${order}` : null,
    nextId: order < 2 ? `P0${order + 2}` : null,
    subsection,
  }
}

const passages = [
  passage(0, 'Overview of the ranking protocol.', 'Overview'),
  passage(1, 'We evaluate on the alpha dataset.', 'Evaluation'),
  passage(2, 'Notes on the evaluation metrics.', 'Metrics'),
]

const DENSE_DIM = 8
const DENSE_ID = 'dense@main#q8'

function denseEmbedder(): Embedder & { embedQuery: ReturnType<typeof vi.fn>; embedPassages: ReturnType<typeof vi.fn> } {
  return {
    id: DENSE_ID,
    embedQuery: vi.fn(async () => new Float32Array(DENSE_DIM).fill(1)),
    embedPassages: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(DENSE_DIM).fill(1))),
  } as Embedder & { embedQuery: ReturnType<typeof vi.fn>; embedPassages: ReturnType<typeof vi.fn> }
}

function denseIndex(): PassageIndex {
  return {
    version: PASSAGE_INDEX_VERSION,
    stage: 2,
    passages,
    tree: cardsToIndexNodes(buildTitleCards(passages), passages),
    passageVectors: passages.map(() => new Float32Array(DENSE_DIM).fill(1)),
    vectorDim: DENSE_DIM,
    embedderId: DENSE_ID,
    passageConfigHash: passageConfigHash({ schemaVersion: 2, segmentation: { minTokens: 1, maxTokens: 350 } }),
    separatorTokens: 2,
  }
}

/** 阶段① 快照：标题树在、无段落向量（词法检索 = bm25）。 */
function bareIndex(): PassageIndex {
  const { passageVectors, vectorDim, embedderId, ...rest } = denseIndex()
  return { ...rest, stage: 1 }
}

function infoFor(index: PassageIndex): PassageIndexInfo {
  return {
    index,
    coldStart: { coldStartPassageMs: 0, coldStartPassageCount: passages.length, coldStartTotalMs: 0 },
    cacheHits: 0,
    cacheMisses: 0,
  }
}

function stubClient(): StreamingLlmClient {
  return {
    complete: vi.fn(async () => ''),
    chat: vi.fn(async () => ''),
    chatStream: vi.fn(async () => ({ content: 'answer' })),
    stats: () => ({ hits: 0, misses: 0 }),
    latencies: () => [],
    requestTimings: () => [],
    tokenSnapshot: () => ({ totalTokens: 0, incompleteRequestCount: 0 }),
    cacheEnabled: () => false,
  } as unknown as StreamingLlmClient
}

function pdfSample(paperId: string): PdfStudySample {
  return {
    paperId,
    title: paperId,
    pages: passages.map(p => p.text),
    questions: [{
      id: `${paperId}#0`,
      question: 'alpha',
      answers: ['a'],
      evidencePages: [0],
      unanswerable: false,
    }],
    source: 'pdf-study',
    pdfPath: `/tmp/${paperId}.pdf`,
    manifestFingerprint: `fp-${paperId}`,
    pdfOutline: [],
  }
}

const materialize = (groups: ContextGroup[]) => materializeContext(groups, tokenizer, CONTEXT_BUDGET)

/** 一个可以人工放行的就绪 Promise，附带「是否已 resolve」的观测。 */
function gatedReady(resolveValue: PassageIndexInfo): {
  ready: Promise<PassageIndexInfo>
  release: () => void
  readyResolved: () => boolean
} {
  let release!: () => void
  let resolved = false
  const gate = new Promise<void>(resolve => { release = resolve })
  const ready = new Promise<PassageIndexInfo>(resolve => {
    void gate.then(() => { resolved = true; resolve(resolveValue) })
  })
  return { ready, release, readyResolved: () => resolved }
}

function streamingAnswer(streamStarted: () => void) {
  return vi.fn(async (_messages: unknown, onVisibleText: (delta: string) => void) => {
    streamStarted()
    onVisibleText('answer token')
    return { content: 'answer token' }
  })
}

describe('runColdFirstQuery', () => {
  it('ask-at-lexical-ready 在向量就绪前就以阶段① 词法快照开始流式回答', async () => {
    const streamStarted = vi.fn()
    const stage2 = infoFor(denseIndex())
    const gate = gatedReady(stage2)
    const stage1 = infoFor(bareIndex())
    const createHook = (): PassageIndexHook => async () => ({ lexicalReady: stage1, ready: gate.ready })

    const runPromise = runColdFirstQuery({
      samples: [pdfSample('p1')],
      mode: 'hybrid-raw',
      strategy: 'ask-at-lexical-ready',
      client: stubClient(),
      systemPrompt: 'system',
      materialize,
      readPdf: async () => passages.map(p => p.text),
      initLocalModel: async () => undefined,
      createHook,
      countTokens,
      contextBudgetTokens: CONTEXT_BUDGET,
      streamAnswer: streamingAnswer(streamStarted),
    })

    // 检索 + 流式已经开始，但向量就绪仍被 gate 卡住
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(streamStarted).toHaveBeenCalledTimes(1)
    expect(gate.readyResolved()).toBe(false)

    gate.release()
    const result = await runPromise
    const record = result.records[0]
    expect(record.actualPassageStage).toBe(1)
    expect(record.retrievalMode).toBe('bm25')
    expect(record.completionStatus).toBe('completed')
    expect(record.timeToFirstTokenMs).toBeDefined()
    expect(record.fullAnswerLatencyMs).toBeDefined()
    // 回答期间向量尚未就绪；放行后由后台收尾补齐 dense 计时
    expect(record.denseReadyMs).toBeDefined()
  })

  it('ready-before-query 在就绪前不开始检索或流式回答', async () => {
    const streamStarted = vi.fn()
    const gate = gatedReady(infoFor(denseIndex()))
    const createHook = (): PassageIndexHook => async () => ({
      lexicalReady: infoFor(bareIndex()),
      ready: gate.ready,
    })

    const runPromise = runColdFirstQuery({
      samples: [pdfSample('p1')],
      mode: 'hybrid-raw',
      strategy: 'ready-before-query',
      client: stubClient(),
      systemPrompt: 'system',
      materialize,
      readPdf: async () => passages.map(p => p.text),
      initLocalModel: async () => denseEmbedder(),
      createHook,
      countTokens,
      contextBudgetTokens: CONTEXT_BUDGET,
      streamAnswer: streamingAnswer(streamStarted),
    })

    await new Promise(resolve => setTimeout(resolve, 0))
    expect(streamStarted).not.toHaveBeenCalled()
    expect(gate.readyResolved()).toBe(false)

    gate.release()
    const result = await runPromise
    const record = result.records[0]
    expect(record.actualPassageStage).toBe(2)
    expect(record.retrievalMode).toBe('bm25+dense')
    expect(record.denseReadyMs).toBeDefined()
    expect(record.completionStatus).toBe('completed')
  })

  it('下一篇论文在前一篇后台就绪 settle 之后才开始', async () => {
    const readOrder: string[] = []
    const readPdf = vi.fn(async (sample: PdfStudySample) => {
      readOrder.push(sample.paperId)
      return passages.map(p => p.text)
    })
    const streamStarted = vi.fn()
    const gate = gatedReady(infoFor(denseIndex()))
    const stage1 = infoFor(bareIndex())
    // p1 的后台就绪被 gate 卡住；p2 的就绪立即完成
    const createHook = (): PassageIndexHook => async sample => ({
      lexicalReady: stage1,
      ready: sample.paperId === 'p1' ? gate.ready : Promise.resolve(infoFor(denseIndex())),
    })

    const runPromise = runColdFirstQuery({
      samples: [pdfSample('p1'), pdfSample('p2')],
      mode: 'hybrid-raw',
      strategy: 'ask-at-lexical-ready',
      client: stubClient(),
      systemPrompt: 'system',
      materialize,
      readPdf,
      initLocalModel: async () => undefined,
      createHook,
      countTokens,
      contextBudgetTokens: CONTEXT_BUDGET,
      streamAnswer: streamingAnswer(streamStarted),
    })

    await new Promise(resolve => setTimeout(resolve, 0))
    // p1 已读完并开始回答，但 p1 的后台 ready 未 settle，p2 不得开始
    expect(readOrder).toEqual(['p1'])
    expect(streamStarted).toHaveBeenCalledTimes(1)
    expect(gate.readyResolved()).toBe(false)

    gate.release()
    const result = await runPromise
    expect(readOrder).toEqual(['p1', 'p2'])
    expect(streamStarted).toHaveBeenCalledTimes(2)
    expect(result.records).toHaveLength(2)
    expect(result.records[0].completionStatus).toBe('completed')
    expect(result.records[1].completionStatus).toBe('completed')
  })
})
