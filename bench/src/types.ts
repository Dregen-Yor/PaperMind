import type { IndexOptions } from '../../src/utils/pageIndex'
import type { RagOptions } from '../../src/utils/ragPipeline'
import type { PdfOutlineEntry, PdfOutlineResult } from '../../src/utils/pdfOutline'

/** 数据来源，用于报表中分开统计语义分块指标 */
export type SampleSource = 'qasper' | 'smoke' | 'pdf-study'

/** 失败阶段，用于区分「网络问题」与「代码问题」 */
export type SampleStage = 'load' | 'index' | 'retrieve' | 'generate' | 'stream' | 'summarize' | 'judge'

/** 单个问答样本。evidencePages 为 0-based inclusive 页号。 */
export interface QaQuestion {
  id: string
  question: string
  /** 参考答案，可有多个（QASPER 多标注者）；unanswerable 样本为空数组 */
  answers: string[]
  evidencePages: number[]
  unanswerable: boolean
  /** QASPER free-text evidence may not map uniquely to a source paragraph. */
  evidenceMapping?: 'mapped' | 'ambiguous' | 'unmapped'
  /** Versioned references used only by the all-question QASPER quality metric. */
  qualityAnswers?: string[]
  qualityDefinition?: 'qasper-all-questions-v1' | 'pdf-qa-all-questions-v1'
}

/** 一篇论文及其挂载的问答/摘要标注。 */
export interface EvalSample {
  paperId: string
  title: string
  /** 逐页文本，0-based。QASPER 为伪页，冒烟集为真实 PDF 页 */
  pages: string[]
  questions: QaQuestion[]
  /** 参考摘要；QASPER 样本可能没有，为 undefined 时跳过摘要任务 */
  referenceAbstract?: string
  /** 节名（` ::: ` 编码层级）。仅 QASPER 样本有；冒烟集为 undefined。 */
  sectionNames?: string[]
  /** 每节内容落到的伪页号，与 sectionNames 同序同长。仅 QASPER 样本有。 */
  sectionPages?: number[][]
  /** 数据来源，用于报表中分开统计语义分块指标 */
  source: SampleSource
}

/**
 * 冻结的 PDF 大纲研究集样本（`--dataset outline-study`）。
 *
 * 下面这些字段是**在 `EvalSample` 之上追加的运行期元数据**。正因为它们只增不减，
 * 才保证不会泄漏进结果 JSON：所有 runner 与聚合都只接收 `EvalSample[]` / `QaQuestion[]`，
 * 且 `PerSampleRecord` 是封闭字段集，路径与目录树没有任何路径能到达一条被序列化的行。
 * 冷首问需要重新打开原始字节，故 `pdfPath` 只在内存里的样本对象上存活。
 */
export interface PdfStudySample extends EvalSample {
  /** 运行期元数据：冷首问需要重新打开原始字节。绝不写进结果 JSON。 */
  readonly pdfPath: string
  /** 文件名 + 标题 + PDF 字节 + 页文本 + 标注 + 目录 JSON 的 SHA-256 */
  readonly manifestFingerprint: string
  /** 解析后的原生目录；缺失或非法时为空数组 */
  readonly pdfOutline: PdfOutlineEntry[]
  /** 目录解析结果（含失败原因与原始条目数）；未读取时为 undefined */
  readonly pdfOutlineResult?: PdfOutlineResult
}

/**
 * 运行期窄化：只有 `--dataset outline-study` 的样本带原生目录（`PdfStudySample`）。
 * `EvalSample` 本身不含这些运行期字段，凡是要用它们的调用方（如 C 臂的 hook）
 * 都必须在**这里**显式窄化，而不是各自 `as` 一把。
 */
export function isPdfStudySample(sample: EvalSample): sample is PdfStudySample {
  return Array.isArray((sample as { pdfOutline?: unknown }).pdfOutline)
}

