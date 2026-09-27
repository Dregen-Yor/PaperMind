/**
 * 段落索引 hook（形态对齐 `runner/semanticTreeQa.ts` 的建树 hook）。
 *
 * 返回一个**句柄** `{ lexicalReady, ready }`：`lexicalReady` 是阶段① 落盘后的稳定快照
 * （冷启动策略选择用它，不必等模型），`ready` 在请求的其余阶段完成后解析。
 * 模式（方案 §3.0）决定请求到哪一阶段：
 * - `legacy-llm`：阶段①②③ 全建，每篇恰好一次卡片 LLM 调用（既有口径）；
 * - `lexical` / `hybrid-raw` / `hybrid-outline`：**零生成式索引调用**——阶段③ 整体关闭，
 *   分别停在阶段① / ② / ②+原生目录索引。
 *
 * 不写 SQLite：评测进程不引入 better-sqlite3，`persist` 是记账空函数。
 */
import type { Embedder } from '../../../src/utils/embedder'
import {
  PASSAGE_INDEX_SCHEMA_VERSION, PASSAGE_INDEX_VERSION,
  passageConfigHash, structureHash, type PassageIndex,
} from '../../../src/utils/passageIndex'
import type { OutlineScoringNode } from '../../../src/utils/passageRetrieval'
import { startPassagePipeline, type PassageStageEvent } from '../../../src/utils/passageIndexBuilder'
import type { TokenCounter } from '../../../src/utils/passages'
import { STRUCTURE_CARD_PROMPT_VERSION } from '../../../src/utils/structureCards'
import {
  buildPdfOutlineIndex, PdfOutlineIndexError,
  type PdfOutlineEntry, type PdfOutlineNode,
} from '../../../src/utils/pdfOutline'
import type { LlmClient } from '../llmClient'
import type { EvalSample, PaperTimingRecord, PassageMode } from '../types'
import { introspectPassageStageEvent } from '../metrics/passageDiagnostics'
import { errorMessage } from './support'

export interface HybridKnobs {
  minTokens: number
  maxTokens: number
  maxInputChars: number
  rrfK: number
  sectionWeight: number
  neighbourFactor: number
  skipLimit: number
}

/**
 * 目录节点文本的分隔符（方案 §3.2「一次构建后复用」）：`[...path, title].join(SEPARATOR)`。
 * 导出给 Task 5 —— 查询期打分必须**复用**索引期编码的这串文本，两侧措辞必须逐字一致，
 * 否则节点向量与查询向量不在同一语义坐标上。
 */
export const OUTLINE_NODE_SEPARATOR = ' > '

/** 目录节点的嵌入文本：祖先标题链 + 自身标题。 */
export function outlineNodeEmbedText(node: PdfOutlineNode): string {
  return [...node.path, node.title].join(OUTLINE_NODE_SEPARATOR)
}

export interface PassageIndexHookOptions {
  knobs: HybridKnobs
  client: LlmClient
  /** 加载失败时为 undefined：本篇/本轮降级为 bm25*，由 cli 标为不参与正式对照 */
  embedder: Embedder | undefined
  /** 契约分词器的 token 计数适配器（`ContextTokenizer` 只有 `tokenize`） */
  countTokens: TokenCounter
  /** 卡片指纹里的模型身份；取 cli 的 `env.model`（`LlmClient` 无 identity 方法） */
  modelIdentity: string
  /**
   * 构建模式（方案 §3.0）。必须显式给出——`legacy-llm` 是既有口径，实验臂则据此关闭阶段③、
   * 决定是否碰嵌入器。缺席不再有「默认」含义，调用方不说清就会拿到错的口径。
   */
  mode: PassageMode
  /**
   * `hybrid-outline`（C 臂）的原生目录来源：从样本取出 Task 1 解析并校验过的目录条目。
   *
   * `EvalSample` 本身**不带**该字段（只有 `PdfStudySample` 有），故刻意由调用方显式注入
   * （`cli.ts` 从 `PdfStudySample.pdfOutline` 取），而不是在 hook 里强行窄化样本——
   * 窄化的两种失败（真无目录 / 传错样本类型）会静默变成同一个 `available:false`。
   */
  outlineIndex?: (sample: EvalSample) => PdfOutlineEntry[] | undefined
  now?: () => number
}

