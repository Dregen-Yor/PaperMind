import { describe, it, expect, vi } from 'vitest'
import type { EvalSample, QaQuestion } from '../types'
import type { StreamingLlmClient } from '../llmClient'
import type { SpeedRunContract } from '../speed/contract'
import type { IndexNode } from '../../../src/utils/pageIndex'
import type { PipelineRetrieval, RagGenerationStage, RagRetrievalStage } from '../../../src/utils/ragPipeline'
import type { QaTaskArgs, QaTaskDeps } from '../runner/qa'

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: {},
  getDocument: vi.fn(),
}))

const { runQaTask, DEFAULT_SYSTEM_PROMPT } = await import('../runner/qa')
const { runFullContextQaTask } = await import('../runner/fullContextQa')
const {
  buildEvaluationContract,
  composeBaseSystemPrompt,
  CONTEXT_BUDGET_TOKENS,
  CONTEXT_TOKENIZER_MODEL,
  CONTEXT_TOKENIZER_REVISION,
} = await import('../evaluationContract')
const { materializeContext } = await import('../../../src/utils/contextTrace')
const ragPipeline = await import('../../../src/utils/ragPipeline')
const { MATH_FORMAT_INSTRUCTION } = ragPipeline
// token 估算口径不在此处复写第二份：跟着生产实现走，改了公式测试也跟着改
const { estimateTokens } = await import('../metrics/retrieval')

function qasperQuestion(question: Omit<QaQuestion, 'qualityAnswers' | 'qualityDefinition'>): QaQuestion {
  return {
    ...question,
    qualityAnswers: question.unanswerable ? ['Unanswerable'] : [...question.answers],
    qualityDefinition: 'qasper-all-questions-v1',
  }
}

function leaf(id: string, start: number, end: number): IndexNode {
  return { title: `S${id}`, nodeId: id, startPage: start, endPage: end, summary: '', nodes: [] }
}

const tree: IndexNode = {
  title: 'P', nodeId: 'root', startPage: 0, endPage: 3, summary: '',
  nodes: [leaf('0', 0, 1), leaf('1', 2, 3)],
}

const sample: EvalSample = {
  paperId: 'p1',
  title: 'Paper 1',
  // pages[0] 用唯一哨兵串：judge evidence 用例靠它区分「evidence 原文」与「检索上下文」，
  // 若用普通字符（如 'a'）会与 prompt 样板文本恒匹配，断言恒真
  pages: ['EVIDENCE_MARKER_7f3a', 'b', 'c', 'd'],
  source: 'qasper',
  questions: [
    {
      id: 'p1#0', question: 'Q1?', answers: ['8'], evidencePages: [0], unanswerable: false,
      qualityAnswers: ['8'], qualityDefinition: 'qasper-all-questions-v1',
    },
  ],
}

const fakeClient = {
  complete: vi.fn(),
  chat: vi.fn(),
  stats: () => ({ hits: 0, misses: 0 }),
  latencies: () => [120, 340],
  requestTimings: () => [],
}

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

function speedClient(
  snapshots: Array<{ totalTokens: number, incompleteRequestCount: number }>,
  events: string[] = [],
): StreamingLlmClient {
  let snapshotIndex = 0
  return {
    complete: vi.fn(),
    chat: vi.fn(),
    chatStream: vi.fn(),
    stats: () => ({ hits: 0, misses: 0 }),
    latencies: () => [120, 340],
    requestTimings: () => [],
    tokenSnapshot: () => {
      events.push(snapshotIndex === 0 ? 'token-before' : 'token-after')
      const snapshot = snapshots[snapshotIndex]
      snapshotIndex++
      if (!snapshot) throw new Error('unexpected token snapshot')
      return snapshot
    },
    cacheEnabled: () => false,
  }
}

/** 确定性字符级分词器：1 字符 = 1 token，让受控预算与页序在测试里完全可预测。 */
const tokenizer = { tokenize: (text: string) => text.split('') }

/** 单篇论文检索结果的最小诊断；`selected` 只是候选页包络，指标不读它。 */
function pipelineRetrieval(overrides: Partial<PipelineRetrieval> = {}): PipelineRetrieval {
  return {
    context: 'CONTEXT_MARKER_9c2e',
    contextGroups: [{ pieces: [{ page: 0, text: 'CONTEXT_MARKER_9c2e' }] }],
    sources: ['Pages 1–2: S0'],
    selected: [leaf('0', 0, 1)],
    scores: [{ id: 0, score: 9 }, { id: 1, score: 1 }],
    degraded: false,
    llmCalled: true,
    ...overrides,
  }
}

/** 检索阶段产物；默认 contextPageOrder [0] 与 sample 的 evidence 页一致 → MRR 1。 */
const retrievalStage = (overrides: Partial<RagRetrievalStage> = {}): RagRetrievalStage => ({
  retrievals: [pipelineRetrieval()],
  retrievalQuery: 'Q1?',
  rewritten: false,
  context: 'CONTEXT_MARKER_9c2e',
  contextPageOrder: [0],
  contextTokenCount: 1,
  contextTruncated: false,
  sources: ['第 1 页'],
  llmCalls: 1,
  treeRouted: false,
  queryRewriteLatencyMs: 0,
  retrievalLatencyMs: 20,
  pipelineStartedAt: 0,
  ...overrides,
})

const generationStage = (overrides: Partial<RagGenerationStage> = {}): RagGenerationStage => ({
  answer: '8',
  answerGenerationLatencyMs: 30,
  queryEndToEndLatencyMs: 50,
  ...overrides,
})

/** 分阶段注入：索引 / 检索 / 生成三段各自可替换，单测无需真实 LLM。 */
const stagedDeps = (overrides: Partial<QaTaskDeps> = {}): QaTaskDeps => ({
  buildIndex: vi.fn().mockResolvedValue(tree),
  retrieveContext: vi.fn().mockResolvedValue(retrievalStage()),
  generateAnswer: vi.fn().mockResolvedValue(generationStage()),
  ...overrides,
})

const baseArgs = {
  samples: [sample] as EvalSample[],
  config: { name: 'default', topK: 2, minScore: 4 },
  client: fakeClient as never,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  gitSha: 'abc1234',
  model: 'test-model',
}

/**
 * 组装 QaTaskArgs：默认注入分阶段 deps、确定性 materialize 与按实际 samples/limit
 * 现算的评测契约——契约里的有效题数必须与逐题观测数一致，否则固定分母不变量会抛错。
 */
const argsWith = (overrides: Partial<QaTaskArgs> = {}): QaTaskArgs => {
  const { deps, materialize, evaluationContract, ...rest } = overrides
  const samples = rest.samples ?? baseArgs.samples
  return {
    ...baseArgs,
    ...rest,
    deps: { ...stagedDeps(), ...deps },
    materialize: materialize ?? (groups => materializeContext(groups, tokenizer, CONTEXT_BUDGET_TOKENS)),
    evaluationContract: evaluationContract ?? buildEvaluationContract(samples, rest.limit),
  }
}

