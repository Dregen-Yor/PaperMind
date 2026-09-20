/**
 * QA runner 共用的记录、错误与结果收尾辅助：逐样本记录底稿、跳过记录语义、错误消息抽取、
 * 建索引失败登记、分位数时延收集与结果 finalize。
 * Task 7/8 改造 traditional / 强基线时直接复用同一份，避免「失败记录长什么样」与
 * 「结果怎么收尾」被各自复制后悄悄分叉（§6.3 记录生命周期 / §7 固定分母只能有一处定义）。
 */
import type { BenchConfig, BenchResult, EvalSample, PaperTimingRecord, PerSampleRecord, QaQuestion, SampleError } from '../types'
import type { LlmClient } from '../llmClient'
import type { EvaluationContract } from '../evaluationContract'
import { ZERO_CONTEXT_PAGE_METRICS } from '../metrics/retrieval'
import { aggregate, emitMetricSampleCounts, metricSampleCounts, renameQaRates, withLatencyStats, withPercentiles } from '../metrics/aggregate'
import { assertContextPageDenominator, contractMeta, isRetrievalEligible } from '../evaluationContract'
import { REFUSAL_PATTERN_VERSION } from '../metrics/answerF1'
import { RUBRIC_VERSION, type JudgeSampleState } from '../metrics/judge'
import type { SpeedRunContract } from '../speed/contract'
import { speedContractMeta } from '../speed/contract'
import { aggregateSpeedMetrics } from '../speed/metrics'

/** 统一错误消息抽取：`Error` 取 message，其余转字符串。 */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * 新入列的逐样本记录：先建好底稿并立即入列，任何后续阶段的失败都只更新状态、
 * 不整条丢弃（§6.3）。检索指标与诊断在记录对象上原地补齐。
 */
export function newSampleRecord(sample: EvalSample, question: QaQuestion): PerSampleRecord {
  return {
    id: question.id,
    paperId: sample.paperId,
    source: sample.source,
    metrics: {},
    evidencePages: question.evidencePages,
  }
}

/**
 * 该题从未真正检索/生成（索引失败，或检索阶段抛错）：有效题补四个零观测并记为 failed，
 * 非有效题一律记 ineligible——消费方据此按 status 直接过滤，不必反推 metrics 是否为空；
 * 生成阶段从未开始，按 skipped 计，不污染 meta.completed。
 */
export function skipSampleRecord(
  record: PerSampleRecord,
  eligible: boolean,
  stage: 'failed' | 'ineligible',
): void {
  if (eligible) Object.assign(record.metrics, ZERO_CONTEXT_PAGE_METRICS)
  record.retrievalStatus = stage
  record.generationStatus = 'skipped'
  record.judgeStatus = 'skipped'
}

/**
 * 建索引失败：该论文在本轮将执行的问题从未检索/生成，但仍逐题入列——有效题补四个零观测，
 * 否则它们会从固定分母缺席，把「本该有观测却丢失」伪装成合法的缺字段（§6.2 / §6.3）。
 * perPaper 记录（qa 记真实缓存差值、传统 RAG 记常量 0）差异太大，留在各自调用点，不并入本函数。
 */
export function recordIndexFailure(
  sample: EvalSample,
  questionCount: number,
  message: string,
  errors: SampleError[],
  records: PerSampleRecord[],
): void {
  for (let i = 0; i < questionCount; i++) {
    const question = sample.questions[i]
    errors.push({ sampleId: question.id, stage: 'index', message })
    const eligible = isRetrievalEligible(question)
    const record = newSampleRecord(sample, question)
    skipSampleRecord(record, eligible, eligible ? 'failed' : 'ineligible')
    records.push(record)
  }
}

/**
 * 收集分位数聚合需要的时延样本：
 * - perSample.timing 中的 retrieval / generation / end-to-end（失败样本不写 timing，自动缺席）
 * - perPaper 成功索引的 indexBuildLatencyMs（失败只写 error，不产生时长）
 * - client.latencies() 的网络 LLM 延迟
 */