/** C 臂的原生目录产物：节点、可用性、失败原因，以及**索引期**算好、查询期复用的节点向量。 */
export interface PassageOutlineInfo {
  nodes: PdfOutlineNode[]
  /**
   * 目录节点**总数**（前序展开，含嵌套子节点），与 `resolvePdfOutline` 的 `entryCount` 同一口径。
   * **不是** `nodes.length`——那只是顶层节点数，每个嵌套目录都会少报（如 22 个条目的 PDF 只有 8 个根）。
   */
  nodeCount: number
  /** 解析成功且节点向量齐全才为 true；Task 5 只应在 true 时使用它 */
  available: boolean
  /**
   * `available === false` 的原因（目录缺失 / 非法 / 向量失败）。
   * **绝不**写进 `coldStartStructureFallback`——目录失败不是卡片失败，混记会让「LLM 结构回落率」失真。
   */
  fallbackReason?: string
  /**
   * 节点文本的预计算向量，键为 `PdfOutlineNode.id`。索引期编码一次，查询期（Task 5）
   * **零 embedder 调用**复用（spec §3.2）。文本口径见 {@link outlineNodeEmbedText}。
   */
  nodeVectors: Map<string, Float32Array>
  /**
   * 本次目录构建的真实耗时（解析 + 建节点 + 节点向量），毫秒。C 臂的
   * `coldStartTotalMs` 把它算在里面（方案 §9.4），此处单列供产物逐篇核对。
   */
  elapsedMs: number
}

export interface PassageIndexInfo {
  index: PassageIndex
  coldStart: Partial<PaperTimingRecord>
  cacheHits: number
  cacheMisses: number
  /** 仅 C 臂携带；A/B 与 legacy 缺席 */
  outline?: PassageOutlineInfo
}

export interface PassageIndexHandle {
  /** 阶段① 已落盘的稳定快照：`ready` 解析前即可用，且不会被后续阶段改写 */
  lexicalReady: PassageIndexInfo
  /** 请求的其余阶段完成后解析 */
  ready: Promise<PassageIndexInfo>
}

export type PassageIndexHook = (sample: EvalSample) => Promise<PassageIndexHandle>

/** 前序展开目录节点（与 `buildPdfOutlineIndex` 的 preorder 一致）。 */
function flattenOutline(nodes: PdfOutlineNode[]): PdfOutlineNode[] {
  const out: PdfOutlineNode[] = []
  const walk = (list: PdfOutlineNode[]): void => {
    for (const node of list) {
      out.push(node)
      walk(node.children)
    }
  }
  walk(nodes)
  return out
}

/**
 * 目录产物 → 查询期打分视图（Task 5）：前序展开，只取打分需要的 `id` / `passageOrders` /
 * 索引期算好的 `vector`。
 *
 * **节点向量不齐即整份不可用**（返回 `undefined`）：`available:true` 已承诺每个节点的向量齐全
 * （见 `buildOutline` 的数量/维度/有限性三重校验），若仍有节点缺向量，说明拿到的是一份畸形产物——
 * 此时**静默丢掉**缺向量节点会把它变成「看起来合法的更弱目录」，掩埋真正的失败。宁可让整份目录
 * 作废、本篇按 B 回落（调用方据此记 `outline-embed-failed`），也不接受一份缩水的目录。
 */
export function toOutlineScoringNodes(info: PassageOutlineInfo): OutlineScoringNode[] | undefined {
  const flat = flattenOutline(info.nodes)
  const nodes: OutlineScoringNode[] = []
  for (const node of flat) {
    const vector = info.nodeVectors.get(node.id)
    if (!vector) return undefined
    nodes.push({ id: node.id, passageOrders: node.passageOrders, vector })
  }
  return nodes
}

/**
 * 构建 C 臂的原生目录索引并计算节点向量。任何失败都**降级**（`available:false` + 原因），
 * 不抛：目录是可选先验，缺了只是这一臂退化成 B，不该让整篇论文的索引失败。
 *
 * 每条返回路径都带上真实耗时：C 臂的冷启动总时长覆盖这一段（方案 §9.4「冷计时含真实等待」）。
 */