/**
 * 一组具体参数取值（矩阵展开后的单点）。
 * 刻意 Omit externalContext：它会让 runRagPipeline 跳过改写与检索，
 * 一个语法合法的配置就能静默关掉正在被评测的整条链路，而指标照常输出数字。
 */
/**
 * 轻量语义树建树参数（方案 §5 / §8）。
 * 分块口径与建树输入上限都是实验变量，必须写进配置而非散落在代码里。
 */
export interface SemanticTreeParams {
  evidence: { targetChars: number; maxChars: number; minChars: number }
  maxInputChars: number
}

/** 段落混合检索的 embedder 身份：必须显式 pin，禁止环境默认（与强基线同一原则）。 */
export interface PassageEmbedderParams {
  model: string
  revision: string
  dtype: string
  dim: number
}

export interface PassageRuntimeParams {
  embedder: PassageEmbedderParams
}

/**
 * 段落索引的构建模式（方案 §3.0 的 A/B/C 结构实验）。
 *
 * - `legacy-llm`：既有产品口径——阶段①②③ 全建，每篇恰好一次卡片 LLM 调用（缺席 `mode` 即此值）。
 * - `lexical`：A 臂，只有 BM25 词法一路，**不加载 embedder、不产向量、不调 LLM**（停留阶段①）。
 * - `hybrid-raw`：B 臂，BM25 + 段落向量（阶段②），仍零生成式 LLM 调用。
 * - `hybrid-outline`：C 臂，B 之上再加原生 PDF 目录索引与节点向量，零生成式 LLM 调用。
 */
export type PassageMode = 'legacy-llm' | 'lexical' | 'hybrid-raw' | 'hybrid-outline'

export interface PaperMindConfig extends IndexOptions, Omit<RagOptions, 'externalContext'> {
  name: string
  /**
   * `semantic-tree` 与 `papermind` 共用同一条生产 RAG 管线，
   * 唯一差别是每篇论文多一棵语义树索引（§11.2 的对照组设计）。
   */
  kind?: 'papermind' | 'semantic-tree'
  /**
   * 段落索引的构建模式（方案 §3.0）。顶层标量、与 `kind` 同级，**不**进 `passage` 块、
   * **不**作 matrix 轴；缺席即 `legacy-llm`（既有产品口径逐字不变）。
   */
  mode?: PassageMode
  /** kind === 'semantic-tree' 时必填 */
  semanticTree?: SemanticTreeParams
  /**
   * 段落级混合检索（方案 §7）：提供即走该路径。
   * 只放不可消融的 embedder 身份；可调旋钮在顶层，好让 matrix 直接消融。
   */
  passage?: PassageRuntimeParams
  /** 切段：不足 minTokens 向后合并 */
  minTokens?: number
  /** 切段：超过 maxTokens 在句子边界切开 */
  maxTokens?: number
  /** 卡片输入字符上限 */
  maxInputChars?: number
  rrfK?: number
  sectionWeight?: number
  neighbourFactor?: number
  skipLimit?: number
}

export interface TraditionalEmbeddingConfig {
  model: string
  revision: string
  queryPrefix: string
  normalize: true
  maxLength: number
}

export interface TraditionalRagConfig {
  name: string
  kind: 'traditional-rag'
  chunking: { tokenizer: 'bge-m3'; chunkSize: number; overlap: number }
  retrieval: { algorithm: 'cosine'; topK: number; embedding: TraditionalEmbeddingConfig }
    | { algorithm: 'bm25'; topK: number; k1: number; b: number }
    | { algorithm: 'jaccard'; topK: number }
  generationContext: { topK: number; maxTokens: number }
}

/**
 * 强基线 1：hybrid-rerank——BM25 与 BGE-M3 双路召回 → RRF 融合 → 交叉编码器重排。
 * 计划（2026-09-08-baseline-matrix §2.2）冻结的参数关系由 config.ts 校验器强制。
 */