describe('runQaTask', () => {
  it('产出 BenchResult，含聚合指标与逐样本记录', async () => {
    const result = await runQaTask(argsWith())

    expect(result.task).toBe('qa')
    expect(result.meta.completed).toBe(1)
    expect(result.meta.total).toBe(1)
    expect(result.meta.gitSha).toBe('abc1234')
    expect(result.metrics.evidenceRecall).toBe(1)
    expect(result.metrics.answerF1).toBe(1)
    expect(result.perSample).toHaveLength(1)
    expect(result.perSample[0].selectedPages).toEqual([0, 1])
    // 最终物化页序 [0] 命中 evidence 页 0 → MRR 1
    expect(result.metrics.contextPageMrr).toBe(1)
    expect(result.errors).toEqual([])
  })

  it('把 config 的分块参数传给 buildPageIndex', async () => {
    const deps = stagedDeps()
    await runQaTask(argsWith({
      config: { name: 'c', chunkPages: 3, minSectionPages: 1, forceFixedChunk: true },
      deps,
    }))
    expect(vi.mocked(deps.buildIndex!).mock.calls[0][2]).toEqual({
      chunkPages: 3, minSectionPages: 1, forceFixedChunk: true,
    })
  })

  it('把 config 的检索参数与受控物化器一起传给 retrieveRagContext', async () => {
    const deps = stagedDeps()
    await runQaTask(argsWith({
      config: { name: 'c', topK: 3, minScore: 6, enableRewrite: false },
      deps,
    }))
    const call = vi.mocked(deps.retrieveContext!).mock.calls[0]
    expect(call[4]).toEqual({ topK: 3, minScore: 6, enableRewrite: false })
    // 预算由注入的 materialize 施加，而非配置里的字符预算
    expect(call[5]?.materialize).toBeTypeOf('function')
    expect(call[5]?.now).toBeTypeOf('function')
  })

  it('每篇论文只建一次索引，多个问题复用', async () => {
    const deps = stagedDeps()
    const twoQuestions: EvalSample = {
      ...sample,
      questions: [
        sample.questions[0],
        qasperQuestion({ id: 'p1#1', question: 'Q2?', answers: ['9'], evidencePages: [2], unanswerable: false }),
      ],
    }
    await runQaTask(argsWith({ samples: [twoQuestions], deps }))

    expect(deps.buildIndex).toHaveBeenCalledTimes(1)
    expect(deps.retrieveContext).toHaveBeenCalledTimes(2)
    expect(deps.generateAnswer).toHaveBeenCalledTimes(2)
  })

  it('单样本生成失败不中断整轮，保留检索指标并记入 errors', async () => {
    const deps = stagedDeps({
      generateAnswer: vi.fn()
        .mockRejectedValueOnce(new Error('network timeout'))
        .mockResolvedValueOnce(generationStage({ answer: '9' })),
    })
    const twoQuestions: EvalSample = {
      ...sample,
      questions: [
        sample.questions[0],
        qasperQuestion({ id: 'p1#1', question: 'Q2?', answers: ['9'], evidencePages: [2], unanswerable: false }),
      ],
    }
    const result = await runQaTask(argsWith({ samples: [twoQuestions], deps }))

    expect(result.meta.completed).toBe(1)
    expect(result.meta.total).toBe(2)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatchObject({ sampleId: 'p1#0', stage: 'generate' })
    expect(result.errors[0].message).toContain('network timeout')
    // 生成失败也要保留这条记录的检索观测，不能整条丢掉
    expect(result.perSample).toHaveLength(2)
    expect(result.perSample[0].generationStatus).toBe('failed')
    expect(result.perSample[0].metrics.contextPageMrr).toBe(1)
    expect(result.metrics).toMatchObject({
      answerF1AllQuestions: 0.5,
      answerF1AllQuestionsSampleCount: 2,
      qaCompletionRate: 0.5,
    })
  })

  it('建索引失败时该论文全部问题记为 index 阶段错误', async () => {
    const deps = { buildIndex: vi.fn().mockRejectedValue(new Error('bad pdf')) }
    const result = await runQaTask(argsWith({ deps }))

    expect(result.meta.completed).toBe(0)
    expect(result.meta.total).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].stage).toBe('index')
    expect(result.metrics).toMatchObject({
      answerF1AllQuestions: 0,
      answerF1AllQuestionsSampleCount: 1,
      qaCompletionRate: 0,
    })
  })

  it('unanswerable 样本按拒答模式判定，不计入 answerF1', async () => {
    const deps = stagedDeps({
      generateAnswer: vi.fn().mockResolvedValue(generationStage({ answer: '参考内容中没有提到这一点。' })),
    })
    const unanswerableSample: EvalSample = {
      ...sample,
      questions: [qasperQuestion({ id: 'p1#0', question: 'Q?', answers: [], evidencePages: [], unanswerable: true })],
    }
    const result = await runQaTask(argsWith({ samples: [unanswerableSample], deps }))

    expect(result.metrics.unanswerableAccuracy).toBe(1)
    expect(result.metrics.answerF1).toBeUndefined()
    expect(result.meta.unanswerableMethod).toBe('pattern')
  })

  it('硬答 unanswerable 问题时 unanswerableAccuracy 为 0', async () => {
    const deps = stagedDeps({
      generateAnswer: vi.fn().mockResolvedValue(generationStage({ answer: '论文中使用了 8 个注意力头。' })),
    })
    const unanswerableSample: EvalSample = {
      ...sample,
      questions: [qasperQuestion({ id: 'p1#0', question: 'Q?', answers: [], evidencePages: [], unanswerable: true })],
    }
    const result = await runQaTask(argsWith({ samples: [unanswerableSample], deps }))
    expect(result.metrics.unanswerableAccuracy).toBe(0)
  })

  it('limit 限制处理的问题数', async () => {
    const deps = stagedDeps()
    const many: EvalSample = {
      ...sample,
      questions: [
        sample.questions[0],
        qasperQuestion({ id: 'p1#1', question: 'Q2?', answers: ['9'], evidencePages: [2], unanswerable: false }),
        qasperQuestion({ id: 'p1#2', question: 'Q3?', answers: ['7'], evidencePages: [3], unanswerable: false }),
      ],
    }
    const result = await runQaTask(argsWith({ samples: [many], limit: 2, deps }))

    expect(result.meta.total).toBe(2)
    expect(deps.retrieveContext).toHaveBeenCalledTimes(2)
    expect(result.meta.qaExpectedQuestionIds).toEqual(['p1#0', 'p1#1'])
    expect(result.metrics.answerF1AllQuestionsSampleCount).toBe(2)
  })

  it('记录管线诊断指标：降级率、改写率、调用数、分块数', async () => {
    const result = await runQaTask(argsWith())
    expect(result.metrics.degradedRate).toBe(0)
    expect(result.metrics.rewriteRate).toBe(0)
    // 检索阶段 1 次 + 生成阶段必定 1 次
    expect(result.metrics.llmCallsPerQuery).toBe(2)
    expect(result.metrics.leafCount).toBe(2)
    // 最近秩法 p50：percentile([120, 340], 50) = ceil(0.5*2)-1 = 0 → 120（340 是 p95）
    expect(result.metrics.latencyP50).toBe(120)
    expect(result.metrics.latencyP95).toBe(340)
  })

  it('selectedContextTokens 量最终合并上下文，而非首篇论文物化前的单篇上下文', async () => {
    // 多篇检索：最终提示词是各篇 context 的合并串，首篇只是其中一小段。
    // 旧实现读 first.context，会把合并后的提示词报成单篇大小；这里让两段长度差得足够远
    // （估算会取整），任何读成首篇的结果都无法偶然命中合并值。
    const firstContext = '首篇上下文'
    const secondContext = '第二篇的上下文内容明显长于首篇且逐字计入最终合并结果'
    const combined = `${firstContext}\n\n---\n\n${secondContext}`
    const deps = stagedDeps({
      retrieveContext: vi.fn().mockResolvedValue(retrievalStage({
        // 两篇检索结果：顺序与入参一致，首篇只贡献合并串的一小部分
        retrievals: [
          pipelineRetrieval({ context: firstContext }),
          pipelineRetrieval({ context: secondContext }),
        ],
        context: combined,
      })),
    })
    const result = await runQaTask(argsWith({ deps }))

    const reported = result.perSample[0].metrics.selectedContextTokens
    // 必须跟随最终合并文本——生成阶段正是拿 retrieval.context 组提示词
    expect(reported).toBe(estimateTokens(combined))
    // 反向钉死：报成首篇的（物化前）上下文即失败
    expect(reported).not.toBe(estimateTokens(firstContext))
  })

  it('answerLanguageInstruction 非空时以空行追加在 systemPrompt 之后，未传时保持原样', async () => {
    const instruction = '请使用论文原文语言（英文）作答'
    const withInstr = stagedDeps()
    await runQaTask(argsWith({ answerLanguageInstruction: instruction, deps: withInstr }))
    expect(vi.mocked(withInstr.generateAnswer!).mock.calls[0][4]).toBe(`${DEFAULT_SYSTEM_PROMPT}\n\n${instruction}`)

    const without = stagedDeps()
    await runQaTask(argsWith({ deps: without }))
    expect(vi.mocked(without.generateAnswer!).mock.calls[0][4]).toBe(DEFAULT_SYSTEM_PROMPT)
  })

  it('打分短路（llmCalled=false）时 MRR 与有无内部打分无关，照常写入', async () => {
    // 单叶索引时 scoreAndSelect 不发 LLM 打分，但 context-page MRR 只消费最终物化页序，
    // 与内部排序有无无关——照常写出，不再靠缺字段退出分母（旧口径才会写 undefined）
    const deps = stagedDeps({
      retrieveContext: vi.fn().mockResolvedValue(retrievalStage({
        retrievals: [pipelineRetrieval({ llmCalled: false })],
        context: 'a\n\nb',
      })),
    })
    const result = await runQaTask(argsWith({ deps }))

    expect(result.metrics.contextPageMrr).toBe(1)
    expect(result.metrics.evidenceRecall).toBe(1)
    expect(result.metrics.evidenceHitRate).toBe(1)
    expect(result.perSample[0].metrics.contextPageMrr).toBe(1)
  })

  it('单节点索引（无叶节点）时 leafCount 为 1，MRR 仍按物化页序照常写入', async () => {
    // 建索引 fallback：tree.nodes 为空时树根自身就是叶（短篇论文的生产真实路径），
    // 单叶短路不发内部打分，但 MRR 只认最终物化页序，与有无排序无关
    const singleNode: IndexNode = leaf('root', 0, 3)
    const deps = stagedDeps({
      buildIndex: vi.fn().mockResolvedValue(singleNode),
      retrieveContext: vi.fn().mockResolvedValue(retrievalStage({
        retrievals: [pipelineRetrieval({ selected: [singleNode], llmCalled: false, sources: ['Pages 1–3: Sroot'] })],
        context: 'a\n\nb',
      })),
    })
    const result = await runQaTask(argsWith({ deps }))

    expect(result.metrics.leafCount).toBe(1)
    expect(result.metrics.contextPageMrr).toBe(1)       // 与有无打分无关，照常写入
    expect(result.metrics.evidenceRecall).toBeDefined() // 覆盖指标与有无打分无关，照常写入
  })

  it('无 evidence 样本保留运行诊断，但不进入任何 retrieval quality 分母', async () => {
    const mixed: EvalSample = {
      ...sample,
      questions: [
        sample.questions[0],
        qasperQuestion({ id: 'p1#1', question: 'unknown?', answers: [], evidencePages: [], unanswerable: true }),
      ],
    }
    const result = await runQaTask(argsWith({ samples: [mixed] }))
    expect(result.metrics.evidenceRecall).toBe(1)
    expect(result.metrics.evidenceRecallSampleCount).toBe(1)
    expect(result.metrics.evidenceHitSampleCount).toBe(1)
    expect(result.metrics.contextPrecisionSampleCount).toBe(1)
    expect(result.metrics.contextPageMrrSampleCount).toBe(1)
    expect(result.metrics.contextPageMrrEligibleCount).toBe(1)
    // 成功路径的非有效题状态为 ineligible，而非 completed——消费方按 status 即可过滤
    expect(result.perSample[1].retrievalStatus).toBe('ineligible')
    expect(result.perSample[1].metrics.contextTokens).toBeDefined()
    expect(result.perSample[1].metrics.evidenceRecall).toBeUndefined()
  })

  it('evidence 映射元数据只统计 QASPER，且 unmapped 进入覆盖率分母', async () => {
    const qasper: EvalSample = {
      ...sample,
      source: 'qasper',
      questions: [
        { ...sample.questions[0], evidenceMapping: 'mapped' },
        qasperQuestion({ id: 'p1#1', question: 'missing?', answers: ['x'], evidencePages: [], unanswerable: false, evidenceMapping: 'unmapped' }),
      ],
    }
    const smoke: EvalSample = { ...qasper, paperId: 'smoke', source: 'smoke' }
    const result = await runQaTask(argsWith({ samples: [qasper, smoke] }))
    expect(result.meta.evidenceMappingCoverage).toBe(0.5)
    expect(result.meta.unmappedEvidenceRate).toBe(0.5)
    expect(result.meta.qaExpectedQuestionIds).toEqual(['p1#0', 'p1#1'])
  })

  it('perPaper 记录索引时长、问题数、cache 差值与 leafCount', async () => {
    // 注入脚本化时钟：runStartedMs → indexStartedMs → indexFinishedMs → runWallClockMs；
    // 分阶段后题目阶段不缺省读时钟（时延全部来自注入的阶段产物），故 now() 恰好调用 4 次
    // （多读第 5 次会触发 scriptedClock 超读抛错，不再被静默吸收）
    const now = scriptedClock([100, 100, 250, 500])
    const result = await runQaTask(argsWith({ now }))

    expect(result.perPaper).toHaveLength(1)
    const p = result.perPaper![0]
    expect(p.paperId).toBe('p1')
    expect(p.source).toBe('qasper')
    expect(p.pageCount).toBe(4)
    expect(p.questionCount).toBe(1)
    expect(p.indexBuildLatencyMs).toBe(150)
    expect(p.leafCount).toBe(2)
    // fakeClient.stats() 恒为 {hits:0, misses:0}，索引前后差值即 0
    expect(p.indexLlmCalls).toBe(0)
    expect(p.indexCacheHits).toBe(0)
    expect(p.indexCacheMisses).toBe(0)
    expect(p.error).toBeUndefined()
  })

  it('每个成功 perSample 都有四个非负 timing 字段', async () => {
    const result = await runQaTask(argsWith())

    expect(result.perSample).toHaveLength(1)
    const t = result.perSample[0].timing
    expect(t).toBeDefined()
    expect(t).toMatchObject({
      queryRewriteLatencyMs: 0,
      retrievalLatencyMs: 20,
      answerGenerationLatencyMs: 30,
      queryEndToEndLatencyMs: 50,
    })
    for (const v of Object.values(t!)) {
      expect(Number.isFinite(v)).toBe(true)
      expect(v).toBeGreaterThanOrEqual(0)
    }
  })

  it('metrics 正确生成 index/retrieval/generation/end-to-end 的 P50/P95', async () => {
    const now = scriptedClock([100, 100, 250, 500])
    const result = await runQaTask(argsWith({ now }))

    // index 单值 150；retrieval 20 / generation 30 / e2e 50 来自注入的阶段产物
    expect(result.metrics.indexBuildLatencyP50Ms).toBe(150)
    expect(result.metrics.indexBuildLatencyP95Ms).toBe(150)
    expect(result.metrics.retrievalLatencyP50Ms).toBe(20)
    expect(result.metrics.retrievalLatencyP95Ms).toBe(20)
    expect(result.metrics.answerGenerationLatencyP50Ms).toBe(30)
    expect(result.metrics.answerGenerationLatencyP95Ms).toBe(30)
    expect(result.metrics.queryEndToEndLatencyP50Ms).toBe(50)
    expect(result.metrics.queryEndToEndLatencyP95Ms).toBe(50)
    // 均值侧同样存在（aggregate 产生），供报表均值列展示
    expect(result.metrics.queryEndToEndLatencyMs).toBe(50)
  })

  it('索引失败仍记录已消耗的索引时长与缓存差值，且有效题补零观测但不产生题目时延', async () => {
    // 注入脚本化时钟：runStartedMs → indexStartedMs → indexFinishedMs（catch 内）→ runWallClockMs
    const now = scriptedClock([100, 100, 250, 400])
    const deps = { buildIndex: vi.fn().mockRejectedValue(new Error('bad pdf')) }
    const result = await runQaTask(argsWith({ now, deps }))

    expect(result.perPaper).toHaveLength(1)
    const p = result.perPaper![0]
    expect(p.error).toContain('bad pdf')
    // 失败论文的索引时长不能被时延分析漏掉——「索引慢后失败」的成本同样要可诊断
    expect(p.indexBuildLatencyMs).toBe(150)
    // fakeClient.stats() 恒为 {hits:0, misses:0}，索引前后差值即 0
    expect(p.indexLlmCalls).toBe(0)
    expect(p.indexCacheHits).toBe(0)
    expect(p.indexCacheMisses).toBe(0)
    // 失败后没有树结构，leafCount 仍不写
    expect(p.leafCount).toBeUndefined()
    // 有效题补一条零检索观测，保证固定分母不变量成立；生成按 skipped 计、不写 timing
    expect(result.perSample).toHaveLength(1)
    expect(result.perSample[0].retrievalStatus).toBe('failed')
    expect(result.perSample[0].metrics.contextPageMrr).toBe(0)
    // 失败样本不得伪造题目时延：无完成题则检索/生成/端到端分位数不产生
    expect(result.metrics.retrievalLatencyP50Ms).toBeUndefined()
    expect(result.metrics.queryEndToEndLatencyP50Ms).toBeUndefined()
    // 但已记录的索引时长进入聚合
    expect(result.metrics.indexBuildLatencyP50Ms).toBe(150)
    expect(result.metrics.indexBuildLatencyP95Ms).toBe(150)
  })

  it('meta 记录 startedAt/finishedAt/runWallClockMs/缓存计数，零请求时 cacheHitRate 为 0', async () => {
    const now = scriptedClock([100, 100, 250, 500])
    const result = await runQaTask(argsWith({ now }))

    expect(result.meta.startedAt).toBeDefined()
    expect(result.meta.finishedAt).toBe(result.meta.timestamp)
    expect(new Date(result.meta.startedAt!).getTime()).toBeLessThanOrEqual(new Date(result.meta.finishedAt!).getTime())
    expect(result.meta.runWallClockMs).toBe(400)
    expect(result.meta.cacheHits).toBe(0)
    expect(result.meta.cacheMisses).toBe(0)
    expect(result.meta.cacheHitRate).toBe(0)
  })

  it('latencyP50/P95 与 llmNetworkLatencyP50Ms/P95Ms 相等', async () => {
    const result = await runQaTask(argsWith())

    // 最近秩法 p50：percentile([120, 340], 50) = ceil(0.5*2)-1 = 0 → 120（340 是 p95）
    expect(result.metrics.latencyP50).toBe(120)
    expect(result.metrics.latencyP95).toBe(340)
    expect(result.metrics.llmNetworkLatencyP50Ms).toBe(120)
    expect(result.metrics.llmNetworkLatencyP95Ms).toBe(340)
    expect(result.metrics.llmNetworkLatencyP50Ms).toBe(result.metrics.latencyP50)
    expect(result.metrics.llmNetworkLatencyP95Ms).toBe(result.metrics.latencyP95)
  })

  it('meta 全量透传评测契约字段', async () => {
    const result = await runQaTask(argsWith())
    const contract = buildEvaluationContract([sample])
    expect(result.meta.metricSchemaVersion).toBe(contract.metricSchemaVersion)
    expect(result.meta.mrrDefinition).toBe(contract.mrrDefinition)
    expect(result.meta.contextBudgetTokens).toBe(contract.contextBudgetTokens)
    expect(result.meta.contextTokenizer).toBe(contract.contextTokenizer)
    expect(result.meta.contextTokenizerRevision).toBe(contract.contextTokenizerRevision)
    expect(result.meta.evidenceMappingVersion).toBe(contract.evidenceMappingVersion)
    expect(result.meta.datasetFingerprint).toBe(contract.datasetFingerprint)
    expect(result.meta.eligibleRetrievalQuestionIdsHash).toBe(contract.eligibleRetrievalQuestionIdsHash)
    expect(result.meta.eligibleRetrievalQuestionCount).toBe(contract.eligibleRetrievalQuestionCount)
  })

  it('检索阶段缺失 timing 字段时抛错，不把缺口径的题静默当成功样本', async () => {
    const deps = stagedDeps({
      retrieveContext: async () => ({
        retrievals: [], retrievalQuery: 'Q?', rewritten: false, context: '', sources: [],
        llmCalls: 0, treeRouted: false, contextTruncated: false, pipelineStartedAt: 0,
      } as unknown as RagRetrievalStage),
    })
    await expect(runQaTask(argsWith({ deps }))).rejects.toThrow(/timing/)
  })

  it('任一阶段时延字段为负或非有限时抛错，不伪造成功', async () => {
    // 检索阶段两个字段逐个覆盖；生成阶段两个字段逐个覆盖
    const badRetrievals: RagRetrievalStage[] = [
      { ...retrievalStage(), queryRewriteLatencyMs: -1 },
      { ...retrievalStage(), retrievalLatencyMs: NaN },
    ]
    for (const stage of badRetrievals) {
      const deps = stagedDeps({ retrieveContext: async () => stage })
      await expect(runQaTask(argsWith({ deps }))).rejects.toThrow(/timing/)
    }
    const badGenerations: RagGenerationStage[] = [
      { ...generationStage(), answerGenerationLatencyMs: Infinity },
      { ...generationStage(), queryEndToEndLatencyMs: -5 },
    ]
    for (const stage of badGenerations) {
      const deps = stagedDeps({ generateAnswer: async () => stage })
      await expect(runQaTask(argsWith({ deps }))).rejects.toThrow(/timing/)
    }
  })

  it('keeps retrieval metrics when answer generation fails', async () => {
    const result = await runQaTask(argsWith({
      deps: {
        buildIndex: async () => tree,
        retrieveContext: async () => retrievalStage({ contextPageOrder: [3, 0] }),
        generateAnswer: async () => { throw new Error('generation failed') },
      },
    }))
    expect(result.perSample[0].metrics.contextPageMrr).toBe(0.5)
    expect(result.perSample[0].generationStatus).toBe('failed')
    expect(result.meta.completed).toBe(0)
    expect(result.errors).toContainEqual(expect.objectContaining({ stage: 'generate' }))
  })

  it('检索阶段抛错时保留 failed 记录并补零观测，生成按 skipped 计且分母不变量成立', async () => {
    const deps = stagedDeps({
      retrieveContext: vi.fn().mockRejectedValue(new Error('retrieve boom')),
    })
    const result = await runQaTask(argsWith({ deps }))

    // 记录在检索前就入列，检索异常只更新状态、不整条丢弃
    expect(result.perSample).toHaveLength(1)
    expect(result.perSample[0].retrievalStatus).toBe('failed')
    expect(result.perSample[0].metrics).toMatchObject({
      contextPageMrr: 0, evidenceRecall: 0, evidenceHit: 0, contextPrecision: 0,
    })
    expect(result.perSample[0].generationStatus).toBe('skipped')
    expect(result.perSample[0].judgeStatus).toBe('skipped')
    expect(result.errors).toContainEqual(expect.objectContaining({ stage: 'retrieve' }))
    // 固定分母不变量仍成立：有效题补了 1 条零观测 == 契约有效题数
    expect(result.metrics.contextPageMrrSampleCount).toBe(1)
    expect(result.metrics.contextPageMrrEligibleCount).toBe(1)
  })

  it('有效题缺少 contextPageOrder 时抛错，空页序 [] 照常按未命中计', async () => {
    // undefined 会把「本该有观测却丢失」伪装成合法的 MRR 0 → 按契约违约抛错
    const deps = stagedDeps({
      retrieveContext: vi.fn().mockResolvedValue(retrievalStage({ contextPageOrder: undefined })),
    })
    await expect(runQaTask(argsWith({ deps }))).rejects.toThrow(/contextPageOrder/)

    // 空上下文写 []（合法的 0 命中），四个指标照常写入 0 且进入固定分母，不抛错
    const empty = await runQaTask(argsWith({
      deps: stagedDeps({ retrieveContext: vi.fn().mockResolvedValue(retrievalStage({ contextPageOrder: [] })) }),
    }))
    expect(empty.perSample[0].metrics.contextPageMrr).toBe(0)
    expect(empty.perSample[0].metrics.evidenceHit).toBe(0)
    expect(empty.metrics.contextPageMrrSampleCount).toBe(1)
  })

  it('writes a zero retrieval observation for every eligible question after index failure', async () => {
    const result = await runQaTask(argsWith({
      deps: { buildIndex: async () => { throw new Error('bad index') } },
    }))
    expect(result.perSample[0].metrics).toMatchObject({
      contextPageMrr: 0, evidenceRecall: 0, evidenceHit: 0, contextPrecision: 0,
    })
    expect(result.perSample[0].retrievalStatus).toBe('failed')
  })

  it('索引失败时有效题记 failed 并补零观测，非有效题记 ineligible 且不写任何检索指标', async () => {
    // 同一篇内一有效一非有效：两者都从未检索，但状态必须能区分，
    // 否则消费方会把「本该有观测却失败」与「本就不在有效集合里」混为一谈
    const mixed: EvalSample = {
      ...sample,
      questions: [
        sample.questions[0],
        qasperQuestion({ id: 'p1#1', question: 'unknown?', answers: [], evidencePages: [2], unanswerable: true }),
      ],
    }
    const result = await runQaTask(argsWith({
      samples: [mixed],
      deps: { buildIndex: async () => { throw new Error('bad index') } },
    }))

    expect(result.perSample[0].retrievalStatus).toBe('failed')
    expect(result.perSample[0].metrics).toMatchObject({
      contextPageMrr: 0, evidenceRecall: 0, evidenceHit: 0, contextPrecision: 0,
    })
    // 非有效题：状态为 ineligible，且一个检索指标键都不写（不伪造观测）
    expect(result.perSample[1].retrievalStatus).toBe('ineligible')
    expect(result.perSample[1].metrics).toEqual({ answerF1AllQuestions: 0 })
    expect(result.perSample[1].metrics.contextPageMrr).toBeUndefined()
    // 固定分母只数有效题：1 条观测 == 契约有效题数 1
    expect(result.metrics.contextPageMrrSampleCount).toBe(1)
    expect(result.metrics.contextPageMrrEligibleCount).toBe(1)
  })

  it('throws when the fixed contextPageMrr denominator drifts from the contract', async () => {
    // 契约声明 2 道有效题，但只执行 1 道（污染 limit）→ 观测数 1 ≠ 2，必须抛错而非静默比较
    await expect(runQaTask(argsWith({
      samples: [
        {
          ...sample,
          questions: [
            sample.questions[0],
            qasperQuestion({ id: 'p1#1', question: 'Q2?', answers: ['9'], evidencePages: [2], unanswerable: false }),
          ],
        },
      ],
      limit: 1,
      evaluationContract: buildEvaluationContract([
        {
          ...sample,
          questions: [
            sample.questions[0],
            qasperQuestion({ id: 'p1#1', question: 'Q2?', answers: ['9'], evidencePages: [2], unanswerable: false }),
          ],
        },
      ]),
    }))).rejects.toThrow(/固定分母/)
  })
})

