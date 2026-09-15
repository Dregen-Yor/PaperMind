import type { IndexOptions } from '../../src/utils/pageIndex'
import type { RagOptions } from '../../src/utils/ragPipeline'

/** 数据来源，用于报表中分开统计语义分块指标 */
export type SampleSource = 'qasper' | 'smoke'

/** 失败阶段，用于区分「网络问题」与「代码问题」 */
export type SampleStage = 'load' | 'index' | 'retrieve' | 'generate' | 'summarize' | 'judge'

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
  /** 数据来源，用于报表中分开统计语义分块指标 */
  source: SampleSource
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

export interface PaperMindConfig extends IndexOptions, Omit<RagOptions, 'externalContext'> {
  name: string
  /**
   * `semantic-tree` 与 `papermind` 共用同一条生产 RAG 管线，
   * 唯一差别是每篇论文多一棵语义树索引（§11.2 的对照组设计）。
   */
  kind?: 'papermind' | 'semantic-tree'
  /** kind === 'semantic-tree' 时必填 */
  semanticTree?: SemanticTreeParams
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
  /** kind === 'semantic-tree' 时必填 */
  semanticTree?: SemanticTreeParams
  /** 键收敛到 BenchConfig 的可调字段，防止拼错的键静默失效 */
  matrix: Partial<Record<Exclude<keyof PaperMindConfig, 'name' | 'kind' | 'semanticTree'>, Array<number | boolean>>>
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
}

/** 逐样本记录，用于错误分析——聚合分数只说好不好，这里说为什么。 */
export interface PerSampleRecord {
  id: string
  paperId: string
  source: SampleSource
  metrics: Record<string, number>
  /** 本问热路径时延（仅 QA，失败样本不写） */
  timing?: PipelineTiming
  /** QA 专有 */
  retrievalQuery?: string
  selectedPages?: number[]
  evidencePages?: number[]
  answer?: string
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
    retrievalAlgorithm?: 'papermind-llm' | 'semantic-tree' | 'cosine' | 'bm25' | 'jaccard' | 'none' | 'hybrid-rerank' | 'long-section-rag'
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
  }
  metrics: Record<string, number>
  perSample: PerSampleRecord[]
  perPaper?: PaperTimingRecord[]
  errors: SampleError[]
}
