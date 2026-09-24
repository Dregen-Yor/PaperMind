import { describe, expect, it, vi } from 'vitest'
import { runTraditionalRagQaTask } from '../runner/traditionalRagQa'
import { buildEvaluationContract, CONTEXT_BUDGET_TOKENS } from '../evaluationContract'
import { materializeContext, type ContextGroup } from '../../../src/utils/contextTrace'
import type { EvalSample, TraditionalRagConfig } from '../types'
import type { StreamingLlmClient } from '../llmClient'
import type { SpeedRunContract } from '../speed/contract'

const embeddingFactories = vi.hoisted(() => ({
  createProvider: vi.fn(),
  createTokenizer: vi.fn(),
}))

vi.mock('../traditionalRag/embedding', async () => ({
  ...await vi.importActual<typeof import('../traditionalRag/embedding')>('../traditionalRag/embedding'),
  createBgeM3Provider: embeddingFactories.createProvider,
  createBgeM3Tokenizer: embeddingFactories.createTokenizer,
}))

// 物化器在测试里按「每个 piece 一个 token」分词：预算 N 恰好放行前 N 个贡献文本的页，
// 让「第二个页码被公共预算截掉」这类边界可用 token 数精确表达，而非依赖字符近似。
const oneTokenPerPiece = { tokenize: (text: string) => (text ? [text] : []) }
const materialize = (maxTokens: number) => (groups: ContextGroup[]) =>
  materializeContext(groups, oneTokenPerPiece, maxTokens)

const client = { complete: async () => '', chat: async () => '', stats: () => ({ hits: 0, misses: 0 }), latencies: () => [], requestTimings: () => [] }

function speedContract(datasetFingerprint: string): SpeedRunContract {
  return {
    speedMetricSchemaVersion: 2,
    speedDefinition: 'query-timeline-v2',
    datasetFingerprint,
    executedQuestionIdsHash: 'executed-question-ids',
    streaming: true,
    llmCacheEnabled: false,
    queryConcurrency: 1,
    retryAttempts: 0,
    answerModelIdentity: 'answer-model',
    answerFramingIdentityHash: 'answer-framing',
    endpointIdentity: 'endpoint',
    generationSettingsHash: 'generation-settings',
    executionEnvironmentFingerprint: 'execution-environment',
  }
}

function speedClient(events: string[]): StreamingLlmClient {
  const snapshots = [
    { totalTokens: 10, incompleteRequestCount: 0 },
    { totalTokens: 18, incompleteRequestCount: 0 },
  ]
  let snapshotIndex = 0
  return {
    complete: async () => '',
    chat: async () => '',
    chatStream: async () => ({ content: '' }),
    stats: () => ({ hits: 0, misses: 0 }),
    latencies: () => [],
    requestTimings: () => [],
    tokenSnapshot: () => {
      events.push(snapshotIndex === 0 ? 'token-before' : 'token-after')
      return snapshots[snapshotIndex++]
    },
    cacheEnabled: () => false,
  }
}

function scriptedClock(values: number[], events: string[], labels: string[]): () => number {
  let index = 0
  return () => {
    if (index >= values.length) throw new Error(`scripted clock read ${index + 1} exceeds ${values.length}`)
    events.push(labels[index])
    return values[index++]
  }
}

// 配置里的 maxTokens 恒为受控预算（config.ts 冻结）：截断由直接注入的物化器施加，
// 不再是「改配置数字」——所以下面的截断用例改预算的是 materialize(N)，config 保持 4096
const jaccardConfig = (chunkSize: number, topK = 1): TraditionalRagConfig => ({
  name: 'j', kind: 'traditional-rag', chunking: { tokenizer: 'bge-m3', chunkSize, overlap: 0 }, retrieval: { algorithm: 'jaccard', topK }, generationContext: { topK: 1, maxTokens: CONTEXT_BUDGET_TOKENS },
})

const cosineConfig = (chunkSize: number, topK = 1): TraditionalRagConfig => ({
  name: 'c',
  kind: 'traditional-rag',
  chunking: { tokenizer: 'bge-m3', chunkSize, overlap: 0 },
  retrieval: {
    algorithm: 'cosine',
    topK,
    embedding: { model: 'BAAI/bge-m3', revision: 'main', queryPrefix: '', normalize: true, maxLength: 8192 },
  },
  generationContext: { topK: 1, maxTokens: CONTEXT_BUDGET_TOKENS },
})