async function buildOutline(
  index: PassageIndex,
  sample: EvalSample,
  opts: PassageIndexHookOptions,
  embedder: Embedder | undefined,
): Promise<PassageOutlineInfo> {
  const now = opts.now ?? Date.now
  const startedAt = now()
  // `nodeCount` 在唯一的收口处统一从 `nodes` 展平算出，与 `elapsedMs` 一样：所有返回路径
  // （缺目录 / 非法 / 向量失败 / 成功）都经此，就不会出现某条分支漏填或填成顶层数。
  const done = (info: Omit<PassageOutlineInfo, 'elapsedMs' | 'nodeCount'>): PassageOutlineInfo =>
    ({ ...info, nodeCount: flattenOutline(info.nodes).length, elapsedMs: Math.max(0, now() - startedAt) })

  const roots = opts.outlineIndex?.(sample)
  if (!roots || roots.length === 0) {
    return done({ nodes: [], available: false, fallbackReason: 'missing-outline', nodeVectors: new Map() })
  }
  let nodes: PdfOutlineNode[]
  try {
    nodes = buildPdfOutlineIndex(roots, index.passages, sample.pages.length)
  } catch (error) {
    return done({
      nodes: [],
      available: false,
      fallbackReason: error instanceof PdfOutlineIndexError ? error.reason : 'invalid-outline',
      nodeVectors: new Map(),
    })
  }
  // 这里刻意**没有** `nodes.length === 0` 分支：`buildPdfOutlineIndex` 只在 `roots` 为空时返回 `[]`
  // （已在上面处理），其余情况下每个非外链条目都会变成一个节点——空数组在本函数内不可达。
  // 节点向量是 Task 5 在查询期**不发嵌入调用**的前提：没有向量就没有可用的目录先验
  if (!embedder) {
    return done({ nodes, available: false, fallbackReason: 'embedder-unavailable', nodeVectors: new Map() })
  }
  const flat = flattenOutline(nodes)
  const nodeVectors = new Map<string, Float32Array>()
  try {
    const vectors = await embedder.embedPassages(flat.map(outlineNodeEmbedText))
    // `available:true` 必须自证：数量、维度、有限性三者一起校验。只查数量时，一条错维度的向量
    // 会挂着「可用」的名义进入查询期的余弦计算（`cosineSimilarity` 对维度不符会抛错）。
    // 与 `carryStoredPassageVectors` 的逐条防御同一口径。
    if (vectors.length !== flat.length) {
      throw new Error(`目录节点向量数量与节点数不一致：${vectors.length} ≠ ${flat.length}`)
    }
    const dim = vectors[0]?.length ?? 0
    if (dim <= 0 || vectors.some(vector => vector.length !== dim || !vector.every(Number.isFinite))) {
      throw new Error('目录节点向量维度不一致或含非有限值')
    }
    flat.forEach((node, i) => nodeVectors.set(node.id, vectors[i]))
  } catch (error) {
    // 与 cli.ts 的「向量模型加载失败」同一风格：静默降级会把 C→B 的退化藏起来，必须留一条可诊断的日志。
    // 目录失败**不写** `coldStartStructureFallback`——那不是卡片失败，写进去会让 LLM 结构回落率失真。
    console.warn(`目录节点向量计算失败，C 臂本篇回落为 B（${sample.paperId}）：${errorMessage(error)}`)
    return done({ nodes, available: false, fallbackReason: 'outline-embed-failed', nodeVectors: new Map() })
  }
  return done({ nodes, available: true, nodeVectors })
}

