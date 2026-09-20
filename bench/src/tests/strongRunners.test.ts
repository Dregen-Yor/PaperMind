import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runHybridRerankQaTask, type HybridRerankQaArgs } from '../runner/hybridRerankQa'
import { runLongSectionQaTask, type LongSectionQaArgs } from '../runner/longSectionQa'
import { runStrongBaselineQaTask, type StrongBaselineQaArgs } from '../runner/strongBaselineQa'
import { buildEvaluationContract, composeBaseSystemPrompt } from '../evaluationContract'
import { materializeContext, type ContextGroup } from '../../../src/utils/contextTrace'
import { MATH_FORMAT_INSTRUCTION } from '../../../src/utils/ragPipeline'
import type { EvalSample } from '../types'
import type { LlmClient } from '../llmClient'

const client: LlmClient = {
  complete: async () => '', chat: async () => '', stats: () => ({ hits: 0, misses: 0 }), latencies: () => [], requestTimings: () => [],
}

// 物化器在测试里按「每个分片一个 token」分词：预算 N 恰好放行前 N 个产出文本的页，
// 让「候选在预算边界被截断、部分进入的页仍计入页序」这类边界可用 token 数精确表达。
const oneTokenPerPiece = { tokenize: (text: string) => (text ? [text] : []) }
const materializeWith = (budget: number) => (groups: ContextGroup[]) =>
  materializeContext(groups, oneTokenPerPiece, budget)

const hybridConfig = {
  name: 'hybrid-rerank', kind: 'hybrid-rerank' as const,
  chunking: { tokenizer: 'bge-m3' as const, chunkSize: 4, overlap: 1 },
  retrieval: {
    bm25: { topK: 3, k1: 1.2, b: 0.75 },
    dense: { topK: 3, embedding: { model: 'BAAI/bge-m3', revision: 'main', queryPrefix: '', normalize: true as const, maxLength: 8192 } },
    rrf: { k: 60, topK: 4 },
    reranker: { model: 'test/reranker', revision: 'main', topK: 3, maxLength: 512 },
  },
  // maxTokens 与出厂配置一致恒为受控预算 4096（config.ts 冻结）；截断由注入的物化器施加
  generationContext: { topK: 2, maxTokens: 4096 },
}

const longConfig = {
  name: 'long-section-rag', kind: 'long-section-rag' as const,
  anchors: { tokenizer: 'bge-m3' as const, chunkSize: 4, overlap: 1 },
  retrieval: { algorithm: 'bm25' as const, topK: 3, k1: 1.2, b: 0.75 },
  generationContext: { topK: 1, maxTokens: 4096 },
}

const sample: EvalSample = {
  paperId: 'p', title: 'p', source: 'smoke',
  pages: [
    'alpha beta gamma delta\nepsilon zeta eta theta',
    'iota kappa lambda mu\nnu xi omicron pi',
  ],
  questions: [
    { id: 'q1', question: 'alpha', answers: ['x'], evidencePages: [0], unanswerable: false },
    { id: 'q2', question: 'zeta', answers: ['y'], evidencePages: [0, 1], unanswerable: false },
  ],
}

/** 组装强基线共享引擎的必填身份字段：物化器、评测契约、端点身份、prompt 指纹。 */
const strongBase = (samples: EvalSample[]) => ({
  samples,
  client,
  materialize: materializeWith(4096),
  evaluationContract: buildEvaluationContract(samples),
  llmEndpointIdentity: 'endpoint-a',
  systemPromptHash: 'prompt-a',
})

const hybridArgs = (samples: EvalSample[], overrides: Partial<HybridRerankQaArgs> = {}): HybridRerankQaArgs => ({
  ...strongBase(samples), config: hybridConfig, systemPrompt: 's', gitSha: 'x', model: 'm', ...overrides,
})

