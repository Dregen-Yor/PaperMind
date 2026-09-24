import { describe, expect, it, vi } from 'vitest'
import type { IndexNode } from '../../../src/utils/pageIndex'
import type { ContextGroup } from '../../../src/utils/contextTrace'
import type { PipelineRetrieval, RagGenerationStage, RagRetrievalStage } from '../../../src/utils/ragPipeline'
import type { LlmClient, StreamingLlmClient } from '../llmClient'
import type { QaTaskDeps } from '../runner/qa'
import type { SpeedRunContract } from '../speed/contract'
import type {
  BenchResult,
  EvalSample,
  HybridRerankConfig,
  LongSectionRagConfig,
  PerSampleRecord,
  SemanticTreeParams,
  TraditionalRagConfig,
} from '../types'

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: {},
  getDocument: vi.fn(),
}))

const { materializeContext } = await import('../../../src/utils/contextTrace')
const { buildEvaluationContract, CONTEXT_BUDGET_TOKENS } = await import('../evaluationContract')
const { runFullContextQaTask } = await import('../runner/fullContextQa')
const { runHybridRerankQaTask } = await import('../runner/hybridRerankQa')
const { runLongSectionQaTask } = await import('../runner/longSectionQa')
const { runQaTask } = await import('../runner/qa')
const { runSemanticTreeQaTask } = await import('../runner/semanticTreeQa')
const { runTraditionalRagQaTask } = await import('../runner/traditionalRagQa')

const qualityMetricKeys = [
  'contextPageMrr', 'evidenceRecall', 'evidenceHitRate', 'contextPrecision',
  'answerF1', 'unanswerableAccuracy',
  'judgeFactuality', 'judgeCompleteness', 'judgeGroundedness',
] as const

const perSampleQualityMetricKeys = [
  'contextPageMrr', 'evidenceRecall', 'evidenceHit', 'contextPrecision',
  'answerF1', 'unanswerableAccuracy',
  'judgeFactuality', 'judgeCompleteness', 'judgeGroundedness',
] as const

const answerableQuestion = {
  id: 'q-answerable',
  question: 'evidence',
  answers: ['answer'],
  evidencePages: [0],
  unanswerable: false,
}

const unanswerableQuestion = {
  id: 'q-unanswerable',
  question: 'missing',
  answers: [],
  evidencePages: [],
  unanswerable: true,
}

const sample: EvalSample = {
  paperId: 'paper',
  title: 'Paper',
  source: 'smoke',
  pages: ['evidence answer supporting context with enough words'],
  questions: [answerableQuestion, unanswerableQuestion],
}

const tree: IndexNode = {
  title: 'Paper',
  nodeId: 'root',
  startPage: 0,
  endPage: 0,
  summary: '',
  nodes: [],
}

const semanticTreeParams: SemanticTreeParams = {
  evidence: { targetChars: 40, maxChars: 80, minChars: 10 },
  maxInputChars: 10_000,
}

const semanticTreeJson = JSON.stringify({
  root: {
    id: 'root',
    label: 'Evidence',
    description: 'The paper evidence',
    relationToParent: null,
    evidenceRefs: ['B001'],
    children: [],
  },
})

const oneTokenPerPiece = { tokenize: (text: string) => (text ? [text] : []) }
const materialize = (groups: ContextGroup[]) =>
  materializeContext(groups, oneTokenPerPiece, CONTEXT_BUDGET_TOKENS)

const judgeClient: LlmClient = {
  complete: async prompt => prompt.includes('只回一个词')
    ? 'REFUSAL'
    : '{"factuality":5,"completeness":4,"groundedness":3}',
  chat: async () => '',
  stats: () => ({ hits: 0, misses: 0 }),
  latencies: () => [],
  requestTimings: () => [],
}

function answerFor(question: string): string {
  return question === unanswerableQuestion.question
    ? '无法根据给定内容回答。'
    : 'answer'
}