export interface HybridRerankConfig {
  name: string
  kind: 'hybrid-rerank'
  chunking: { tokenizer: 'bge-m3'; chunkSize: number; overlap: number }
  retrieval: {
    bm25: { topK: number; k1: number; b: number }
    dense: { topK: number; embedding: TraditionalEmbeddingConfig }
    rrf: { k: number; topK: number }
    reranker: { model: string; revision: string; topK: number; maxLength: number }
  }
  generationContext: { topK: number; maxTokens: number }
}

/**
 * 强基线 2：long-section-rag——BM25 召回锚点段 → 在所属章节内做连续扩展阅读。
 * 连续区域是单一上下文单元，故 generationContext.topK 恒为 1（校验器强制）。
 */
export interface LongSectionRagConfig {
  name: string
  kind: 'long-section-rag'
  anchors: { tokenizer: 'bge-m3'; chunkSize: number; overlap: number }
  retrieval: { algorithm: 'bm25'; topK: number; k1: number; b: number }
  generationContext: { topK: number; maxTokens: number }
}

export type BenchConfig = PaperMindConfig | TraditionalRagConfig | HybridRerankConfig | LongSectionRagConfig

/** 报表分组口径：classic=既有对照组，strong=强基线（计划 §0：三条新基线同组）。 */
export type BaselineFamily = 'classic' | 'strong'

/** 配置文件形态：matrix 各字段取值数组，展开为笛卡尔积。 */
export interface ConfigFile {
  name: string
  /** 语义树配置与 PaperMind 共用矩阵形态，只多一个建树参数块 */
  kind?: 'papermind' | 'semantic-tree'
  /** 段落构建模式；非默认（非 legacy-llm）时由 expandMatrix 原样带到每个展开点 */
  mode?: PassageMode
  /** kind === 'semantic-tree' 时必填 */
  semanticTree?: SemanticTreeParams
  /** 段落混合检索块（不可消融），由 expandMatrix 原样带到每个展开点 */
  passage?: PassageRuntimeParams
  /** 键收敛到 BenchConfig 的可调字段，防止拼错的键静默失效 */
  matrix: Partial<Record<Exclude<keyof PaperMindConfig, 'name' | 'kind' | 'mode' | 'semanticTree' | 'passage'>, Array<number | boolean>>>
}

export interface SampleError {
  sampleId: string
  /** 失败阶段，用于区分「网络问题」与「代码问题」 */
  stage: SampleStage
  message: string
}

/** 单次 RAG 问答的热路径时延分阶段口径（毫秒），语义与 src/utils/ragPipeline.PipelineTiming 一致。 */
export interface PipelineTiming {
  queryRewriteLatencyMs: number
  retrievalLatencyMs: number
  answerGenerationLatencyMs: number
  queryEndToEndLatencyMs: number
}

/** Cumulative provider usage at a query timeline boundary. */
export interface TokenSnapshot {
  totalTokens: number
  incompleteRequestCount: number
}

/** Per-query speed observations. Missing milestones represent an incomplete query. */
export interface QuerySpeedRecord {
  evidenceReadyLatencyMs?: number
  timeToFirstTokenMs?: number
  fullAnswerLatencyMs?: number
  onlineTokenCount?: number
  tokenAccountingComplete: boolean
}

export interface QueryTimeline {
  markEvidenceReady(): void
  onVisibleText(delta: string): void
  complete(readAfter: () => TokenSnapshot, evidenceRequired?: boolean): QuerySpeedRecord
  partial(after: TokenSnapshot): QuerySpeedRecord
}