describe('runQaTask — speed mode', () => {
  it('rejects a cache-enabled answer client before indexing', async () => {
    const evaluationContract = buildEvaluationContract([sample])
    const cachedClient = { ...speedClient([]), cacheEnabled: () => true }

    await expect(runQaTask(argsWith({
      client: cachedClient,
      deps: stagedDeps({
        buildIndex: async () => { throw new Error('index must not start') },
      }),
      evaluationContract,
      speed: { contract: speedContract(evaluationContract.datasetFingerprint) },
    }))).rejects.toThrow(/cache/i)
  })

  it('starts after indexing, marks the final materialized context, streams, and finishes before judge', async () => {
    const events: string[] = []
    const client = speedClient([
      { totalTokens: 10, incompleteRequestCount: 0 },
      { totalTokens: 22, incompleteRequestCount: 0 },
    ], events)
    const deps = stagedDeps({
      buildIndex: vi.fn(async () => {
        events.push('index')
        return tree
      }),
      retrieveContext: vi.fn(async () => {
        events.push('retrieve-start')
        events.push('retrieve-return')
        return retrievalStage({ pipelineStartedAt: 30 })
      }),
      generateAnswer: vi.fn(async () => {
        throw new Error('non-stream generation must not run in speed mode')
      }),
    })
    const speedNow = scriptedClock([100, 130, 150, 190], events, ['t0', 't1', 'ttft', 't3'])
    const streamAnswer: StreamingLlmClient['chatStream'] = vi.fn(async (_messages, onVisibleText) => {
      events.push('stream-start')
      onVisibleText('8')
      events.push('stream-return')
      return { content: '8' }
    })
    const judgeClient = {
      ...fakeClient,
      complete: vi.fn(async () => {
        events.push('judge')
        return '{"factuality":5,"completeness":5,"groundedness":5}'
      }),
    }
    const evaluationContract = buildEvaluationContract([sample])

    const result = await runQaTask(argsWith({
      client,
      deps,
      now: scriptedClock(
        [0, 0, 10, 50, 80, 100, 120],
        events,
        ['clock-1', 'clock-2', 'clock-3', 'clock-4', 'clock-5', 'clock-6', 'clock-7'],
      ),
      judgeClient: judgeClient as never,
      judgeModel: 'judge-model',
      evaluationContract,
      speed: {
        contract: speedContract(evaluationContract.datasetFingerprint),
        now: speedNow,
        streamAnswer,
      },
    }))

    expect(events).toEqual([
      'clock-1',
      'clock-2',
      'index',
      'clock-3',
      'token-before',
      't0',
      'retrieve-start',
      'retrieve-return',
      't1',
      'clock-4',
      'stream-start',
      'ttft',
      'stream-return',
      'clock-5',
      't3',
      'token-after',
      'judge',
      'clock-6',
    ])
    expect(deps.generateAnswer).not.toHaveBeenCalled()
    expect(result.perSample[0]).toMatchObject({
      retrievalStatus: 'completed',
      generationStatus: 'completed',
      judgeStatus: 'completed',
      answer: '8',
      timing: {
        queryRewriteLatencyMs: 0,
        retrievalLatencyMs: 20,
        answerGenerationLatencyMs: 30,
        queryEndToEndLatencyMs: 50,
      },
      speed: {
        evidenceReadyLatencyMs: 30,
        timeToFirstTokenMs: 50,
        fullAnswerLatencyMs: 90,
        onlineTokenCount: 12,
        tokenAccountingComplete: true,
      },
    })
    expect(result.perSample[0].metrics).toMatchObject({ contextPageMrr: 1, answerF1: 1 })
    expect(result.metrics).toMatchObject({
      speedSampleCount: 1,
      onlineTokenSampleCount: 1,
      evidenceReadyLatencyP50Ms: 30,
      timeToFirstTokenP50Ms: 50,
      fullAnswerLatencyP50Ms: 90,
    })
    expect(result.meta).toMatchObject({
      speedMetricSchemaVersion: 2,
      speedDefinition: 'query-timeline-v2',
      completedSpeedQuestionCount: 1,
    })
  })

  it('keeps retrieval failure semantics and records only the reached speed boundary', async () => {
    const client = speedClient([
      { totalTokens: 10, incompleteRequestCount: 0 },
      { totalTokens: 13, incompleteRequestCount: 0 },
    ])
    const evaluationContract = buildEvaluationContract([sample])
    const result = await runQaTask(argsWith({
      client,
      deps: stagedDeps({ retrieveContext: vi.fn().mockRejectedValue(new Error('retrieve boom')) }),
      evaluationContract,
      speed: {
        contract: speedContract(evaluationContract.datasetFingerprint),
        now: scriptedClock([100]),
      },
    }))

    expect(result.perSample[0]).toMatchObject({
      retrievalStatus: 'failed',
      generationStatus: 'skipped',
      judgeStatus: 'skipped',
      metrics: { contextPageMrr: 0, evidenceRecall: 0, evidenceHit: 0, contextPrecision: 0 },
      speed: { onlineTokenCount: 3, tokenAccountingComplete: true },
    })
    expect(result.perSample[0].speed).not.toHaveProperty('evidenceReadyLatencyMs')
    expect(result.errors).toContainEqual(expect.objectContaining({ stage: 'retrieve', message: 'retrieve boom' }))
    expect(result.metrics.speedSampleCount).toBe(0)
  })

  it('records a pre-first-token stream failure without inventing TTFT or full-answer milestones', async () => {
    const client = speedClient([
      { totalTokens: 10, incompleteRequestCount: 0 },
      { totalTokens: 14, incompleteRequestCount: 1 },
    ])
    const evaluationContract = buildEvaluationContract([sample])
    const result = await runQaTask(argsWith({
      client,
      evaluationContract,
      speed: {
        contract: speedContract(evaluationContract.datasetFingerprint),
        now: scriptedClock([100, 120]),
        streamAnswer: async () => { throw new Error('stream failed before first token') },
      },
    }))

    expect(result.perSample[0]).toMatchObject({
      retrievalStatus: 'completed',
      generationStatus: 'failed',
      judgeStatus: 'skipped',
      speed: { evidenceReadyLatencyMs: 20, tokenAccountingComplete: false },
    })
    expect(result.perSample[0].speed).not.toHaveProperty('timeToFirstTokenMs')
    expect(result.perSample[0].speed).not.toHaveProperty('fullAnswerLatencyMs')
    expect(result.perSample[0].metrics.contextPageMrr).toBe(1)
    expect(result.errors).toContainEqual(expect.objectContaining({ stage: 'stream' }))
  })

  it('records a mid-stream failure through TTFT but not full answer', async () => {
    const client = speedClient([
      { totalTokens: 5, incompleteRequestCount: 0 },
      { totalTokens: 9, incompleteRequestCount: 0 },
    ])
    const evaluationContract = buildEvaluationContract([sample])
    const result = await runQaTask(argsWith({
      client,
      evaluationContract,
      speed: {
        contract: speedContract(evaluationContract.datasetFingerprint),
        now: scriptedClock([100, 120, 145]),
        streamAnswer: async (_messages, onVisibleText) => {
          onVisibleText('partial')
          throw new Error('stream disconnected')
        },
      },
    }))

    expect(result.perSample[0].speed).toEqual({
      evidenceReadyLatencyMs: 20,
      timeToFirstTokenMs: 45,
      onlineTokenCount: 4,
      tokenAccountingComplete: true,
    })
    expect(result.errors).toContainEqual(expect.objectContaining({ stage: 'stream', message: 'stream disconnected' }))
  })

  it('invalidates the run when a completed stream violates timeline invariants', async () => {
    const client = speedClient([
      { totalTokens: 5, incompleteRequestCount: 0 },
      { totalTokens: 9, incompleteRequestCount: 0 },
    ])
    const evaluationContract = buildEvaluationContract([sample])

    await expect(runQaTask(argsWith({
      client,
      evaluationContract,
      speed: {
        contract: speedContract(evaluationContract.datasetFingerprint),
        now: scriptedClock([100, 120, 145]),
        streamAnswer: async () => ({ content: 'answer without a visible callback' }),
      },
    }))).rejects.toThrow(/timeToFirstTokenMs/)
  })
})