function answerClient(speed: boolean, complete: LlmClient['complete'] = async () => ''): LlmClient {
  const base: LlmClient = {
    complete,
    chat: async messages => answerFor(messages[messages.length - 1]?.content ?? ''),
    stats: () => ({ hits: 0, misses: 0 }),
    latencies: () => [],
    requestTimings: () => [],
  }
  if (!speed) return base

  let totalTokens = 0
  const streaming: StreamingLlmClient = {
    ...base,
    chatStream: async (messages, onVisibleText) => {
      const answer = answerFor(messages[messages.length - 1]?.content ?? '')
      onVisibleText(answer)
      return { content: answer }
    },
    tokenSnapshot: () => ({ totalTokens: totalTokens += 5, incompleteRequestCount: 0 }),
    cacheEnabled: () => false,
  }
  return streaming
}

function speedContract(datasetFingerprint: string): SpeedRunContract {
  return {
    speedMetricSchemaVersion: 2,
    speedDefinition: 'query-timeline-v2',
    datasetFingerprint,
    executedQuestionIdsHash: 'quality-regression-question-ids',
    streaming: true,
    llmCacheEnabled: false,
    queryConcurrency: 1,
    retryAttempts: 0,
    answerModelIdentity: 'quality-regression-answer-model',
    answerFramingIdentityHash: 'quality-regression-answer-framing',
    endpointIdentity: 'quality-regression-endpoint',
    generationSettingsHash: 'quality-regression-generation-settings',
    executionEnvironmentFingerprint: 'quality-regression-environment',
  }
}

function speedOptions(client: LlmClient, datasetFingerprint: string) {
  let timestamp = 0
  return {
    contract: speedContract(datasetFingerprint),
    now: () => (timestamp += 10),
    streamAnswer: (client as StreamingLlmClient).chatStream,
  }
}

function pipelineRetrieval(): PipelineRetrieval {
  return {
    context: sample.pages[0],
    contextGroups: [{ pieces: [{ page: 0, text: sample.pages[0] }] }],
    sources: ['Page 1'],
    selected: [tree],
    scores: [{ id: 0, score: 1 }],
    degraded: false,
    llmCalled: true,
  }
}

function retrievalStage(question: string): RagRetrievalStage {
  return {
    retrievals: [pipelineRetrieval()],
    retrievalQuery: question,
    rewritten: false,
    context: sample.pages[0],
    contextPageOrder: [0],
    contextTokenCount: 1,
    contextTruncated: false,
    sources: ['Page 1'],
    llmCalls: 1,
    treeRouted: false,
    queryRewriteLatencyMs: 0,
    retrievalLatencyMs: 0,
    pipelineStartedAt: 0,
  }
}

function qaDeps(): QaTaskDeps {
  return {
    buildIndex: vi.fn().mockResolvedValue(tree),
    retrieveContext: vi.fn(async (_papers, question) => retrievalStage(question)),
    generateAnswer: vi.fn(async (_retrieval, question): Promise<RagGenerationStage> => ({
      answer: answerFor(question),
      answerGenerationLatencyMs: 0,
      queryEndToEndLatencyMs: 0,
    })),
  }
}

function pickMetrics<const T extends readonly string[]>(metrics: Record<string, number>, keys: T) {
  return Object.fromEntries(keys.map(key => [key, metrics[key]])) as Record<T[number], number | undefined>
}

function perSampleQuality(record: PerSampleRecord) {
  return {
    id: record.id,
    metrics: pickMetrics(record.metrics, perSampleQualityMetricKeys),
    retrievalStatus: record.retrievalStatus,
    generationStatus: record.generationStatus,
    judgeStatus: record.judgeStatus,
    retrievalQuery: record.retrievalQuery,
    contextPageOrder: record.contextPageOrder,
    contextTokenCount: record.contextTokenCount,
    contextTruncated: record.contextTruncated,
    selectedPages: record.selectedPages,
    evidencePages: record.evidencePages,
    answer: record.answer,
  }
}

function qualityProjection(result: BenchResult) {
  // This allowlist intentionally materializes every protected key, even when undefined.
  // Speed identities, speed samples, meta identities, and timing diagnostics are the only
  // result families omitted from the comparison.
  return {
    metrics: pickMetrics(result.metrics, qualityMetricKeys),
    perSample: result.perSample.map(perSampleQuality),
  }
}