/** 一篇论文的索引成本记录。索引失败时 error 与已消耗的索引时长/缓存差值仍记录，leafCount 不写。 */
export interface PaperTimingRecord {
  paperId: string
  source: SampleSource
  pageCount: number
  /** 本篇在 limit 约束下实际将执行的问题数，而非原始总数 */
  questionCount: number
  indexBuildLatencyMs?: number
  indexLlmCalls?: number
  indexCacheHits?: number
  indexCacheMisses?: number
  leafCount?: number
  error?: string
  /** —— 语义树诊断（§11.4）；仅 kind === 'semantic-tree' 的论文写入 —— */
  /** 建树输入的证据块数量 */
  evidenceBlockCount?: number
  treeNodeCount?: number
  treeDepth?: number
  treeLevel1Count?: number
  treeLevel2Count?: number
  /** 被树引用的证据块覆盖率 */
  treeEvidenceCoverage?: number
  /** 被多个节点共同引用的证据块比例（多重归属） */
  treeSharedBlockRate?: number
  /** 引用跨越非连续区块的节点比例（跨章节取证能力） */
  treeCrossSectionNodeRate?: number
  treeBuildLlmCalls?: number
  treeBuildInputTokens?: number
  treeBuildOutputTokens?: number
  treeBuildLatencyMs?: number
  /** 1 = 本篇建树失败并已降级到平面检索 */
  treeBuildFailed?: number
  /** —— 段落混合检索冷启动（方案 §7）；仅 passage 配置的论文写入 —— */
  coldStartPassageMs?: number
  coldStartEmbedPassagesMs?: number
  coldStartStructureCallMs?: number
  /** 1 = 卡片调用命中缓存，不计入 structureCall 耗时统计 */
  coldStartStructureCacheHit?: number
  coldStartStructureInputTokens?: number
  coldStartStructureOutputTokens?: number
  /** 1 = token 数为估算值（服务商 usage 未透传） */
  coldStartStructureTokensEstimated?: number
  coldStartEmbedCardsMs?: number
  /** 1 = 本篇段落向量计算失败，检索降级为 bm25*（整轮据此判不可比） */
  coldStartEmbedFailed?: number
  coldStartTotalMs?: number
  /** 卡片回落原因；未回落时不写 */
  coldStartStructureFallback?: string
  coldStartCardCount?: number
  coldStartPassageCount?: number
  /** 1 = 本篇建索引失败 */
  coldStartFailed?: number
  /** —— C 臂原生目录（方案 §10.1 交付物 3）；仅 hybrid-outline 的论文写入 —— */
  /**
   * 目录构建耗时（解析 + 建节点 + 节点向量）。**包含在** `coldStartTotalMs` 之内
   * （方案 §9.4「冷计时含真实等待」）；单列一项是因为它是 C 臂独有的真实等待。
   */
  coldStartOutlineMs?: number
  /**
   * 1 = 本篇目录可用（解析成功且节点向量齐全）；0 = 目录缺失/非法/向量失败，C 臂本篇
   * 回落为 B 的检索口径（方案 §221 预声明的合法回落）。只有 hybrid-outline 的论文写这个字段，
   * 因此它也是「C 臂这一篇到底有没有用上目录」的唯一证据。
   */
  coldStartOutlineAvailable?: number
  /**
   * 目录节点总数（前序展开，含嵌套子节点）——与 `resolvePdfOutline` 的 `entryCount` 同一口径。
   * **不是**顶层节点数（`outline.nodes.length`）——顶层数会把每个嵌套目录都少报。目录不可用（节点为空）时为 0。
   */
  coldStartOutlineNodeCount?: number
  /** 目录不可用的原因（missing-outline / null-page / outline-embed-failed …）；可用时不写。 */
  coldStartOutlineFallback?: string
}

