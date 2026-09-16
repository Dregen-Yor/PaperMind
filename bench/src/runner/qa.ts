/**
 * QA 任务 Runner——整个评测的中枢编排：
 * 加载数据（由调用方完成）→ 建索引 → 跑生产 RAG 管线 → 计算检索/答案指标 → 聚合。
 * 复用 src/utils/ 的生产实现（buildPageIndex / runRagPipeline），
 * 评测与应用跑同一份代码，这是 benchmark 有效性的前提。
 */
import { buildPageIndex, collectLeafNodes, type IndexNode, type IndexOptions } from '../../../src/utils/pageIndex'
import { runRagPipeline, type RagOptions } from '../../../src/utils/ragPipeline'
import type { SemanticTreeHook } from '../metrics/treeDiagnostics'
import { summarizeTreeDiagnostics, treeRecordFields } from '../metrics/treeDiagnostics'
import type { PaperMindConfig, BenchResult, EvalSample, PaperTimingRecord, PerSampleRecord, PipelineTiming, SampleError } from '../types'
import type { LlmClient } from '../llmClient'
import { computeRetrievalMetrics, estimateTokens, expandPages } from '../metrics/retrieval'
import { answerF1, isRefusal, REFUSAL_PATTERN_VERSION } from '../metrics/answerF1'
import { judgeAnswer, judgeUnanswerable, RUBRIC_VERSION } from '../metrics/judge'
import { aggregate, metricSampleCounts, renameQaRates, withLatencyStats, withPercentiles } from '../metrics/aggregate'

/** 与 src/stores/chat.ts 的 DEFAULT_PROFILE.systemPrompt 保持一致的字面值。 */
export const DEFAULT_SYSTEM_PROMPT =
  '你是一个专业的学术论文阅读助手，帮助用户理解和分析论文内容。'

export interface QaTaskDeps {
  buildIndex?: typeof buildPageIndex
  runPipeline?: typeof runRagPipeline
}


export interface QaTaskArgs {
  samples: EvalSample[]
  config: PaperMindConfig
  client: LlmClient
  systemPrompt: string
  /**
   * 样本级语言覆盖指令：非空时以 `\n\n` 追加在 systemPrompt 之后。
   * QASPER 参考答案是英文而生产 prompt 是中文的，若不强制英文作答，
   * 中英 token 完全不相交，answerable 样本的 answerF1 恒≈0，量化评测失效。
   */
  answerLanguageInstruction?: string
  limit?: number
  gitSha: string
  model: string
  /** 提供时启用 LLM-as-judge；通常与 client 用不同模型 */
  judgeClient?: LlmClient
  judgeModel?: string
  /** 测试注入单调时钟；生产默认 Date.now */
  now?: () => number
  /** 注入替换生产实现，单测无需真实 LLM */
  deps?: QaTaskDeps
  /**
   * 提供时启用轻量语义树索引（§11.2 对照组的唯一变量）：
   * 同一条生产 RAG 管线，只是每篇论文多挂一棵树。
   */
  semanticTree?: SemanticTreeHook
}

/** 只透传 config 中显式给出的分块字段，未设置的字段让生产代码用默认值。 */
function indexOptions(config: PaperMindConfig): IndexOptions {
  const out: IndexOptions = {}
  if (config.chunkPages !== undefined) out.chunkPages = config.chunkPages
  if (config.minSectionPages !== undefined) out.minSectionPages = config.minSectionPages
  if (config.forceFixedChunk !== undefined) out.forceFixedChunk = config.forceFixedChunk
  if (config.maxSectionPages !== undefined) out.maxSectionPages = config.maxSectionPages
  return out
}