const expectedRetrievalQuality = {
  metrics: {
    contextPageMrr: 1,
    evidenceRecall: 1,
    evidenceHitRate: 1,
    contextPrecision: 1,
    answerF1: 1,
    unanswerableAccuracy: 1,
    judgeFactuality: 5,
    judgeCompleteness: 4,
    judgeGroundedness: 3,
  },
  perSample: [
    {
      id: 'q-answerable',
      metrics: {
        contextPageMrr: 1,
        evidenceRecall: 1,
        evidenceHit: 1,
        contextPrecision: 1,
        answerF1: 1,
        unanswerableAccuracy: undefined,
        judgeFactuality: 5,
        judgeCompleteness: 4,
        judgeGroundedness: 3,
      },
      retrievalStatus: 'completed',
      generationStatus: 'completed',
      judgeStatus: 'completed',
      retrievalQuery: 'evidence',
      contextPageOrder: [0],
      contextTokenCount: 1,
      contextTruncated: false,
      selectedPages: [0],
      evidencePages: [0],
      answer: 'answer',
    },
    {
      id: 'q-unanswerable',
      metrics: {
        contextPageMrr: undefined,
        evidenceRecall: undefined,
        evidenceHit: undefined,
        contextPrecision: undefined,
        answerF1: undefined,
        unanswerableAccuracy: 1,
        judgeFactuality: undefined,
        judgeCompleteness: undefined,
        judgeGroundedness: undefined,
      },
      retrievalStatus: 'ineligible',
      generationStatus: 'completed',
      judgeStatus: 'completed',
      retrievalQuery: 'missing',
      contextPageOrder: [0],
      contextTokenCount: 1,
      contextTruncated: false,
      selectedPages: [0],
      evidencePages: [],
      answer: '无法根据给定内容回答。',
    },
  ],
}

const expectedFullContextQuality = {
  metrics: {
    contextPageMrr: undefined,
    evidenceRecall: undefined,
    evidenceHitRate: undefined,
    contextPrecision: undefined,
    answerF1: 1,
    unanswerableAccuracy: 1,
    judgeFactuality: 5,
    judgeCompleteness: 4,
    judgeGroundedness: 3,
  },
  perSample: [
    {
      id: 'q-answerable',
      metrics: {
        contextPageMrr: undefined,
        evidenceRecall: undefined,
        evidenceHit: undefined,
        contextPrecision: undefined,
        answerF1: 1,
        unanswerableAccuracy: undefined,
        judgeFactuality: 5,
        judgeCompleteness: 4,
        judgeGroundedness: 3,
      },
      retrievalStatus: undefined,
      generationStatus: 'completed',
      judgeStatus: 'completed',
      retrievalQuery: undefined,
      contextPageOrder: undefined,
      contextTokenCount: undefined,
      contextTruncated: undefined,
      selectedPages: undefined,
      evidencePages: [0],
      answer: 'answer',
    },
    {
      id: 'q-unanswerable',
      metrics: {
        contextPageMrr: undefined,
        evidenceRecall: undefined,
        evidenceHit: undefined,
        contextPrecision: undefined,
        answerF1: undefined,
        unanswerableAccuracy: 1,
        judgeFactuality: undefined,
        judgeCompleteness: undefined,
        judgeGroundedness: undefined,
      },
      retrievalStatus: undefined,
      generationStatus: 'completed',
      judgeStatus: 'completed',
      retrievalQuery: undefined,
      contextPageOrder: undefined,
      contextTokenCount: undefined,
      contextTruncated: undefined,
      selectedPages: undefined,
      evidencePages: [],
      answer: '无法根据给定内容回答。',
    },
  ],
}

async function runPaperMind(speed: boolean): Promise<BenchResult> {
  const evaluationContract = buildEvaluationContract([sample])
  const client = answerClient(speed)
  return runQaTask({
    samples: [sample],
    config: { name: 'quality-papermind', kind: 'papermind' },
    client,
    systemPrompt: 'system',
    gitSha: 'main-quality-baseline',
    model: 'answer-model',
    judgeClient,
    judgeModel: 'judge-model',
    now: () => 0,
    deps: qaDeps(),
    materialize,
    evaluationContract,
    ...(speed ? { speed: speedOptions(client, evaluationContract.datasetFingerprint) } : {}),
  })
}