const longArgs = (samples: EvalSample[], overrides: Partial<LongSectionQaArgs> = {}): LongSectionQaArgs => ({
  ...strongBase(samples), config: longConfig, systemPrompt: 's', gitSha: 'x', model: 'm', ...overrides,
})

describe('hybrid-rerank runner', () => {
  const deps = {
    tokenizer: { tokenize: (text: string) => text.split(/\s+/).filter(Boolean).map(w => `▁${w}`) },
    // dense 返回固定打分：与 BM25 召回相交可验证 RRF 去重与融合次序
    denseProvider: { embed: async (texts: string[]) => texts.map((_, i) => [1, i, 0]) },
    reranker: { score: async (pairs: Array<{ query: string; document: string }>) => pairs.map(p => -p.document.length) },
  }

  it('propagates page spans, respects token budget and computes MRR on the full final ordering', async () => {
    const result = await runHybridRerankQaTask(hybridArgs([sample], {
      deps,
      generateAnswer: async (_system, question) => `ans:${question}`,
    }))
    expect(result.meta.retrievalAlgorithm).toBe('hybrid-rerank')
    expect(result.meta.baselineFamily).toBe('strong')
    expect(result.meta.candidateGranularity).toContain('4-token')
    expect(result.errors).toEqual([])
    expect(result.perSample).toHaveLength(2)
    for (const record of result.perSample) {
      expect(record.selectedPages!.every(p => p >= 0 && p <= 1)).toBe(true)
      expect(record.metrics.contextPageMrr).toBeDefined()
    }
    // 指标样本数在聚合层：MRR 有 2 个有效观测
    expect(result.metrics.contextPageMrrSampleCount).toBe(2)
    // 每问恰好 1 次生成调用；索引阶段 0 次 LLM 调用
    expect(result.perSample.every(r => r.metrics.llmCalls === 1)).toBe(true)
    expect(result.perPaper!.every(p => p.indexLlmCalls === 0 && p.leafCount === result.perPaper![0].leafCount)).toBe(true)
  })

  it('records rerank failures as retrieve errors instead of silently falling back', async () => {
    const result = await runHybridRerankQaTask(hybridArgs([sample], {
      deps: { ...deps, reranker: { score: async () => { throw new Error('reranker exploded') } } },
      generateAnswer: async () => 'a',
    }))
    expect(result.errors).toHaveLength(2)
    expect(result.errors.every(e => e.stage === 'retrieve' && e.message.startsWith('rerank 失败：reranker exploded'))).toBe(true)
    // schema-v2：检索失败不再丢弃整条记录，而是保留并标注 failed（有效题补四个零观测）
    expect(result.perSample.map(r => r.id)).toEqual(['q1', 'q2'])
    expect(result.perSample.every(r => r.retrievalStatus === 'failed' && r.generationStatus === 'skipped')).toBe(true)
    expect(result.perSample.every(r => r.metrics.contextPageMrr === 0)).toBe(true)
  })

  // Task 8：删除了「候选整段超预算即整轮失败」的过渡守卫——现在由公共 materializer 在
  // 预算边界截断单个候选，部分进入的页仍计入最终页序（设计 §5）。
  // Task 9：配置里的 maxTokens 已被 config.ts 冻结为 4096（唯一合法值），runner 从不读它做
  // 最终预算——下面固定用合法配置、只改注入的物化器预算，正是这一点本身在受测。
  it('truncates at the budget boundary and still counts partially-included pages', async () => {
    const full = await runHybridRerankQaTask(hybridArgs([sample], {
      config: hybridConfig, materialize: materializeWith(16), deps, generateAnswer: async () => 'a',
    }))
    const partial = await runHybridRerankQaTask(hybridArgs([sample], {
      config: hybridConfig, materialize: materializeWith(1), deps, generateAnswer: async () => 'a',
    }))
    // 未截断：候选跨页 0-1，页序完整
    expect(full.errors).toEqual([])
    expect(full.perSample.map(r => r.contextPageOrder)).toEqual([[0, 1], [0, 1]])
    expect(full.perSample.every(r => r.contextTruncated === false)).toBe(true)
    // 预算边界截断：第一个候选只吐出页 0，被截掉的页 1 仍留在诊断包络里，但不进页序
    expect(partial.errors).toEqual([])
    for (const record of partial.perSample) {
      expect(record.selectedPages).toEqual([0, 1])
      expect(record.contextPageOrder).toEqual([0])
      expect(record.contextTruncated).toBe(true)
      // 部分进入的页照常参与检索指标：gold 页 0 在页序首位
      expect(record.metrics.contextPageMrr).toBe(1)
    }
  })
})