/**
 * 全文直投基线（--mode full-context）：它表示「回答模型能用全文时的效果上限」，
 * 不是检索参赛者——不受 4096 受控预算约束，也不得携带任何检索契约身份。
 */
describe('runFullContextQaTask — 生成上限基线', () => {
  const fullContextClient = {
    complete: vi.fn(),
    chat: vi.fn(async () => '答案'),
    stats: () => ({ hits: 0, misses: 0 }),
    latencies: () => [120],
    requestTimings: () => [],
  }

  const fullContext = () => runFullContextQaTask({
    samples: [sample],
    config: { name: 'default', topK: 2 },
    client: fullContextClient as never,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    gitSha: 'abc1234',
    model: 'test-model',
  })

  it('显式排除于检索比较之外，且不写任何受控契约身份', async () => {
    const result = await fullContext()

    expect(result.meta).toMatchObject({
      comparisonEligible: false,
      comparisonIneligibleReason: 'full-context-generation-ceiling',
      retrievalAlgorithm: 'none',
    })
    // 不参与检索排名：Context Page MRR 无观测
    expect(result.metrics.contextPageMrr).toBeUndefined()
    // 契约 tokenizer/预算身份一个都不写——写上去等于宣称它跑过受控预算
    expect(result.meta.contextTokenizer).toBeUndefined()
    expect(result.meta.contextTokenizerRevision).toBeUndefined()
    expect(result.meta.contextBudgetTokens).toBeUndefined()
    expect(result.meta.metricSchemaVersion).toBeUndefined()
  })

  it('retains non-stream generation failures and scores them as zero', async () => {
    const client = {
      ...fullContextClient,
      chat: vi.fn().mockRejectedValue(new Error('generation unavailable')),
    }
    const result = await runFullContextQaTask({
      samples: [sample],
      config: { name: 'default', topK: 2 },
      client: client as never,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      gitSha: 'abc1234',
      model: 'test-model',
    })

    expect(result.meta.completed).toBe(0)
    expect(result.perSample).toEqual([expect.objectContaining({
      id: 'p1#0',
      generationStatus: 'failed',
      judgeStatus: 'skipped',
      metrics: { answerF1AllQuestions: 0 },
      referenceAnswers: ['8'],
    })])
    expect(result.metrics).toMatchObject({
      answerF1AllQuestions: 0,
      answerF1AllQuestionsSampleCount: 1,
      qaCompletionRate: 0,
    })
    expect(result.errors).toContainEqual(expect.objectContaining({ stage: 'generate', message: 'generation unavailable' }))
  })

  it('omits the QASPER quality contract when the selected slice contains only smoke questions', async () => {
    const smoke: EvalSample = { ...sample, paperId: 'smoke', source: 'smoke' }
    const result = await runFullContextQaTask({
      samples: [smoke, sample],
      limit: 1,
      config: { name: 'default', topK: 2 },
      client: { ...fullContextClient, chat: vi.fn(async () => '8') } as never,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      gitSha: 'abc1234',
      model: 'test-model',
    })

    expect(result.meta.qaQualityDefinition).toBeUndefined()
    expect(result.metrics.answerF1AllQuestions).toBeUndefined()
  })

  it('保持全文直投：system 报文含整篇论文与数学格式约束，user 报文只含原始问题', async () => {
    fullContextClient.chat.mockClear()
    await fullContext()

    const [messages] = fullContextClient.chat.mock.calls[0] as unknown as [Array<{ role: string; content: string }>]
    const system = messages[0].content
    expect(messages[0].role).toBe('system')
    expect(system).toContain(DEFAULT_SYSTEM_PROMPT)
    expect(system).toContain(MATH_FORMAT_INSTRUCTION)
    // 整篇论文逐页拼进 system（含第 0 页哨兵串），未被任何预算裁剪
    for (const page of sample.pages) expect(system).toContain(page)
    expect(messages[1]).toEqual({ role: 'user', content: sample.questions[0].question })
  })

  it('经由共享 builder 产生逐字相同的全文 prompt，并保持答案质量', async () => {
    const buildMessages = vi.spyOn(ragPipeline, 'buildAnswerMessages')
    fullContextClient.chat.mockReset().mockResolvedValue('8')
    const baseSystemPrompt = '全文基座提示词'
    const languageInstruction = '请用英文作答。'

    const result = await runFullContextQaTask({
      samples: [sample],
      config: { name: 'default', topK: 2 },
      client: fullContextClient as never,
      systemPrompt: baseSystemPrompt,
      answerLanguageInstruction: languageInstruction,
      gitSha: 'abc1234',
      model: 'test-model',
    })

    const paper = sample.pages.join('\n\n')
    expect(buildMessages).toHaveBeenCalledWith(
      paper,
      sample.questions[0].question,
      [],
      `${baseSystemPrompt}\n\n${languageInstruction}`,
    )
    expect(fullContextClient.chat).toHaveBeenCalledWith([
      {
        role: 'system',
        content: `${baseSystemPrompt}\n\n${languageInstruction}\n\n${MATH_FORMAT_INSTRUCTION}\n\n参考内容：\n${paper}`,
      },
      { role: 'user', content: sample.questions[0].question },
    ])
    expect(result.metrics.answerF1).toBe(1)
    buildMessages.mockRestore()
  })

  it('speed 模式在构造全文 prompt 前拒绝 cache-enabled answer client', async () => {
    const cachedClient = { ...speedClient([]), cacheEnabled: () => true }

    await expect(runFullContextQaTask({
      samples: [sample],
      config: { name: 'default', topK: 2 },
      client: cachedClient,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      gitSha: 'abc1234',
      model: 'test-model',
      speed: { contract: speedContract('full-context-fingerprint') },
    })).rejects.toThrow(/cache/i)
  })

  it('speed 模式流式发送同一全文 prompt，仅记录生成时间线且不因不完整 token 遥测平均用量', async () => {
    const speedSample: EvalSample = {
      ...sample,
      questions: [
        sample.questions[0],
        qasperQuestion({ id: 'p1#1', question: 'Q2?', answers: [], evidencePages: [], unanswerable: true }),
      ],
    }
    const client = speedClient([
      { totalTokens: 10, incompleteRequestCount: 0 },
      { totalTokens: 14, incompleteRequestCount: 0 },
      { totalTokens: 14, incompleteRequestCount: 0 },
      { totalTokens: 20, incompleteRequestCount: 1 },
    ])
    const streamAnswer: StreamingLlmClient['chatStream'] = vi.fn(async (messages, onVisibleText) => {
      onVisibleText('visible')
      return { content: messages[1].content === 'Q1?' ? '8' : '无法根据给定内容回答。' }
    })
    const judgeClient = {
      complete: vi.fn(async (prompt: string) => prompt.includes('待评估回答')
        ? '{"factuality":5,"completeness":4,"groundedness":5}'
        : 'REFUSAL'),
      chat: vi.fn(),
      stats: () => ({ hits: 0, misses: 0 }),
      latencies: () => [],
      requestTimings: () => [],
    }

    const result = await runFullContextQaTask({
      samples: [speedSample],
      config: { name: 'default', topK: 2 },
      client,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      gitSha: 'abc1234',
      model: 'test-model',
      judgeClient,
      judgeModel: 'judge-model',
      now: () => 0,
      speed: {
        contract: speedContract('full-context-fingerprint'),
        now: scriptedClock([100, 125, 160, 200, 215, 270]),
        streamAnswer,
      },
    })

    const expectedSystem = `${DEFAULT_SYSTEM_PROMPT}\n\n${MATH_FORMAT_INSTRUCTION}\n\n参考内容：\n${speedSample.pages.join('\n\n')}`
    expect(streamAnswer).toHaveBeenCalledTimes(2)
    expect(vi.mocked(streamAnswer).mock.calls[0][0]).toEqual([
      { role: 'system', content: expectedSystem },
      { role: 'user', content: 'Q1?' },
    ])
    expect(result.perSample.map(record => record.speed)).toEqual([
      { timeToFirstTokenMs: 25, fullAnswerLatencyMs: 60, onlineTokenCount: 4, tokenAccountingComplete: true },
      { timeToFirstTokenMs: 15, fullAnswerLatencyMs: 70, tokenAccountingComplete: false },
    ])
    expect(result.perSample.every(record => record.speed?.evidenceReadyLatencyMs === undefined)).toBe(true)
    expect(result.metrics).toMatchObject({
      answerF1: 1,
      unanswerableAccuracy: 1,
      judgeFactuality: 5,
      judgeCompleteness: 4,
      judgeGroundedness: 5,
      timeToFirstTokenP50Ms: 15,
      timeToFirstTokenP95Ms: 25,
      fullAnswerLatencyP50Ms: 60,
      fullAnswerLatencyP95Ms: 70,
      speedSampleCount: 2,
      onlineTokenSampleCount: 1,
    })
    expect(result.metrics.evidenceReadyLatencyP50Ms).toBeUndefined()
    expect(result.metrics.avgOnlineTokensPerCompletedAnswer).toBeUndefined()
    expect(result.meta).toMatchObject({
      comparisonEligible: false,
      comparisonIneligibleReason: 'full-context-generation-ceiling',
      unanswerableMethod: 'judge',
      completedSpeedQuestionCount: 2,
    })
  })

  it('speed 流中断后保留已达到的生成时间线并标记 stream 错误', async () => {
    const client = speedClient([
      { totalTokens: 10, incompleteRequestCount: 0 },
      { totalTokens: 14, incompleteRequestCount: 0 },
    ])

    const result = await runFullContextQaTask({
      samples: [sample],
      config: { name: 'default', topK: 2 },
      client,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      gitSha: 'abc1234',
      model: 'test-model',
      now: () => 0,
      speed: {
        contract: speedContract('full-context-fingerprint'),
        now: scriptedClock([100, 120]),
        streamAnswer: async (_messages, onVisibleText) => {
          onVisibleText('partial')
          throw new Error('stream disconnected')
        },
      },
    })

    expect(result.perSample).toEqual([expect.objectContaining({
      id: 'p1#0',
      generationStatus: 'failed',
      judgeStatus: 'skipped',
      speed: {
        timeToFirstTokenMs: 20,
        onlineTokenCount: 4,
        tokenAccountingComplete: true,
      },
    })])
    expect(result.perSample[0].speed).not.toHaveProperty('evidenceReadyLatencyMs')
    expect(result.perSample[0].speed).not.toHaveProperty('fullAnswerLatencyMs')
    expect(result.errors).toContainEqual(expect.objectContaining({ stage: 'stream', message: 'stream disconnected' }))
    expect(result.metrics.speedSampleCount).toBe(0)
  })

  it('speed 完成但未出现可见文本时使整轮失效', async () => {
    const client = speedClient([
      { totalTokens: 10, incompleteRequestCount: 0 },
      { totalTokens: 14, incompleteRequestCount: 0 },
    ])

    await expect(runFullContextQaTask({
      samples: [sample],
      config: { name: 'default', topK: 2 },
      client,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      gitSha: 'abc1234',
      model: 'test-model',
      now: () => 0,
      speed: {
        contract: speedContract('full-context-fingerprint'),
        now: scriptedClock([100, 140]),
        streamAnswer: async () => ({ content: 'answer without a visible callback' }),
      },
    })).rejects.toThrow(/timeToFirstTokenMs/)
  })

  it('records a full-context judge-null diagnostic without changing answer quality provenance', async () => {
    const client = speedClient([
      { totalTokens: 10, incompleteRequestCount: 0 },
      { totalTokens: 14, incompleteRequestCount: 0 },
    ])
    const judgeClient = {
      complete: vi.fn(async () => 'not valid judge JSON'),
      chat: vi.fn(),
      stats: () => ({ hits: 0, misses: 0 }),
      latencies: () => [],
      requestTimings: () => [],
    }

    const result = await runFullContextQaTask({
      samples: [sample],
      config: { name: 'default', topK: 2 },
      client,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      gitSha: 'abc1234',
      model: 'test-model',
      judgeClient,
      judgeModel: 'judge-model',
      now: () => 0,
      speed: {
        contract: speedContract('full-context-fingerprint'),
        now: scriptedClock([100, 120, 140]),
        streamAnswer: async (_messages, onVisibleText) => {
          onVisibleText('8')
          return { content: '8' }
        },
      },
    })

    expect(result.metrics.answerF1).toBe(1)
    expect(result.metrics.judgeFactuality).toBeUndefined()
    expect(result.perSample[0]).toMatchObject({
      generationStatus: 'completed',
      judgeStatus: 'failed',
      answer: '8',
      metrics: { answerF1: 1, answerF1AllQuestions: 1 },
    })
    expect(result.errors).toContainEqual({
      sampleId: sample.questions[0].id,
      stage: 'judge',
      message: 'judge returned no valid answer scores',
    })
  })
})