async function runSemanticTree(speed: boolean): Promise<BenchResult> {
  const evaluationContract = buildEvaluationContract([sample])
  const client = answerClient(speed, async () => semanticTreeJson)
  return runSemanticTreeQaTask({
    samples: [sample],
    config: { name: 'quality-semantic-tree', kind: 'semantic-tree', semanticTree: semanticTreeParams },
    client,
    systemPrompt: 'system',
    gitSha: 'main-quality-baseline',
    model: 'answer-model',
    judgeClient,
    judgeModel: 'judge-model',
    now: () => 0,
    deps: qaDeps(),
    materialize,
    evaluationContract,
    ...(speed ? { speed: speedOptions(client, evaluationContract.datasetFingerprint) } : {}),
  })
}

const traditionalConfig: TraditionalRagConfig = {
  name: 'quality-traditional',
  kind: 'traditional-rag',
  chunking: { tokenizer: 'bge-m3', chunkSize: 16, overlap: 0 },
  retrieval: { algorithm: 'jaccard', topK: 1 },
  generationContext: { topK: 1, maxTokens: CONTEXT_BUDGET_TOKENS },
}

async function runTraditional(speed: boolean): Promise<BenchResult> {
  const evaluationContract = buildEvaluationContract([sample])
  const client = answerClient(speed)
  return runTraditionalRagQaTask({
    samples: [sample],
    config: traditionalConfig,
    client,
    systemPrompt: 'system',
    gitSha: 'main-quality-baseline',
    model: 'answer-model',
    judgeClient,
    judgeModel: 'judge-model',
    now: () => 0,
    materialize,
    evaluationContract,
    deps: {
      tokenizer: { tokenize: text => text.split(/\s+/).filter(Boolean) },
      buildRetriever: async chunks => ({ chunks, score: async () => [{ id: 0, score: 1 }] }),
      generateAnswer: async (_system, question) => answerFor(question),
    },
    ...(speed ? { speed: speedOptions(client, evaluationContract.datasetFingerprint) } : {}),
  })
}

const hybridConfig: HybridRerankConfig = {
  name: 'quality-hybrid',
  kind: 'hybrid-rerank',
  chunking: { tokenizer: 'bge-m3', chunkSize: 16, overlap: 0 },
  retrieval: {
    bm25: { topK: 1, k1: 1.2, b: 0.75 },
    dense: {
      topK: 1,
      embedding: {
        model: 'BAAI/bge-m3',
        revision: 'main',
        queryPrefix: '',
        normalize: true,
        maxLength: 8192,
      },
    },
    rrf: { k: 60, topK: 1 },
    reranker: { model: 'test/reranker', revision: 'main', topK: 1, maxLength: 512 },
  },
  generationContext: { topK: 1, maxTokens: CONTEXT_BUDGET_TOKENS },
}

async function runHybrid(speed: boolean): Promise<BenchResult> {
  const evaluationContract = buildEvaluationContract([sample])
  const client = answerClient(speed)
  return runHybridRerankQaTask({
    samples: [sample],
    config: hybridConfig,
    client,
    systemPrompt: 'system',
    gitSha: 'main-quality-baseline',
    model: 'answer-model',
    judgeClient,
    judgeModel: 'judge-model',
    now: () => 0,
    materialize,
    evaluationContract,
    llmEndpointIdentity: 'endpoint',
    systemPromptHash: 'system-prompt',
    deps: {
      tokenizer: { tokenize: text => text.split(/\s+/).filter(Boolean).map(token => `▁${token}`) },
      denseProvider: { embed: async texts => texts.map(() => [1, 0]) },
      reranker: { score: async pairs => pairs.map(() => 1) },
    },
    generateAnswer: async (_system, question) => answerFor(question),
    ...(speed ? { speed: speedOptions(client, evaluationContract.datasetFingerprint) } : {}),
  })
}

const longSectionConfig: LongSectionRagConfig = {
  name: 'quality-long-section',
  kind: 'long-section-rag',
  anchors: { tokenizer: 'bge-m3', chunkSize: 16, overlap: 0 },
  retrieval: { algorithm: 'bm25', topK: 1, k1: 1.2, b: 0.75 },
  generationContext: { topK: 1, maxTokens: CONTEXT_BUDGET_TOKENS },
}