/** 只透传 config 中显式给出的检索字段（externalContext 已被 BenchConfig Omit，永不传入）。 */
function ragOptions(config: PaperMindConfig): RagOptions {
  const out: RagOptions = {}
  if (config.topK !== undefined) out.topK = config.topK
  if (config.minScore !== undefined) out.minScore = config.minScore
  if (config.enableRewrite !== undefined) out.enableRewrite = config.enableRewrite
  if (config.maxContextChars !== undefined) out.maxContextChars = config.maxContextChars
  return out
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export async function runQaTask(args: QaTaskArgs): Promise<BenchResult> {
  const { samples, config, client, limit, gitSha, model } = args
  const now = args.now ?? Date.now
  const startedAt = new Date().toISOString()
  const runStartedMs = now()
  const buildIndex = args.deps?.buildIndex ?? buildPageIndex
  const runPipeline = args.deps?.runPipeline ?? runRagPipeline
  // 语言覆盖指令追加在调用方 systemPrompt 之后；未传时 prompt 原样透传
  const systemPrompt = args.answerLanguageInstruction
    ? `${args.systemPrompt}\n\n${args.answerLanguageInstruction}`
    : args.systemPrompt

  const perSample: PerSampleRecord[] = []
  const perPaper: PaperTimingRecord[] = []
  const errors: SampleError[] = []
  let total = 0
  let sawUnanswerable = false
  // judge 不可用或部分失败而回落 pattern 时置位；meta.unanswerableMethod 据此如实标注口径
  let usedPatternFallback = false
  let qasperEvidenceQuestions = 0
  let mappedEvidenceQuestions = 0
  let ambiguousEvidenceQuestions = 0
  let unmappedEvidenceQuestions = 0

  for (const sample of samples) {
    if (limit !== undefined && total >= limit) break

    // 每篇论文只建一次索引，同篇的多个问题复用
    let tree: IndexNode
    const indexClientBefore = client.stats()
    const indexStartedMs = now()
    try {
      tree = await buildIndex(sample.pages, client.complete, indexOptions(config))
    } catch (e) {
      // 建索引失败：该论文全部问题按 index 阶段记错，不静默跳过。
      // 仍记录已消耗的索引时长与缓存差值——「索引慢后失败」的论文不能被时延分析漏掉，
      // 否则首次索引的真实成本在故障样本上完全不可见
      const indexFinishedMs = now()
      const indexClientAfter = client.stats()
      const questionCount = countExecutedQuestions(sample, limit, total)
      total += questionCount
      for (let i = 0; i < questionCount; i++) {
        errors.push({ sampleId: sample.questions[i].id, stage: 'index', message: errorMessage(e) })
      }
      perPaper.push({
        paperId: sample.paperId,
        source: sample.source,
        pageCount: sample.pages.length,
        questionCount,
        indexBuildLatencyMs: Math.max(0, indexFinishedMs - indexStartedMs),
        indexLlmCalls:
          (indexClientAfter.hits - indexClientBefore.hits)
          + (indexClientAfter.misses - indexClientBefore.misses),
        indexCacheHits: indexClientAfter.hits - indexClientBefore.hits,
        indexCacheMisses: indexClientAfter.misses - indexClientBefore.misses,
        error: errorMessage(e),
      })
      continue
    }
    const indexFinishedMs = now()
    const indexClientAfter = client.stats()
    // 单节点文档（buildPageIndex 直接返回叶子）时叶节点是树本身，
    // 与生产 pipeline 里的树路由用同一个取法，保证两边的候选集合一致
    const leaves = collectLeafNodes(tree)

    // 语义树在平面索引之后单独建：树的输入是原文证据块，与平面索引互不依赖。
    // 建树失败只是没有树，本篇所有问题照常走平面路径（§8.2）
    const treeInfo = args.semanticTree ? await args.semanticTree(sample) : undefined

    // questionCount 为本篇在 limit 约束下实际将执行的问题数，而不是原始总数
    const paperQuestionCount = countExecutedQuestions(sample, limit, total)
    perPaper.push({
      paperId: sample.paperId,
      source: sample.source,
      pageCount: sample.pages.length,
      questionCount: paperQuestionCount,
      indexBuildLatencyMs: Math.max(0, indexFinishedMs - indexStartedMs),
      // LLM 调用数 = 网络请求 + 缓存命中（buildPageIndex 的每叶 summarize + 根索引一次）
      indexLlmCalls:
        (indexClientAfter.hits - indexClientBefore.hits)
        + (indexClientAfter.misses - indexClientBefore.misses),
      indexCacheHits: indexClientAfter.hits - indexClientBefore.hits,
      indexCacheMisses: indexClientAfter.misses - indexClientBefore.misses,
      leafCount: leaves.length,
      ...treeRecordFields(treeInfo),
    })

    for (const question of sample.questions) {
      if (limit !== undefined && total >= limit) break
      total++
      if (sample.source === 'qasper' && !question.unanswerable) {
        qasperEvidenceQuestions++
        if (question.evidenceMapping === 'mapped') mappedEvidenceQuestions++
        else if (question.evidenceMapping === 'ambiguous') ambiguousEvidenceQuestions++
        else unmappedEvidenceQuestions++
      }

      // 生产 scoreAndSelect 对野值打分可能在 try 块外抛 TypeError，
      // 这里必须 catch 一切异常——单个坏样本不能终止整轮评测
      try {
        const questionStartedMs = now()
        const result = await runPipeline(
          [{
            tree,
            pages: sample.pages,
            ...(treeInfo?.semantic ? { semantic: treeInfo.semantic } : {}),
          }],
          question.question,
          [],                       // 单轮评测，无历史；rewriteRate 因此在本评测中恒为 0
          client.complete,
          client.chat,
          systemPrompt,
          ragOptions(config),
          { now },
        )
        // timing 是 benchmark 与生产 pipeline 的硬契约；必须在任何 judge 调用前验证。
        assertTiming(result.timing)

        const retrieval = result.retrievals[0]
        const metrics: Record<string, number> = {
          llmCalls: result.llmCalls,
          rewrite: result.rewritten ? 1 : 0,
          leafCount: leaves.length,
          contextTruncated: result.contextTruncated ? 1 : 0,
        }
        // 树诊断（§11.4）：本篇根本没建出树时记 treeDegraded，与「有树但没被选中」区分开。
        // 降级有两种来源，漏掉任何一种都会把失败路由统计成成功：
        // - 树取证不足（insufficientEvidence，已就地回落平面）
        // - 打分本身失败（retrieval.degraded：JSON 非法 / 覆盖不全 / 请求异常）
        if (treeInfo) {
          const semantic = retrieval?.semantic
          metrics.treeUsed = semantic ? 1 : 0
          metrics.treeDegraded = semantic
            ? (semantic.insufficientEvidence || retrieval?.degraded ? 1 : 0)
            : 1
          if (semantic) {
            metrics.selectedNodeCount = semantic.selectedNodeCount
            metrics.routableNodeCount = semantic.routableNodeCount
          }
        }

        if (retrieval) {
          const retrievalEligible = question.evidencePages.length > 0 && question.evidenceMapping !== 'ambiguous' && question.evidenceMapping !== 'unmapped'
          if (retrievalEligible) {
            // scores 的 id 必须与 leaves 同坐标系，否则 MRR 会把分数映射到别的页区间。
            // 树路由返回的 scores 已由 semanticRoute 保证只含平面叶节点下标（树域打分一律为空），
            // 走平面回落时这两个集合本来就是同一批叶节点。
            Object.assign(metrics, computeRetrievalMetrics({
              selected: retrieval.selected,
              leaves,
              scores: retrieval.scores,
              evidencePages: question.evidencePages,
              context: result.context,
              degraded: retrieval.degraded,
            }))
          } else {
            metrics.contextTokens = estimateTokens(result.context)
          }
          metrics.selectedContextTokens = estimateTokens(retrieval.context)
          metrics.degraded = retrieval.degraded ? 1 : 0
          metrics.partialScoreCoverage = retrieval.degradedReason === 'incomplete-score-coverage' ? 1 : 0
          // 单叶索引短路时 scoreAndSelect 不发 LLM 打分（llmCalled=false），
          // 排序无从谈起——此时不写 mrr，否则「无排序可言」被误算成「排得差」，
          // 系统性拉低均值；缺指标交给聚合层自动剔除分母。
          // evidenceRecall / evidenceHit / contextPrecision 与有无打分无关，照常写入。
          if (!retrieval.llmCalled || retrieval.degraded) delete metrics.mrr
        }

        // judge 只看 evidence 原文，不看检索到的上下文——避免检索失败连带压低 judge 分；
        // trim 保证 evidencePages 全部越界时（join 结果为纯空白）也走「为空则跳过 judge 打分」的裁定
        const evidenceText = question.evidencePages
          .map(p => sample.pages[p] ?? '')
          .join('\n\n')
          .trim()

        if (question.unanswerable) {
          sawUnanswerable = true
          if (args.judgeClient) {
            const verdict = await judgeUnanswerable({
              question: question.question,
              answer: result.answer,
              client: args.judgeClient,
            })
            // judge 不可用时回落到正则口径，并如实记录用了哪种
            if (verdict === null) {
              metrics.unanswerableAccuracy = isRefusal(result.answer) ? 1 : 0
              usedPatternFallback = true
            } else {
              metrics.unanswerableAccuracy = verdict ? 1 : 0
            }
          } else {
            metrics.unanswerableAccuracy = isRefusal(result.answer) ? 1 : 0
            usedPatternFallback = true
          }
        } else {
          metrics.answerF1 = answerF1(result.answer, question.answers)

          if (args.judgeClient && evidenceText) {
            const scores = await judgeAnswer({
              question: question.question,
              evidence: evidenceText,
              answer: result.answer,
              client: args.judgeClient,
            })
            if (scores) {
              metrics.judgeFactuality = scores.factuality
              metrics.judgeCompleteness = scores.completeness
              metrics.judgeGroundedness = scores.groundedness
            }
            // scores 为 null 时不写指标 → aggregate 自动从分母剔除
          }
        }

        const { timing } = result

        perSample.push({
          id: question.id,
          paperId: sample.paperId,
          source: sample.source,
          metrics,
          timing: { ...timing },
          retrievalQuery: result.retrievalQuery,
          selectedPages: retrieval ? expandPages(retrieval.selected) : [],
          evidencePages: question.evidencePages,
          answer: result.answer,
        })

        // 端到端与阶段时延写入 metrics 让 aggregate 能产生均值；分位数由 withPercentiles
        // 从 perSample.timing 单独计算，不能把 P50/P95 误当均值
        metrics.queryRewriteLatencyMs = timing.queryRewriteLatencyMs
        metrics.retrievalLatencyMs = timing.retrievalLatencyMs
        metrics.answerGenerationLatencyMs = timing.answerGenerationLatencyMs
        metrics.queryEndToEndLatencyMs = timing.queryEndToEndLatencyMs
      } catch (e) {
        // 时延不变量破坏是评测口径漂移而非样本失败，向上抛出让整轮失效
        if (e instanceof TimingInvariantViolation) throw e
        errors.push({ sampleId: question.id, stage: 'generate', message: errorMessage(e) })
      }
    }
  }

  const finishedAt = new Date().toISOString()
  const { hits: cacheHits, misses: cacheMisses } = client.stats()
  const runWallClockMs = Math.max(0, now() - runStartedMs)
  const raw = aggregate(perSample)
  const counts = metricSampleCounts(perSample)
  for (const metric of ['evidenceRecall', 'evidenceHit', 'contextPrecision', 'mrr']) {
    if (counts[metric] !== undefined) raw[`${metric}SampleCount`] = counts[metric]
  }
  // 树诊断与检索质量指标合流进同一份 metrics，报表才能在同一行同时回答
  // 「检索有没有变好」与「树是什么样、贵不贵、失败得多不多」（§阶段 E）
  const treeAgg = summarizeTreeDiagnostics(perPaper)
  // 重命名 0/1 指标的聚合结果为「率」，让报表列名自解释；
  // withLatencyStats 追加既有 latencyP50/P95（与 llmNetworkLatency* 同值，deprecated 待移除）
  const metrics = withPercentiles(
    { ...withLatencyStats(renameQaRates(raw), client.latencies()), ...treeAgg.metrics },
    { ...collectTimingValues(perSample, perPaper, client), treeBuildLatency: treeAgg.latencies },
  )

  return {
    task: 'qa',
    config,
    meta: {
      model,
      ...(args.judgeModel ? { judgeModel: args.judgeModel } : {}),
      timestamp: finishedAt,
      startedAt,
      finishedAt,
      runWallClockMs,
      cacheHits,
      cacheMisses,
      // 无请求时为 0，不能 NaN
      cacheHitRate: cacheHits + cacheMisses > 0 ? cacheHits / (cacheHits + cacheMisses) : 0,
      gitSha,
      refusalPatternVersion: REFUSAL_PATTERN_VERSION,
      rubricVersion: RUBRIC_VERSION,
      retrievalAlgorithm: args.semanticTree ? 'semantic-tree' : 'papermind-llm',
      completed: perSample.length,
      total,
      ...(sawUnanswerable
        ? { unanswerableMethod: (args.judgeClient && !usedPatternFallback ? 'judge' : 'pattern') as 'judge' | 'pattern' }
        : {}),
      ...(qasperEvidenceQuestions > 0
        ? {
            evidenceMappingCoverage: mappedEvidenceQuestions / qasperEvidenceQuestions,
            ambiguousEvidenceRate: ambiguousEvidenceQuestions / qasperEvidenceQuestions,
            unmappedEvidenceRate: unmappedEvidenceQuestions / qasperEvidenceQuestions,
          }
        : {}),
    },
    metrics,
    perSample,
    perPaper,
    errors,
  }
}

/**
 * 时延不变量破坏（pipeline 缺失 timing，或四个字段非有限/为负）是评测口径漂移
 * 而非样本失败，用专用异常向上抛出让整轮失效，避免把诊断性失败吞成 errors 数据点。
 */
class TimingInvariantViolation extends Error {
  constructor() {
    super('runRagPipeline 返回的 timing 缺失，或存在非有限/负值的字段')
    this.name = 'TimingInvariantViolation'
  }
}

function assertTiming(timing: PipelineTiming | undefined): asserts timing is PipelineTiming {
  if (!timing
    || !Number.isFinite(timing.queryRewriteLatencyMs) || timing.queryRewriteLatencyMs < 0
    || !Number.isFinite(timing.retrievalLatencyMs) || timing.retrievalLatencyMs < 0
    || !Number.isFinite(timing.answerGenerationLatencyMs) || timing.answerGenerationLatencyMs < 0
    || !Number.isFinite(timing.queryEndToEndLatencyMs) || timing.queryEndToEndLatencyMs < 0) throw new TimingInvariantViolation()
}

/**
 * 本篇论文在 limit 约束下实际将执行的问题数。索引失败分支与成功分支共用，
 * 保证 perPaper.questionCount 与 errors 计数口径一致。
 */
function countExecutedQuestions(sample: EvalSample, limit: number | undefined, total: number): number {
  const remaining = limit === undefined ? Infinity : Math.max(0, limit - total)
  return Math.min(sample.questions.length, remaining)
}

/**
 * 收集分位数聚合需要的时延样本：
 * - perSample.timing 中的 retrieval / generation / end-to-end（失败样本不写 timing，自动缺席）
 * - perPaper 成功索引的 indexBuildLatencyMs（失败只写 error，不产生时长）
 * - client.latencies() 的网络 LLM 延迟
 */
function collectTimingValues(
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

export { REFUSAL_PATTERN_VERSION }