/**
 * 生效 prompt 指纹必须来自 runner 真正使用的同一份拼装结果：CLI 只把
 * `composeBaseSystemPrompt(...)`（+ 数学格式约束）交给 runner，runner 内部不得再拼一遍。
 * 这里用注入的生成阶段实测报文，把「两处各写一份拼接」的漂移钉死。
 */
describe('生效 prompt 与 CLI 指纹同源', () => {
  it('runQaTask 传给生成阶段的 base prompt 与 composeBaseSystemPrompt 逐字一致', async () => {
    const instruction = '请使用论文原文语言（英文）作答'
    for (const passInstruction of [true, false]) {
      const deps = stagedDeps()
      await runQaTask(argsWith({
        deps,
        ...(passInstruction ? { answerLanguageInstruction: instruction } : {}),
      }))
      const observed = vi.mocked(deps.generateAnswer!).mock.calls[0][4]
      expect(observed).toBe(
        composeBaseSystemPrompt(DEFAULT_SYSTEM_PROMPT, passInstruction ? instruction : undefined),
      )
    }
  })
})

/**
 * 注入脚本化时钟：返回预设时间序列；读取次数超过预设即抛错，
 * 防止新增的时钟读取被静默吸收（用尽后保持末值会让「恰好调用 N 次」的注释形同虚设）。
 */
