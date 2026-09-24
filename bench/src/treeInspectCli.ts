/**
 * 结构人工检查 CLI（方案 §阶段 E 第 4 步 / §7「结构抽查」）。
 *
 *   npm run bench:trees -- --config semantic-tree --dataset qasper --limit 5
 *   npm run bench:trees -- --config papermind-hybrid --dataset qasper --limit 5
 *
 * 自动指标能回答「树有多大」「卡片有几张」，回答不了「节点是不是论文特有的语义」
 * 「主题划分是否合理」。这个入口按配置分流：
 * - `semantic-tree` 配置 → 逐层打印语义树；
 * - 带 `passage` 的配置 → 逐卡片打印范围 / 页区间 / 标题 / keyTerms。
 * 两者都只建索引、不跑问答，输出到 `--out`（缺省 `bench/results/trees.md`）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseArgs } from './args'
import { loadConfigs } from './config'
import { createLlmClient, resolveEnvConfig, type LlmClient } from './llmClient'
import { loadQasperDataset } from './datasets/qasper'
import { loadSmokeDataset } from './datasets/smoke'
import { createSemanticTreeHook } from './runner/semanticTreeQa'
import { createPassageIndexHook, type HybridKnobs } from './runner/passageIndexHook'
import { errorMessage } from './runner/support'
import { renderTreeReport, renderCardReport, type TreeInspectionEntry } from './treeInspect'
import { benchPath } from './paths'
import { CONTEXT_TOKENIZER_MODEL, CONTEXT_TOKENIZER_REVISION } from './evaluationContract'
import { createBgeM3Tokenizer } from './traditionalRag/embedding'
import { createTransformersEmbedder } from '../../src/utils/transformersEmbedder'
import type { Embedder } from '../../src/utils/embedder'
import type { BenchConfig, EvalSample, PaperMindConfig, PassageRuntimeParams } from './types'

/** 与各 runner 内部的 modelCacheDir() 指向同一目录（bench/cache/models/）。 */
const MODEL_CACHE_DIR = () => benchPath(import.meta.url, '../cache/models/')

async function loadDatasets(which: string): Promise<EvalSample[]> {
  const out: EvalSample[] = []
  if (which === 'qasper' || which === 'all') out.push(...await loadQasperDataset())
  if (which === 'smoke' || which === 'all') out.push(...await loadSmokeDataset())
  if (out.length === 0) throw new Error(`数据集为空（--dataset ${which}）`)
  return out
}

/** `passage` 块只挂在 PaperMind 配置上；其余 union 成员没有该字段，故先 `in` 收窄再查值。 */
function isPassageConfig(config: BenchConfig): config is PaperMindConfig & { passage: PassageRuntimeParams } {
  return 'passage' in config && config.passage !== undefined
}

/** 语义树视图：逐篇建树，把树按层打印出来。 */
async function renderTreeSections(
  params: PaperMindConfig['semanticTree'],
  samples: EvalSample[],
  client: LlmClient,
): Promise<string> {
  if (!params) throw new Error('语义树配置缺少 semanticTree 参数块，无法做结构检查')
  const hook = createSemanticTreeHook({ params, client })
  process.stdout.write(`对 ${samples.length} 篇论文建树...\n`)
  const entries: TreeInspectionEntry[] = []
  for (const sample of samples) {
    const outcome = await hook(sample)
    entries.push(outcome.semantic
      ? { paperId: sample.paperId, outcome: outcome.semantic }
      : { paperId: sample.paperId, failure: 'build-failed' })
    process.stdout.write(`  ${sample.paperId}：${outcome.semantic ? '已建树' : '建树失败（该篇回落平面检索）'}\n`)
  }
  return renderTreeReport(entries)
}

/**
 * 卡片视图：用与 bench 主流程同一个 hook 建一次索引（`persist` 在 hook 内已是空函数，
 * 评测进程不引入 SQLite），把最终 `index` 里的卡片划分原样交给人工核对。
 */
async function renderCardSections(
  config: PaperMindConfig & { passage: PassageRuntimeParams },
  samples: EvalSample[],
  client: LlmClient,
  modelIdentity: string,
): Promise<string> {
  // 卡片来自 LLM，没有向量模型也能核对；加载失败只降级为「无卡片向量」，不中断
  let embedder: Embedder | undefined
  try {
    embedder = await createTransformersEmbedder({
      model: config.passage.embedder.model,
      revision: config.passage.embedder.revision,
      dtype: config.passage.embedder.dtype,
      dim: config.passage.embedder.dim,
      cacheDir: MODEL_CACHE_DIR(),
    })
  } catch (error) {
    console.warn(`向量模型加载失败，卡片视图继续（无卡片向量）：${errorMessage(error)}`)
  }
  // 契约分词器只有 tokenize：计数口径必须与 materializeContext 一致，否则切段边界与 bench 不同
  const contractTokenizer = await createBgeM3Tokenizer({
    model: CONTEXT_TOKENIZER_MODEL,
    revision: CONTEXT_TOKENIZER_REVISION,
    cacheDir: MODEL_CACHE_DIR(),
  })
  const knobs: HybridKnobs = {
    minTokens: config.minTokens as number,
    maxTokens: config.maxTokens as number,
    maxInputChars: config.maxInputChars as number,
    rrfK: config.rrfK as number,
    sectionWeight: config.sectionWeight as number,
    neighbourFactor: config.neighbourFactor as number,
    skipLimit: config.skipLimit as number,
  }
  const hook = createPassageIndexHook({
    knobs,
    client,
    embedder,
    countTokens: (text: string) => contractTokenizer.tokenize(text).length,
    modelIdentity,
  })

  process.stdout.write(`对 ${samples.length} 篇论文建卡片索引（${config.name}）...\n`)
  const lines: string[] = ['# 卡片划分人工核对', '']
  for (const sample of samples) {
    const { index } = await hook(sample)
    const cards = index.cards
    // hook 契约保证阶段③ 一定有成型的卡片；真缺了就说实话，不渲染一张空表
    if (cards === undefined) throw new Error(`论文 ${sample.paperId} 未走到阶段③，卡片刻度缺失`)
    lines.push(renderCardReport({
      paperId: sample.paperId,
      title: sample.title,
      passages: index.passages,
      cards,
      ...(index.structureFallback ? { fallback: index.structureFallback.reason } : {}),
      ...(index.paper ? { paper: index.paper } : {}),
    }))
    process.stdout.write(
      `  ${sample.paperId}：${cards.length} 张卡片`
      + `${index.structureFallback ? `（回落 ${index.structureFallback.reason}）` : ''}\n`,
    )
  }
  return lines.join('\n')
}

const args = parseArgs(process.argv.slice(2))
const configs = await loadConfigs(args.config)
const config = configs[0]

const samples = await loadDatasets(args.dataset)
const limited = args.limit === undefined ? samples : samples.slice(0, args.limit)
const env = resolveEnvConfig(process.env)
const client = createLlmClient({ ...env, useCache: args.useCache })

let report: string
if (config.kind === 'semantic-tree') {
  report = await renderTreeSections(config.semanticTree, limited, client)
} else if (isPassageConfig(config)) {
  report = await renderCardSections(config, limited, client, env.model)
} else {
  throw new Error(
    `${args.config} 既不是语义树配置（缺少 semanticTree 参数块）也不是段落混合配置（缺少 passage 参数块），无法做结构检查`,
  )
}

const out = args.out ?? benchPath(import.meta.url, '../results/trees.md')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, report)
process.stdout.write(`检查报告已写入 ${out}\n`)