export function createPassageIndexHook(opts: PassageIndexHookOptions): PassageIndexHook {
  const now = opts.now ?? Date.now
  // 只有 legacy-llm 构建阶段③（唯一一次 LLM 调用）；A/B/C 三个实验臂零生成式索引调用
  const buildStructure = opts.mode === 'legacy-llm'
  // A 臂不加载嵌入器：即便调用方注入了，lexical 也不得使用它（「不加载」由 hook 兜底，不靠 CLI 自觉）
  const embedder = opts.mode === 'lexical' ? undefined : opts.embedder
  // 下面两个指纹是 **bench 侧自己的失效令牌**（产品侧 `stores/chat.ts` 有一对同名概念）。
  // 两侧的值永远不可比、也永远不该被比较：输入取自各自侧（这里用配置旋钮 + `env.model`，
  // 产品用默认切段参数 + `baseUrl|model`），两侧的 token 计数器（本侧注入的冻结 BGE-M3 /
  // 产品的估算器）不进哈希——哈希只覆盖显式写进去的那几项，所以「数值相等」
  // 既推不出「两侧口径相同」，也推不出「这份索引在对面可用」。将来真要跨侧核对，
  // 比的是**输入**（schemaVersion / minTokens / maxTokens / maxInputChars / 提示词版本 /
  // 模型身份），不是这两个摘要。
  const passageConfig = passageConfigHash({
    schemaVersion: PASSAGE_INDEX_SCHEMA_VERSION,
    segmentation: { minTokens: opts.knobs.minTokens, maxTokens: opts.knobs.maxTokens },
  })
  const structure = structureHash({
    schemaVersion: PASSAGE_INDEX_SCHEMA_VERSION,
    passageConfigHash: passageConfig,
    promptVersion: STRUCTURE_CARD_PROMPT_VERSION,
    maxInputChars: opts.knobs.maxInputChars,
    model: opts.modelIdentity,
  })

  return async (sample: EvalSample): Promise<PassageIndexHandle> => {
    const before = opts.client.stats()
    const startedAt = now()
    const coldStart: Partial<PaperTimingRecord> = {}
    let structureCacheHit = false
    let inputChars = 0
    let outputChars = 0

    const llm = async (prompt: string): Promise<string> => {
      inputChars = prompt.length
      const statsBefore = opts.client.stats()
      const raw = await opts.client.complete(prompt)
      structureCacheHit = opts.client.stats().hits > statsBefore.hits
      outputChars = raw.length
      return raw
    }

    const { index: stage1, rest } = await startPassagePipeline(
      sample.pages,
      {
        llm,
        countTokens: opts.countTokens,
        ...(embedder ? { embedder } : {}),
        // 指纹与切段必须描述同一件事：`passageConfigHash` 由 minTokens/maxTokens 算出，
        // 而管线不传 `segmentation` 时切段走的是 `DEFAULT_PASSAGE_OPTIONS`。少了这一行，
        // 消融改了旋钮只会换掉指纹、段落边界照旧——对照实验里那种「无提示的假阴性」。
        segmentation: { minTokens: opts.knobs.minTokens, maxTokens: opts.knobs.maxTokens },
        passageConfigHash: passageConfig,
        structureHash: structure,
        maxInputChars: opts.knobs.maxInputChars,
        buildStructure,
        now,
        persist: () => {},
        onStage: (event: PassageStageEvent) => {
          if (event.stage === 'passages') {
            coldStart.coldStartPassageMs = event.latencyMs
            coldStart.coldStartPassageCount = event.passageCount
          } else if (event.stage === 'passage-vectors') {
            // 失败那次的耗时不是「段落向量成本」，不进均值；只留失败标记
            if (event.failed) coldStart.coldStartEmbedFailed = 1
            else coldStart.coldStartEmbedPassagesMs = event.latencyMs
          } else if (event.stage === 'card-vectors') {
            coldStart.coldStartEmbedCardsMs = event.latencyMs
          } else {
            Object.assign(coldStart, introspectPassageStageEvent(
              {
                stage: 'structure',
                latencyMs: event.latencyMs,
                ...(event.cardCount !== undefined ? { cardCount: event.cardCount } : {}),
                ...(event.fallback ? { fallback: event.fallback } : {}),
              },
              { inputChars, outputChars, cacheHit: structureCacheHit || event.cacheHit === true },
            ))
          }
        },
      },
      { force: true },
    )

    // 旧版 / 缺失段落索引在 bench 里**直接报错**，绝不静默回落旧路径（方案 §7）：
    // 一个跑到阶段③ 却没有段落的结果，会让下游拿到旧口径的数字而毫无提示
    if (stage1.passages.length === 0) throw new Error(`论文 ${sample.paperId} 没有切出任何段落`)

    // 阶段① 快照：复制一份 coldStart，让 lexicalReady 停在第① 阶段的账上——
    // 后续阶段的 onStage 继续往原对象写，不会回头改写这个快照
    const lexicalReady: PassageIndexInfo = {
      index: stage1,
      coldStart: { ...coldStart },
      cacheHits: 0,
      cacheMisses: 0,
    }

    const ready = (async (): Promise<PassageIndexInfo> => {
      const index = await rest
      // 只有 legacy 口径要求阶段③ 的卡片；A/B/C 三个实验臂本就关掉了阶段③
      if (buildStructure && index.cards === undefined) {
        throw new Error(`论文 ${sample.paperId} 未走到阶段③，卡片刻度缺失`)
      }
      // C 臂：阶段② 之后构建原生目录索引与节点向量（必须在阶段① 之后——它要 passages）。
      // 计时**必须**在这之后收口：目录建树 + 逐节点嵌入是 C 臂真实等待的一部分（方案 §9.4），
      // 放在它之前会让 C 的冷启动总时长系统性少报，而 qa.ts 的 indexBuildLatencyMs 覆盖的是同一段——
      // 两个字段描述一次冷启动却各说各话。A/B/legacy 不调 buildOutline，行为逐字不变。
      const outline = opts.mode === 'hybrid-outline'
        ? await buildOutline(index, sample, opts, embedder)
        : undefined
      coldStart.coldStartTotalMs = Math.max(0, now() - startedAt)

      const after = opts.client.stats()
      return {
        index,
        coldStart,
        cacheHits: after.hits - before.hits,
        cacheMisses: after.misses - before.misses,
        ...(outline ? { outline } : {}),
      }
    })()

    return { lexicalReady, ready }
  }
}
