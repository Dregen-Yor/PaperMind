/**
 * 段落索引 hook（形态对齐 `runner/semanticTreeQa.ts` 的建树 hook）：
 * 冷启动在**逐题计时之前**完成（`query-timeline-v2` 协议），因此 hook 里
 * `await` 整个 `rest`（bench 始终构建到阶段③，不评测中间阶段的检索）。
 *
 * 不写 SQLite：评测进程不引入 better-sqlite3，`persist` 是记账空函数。
 */
import type { Embedder } from '../../../src/utils/embedder'
import {
  PASSAGE_INDEX_SCHEMA_VERSION, PASSAGE_INDEX_VERSION,
  passageConfigHash, structureHash, type PassageIndex,
} from '../../../src/utils/passageIndex'
import { startPassagePipeline, type PassageStageEvent } from '../../../src/utils/passageIndexBuilder'
import type { TokenCounter } from '../../../src/utils/passages'
import { STRUCTURE_CARD_PROMPT_VERSION } from '../../../src/utils/structureCards'
import type { LlmClient } from '../llmClient'
import type { EvalSample, PaperTimingRecord } from '../types'
import { introspectPassageStageEvent } from '../metrics/passageDiagnostics'

export interface HybridKnobs {
  minTokens: number
  maxTokens: number
  maxInputChars: number
  rrfK: number
  sectionWeight: number
  neighbourFactor: number
  skipLimit: number
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
  now?: () => number
}

export interface PassageIndexInfo {
  index: PassageIndex
  coldStart: Partial<PaperTimingRecord>
  cacheHits: number
  cacheMisses: number
}

export type PassageIndexHook = (sample: EvalSample) => Promise<PassageIndexInfo>

export function createPassageIndexHook(opts: PassageIndexHookOptions): PassageIndexHook {
  const now = opts.now ?? Date.now
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

  return async (sample: EvalSample): Promise<PassageIndexInfo> => {
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

    const { rest } = await startPassagePipeline(
      sample.pages,
      {
        llm,
        countTokens: opts.countTokens,
        ...(opts.embedder ? { embedder: opts.embedder } : {}),
        // 指纹与切段必须描述同一件事：`passageConfigHash` 由 minTokens/maxTokens 算出，
        // 而管线不传 `segmentation` 时切段走的是 `DEFAULT_PASSAGE_OPTIONS`。少了这一行，
        // 消融改了旋钮只会换掉指纹、段落边界照旧——对照实验里那种「无提示的假阴性」。
        segmentation: { minTokens: opts.knobs.minTokens, maxTokens: opts.knobs.maxTokens },
        passageConfigHash: passageConfig,
        structureHash: structure,
        maxInputChars: opts.knobs.maxInputChars,
        now,
        persist: () => {},
        onStage: (event: PassageStageEvent) => {
          if (event.stage === 'passages') {
            coldStart.coldStartPassageMs = event.latencyMs
            coldStart.coldStartPassageCount = event.passageCount
          } else if (event.stage === 'passage-vectors') {
            coldStart.coldStartEmbedPassagesMs = event.latencyMs
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

    const index = await rest
    coldStart.coldStartTotalMs = Math.max(0, now() - startedAt)
    // 旧版 / 缺失段落索引在 bench 里**直接报错**，绝不静默回落旧路径（方案 §7）：
    // 一个跑到阶段③ 却没有段落的结果，会让下游拿到旧口径的数字而毫无提示
    if (index.passages.length === 0) throw new Error(`论文 ${sample.paperId} 没有切出任何段落`)
    if (index.cards === undefined) throw new Error(`论文 ${sample.paperId} 未走到阶段③，卡片刻度缺失`)

    const after = opts.client.stats()
    return {
      index,
      coldStart,
      cacheHits: after.hits - before.hits,
      cacheMisses: after.misses - before.misses,
    }
  }
}