describe('traditional RAG runner', () => {
  it('rejects a cache-enabled speed answer client before tokenizer or retriever setup', async () => {
    const samples: EvalSample[] = [{
      paperId: 'p', title: 'p', pages: ['evidence'], source: 'smoke',
      questions: [{ id: 'q1', question: 'q', answers: ['a'], evidencePages: [0], unanswerable: false }],
    }]
    const evaluationContract = buildEvaluationContract(samples)
    const cachedClient = { ...speedClient([]), cacheEnabled: () => true }

    await expect(runTraditionalRagQaTask({
      samples,
      config: jaccardConfig(2),
      client: cachedClient,
      systemPrompt: 'system',
      gitSha: 'x',
      model: 'm',
      materialize: materialize(4096),
      evaluationContract,
      deps: {
        tokenizer: { tokenize: () => { throw new Error('tokenizer must not start') } },
      },
      speed: { contract: speedContract(evaluationContract.datasetFingerprint) },
    })).rejects.toThrow(/cache/i)
  })

  it('builds once per paper and generates once per question', async () => {
    let builds = 0; let generations = 0
    const samples: EvalSample[] = [{ paperId: 'p', title: 'p', pages: ['evidence'], source: 'smoke', questions: [{ id: 'q1', question: 'q', answers: ['a'], evidencePages: [0], unanswerable: false }, { id: 'q2', question: 'q', answers: ['a'], evidencePages: [0], unanswerable: false }] }]
    const result = await runTraditionalRagQaTask({
      samples, config: jaccardConfig(2), client, systemPrompt: 'system', gitSha: 'x', model: 'm',
      materialize: materialize(4096),
      evaluationContract: buildEvaluationContract(samples),
      deps: {
        tokenizer: { tokenize: text => [text] },
        buildRetriever: async chunks => { builds++; return { chunks, score: () => chunks.map(c => ({ id: c.id, score: 1 })) } },
        generateAnswer: async () => { generations++; return 'a' },
      },
    })
    expect(builds).toBe(1)
    expect(generations).toBe(2)
    expect(result.perSample.every(r => r.metrics.llmCalls === 1)).toBe(true)
    expect(result.perSample.every(r => r.retrievalStatus === 'completed' && r.generationStatus === 'completed')).toBe(true)
  })

  it('excludes ambiguous evidence from retrieval-quality denominators', async () => {
    const samples: EvalSample[] = [{ paperId: 'p', title: 'p', pages: ['text'], source: 'qasper', questions: [{ id: 'q', question: 'q', answers: ['a'], evidencePages: [0], evidenceMapping: 'ambiguous', unanswerable: false, qualityAnswers: ['a'], qualityDefinition: 'qasper-all-questions-v1' }] }]
    const result = await runTraditionalRagQaTask({
      samples, config: jaccardConfig(2), client, systemPrompt: 's', gitSha: 'x', model: 'm',
      materialize: materialize(4096),
      evaluationContract: buildEvaluationContract(samples),
      deps: { tokenizer: { tokenize: text => [text] }, buildRetriever: async chunks => ({ chunks, score: () => [{ id: 0, score: 1 }] }), generateAnswer: async () => 'a' },
    })
    expect(result.metrics.evidenceRecall).toBeUndefined()
    expect(result.perSample[0]).toMatchObject({ retrievalStatus: 'ineligible' })
  })

  it('records a retrieval failure and continues with later questions', async () => {
    let calls = 0
    const samples: EvalSample[] = [{ paperId: 'p', title: 'p', pages: ['text'], source: 'smoke', questions: [{ id: 'bad', question: 'q', answers: ['a'], evidencePages: [], unanswerable: false }, { id: 'good', question: 'q', answers: ['a'], evidencePages: [], unanswerable: false }] }]
    const result = await runTraditionalRagQaTask({
      samples, config: jaccardConfig(2), client, systemPrompt: 's', gitSha: 'x', model: 'm',
      materialize: materialize(4096),
      evaluationContract: buildEvaluationContract(samples),
      deps: { tokenizer: { tokenize: text => [text] }, buildRetriever: async chunks => ({ chunks, score: () => { if (calls++ === 0) throw new Error('broken retrieval'); return [{ id: 0, score: 1 }] } }), generateAnswer: async () => 'a' },
    })
    expect(result.errors).toEqual([{ sampleId: 'bad', stage: 'retrieve', message: 'broken retrieval' }])
    // 新口径：失败题不再整条丢弃，记录保留并标注状态（两题均无 evidence → 未进检索质量分母）
    expect(result.perSample.map(x => x.id)).toEqual(['bad', 'good'])
    expect(result.perSample[0]).toMatchObject({ retrievalStatus: 'ineligible', generationStatus: 'skipped' })
  })

  it('uses the materialized page order and keeps retrieval metrics when generation fails', async () => {
    // 单个跨页候选：pieces 覆盖第 0、1 页；预算只够第一页，第二页被公共预算截掉
    const samples: EvalSample[] = [{ paperId: 'p', title: 'p', pages: ['alpha beta', 'gamma delta'], source: 'smoke', questions: [{ id: 'q', question: 'q', answers: ['a'], evidencePages: [0], unanswerable: false }] }]
    const result = await runTraditionalRagQaTask({
      samples, config: jaccardConfig(3), client, systemPrompt: 'system', gitSha: 'x', model: 'm',
      materialize: materialize(1),
      evaluationContract: buildEvaluationContract(samples),
      deps: {
        tokenizer: { tokenize: text => text.split(' ') },
        buildRetriever: async chunks => ({ chunks, score: () => chunks.map(c => ({ id: c.id, score: 1 })) }),
        generateAnswer: async () => { throw new Error('generation boom') },
      },
    })
    expect(result.perSample[0]).toMatchObject({
      contextPageOrder: [0],
      retrievalStatus: 'completed',
      generationStatus: 'failed',
      judgeStatus: 'skipped',
      // 四个检索指标只认最终物化页序；contextPrecision 1/1 可识别「包络混入」的污染
      metrics: { contextPageMrr: 1, evidenceRecall: 1, evidenceHit: 1, contextPrecision: 1 },
    })
    // selectedPages 是诊断包络（含被预算截掉的第二页），与指标页序刻意分叉
    expect(result.perSample[0].selectedPages).toEqual([0, 1])
    expect(result.perSample[0].contextTruncated).toBe(true)
    expect(result.errors).toEqual([{ sampleId: 'q', stage: 'generate', message: 'generation boom' }])
    expect(result.meta.completed).toBe(0)
    expect(result.meta.total).toBe(1)
  })

  it('writes zero context metrics when retrieval throws on an eligible question', async () => {
    const samples: EvalSample[] = [{ paperId: 'p', title: 'p', pages: ['text'], source: 'smoke', questions: [{ id: 'q', question: 'q', answers: ['a'], evidencePages: [0], unanswerable: false }] }]
    const result = await runTraditionalRagQaTask({
      samples, config: jaccardConfig(2), client, systemPrompt: 's', gitSha: 'x', model: 'm',
      materialize: materialize(4096),
      evaluationContract: buildEvaluationContract(samples),
      deps: { tokenizer: { tokenize: text => [text] }, buildRetriever: async chunks => ({ chunks, score: () => { throw new Error('broken retrieval') } }), generateAnswer: async () => 'a' },
    })
    expect(result.perSample[0]).toMatchObject({
      retrievalStatus: 'failed',
      generationStatus: 'skipped',
      judgeStatus: 'skipped',
      metrics: { contextPageMrr: 0, evidenceRecall: 0, evidenceHit: 0, contextPrecision: 0 },
    })
    expect(result.errors).toEqual([{ sampleId: 'q', stage: 'retrieve', message: 'broken retrieval' }])
    // 失败以 0 如实计入固定分母，而非缺字段悄然退出
    expect(result.metrics.contextPageMrr).toBe(0)
    expect(result.metrics.contextPageMrrSampleCount).toBe(1)
  })

  it('starts speed timing after local/index setup and streams the unchanged quality outcome', async () => {
    const events: string[] = []
    const samples: EvalSample[] = [{
      paperId: 'p', title: 'p', pages: ['evidence'], source: 'smoke',
      questions: [{ id: 'q', question: 'question?', answers: ['answer'], evidencePages: [0], unanswerable: false }],
    }]
    const evaluationContract = buildEvaluationContract(samples)
    const streamAnswer: StreamingLlmClient['chatStream'] = vi.fn(async (_messages, onVisibleText) => {
      events.push('stream')
      onVisibleText('answer')
      return { content: 'answer' }
    })
    const judgeClient = {
      ...client,
      complete: async () => {
        events.push('judge')
        return '{"factuality":5,"completeness":4,"groundedness":3}'
      },
    }
    let embeddingCall = 0
    embeddingFactories.createProvider.mockReset()
    embeddingFactories.createProvider.mockImplementation(async () => {
      events.push('embedding-init')
      return {
        tokenizer: {
          tokenize: (text: string) => {
            events.push('tokenize')
            return [text]
          },
        },
        provider: {
          embed: async (texts: string[]) => {
            events.push(embeddingCall++ === 0 ? 'embed-index' : 'embed-query')
            return texts.map(() => [1, 0])
          },
        },
      }
    })
    const result = await runTraditionalRagQaTask({
      samples,
      config: cosineConfig(2),
      client: speedClient(events),
      systemPrompt: 'system',
      answerLanguageInstruction: 'answer in English',
      gitSha: 'x',
      model: 'm',
      judgeClient,
      judgeModel: 'judge',
      now: () => 0,
      materialize: groups => {
        events.push('materialize')
        return materialize(4096)(groups)
      },
      evaluationContract,
      deps: {
        generateAnswer: async () => {
          throw new Error('legacy generation must not run in speed mode')
        },
      },
      speed: {
        contract: speedContract(evaluationContract.datasetFingerprint),
        now: scriptedClock([100, 130, 150, 190], events, ['t0', 't1', 'ttft', 't3']),
        streamAnswer,
      },
    })

    for (const sentinel of [
      'embedding-init', 'tokenize', 'embed-index', 'token-before', 't0', 'embed-query',
      'materialize', 't1', 'stream', 't3', 'token-after', 'judge',
    ]) expect(events).toContain(sentinel)
    expect(events.indexOf('embedding-init')).toBeLessThan(events.indexOf('token-before'))
    expect(events.indexOf('tokenize')).toBeLessThan(events.indexOf('token-before'))
    expect(events.indexOf('embed-index')).toBeLessThan(events.indexOf('token-before'))
    expect(events.indexOf('token-before')).toBeLessThan(events.indexOf('t0'))
    expect(events.indexOf('t0')).toBeLessThan(events.indexOf('embed-query'))
    expect(events.indexOf('embed-query')).toBeLessThan(events.indexOf('materialize'))
    expect(events.indexOf('materialize')).toBeLessThan(events.indexOf('t1'))
    expect(events.indexOf('t1')).toBeLessThan(events.indexOf('stream'))
    expect(events.indexOf('t3')).toBeLessThan(events.indexOf('token-after'))
    expect(events.indexOf('token-after')).toBeLessThan(events.indexOf('judge'))
    expect(streamAnswer).toHaveBeenCalledWith([
      {
        role: 'system',
        content: 'system\n\nanswer in English\n\n数学公式请使用 LaTeX：行内公式使用 $...$，独立公式使用 $$...$$。不要使用 \\(...\\) 或 \\[...\\] 包裹公式。\n\n参考内容：\nevidence',
      },
      { role: 'user', content: 'question?' },
    ], expect.any(Function))
    expect(result.perSample[0]).toMatchObject({
      answer: 'answer',
      retrievalStatus: 'completed',
      generationStatus: 'completed',
      judgeStatus: 'completed',
      speed: {
        evidenceReadyLatencyMs: 30,
        timeToFirstTokenMs: 50,
        fullAnswerLatencyMs: 90,
        onlineTokenCount: 8,
        tokenAccountingComplete: true,
      },
      metrics: {
        contextPageMrr: 1,
        evidenceRecall: 1,
        evidenceHit: 1,
        contextPrecision: 1,
        answerF1: 1,
        judgeFactuality: 5,
        judgeCompleteness: 4,
        judgeGroundedness: 3,
      },
    })
    expect(result.metrics).toMatchObject({
      contextPageMrr: 1,
      evidenceRecall: 1,
      evidenceHitRate: 1,
      contextPrecision: 1,
      answerF1: 1,
      judgeFactuality: 5,
      judgeCompleteness: 4,
      judgeGroundedness: 3,
      speedSampleCount: 1,
    })
  })
})