export function collectTimingValues(
  perSample: PerSampleRecord[],
  perPaper: PaperTimingRecord[],
  client: LlmClient,
): Record<string, number[]> {
  const values: Record<string, number[]> = {
    indexBuildLatency: [],
    retrievalLatency: [],
    answerGenerationLatency: [],
    queryEndToEndLatency: [],
    llmNetworkLatency: [],
  }
  for (const record of perPaper) {
    if (record.indexBuildLatencyMs !== undefined) values.indexBuildLatency.push(record.indexBuildLatencyMs)
  }
  for (const record of perSample) {
    if (!record.timing) continue
    values.retrievalLatency.push(record.timing.retrievalLatencyMs)
    values.answerGenerationLatency.push(record.timing.answerGenerationLatencyMs)
    values.queryEndToEndLatency.push(record.timing.queryEndToEndLatencyMs)
  }
  values.llmNetworkLatency.push(...client.latencies())
  return values
}

export interface FinalizeQaArgs {
  config: BenchConfig
  contract: EvaluationContract
  records: PerSampleRecord[]
  perPaper: PaperTimingRecord[]
  errors: SampleError[]
  client: LlmClient
  model: string
  judgeModel?: string
  /** 是否显式提供了 judge 客户端；决定 meta.unanswerableMethod 是 judge 还是 pattern */
  hasJudgeClient: boolean
  /** judge 阶段累计口径状态（sawUnanswerable / usedPatternFallback） */
  judgeState: JudgeSampleState
  gitSha: string
  /** 默认 'qa'；摘要等任务可覆盖 */
  task?: BenchResult['task']
  startedAt: string
  finishedAt: string
  runWallClockMs: number
  total: number
  cacheHits: number
  cacheMisses: number
  retrievalAlgorithm: BenchResult['meta']['retrievalAlgorithm']
  qasperEvidenceQuestions: number
  mappedEvidenceQuestions: number
  ambiguousEvidenceQuestions: number
  unmappedEvidenceQuestions: number
  /** 追加/覆盖聚合指标（如语义树诊断），在既有指标之上合流 */
  extraMetrics?: Record<string, number>
  /** 追加分位数时延序列（如 treeBuildLatency），覆盖同名默认序列 */
  extraTimingValues?: Record<string, number[]>
  /** 追加 meta 字段（如 baselineFamily / candidateGranularity / checkpoint 调整后的计时口径） */
  extraMeta?: Partial<BenchResult['meta']>
  /** Opt-in query-timeline speed output; quality aggregation remains unchanged when absent. */
  speed?: { contract: SpeedRunContract }
}

/**
 * QA runner 共用的结果收尾：聚合 → 固定分母校验 → 改名/分位数 → meta 组装。
 * `completed`、契约字段、checkpoint 无关的计时口径与样本计数只在这里定义一次，
 * 避免五个 runner 各自复制后悄悄分叉。`finishedAt` 同时作为 meta.timestamp；
 * `runWallClockMs` 由调用方用各自时钟算好传入（Task 8 的断点续跑需自行调整该口径）。
 */