async function runLongSection(speed: boolean): Promise<BenchResult> {
  const evaluationContract = buildEvaluationContract([sample])
  const client = answerClient(speed)
  const tokenizer = { tokenize: (text: string) => text.split(/\s+/).filter(Boolean).map(token => `▁${token}`) }
  return runLongSectionQaTask({
    samples: [sample],
    config: longSectionConfig,
    client,
    systemPrompt: 'system',
    gitSha: 'main-quality-baseline',
    model: 'answer-model',
    judgeClient,
    judgeModel: 'judge-model',
    now: () => 0,
    materialize,
    evaluationContract,
    llmEndpointIdentity: 'endpoint',
    systemPromptHash: 'system-prompt',
    deps: {
      tokenizer,
      detectSections: pages => [{
        title: 'All',
        startToken: 0,
        endToken: tokenizer.tokenize(pages.join('\n')).length,
        startPage: 0,
        endPage: 0,
      }],
    },
    generateAnswer: async (_system, question) => answerFor(question),
    ...(speed ? { speed: speedOptions(client, evaluationContract.datasetFingerprint) } : {}),
  })
}

async function runFullContext(speed: boolean): Promise<BenchResult> {
  const client = answerClient(speed)
  return runFullContextQaTask({
    samples: [sample],
    config: { name: 'quality-full-context', kind: 'papermind' },
    client,
    systemPrompt: 'system',
    gitSha: 'main-quality-baseline',
    model: 'answer-model',
    judgeClient,
    judgeModel: 'judge-model',
    now: () => 0,
    ...(speed ? { speed: speedOptions(client, 'full-context-quality-regression') } : {}),
  })
}

describe('speed mode quality regression', () => {
  it('counts online full-context assembly in TTFT but excludes paper preparation', async () => {
    const measure = async (preparationMs: number, assemblyMs: number) => {
      let clock = 0
      const pages = ['paper evidence']
      const join = pages.join.bind(pages)
      let prepared = false
      pages.join = (separator?: string) => {
        if (!prepared) { clock += preparationMs; prepared = true }
        return join(separator)
      }
      const question = { ...answerableQuestion }
      let assembled = false
      Object.defineProperty(question, 'question', {
        get: () => {
          if (!assembled) { clock += assemblyMs; assembled = true }
          return 'evidence'
        },
      })
      const fixture = { ...sample, pages, questions: [question] }
      const client = answerClient(true) as StreamingLlmClient
      const result = await runFullContextQaTask({
        samples: [fixture],
        config: { name: 'timing', kind: 'papermind' },
        client,
        systemPrompt: 'system',
        gitSha: 'test',
        model: 'answer-model',
        now: () => clock,
        speed: {
          ...speedOptions(client, 'timing'),
          now: () => clock,
          streamAnswer: async (_messages, onVisibleText) => {
            clock += 3
            onVisibleText('answer')
            clock += 2
            return { content: 'answer' }
          },
        },
      })
      return result.perSample[0].speed?.timeToFirstTokenMs
    }
    expect(await measure(0, 0)).toBe(3)
    expect(await measure(7, 0)).toBe(3)
    expect(await measure(0, 7)).toBe(10)
  })
  it.each([
    ['PaperMind', runPaperMind, expectedRetrievalQuality],
    ['semantic-tree', runSemanticTree, expectedRetrievalQuality],
    ['traditional', runTraditional, expectedRetrievalQuality],
    ['hybrid', runHybrid, expectedRetrievalQuality],
    ['long-section', runLongSection, expectedRetrievalQuality],
    ['full-context', runFullContext, expectedFullContextQuality],
  ] as const)('%s keeps main-branch quality and provenance unchanged in speed mode', async (_name, run, expected) => {
    const regularResult = await run(false)
    const speedResult = await run(true)
    const regularQuality = qualityProjection(regularResult)
    const speedQuality = qualityProjection(speedResult)

    expect(regularQuality).toEqual(expected)
    expect(speedQuality).toEqual(expected)
    expect(speedQuality).toEqual(regularQuality)
    expect(speedResult.perSample.map(record => record.answer))
      .toEqual(regularResult.perSample.map(record => record.answer))
    expect(regularResult.meta.speedDefinition).toBeUndefined()
    expect(speedResult.meta.speedDefinition).toBe('query-timeline-v2')
    expect(speedResult.perSample.every(record => record.speed !== undefined)).toBe(true)
  })
})