function scriptedClock(ts: number[], events?: string[], labels?: string[]): () => number {
  let i = 0
  return () => {
    if (i >= ts.length) throw new Error(`scriptedClock 超读：预设 ${ts.length} 次，第 ${i + 1} 次`)
    if (events && labels) events.push(labels[i])
    return ts[i++]
  }
}

describe('runQaTask + judge', () => {
  const judgeClient = {
    complete: vi.fn().mockResolvedValue('{"factuality":5,"completeness":4,"groundedness":5}'),
    chat: vi.fn(),
    stats: () => ({ hits: 0, misses: 0 }),
    latencies: () => [],
  }

  it('启用 judge 时记录三维分数并标注 judgeModel', async () => {
    const result = await runQaTask(argsWith({
      judgeClient: judgeClient as never,
      judgeModel: 'judge-model',
    }))

    expect(result.metrics.judgeFactuality).toBe(5)
    expect(result.metrics.judgeCompleteness).toBe(4)
    expect(result.metrics.judgeGroundedness).toBe(5)
    expect(result.meta.judgeModel).toBe('judge-model')
    expect(result.perSample[0].judgeStatus).toBe('completed')
  })

  it('judge prompt 用 evidence 原文而非检索上下文', async () => {
    judgeClient.complete.mockClear()
    await runQaTask(argsWith({
      judgeClient: judgeClient as never,
      judgeModel: 'judge-model',
    }))
    // 哨兵断言：evidence 只能来自 sample.pages[0]，不能混入 retrieveContext mock 返回的检索 context；
    // 普通短串会与 prompt 样板恒匹配（变异测试已证），必须用双方互斥的哨兵串
    const prompt = judgeClient.complete.mock.calls[0][0]
    expect(prompt).toContain('EVIDENCE_MARKER_7f3a')
    expect(prompt).not.toContain('CONTEXT_MARKER_9c2e')
  })

  it('judge 返回不可解析内容时不写 judge 指标、记 failed，其余指标照常', async () => {
    const badJudge = {
      complete: vi.fn().mockResolvedValue('我拒绝评分'),
      chat: vi.fn(), stats: () => ({ hits: 0, misses: 0 }), latencies: () => [],
    }
    const result = await runQaTask(argsWith({
      judgeClient: badJudge as never,
      judgeModel: 'judge-model',
    }))

    expect(result.metrics.judgeFactuality).toBeUndefined()
    expect(result.metrics.answerF1).toBe(1)
    expect(result.perSample[0].judgeStatus).toBe('failed')
  })

  it('keeps retrieval and answer metrics when judging fails', async () => {
    // judgeAnswer 内部吞掉网络异常返回 null；这里验证 judge 阶段失败不会牵连检索与答案指标
    const badJudge = { ...fakeClient, complete: vi.fn().mockRejectedValue(new Error('judge failed')) }
    const result = await runQaTask(argsWith({ judgeClient: badJudge as never, judgeModel: 'judge-model' }))
    expect(result.perSample[0]).toMatchObject({
      retrievalStatus: 'completed',
      generationStatus: 'completed',
      judgeStatus: 'failed',
    })
    expect(result.perSample[0].metrics.contextPageMrr).toBe(1)
    expect(result.perSample[0].metrics.answerF1).toBe(1)
  })

  it('judge 判定 unanswerable 时 meta 标注口径为 judge', async () => {
    const refusalJudge = {
      complete: vi.fn().mockResolvedValue('REFUSAL'),
      chat: vi.fn(), stats: () => ({ hits: 0, misses: 0 }), latencies: () => [],
    }
    const deps = stagedDeps({
      generateAnswer: vi.fn().mockResolvedValue(generationStage({ answer: '无从判断' })),
    })
    const unanswerableSample: EvalSample = {
      ...sample,
      questions: [qasperQuestion({ id: 'p1#0', question: 'Q?', answers: [], evidencePages: [], unanswerable: true })],
    }
    const result = await runQaTask(argsWith({
      samples: [unanswerableSample],
      judgeClient: refusalJudge as never,
      judgeModel: 'judge-model',
      deps,
    }))

    expect(result.metrics.unanswerableAccuracy).toBe(1)
    expect(result.meta.unanswerableMethod).toBe('judge')
  })
})