export function finalizeQaResult(args: FinalizeQaArgs): BenchResult {
  const raw = aggregate(args.records)
  const counts = metricSampleCounts(args.records)
  emitMetricSampleCounts(raw, counts)
  // 固定分母的另一半（§7）：契约声明的有效题数随指标一并落盘，供比较门按
  // contextPageMrrSampleCount === contextPageMrrEligibleCount 判定
  raw.contextPageMrrEligibleCount = args.contract.eligibleRetrievalQuestionCount
  // 固定分母不变量在契约模块统一强制，三个 runner 引擎共用同一处，禁止各自放宽
  assertContextPageDenominator(counts, args.contract)
  let speedMeta: Omit<ReturnType<typeof speedContractMeta>, 'datasetFingerprint'> | undefined
  if (args.speed) {
    if (args.speed.contract.datasetFingerprint !== args.contract.datasetFingerprint) {
      throw new Error('speed contract dataset fingerprint does not match evaluation contract')
    }
    // The equality check validates the duplicate field, but quality provenance remains owned by
    // contractMeta(args.contract), so the speed fragment deliberately does not merge its copy.
    const { datasetFingerprint: _validatedDatasetFingerprint, ...rest } = speedContractMeta(
      args.speed.contract,
      args.records,
    )
    speedMeta = rest
  }
  const values = { ...collectTimingValues(args.records, args.perPaper, args.client), ...args.extraTimingValues }
  // 重命名 0/1 指标的聚合结果为「率」，让报表列名自解释；
  // withLatencyStats 追加既有 latencyP50/P95（deprecated），分位数由 withPercentiles 计算
  const metrics = withPercentiles(
    { ...withLatencyStats(renameQaRates(raw), args.client.latencies()), ...args.extraMetrics },
    values,
  )
  // Speed is a separate completed-query cohort. Append it only after the existing quality
  // aggregate/rate rename/fixed-denominator and legacy timing paths have produced their values.
  if (args.speed) Object.assign(metrics, aggregateSpeedMetrics(args.records))
  // meta.completed 只数真正走完生成阶段的题；total 仍是本轮尝试执行的全部题（§6.2）
  const completed = args.records.filter(record => record.generationStatus === 'completed').length
  const ownedContractMeta: Partial<BenchResult['meta']> = {
    ...contractMeta(args.contract),
    ...speedMeta,
  }
  const extraMeta = { ...args.extraMeta }
  for (const [key, value] of Object.entries(ownedContractMeta)) {
    if (!Object.prototype.hasOwnProperty.call(extraMeta, key)) continue
    const supplied = extraMeta[key as keyof typeof extraMeta]
    if (supplied !== value) {
      throw new Error(`extraMeta ${key} cannot override contract-owned metadata`)
    }
    delete extraMeta[key as keyof typeof extraMeta]
  }
  return {
    task: args.task ?? 'qa',
    config: args.config,
    meta: {
      model: args.model,
      ...(args.judgeModel ? { judgeModel: args.judgeModel } : {}),
      timestamp: args.finishedAt,
      startedAt: args.startedAt,
      finishedAt: args.finishedAt,
      runWallClockMs: args.runWallClockMs,
      cacheHits: args.cacheHits,
      cacheMisses: args.cacheMisses,
      // 无请求时为 0，不能 NaN
      cacheHitRate: args.cacheHits + args.cacheMisses > 0 ? args.cacheHits / (args.cacheHits + args.cacheMisses) : 0,
      gitSha: args.gitSha,
      refusalPatternVersion: REFUSAL_PATTERN_VERSION,
      rubricVersion: RUBRIC_VERSION,
      retrievalAlgorithm: args.retrievalAlgorithm,
      completed,
      total: args.total,
      ...(args.judgeState.sawUnanswerable
        ? { unanswerableMethod: (args.hasJudgeClient && !args.judgeState.usedPatternFallback ? 'judge' : 'pattern') as 'judge' | 'pattern' }
        : {}),
      ...(args.qasperEvidenceQuestions > 0
        ? {
            evidenceMappingCoverage: args.mappedEvidenceQuestions / args.qasperEvidenceQuestions,
            ambiguousEvidenceRate: args.ambiguousEvidenceQuestions / args.qasperEvidenceQuestions,
            unmappedEvidenceRate: args.unmappedEvidenceQuestions / args.qasperEvidenceQuestions,
          }
        : {}),
      ...extraMeta,
      // 契约字段最后合流且不接受 extraMeta 改写，让每个数字都能追溯到真实坐标。
      ...ownedContractMeta,
    },
    metrics,
    perSample: args.records,
    perPaper: args.perPaper,
    errors: args.errors,
  }
}