describe('long-section-rag runner', () => {
  const tokenizer = { tokenize: (text: string) => text.split(/\s+/).filter(Boolean).map(w => `▁${w}`) }
  // 手工章节：页 0 一节，页 1 一节
  const deps = {
    tokenizer,
    detectSections: () => [
      { title: 'A', startToken: 0, endToken: 8, startPage: 0, endPage: 0 },
      { title: 'B', startToken: 8, endToken: 16, startPage: 1, endPage: 1 },
    ],
  }

  it('returns one contiguous region as the single context unit and maps all covered pages', async () => {
    const result = await runLongSectionQaTask(longArgs([sample], {
      deps,
      generateAnswer: async (_system, question) => `ans:${question}`,
    }))
    expect(result.meta.retrievalAlgorithm).toBe('long-section-rag')
    expect(result.meta.candidateGranularity).toBe('contiguous section region')
    expect(result.errors).toEqual([])
    for (const record of result.perSample) {
      // 连续区域是单一上下文单元；token 预算由 runner 内部断言（tokenCount 口径），
      // metrics.contextTokens 是字符/4 的成本代理，与预算不同量纲，不做比较
      expect(record.selectedPages).toHaveLength(1)
      expect(record.selectedPages![0]).toBe(0)
      expect(record.metrics.contextTokens).toBeGreaterThan(0)
    }
  })

  it('never crosses section boundaries even when the budget is huge', async () => {
    const result = await runLongSectionQaTask(longArgs([sample], {
      config: { ...longConfig, generationContext: { topK: 1, maxTokens: 4096 } },
      deps,
      generateAnswer: async () => 'a',
    }))
    // 区域不能同时覆盖两页（章节边界即页边界）
    expect(result.perSample.every(r => r.selectedPages!.length === 1)).toBe(true)
  })

  it('falls back to the next ranked anchor deterministically when the best has no region', async () => {
    // 两锚点 BM25 同分（各含 1 次 zirconium）→ id 序：锚点 0 首位。
    // 注入的 detectSections 只覆盖页 1（token [2,6)）：锚点 0 起点在页 0 无章节，
    // 回退到锚点 1（起点 token 3 在页 1 章节内）
    const fallbackSample: EvalSample = {
      paperId: 'p2', title: 'p2', source: 'smoke',
      pages: ['zirconium alpha', 'beta gamma delta epsilon'],
      questions: [{ id: 'qz', question: 'zirconium', answers: ['x'], evidencePages: [1], unanswerable: false }],
    }
    let calls = 0
    const result = await runLongSectionQaTask(longArgs([fallbackSample], {
      deps: { ...deps, detectSections: () => { calls++; return [{ title: 'B', startToken: 2, endToken: 6, startPage: 1, endPage: 1 }] } },
      generateAnswer: async () => 'a',
    }))
    expect(calls).toBeGreaterThan(0)
    // 首选锚点无区域 → 回退到后续锚点（页 1 章节），证据页 1 被完整覆盖
    expect(result.perSample).toHaveLength(1)
    expect(result.perSample[0].selectedPages).toEqual([1])
    expect(result.metrics.evidenceRecall).toBe(1)
  })

  /**
   * CLI 的 systemPromptHash 取自 composeBaseSystemPrompt(...) + 数学格式约束。若 runner 内部
   * 另拼一份（换顺序、换分隔符），指纹就会去哈希一段模型从未见过的文本：改了 prompt 却
   * 复用了旧断点，两次运行混成一份。这里读生成阶段真实收到的报文做同源断言。
   */
  it('生成报文的 base prompt 与 CLI 指纹同源', async () => {
    const seen: string[] = []
    await runLongSectionQaTask(longArgs([sample], {
      answerLanguageInstruction: '请用英文作答',
      deps,
      generateAnswer: async (system) => { seen.push(system); return 'a' },
    }))
    expect(seen).toHaveLength(2)
    for (const system of seen) {
      expect(system.startsWith(`${composeBaseSystemPrompt('s', '请用英文作答')}\n\n${MATH_FORMAT_INSTRUCTION}`)).toBe(true)
    }
    // 未传语言指令时 base 就是原样 prompt，不得凭空多出一段分隔符
    const bare: string[] = []
    await runLongSectionQaTask(longArgs([sample], {
      deps,
      generateAnswer: async (system) => { bare.push(system); return 'a' },
    }))
    for (const system of bare) {
      expect(system.startsWith(`${composeBaseSystemPrompt('s')}\n\n${MATH_FORMAT_INSTRUCTION}`)).toBe(true)
    }
  })

  it('records a retrieve error when no anchor resolves', async () => {
    const result = await runLongSectionQaTask(longArgs([sample], {
      deps: { ...deps, detectSections: () => [] },
      generateAnswer: async () => 'a',
    }))
    expect(result.errors.every(e => e.stage === 'retrieve' && e.message.includes('无法解析'))).toBe(true)
    // 失败题保留记录并标注 failed（有效题四个指标写 0），不再整条丢弃
    expect(result.perSample.map(r => r.id)).toEqual(['q1', 'q2'])
    expect(result.perSample.every(r => r.retrievalStatus === 'failed' && r.metrics.contextPageMrr === 0)).toBe(true)
  })

  it('resumes completed questions and re-runs only the pending generation from an atomic checkpoint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'strong-checkpoint-'))
    const checkpointPath = join(dir, 'long.json')
    try {
      const firstCalls: string[] = []
      const first = await runLongSectionQaTask(longArgs([sample], {
        deps,
        checkpointPath,
        generateAnswer: async (_system, question) => {
          firstCalls.push(question)
          if (question === 'zeta') throw new Error('temporary failure')
          return `ans:${question}`
        },
      }))
      // 生成失败的题不再消失：记录保留为 failed（检索指标照常落盘），断点登记为待生成
      expect(first.perSample.map(record => record.id)).toEqual(['q1', 'q2'])
      expect(first.perSample[1]).toMatchObject({ retrievalStatus: 'completed', generationStatus: 'failed' })
      expect(first.errors).toHaveLength(1)

      const resumedCalls: string[] = []
      const progress: string[] = []
      const resumed = await runLongSectionQaTask(longArgs([sample], {
        deps,
        checkpointPath,
        onProgress: event => progress.push(`${event.status}:${event.sampleId}`),
        generateAnswer: async (_system, question) => {
          resumedCalls.push(question)
          return `ans:${question}`
        },
      }))
      // 生成已完成的 q1 整套跳过；q2 从断点里保存的检索产物继续，只重跑生成（不重跑检索）
      expect(firstCalls).toEqual(['alpha', 'zeta'])
      expect(resumedCalls).toEqual(['zeta'])
      expect(progress).toContain('resumed:q1')
      expect(progress).toContain('completed:q2')
      expect(resumed.perSample.map(record => record.id)).toEqual(['q1', 'q2'])
      expect(resumed.errors).toEqual([])
      expect(resumed.meta.completed).toBe(2)
      expect(resumed.meta.total).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('strong baseline stage-aware checkpoints', () => {
  // 单题样本：让 retrieve 调用次数与 meta.completed 可直接表达（1 = 首轮检索一次）
  const checkpointSample: EvalSample = {
    paperId: 'p', title: 'p', source: 'smoke',
    pages: ['alpha beta gamma', 'delta epsilon zeta'],
    questions: [{ id: 'q1', question: 'alpha', answers: ['x'], evidencePages: [0], unanswerable: false }],
  }

  const retrieve = vi.fn(async () => ({
    contextGroups: [{ pieces: [{ page: 0, text: 'alpha beta' }] }],
    retrievalLlmCalls: 0,
  }))

  const strongArgs = (checkpointPath: string): StrongBaselineQaArgs => ({
    samples: [checkpointSample],
    client,
    systemPrompt: 'system',
    gitSha: 'abc1234',
    model: 'answer-model',
    evaluationContract: buildEvaluationContract([checkpointSample]),
    materialize: groups => materializeContext(groups, oneTokenPerPiece, 4096),
    llmEndpointIdentity: 'provider:endpoint-hash-a',
    systemPromptHash: 'prompt-hash-a',
    generationSettings: { maxTokens: 512, requestTimeoutMs: 30_000 },
    judgeEnabled: false,
    retrieval: { granularity: 'test passage', build: async () => ({ leafCount: 1, retrieve }) },
    meta: { retrievalAlgorithm: 'long-section-rag', baselineFamily: 'strong', config: longConfig },
    checkpointPath,
  })

  it('resumes generation from a saved retrieval-only checkpoint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'strong-stage-'))
    const checkpointPath = join(dir, 'checkpoint.json')
    retrieve.mockClear()
    try {
      await runStrongBaselineQaTask({
        ...strongArgs(checkpointPath),
        generateAnswer: async () => { throw new Error('generation failed') },
      })
      const resumed = await runStrongBaselineQaTask({
        ...strongArgs(checkpointPath),
        generateAnswer: async () => 'answer',
      })
      // 检索只在首轮发生一次：续跑直接从保存的 pendingContext 继续生成
      expect(retrieve).toHaveBeenCalledTimes(1)
      expect(resumed.meta.completed).toBe(1)
      expect(resumed.perSample[0].metrics.contextPageMrr).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.each([
    ['judge model', { judgeModel: 'judge-b' }],
    ['endpoint identity', { llmEndpointIdentity: 'endpoint-b' }],
    ['system prompt hash', { systemPromptHash: 'prompt-b' }],
    ['generation settings', { generationSettings: { maxTokens: 1024, requestTimeoutMs: 30_000 } }],
    ['git sha', { gitSha: 'def5678' }],
    ['evaluation contract', { evaluationContract: { ...buildEvaluationContract([checkpointSample]), datasetFingerprint: 'fingerprint-b' } }],
  ])('rejects checkpoint when %s changes', async (_label, change) => {
    const dir = mkdtempSync(join(tmpdir(), 'strong-stage-'))
    const checkpointPath = join(dir, 'checkpoint.json')
    retrieve.mockClear()
    try {
      await runStrongBaselineQaTask({
        ...strongArgs(checkpointPath),
        generateAnswer: async () => { throw new Error('generation failed') },
      })
      // 身份变了 → 签名不匹配 → 旧断点被忽略 → 整题重跑检索
      await runStrongBaselineQaTask({
        ...strongArgs(checkpointPath),
        ...change,
        generateAnswer: async () => 'answer',
      })
      expect(retrieve).toHaveBeenCalledTimes(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('falls back to a fresh run when the checkpoint JSON parses but its entries are malformed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'strong-stage-'))
    const checkpointPath = join(dir, 'checkpoint.json')
    retrieve.mockClear()
    try {
      await runStrongBaselineQaTask({
        ...strongArgs(checkpointPath),
        generateAnswer: async () => { throw new Error('generation failed') },
      })
      // 保留签名、只把条目改写成损坏形状，模拟「合法 JSON 但内容被截断/损坏」
      const raw = JSON.parse(readFileSync(checkpointPath, 'utf-8')) as Record<string, unknown>
      raw.entries = [{}]
      writeFileSync(checkpointPath, JSON.stringify(raw))
      const resumed = await runStrongBaselineQaTask({
        ...strongArgs(checkpointPath),
        generateAnswer: async () => 'answer',
      })
      // 不抛异常：损坏断点被忽略，整题重跑检索（首轮 1 次 + 续跑 1 次）
      expect(retrieve).toHaveBeenCalledTimes(2)
      expect(resumed.perSample[0].metrics.contextPageMrr).toBe(1)
      expect(resumed.meta.completed).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('preserves meta.unanswerableMethod when an unanswerable question was judged in a prior run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'strong-stage-'))
    const checkpointPath = join(dir, 'checkpoint.json')
    const unanswerableSample: EvalSample = {
      paperId: 'p', title: 'p', source: 'smoke',
      pages: ['alpha beta gamma'],
      questions: [{ id: 'u1', question: 'what color?', answers: [], evidencePages: [], unanswerable: true }],
    }
    const judgeClient: LlmClient = {
      complete: async () => 'REFUSAL', chat: async () => '', stats: () => ({ hits: 0, misses: 0 }), latencies: () => [], requestTimings: () => [],
    }
    const args = (): StrongBaselineQaArgs => ({
      ...strongArgs(checkpointPath),
      samples: [unanswerableSample],
      evaluationContract: buildEvaluationContract([unanswerableSample]),
      judgeClient,
      judgeEnabled: true,
      generateAnswer: async () => '无法回答',
    })
    retrieve.mockClear()
    try {
      const first = await runStrongBaselineQaTask(args())
      expect(first.meta.unanswerableMethod).toBe('judge')
      // 上一进程判定的不可回答题在本进程被跳过，但口径必须从断点恢复，不静默消失
      const resumed = await runStrongBaselineQaTask(args())
      expect(resumed.meta.unanswerableMethod).toBe('judge')
      expect(retrieve).toHaveBeenCalledTimes(1)
      expect(resumed.meta.completed).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('replays only the judge stage when generation succeeded but judging failed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'strong-stage-'))
    const checkpointPath = join(dir, 'checkpoint.json')
    const failingJudge: LlmClient = {
      complete: async () => { throw new Error('judge down') }, chat: async () => '', stats: () => ({ hits: 0, misses: 0 }), latencies: () => [], requestTimings: () => [],
    }
    const workingJudge: LlmClient = {
      complete: async () => '{"factuality":5,"completeness":5,"groundedness":5}', chat: async () => '', stats: () => ({ hits: 0, misses: 0 }), latencies: () => [], requestTimings: () => [],
    }
    const generate = vi.fn(async () => 'answer')
    retrieve.mockClear()
    try {
      await runStrongBaselineQaTask({
        ...strongArgs(checkpointPath),
        judgeClient: failingJudge,
        judgeEnabled: true,
        generateAnswer: generate,
      })
      const firstGenerationCalls = generate.mock.calls.length
      retrieve.mockClear()
      // judge 客户端换了（模型/端点/prompt 身份未变，签名不变）→ 复用断点，只重放打分
      const resumed = await runStrongBaselineQaTask({
        ...strongArgs(checkpointPath),
        judgeClient: workingJudge,
        judgeEnabled: true,
        generateAnswer: generate,
      })
      // 检索与生成都不重跑：answer 复用断点里已落盘的那份
      expect(retrieve).not.toHaveBeenCalled()
      expect(generate.mock.calls.length).toBe(firstGenerationCalls)
      expect(resumed.perSample[0].judgeStatus).toBe('completed')
      expect(resumed.perSample[0].metrics.judgeFactuality).toBe(5)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