/** 逐样本记录，用于错误分析——聚合分数只说好不好，这里说为什么。 */
export interface PerSampleRecord {
  id: string
  paperId: string
  source: SampleSource
  metrics: Record<string, number>
  /** 本问热路径时延（仅 QA，失败样本不写） */
  timing?: PipelineTiming
  /** Query-timeline speed diagnostics (opt-in speed benchmark only). */
  speed?: QuerySpeedRecord
  /** QA 专有 */
  retrievalQuery?: string
  /** 段落混合检索实际使用的模式（bm25 / bm25+dense / bm25+dense+outline / full / full-title-fallback / bm25+card-lexical） */
  retrievalMode?: string
  /*
   * C 臂逐题目录诊断（仅 hybrid-outline 且有目录产物的论文写入）。
   *
   * **这里只是原始逐题观测，目前没有任何聚合消费者**：别以为它们被算进了某个「目录可用率 /
   * 目录实际使用率」。现存唯一的目录率 `outlineAvailabilityRate` 取自**每篇**的
   * `coldStartOutlineAvailable`（见 `metrics/passageDiagnostics.ts`），与本组字段无关；
   * `outlineUsed` 想留下「目录实际使用率」这个信号，但聚合与渲染是**后续任务**的交付物，
   * 在那之前本组字段只被写入（`runner/qa.ts`）而无人汇总。谁先接聚合谁负责补上口径与用例。
   *
   * 与 perPaper 的 `coldStartOutline*` 分属两层：那三个是**每篇**的索引期事实，这三个随**逐题**记录。
   */
  /**
   * 本篇的**目录索引**是否构建成功（索引期事实，同一篇的所有问题相同）。
   *
   * 注意与 `HybridPassageDiagnostics.outlineAvailable` **不是**一回事：那个是**查询期**事实，
   * 指「本次检索是否收到了非空目录节点」。二者会**故意**不一致——目录索引成功但节点向量不齐
   * （畸形产物，见 `toOutlineScoringNodes`）时，本篇索引期 `true`、但检索期收不到节点、模式
   * 退回 `bm25+dense`。故改名 `outlineIndexAvailable` 以消歧，别把两个 `available` 混读。
   */
  outlineIndexAvailable?: boolean
  /**
   * 本问题的目录先验是否真的进入了融合（查询期事实；dense 不可用或目录缺失时为 false）。
   * 与 `HybridPassageDiagnostics.outlineUsed` **同义**（这里就是它逐字复制来的），故沿用同名。
   */
  outlineUsed?: boolean
  /**
   * 目录未被使用的原因。与检索期同名字段同一问题，但这里是**合并后的优先级视图**：
   * 先取索引期回落（missing-outline / outline-embed-failed …），再取查询期（dense-unavailable …）。
   */
  outlineFallbackReason?: string
  /**
   * 诊断专用：被选中候选的页区间包络（去重升序）。
   * 它包含「仅被选中、但可能被最终预算截掉」的页，**不是**生成模型实际读到的页集合，
   * 任何跨方法指标都不得读取本字段；真实页集合一律看 `contextPageOrder`。
   */
  selectedPages?: number[]
  evidencePages?: number[]
  /**
   * schema-v2 阶段状态（§6）。旧结果缺这些字段时按「未知」处理，不得据此推断成功。
   * retrievalStatus：completed=检索产物齐全；failed=检索/索引失败（有效题四个指标写 0）；
   * ineligible=非有效题，不产生检索指标。
   */
  retrievalStatus?: 'completed' | 'failed' | 'ineligible'
  generationStatus?: 'completed' | 'failed' | 'skipped'
  judgeStatus?: 'completed' | 'failed' | 'skipped'
  /** 最终生成上下文的去重首次出现页序；四个检索指标的唯一来源 */
  contextPageOrder?: number[]
  /** 最终生成上下文的实际 token 数 */
  contextTokenCount?: number
  /** 最终上下文是否被预算截断 */
  contextTruncated?: boolean
  answer?: string
  /** Versioned references used to score this record; absent from historical result JSON. */
  referenceAnswers?: string[]
  /** 摘要专有 */
  summary?: string
}

export interface BenchResult {
  task: 'qa' | 'summary'
  config: BenchConfig
  meta: {
    model: string
    judgeModel?: string
    timestamp: string
    gitSha: string
    completed: number
    total: number
    /** 整轮起止与 wall-clock（毫秒，QA 专有） */
    startedAt?: string
    finishedAt?: string
    runWallClockMs?: number
    /** 缓存计数（QA 专有） */
    cacheHits?: number
    cacheMisses?: number
    /** 无请求时为 0，不能 NaN */
    cacheHitRate?: number
    /** rag 为生产 RAG；full-context 为整篇论文直投 LLM 的无检索基线。 */
    mode?: 'rag' | 'full-context'
    /** 请求上限是实验口径的一部分，尤其影响 full-context 与 judge。 */
    requestTimeoutMs?: number
    generationMaxTokens?: number
    refusalPatternVersion?: string
    rubricVersion?: string
    retrievalAlgorithm?: 'papermind-llm' | 'semantic-tree' | 'cosine' | 'bm25' | 'jaccard' | 'none' | 'hybrid-rerank' | 'long-section-rag' | 'hybrid-passage'
    /** 基线家族（报表分组用），新基线必须标注，旧配置缺省由报表按 kind 推断 */
    baselineFamily?: BaselineFamily
    /** 候选/上下文粒度自证：如 '512-token passage'、'contiguous section region'、'structure node' */
    candidateGranularity?: string
    /** unanswerableAccuracy 的判定口径，避免两种口径的数字被混着对比 */
    unanswerableMethod?: 'pattern' | 'judge'
    /** 缓存模式：normal 读写缓存；bypass（--no-cache）只跳过读，不覆写已有缓存文件 */
    cacheMode?: 'normal' | 'bypass'
    /** 缓存计数的统计范围：仅主 RAG client；启用 --judge 时明确标注，不含 judgeClient 流量 */
    cacheScope?: 'rag'
    evidenceMappingCoverage?: number
    ambiguousEvidenceRate?: number
    unmappedEvidenceRate?: number
    /**
     * —— schema-v2 评测契约（§7）——
     * 缺 `mrrDefinition: 'context-page-v1'` 的结果一律按 legacy 处理，禁止与新口径算差值。
     * comparisonEligible=false 时（如 full-context 生成上限）不进入检索排名。
     */
    metricSchemaVersion?: number
    mrrDefinition?: string
    contextBudgetTokens?: number
    contextTokenizer?: string
    contextTokenizerRevision?: string
    evidenceMappingVersion?: string
    datasetFingerprint?: string
    executedQuestionIdsHash?: string
    eligibleRetrievalQuestionIdsHash?: string
    eligibleRetrievalQuestionCount?: number
    comparisonEligible?: boolean
    comparisonIneligibleReason?: string
    /** Query-timeline speed benchmark contract fields. */
    speedMetricSchemaVersion?: 1 | 2
    speedDefinition?: 'query-timeline-v1' | 'query-timeline-v2'
    completedSpeedQuestionIdsHash?: string
    completedSpeedQuestionCount?: number
    streaming?: true
    llmCacheEnabled?: false
    queryConcurrency?: 1
    retryAttempts?: number
    answerModelIdentity?: string
    answerFramingIdentityHash?: string
    endpointIdentity?: string
    generationSettingsHash?: string
    executionEnvironmentFingerprint?: string
    /** Versioned all-question quality provenance. */
    qaQualityDefinition?: 'qasper-all-questions-v1' | 'pdf-qa-all-questions-v1'
    qaExpectedQuestionIds?: string[]
    /**
     * pdf-study 质量批次的来源（仅 pdf-study 写此键；QASPER 不加，保持旧结果逐字不变）。
     * QASPER 的来源由 `qaQualityDefinition` 与逐样本 `source` 唯一确定，无需重复落盘。
     */
    qaQualitySource?: SampleSource
    /** pdf-study 质量批次的 manifest 指纹（仅 pdf-study 写此键；同一论文集合的摘要必须一致）。 */
    qaQualityManifestFingerprint?: string
  }
  metrics: Record<string, number>
  perSample: PerSampleRecord[]
  perPaper?: PaperTimingRecord[]
  errors: SampleError[]
}
