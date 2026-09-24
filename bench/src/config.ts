import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { BenchConfig, ConfigFile, HybridRerankConfig, LongSectionRagConfig, PaperMindConfig, PassageRuntimeParams, SemanticTreeParams, TraditionalEmbeddingConfig, TraditionalRagConfig } from './types'
import { benchPath } from './paths'
// 受控上下文预算只有一处定义：契约模块（evaluationContract.ts）的 CONTEXT_BUDGET_TOKENS。
// 这里刻意不再另立 4096 常量——两个数字各写一遍，就有一天会各自漂移而没人发现。
import { CONTEXT_BUDGET_TOKENS, CONTEXT_TOKENIZER_MODEL, CONTEXT_TOKENIZER_REVISION } from './evaluationContract'

const DEFAULT_CONFIG_DIR = () => benchPath(import.meta.url, '../configs/')
const fail = (path: string, field: string, reason = '无效'): never => { throw new Error(`配置文件 ${path} 的 ${field} ${reason}`) }
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const positiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0
const nonNegative = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

/** 递归冻结：共享的配置块不得被按臂改写（见 `expandMatrix` 的 `carried`）。 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) deepFreeze((value as Record<string, unknown>)[key])
    Object.freeze(value)
  }
  return value
}

/** 段落混合检索的七项旋钮（`matrix` 里的键名）；与 `validateHybridKnobs` 的清单同源。 */
const PASSAGE_KNOB_KEYS = ['minTokens', 'maxTokens', 'maxInputChars', 'rrfK', 'sectionWeight', 'neighbourFactor', 'skipLimit'] as const

export function expandMatrix(file: ConfigFile): PaperMindConfig[] {
  const keys = Object.keys(file.matrix) as Array<keyof NonNullable<ConfigFile['matrix']>>
  // semanticTree 与「非默认 kind」不属于矩阵维度，但展开时必须原样带到每个配置上。
  // 默认 kind（papermind）刻意不写回，保持既有配置对象形态不变
  const carried: Partial<PaperMindConfig> = {
    ...(file.kind && file.kind !== 'papermind' ? { kind: file.kind } : {}),
    ...(file.semanticTree ? { semanticTree: file.semanticTree } : {}),
    // passage 的身份由 validatePaperMind 校验并归一化，这里不再重复校验。
    // 三个 sectionWeight 臂共享**同一个** passage 对象，所以这里克隆一次并深冻结：
    // 克隆让展开结果不依赖调用方那份对象的后续改动，冻结让任何未来的按臂改写在严格模式下
    // 当场抛错，而不是「悄悄把三个臂的嵌入器身份一起改掉、却仍各自声称不同的旋钮」。
    // （选冻结而不是「按臂克隆」：克隆只隔离副作用，改写仍然静默通过；这里的语义是
    //   「不可消融、各臂逐字相同」，越界就该是显式失败。显式克隆也是类型检查点——
    //   将来给 PassageRuntimeParams 加必填字段时，这里会先编译失败，而不是漏拷贝一个键。）
    ...(file.passage ? { passage: deepFreeze({ embedder: { ...file.passage.embedder } }) } : {}),
  }
  if (!keys.length) return [{ ...carried, name: file.name }]
  let combos: Array<Record<string, number | boolean>> = [{}]
  for (const key of keys) combos = combos.flatMap(combo => file.matrix[key]!.map(v => ({ ...combo, [key]: v })))
  const single = combos.length === 1
  return combos.map(combo => ({ ...carried, ...combo, name: single ? file.name : `${file.name}[${Object.entries(combo).map(([k, v]) => `${k}=${v}`).join(',')}]` })) as PaperMindConfig[]
}

function validateTraditional(raw: Record<string, unknown>, path: string): TraditionalRagConfig {
  if (typeof raw.name !== 'string' || !raw.name) fail(path, 'name', '缺失或不是非空字符串')
  if (!obj(raw.chunking)) fail(path, 'chunking', '缺失或不是对象')
  if (!obj(raw.retrieval)) fail(path, 'retrieval', '缺失或不是对象')
  if (!obj(raw.generationContext)) fail(path, 'generationContext', '缺失或不是对象')
  const c = raw.chunking as Record<string, unknown>; const r = raw.retrieval as Record<string, unknown>; const g = raw.generationContext as Record<string, unknown>; const name = raw.name as string
  if (c.tokenizer !== 'bge-m3' || !positiveInt(c.chunkSize)) fail(path, 'chunking', 'tokenizer 必须为 bge-m3 且 chunkSize 为正整数')
  if (!nonNegative(c.overlap) || !Number.isInteger(c.overlap) || (c.overlap as number) >= (c.chunkSize as number)) fail(path, 'chunking.overlap', '必须为非负整数且小于 chunkSize')
  if (!positiveInt(r.topK)) fail(path, 'retrieval.topK', '必须为正整数')
  if (!positiveInt(g.topK) || (g.topK as number) > (r.topK as number)) fail(path, 'generationContext.topK', '必须为正整数且不大于 retrieval.topK')
  if (!positiveInt(g.maxTokens) || (g.maxTokens as number) < (c.chunkSize as number)) fail(path, 'generationContext.maxTokens', '必须为不小于 chunkSize 的正整数')
  // 与强基线同一处冻结（§5）：最终 4096 预算由 CLI 注入的受控物化器统一施加，
  // 配置里的 maxTokens 不再是可变实验参数——允许它偏离就等于允许某条基线偷换预算，
  // 而跨方法差值会照常算出来。topK 仍是本方法自己的候选选择控制，不在冻结之列。
  if ((g.maxTokens as number) !== CONTEXT_BUDGET_TOKENS) fail(path, 'generationContext.maxTokens', `必须为冻结口径 ${CONTEXT_BUDGET_TOKENS}`)
  const base = { name, kind: 'traditional-rag' as const, chunking: { tokenizer: 'bge-m3' as const, chunkSize: c.chunkSize as number, overlap: c.overlap as number }, generationContext: { topK: g.topK as number, maxTokens: g.maxTokens as number } }
  if (r.algorithm === 'bm25') {
    if (!nonNegative(r.k1) || !nonNegative(r.b) || (r.b as number) > 1) fail(path, 'retrieval.k1/b', 'k1 必须非负且 b 必须在 [0,1]')
    return { ...base, retrieval: { algorithm: 'bm25', topK: r.topK as number, k1: r.k1 as number, b: r.b as number } }
  }
  if (r.algorithm === 'jaccard') return { ...base, retrieval: { algorithm: 'jaccard', topK: r.topK as number } }
  if (r.algorithm === 'cosine') {
    if (!obj(r.embedding)) fail(path, 'retrieval.embedding', '缺失或不是对象')
    const e = r.embedding as Record<string, unknown>
    if (typeof e.model !== 'string' || typeof e.revision !== 'string' || typeof e.queryPrefix !== 'string' || e.normalize !== true || !positiveInt(e.maxLength)) fail(path, 'retrieval.embedding', '字段不完整，且 normalize 必须为 true')
    return { ...base, retrieval: { algorithm: 'cosine', topK: r.topK as number, embedding: { model: e.model as string, revision: e.revision as string, queryPrefix: e.queryPrefix as string, normalize: true, maxLength: e.maxLength as number } } }
  }
  return fail(path, 'retrieval.algorithm', '非法')
}

/**
 * 三种新基线（2026-09-08 计划 §1.1）与受控上下文预算（2026-09-19 计划 §5）共用同一个
 * 数字，来源统一为契约模块的 `CONTEXT_BUDGET_TOKENS`；偏离即口径漂移，直接拒绝。
 */
function validateEmbedding(value: unknown, path: string, field: string): TraditionalEmbeddingConfig {
  if (!obj(value)) fail(path, field, '缺失或不是对象')
  const e = value as Record<string, unknown>
  if (typeof e.model !== 'string' || typeof e.revision !== 'string' || typeof e.queryPrefix !== 'string' || e.normalize !== true || !positiveInt(e.maxLength)) fail(path, field, '字段不完整，且 normalize 必须为 true')
  return { model: e.model as string, revision: e.revision as string, queryPrefix: e.queryPrefix as string, normalize: true, maxLength: e.maxLength as number }
}

function validateChunking(value: unknown, path: string, field: string): { tokenizer: 'bge-m3'; chunkSize: number; overlap: number } {
  if (!obj(value)) fail(path, field, '缺失或不是对象')
  const c = value as Record<string, unknown>
  if (c.tokenizer !== 'bge-m3' || !positiveInt(c.chunkSize)) fail(path, `${field}`, 'tokenizer 必须为 bge-m3 且 chunkSize 为正整数')
  if (!nonNegative(c.overlap) || !Number.isInteger(c.overlap) || (c.overlap as number) >= (c.chunkSize as number)) fail(path, `${field}.overlap`, '必须为非负整数且小于 chunkSize')
  return { tokenizer: 'bge-m3', chunkSize: c.chunkSize as number, overlap: c.overlap as number }
}

function validateContext(raw: Record<string, unknown>, path: string, floorChunkSize: number): { topK: number; maxTokens: number } {
  if (!obj(raw.generationContext)) fail(path, 'generationContext', '缺失或不是对象')
  const g = raw.generationContext as Record<string, unknown>
  if (!positiveInt(g.topK)) fail(path, 'generationContext.topK', '必须为正整数')
  if (!positiveInt(g.maxTokens) || (g.maxTokens as number) < floorChunkSize) fail(path, 'generationContext.maxTokens', `必须为不小于 ${floorChunkSize} 的正整数`)
  if ((g.maxTokens as number) !== CONTEXT_BUDGET_TOKENS) fail(path, 'generationContext.maxTokens', `必须为冻结口径 ${CONTEXT_BUDGET_TOKENS}`)
  return { topK: g.topK as number, maxTokens: g.maxTokens as number }
}

function validateHybridRerank(raw: Record<string, unknown>, path: string): HybridRerankConfig {
  if (typeof raw.name !== 'string' || !raw.name) fail(path, 'name', '缺失或不是非空字符串')
  const chunking = validateChunking(raw.chunking, path, 'chunking')
  if (!obj(raw.retrieval)) fail(path, 'retrieval', '缺失或不是对象')
  const r = raw.retrieval as Record<string, unknown>
  if (!obj(r.bm25) || !obj(r.dense) || !obj(r.rrf) || !obj(r.reranker)) fail(path, 'retrieval', '必须包含 bm25/dense/rrf/reranker 四个对象')
  const bm25 = r.bm25 as Record<string, unknown>; const dense = r.dense as Record<string, unknown>; const rrf = r.rrf as Record<string, unknown>; const reranker = r.reranker as Record<string, unknown>
  if (!positiveInt(bm25.topK) || !nonNegative(bm25.k1) || !nonNegative(bm25.b) || (bm25.b as number) > 1) fail(path, 'retrieval.bm25', 'topK 必须为正整数，k1 非负且 b 在 [0,1]')
  if (!positiveInt(dense.topK)) fail(path, 'retrieval.dense.topK', '必须为正整数')
  const embedding = validateEmbedding(dense.embedding, path, 'retrieval.dense.embedding')
  if (!positiveInt(rrf.k)) fail(path, 'retrieval.rrf.k', '必须为正整数')
  if (!positiveInt(rrf.topK) || (rrf.topK as number) > (bm25.topK as number) + (dense.topK as number)) fail(path, 'retrieval.rrf.topK', '必须为正整数且不大于 bm25.topK + dense.topK')
  if (typeof reranker.model !== 'string' || typeof reranker.revision !== 'string') fail(path, 'retrieval.reranker', 'model/revision 必须为字符串（显式 pin，禁止环境默认）')
  if (!positiveInt(reranker.topK) || (reranker.topK as number) > (rrf.topK as number)) fail(path, 'retrieval.reranker.topK', '必须为正整数且不大于 rrf.topK')
  if (!positiveInt(reranker.maxLength)) fail(path, 'retrieval.reranker.maxLength', '必须为正整数')
  const generationContext = validateContext(raw, path, chunking.chunkSize)
  if (generationContext.topK > (reranker.topK as number)) fail(path, 'generationContext.topK', '不能大于 retrieval.reranker.topK')
  return {
    name: raw.name as string,
    kind: 'hybrid-rerank',
    chunking,
    retrieval: {
      bm25: { topK: bm25.topK as number, k1: bm25.k1 as number, b: bm25.b as number },
      dense: { topK: dense.topK as number, embedding },
      rrf: { k: rrf.k as number, topK: rrf.topK as number },
      reranker: { model: reranker.model as string, revision: reranker.revision as string, topK: reranker.topK as number, maxLength: reranker.maxLength as number },
    },
    generationContext,
  }
}

function validateLongSectionRag(raw: Record<string, unknown>, path: string): LongSectionRagConfig {
  if (typeof raw.name !== 'string' || !raw.name) fail(path, 'name', '缺失或不是非空字符串')
  const anchors = validateChunking(raw.anchors, path, 'anchors')
  if (!obj(raw.retrieval)) fail(path, 'retrieval', '缺失或不是对象')
  const r = raw.retrieval as Record<string, unknown>
  if (r.algorithm !== 'bm25') fail(path, 'retrieval.algorithm', 'long-section-rag 固定为 bm25 锚点检索')
  if (!positiveInt(r.topK)) fail(path, 'retrieval.topK', '必须为正整数')
  if (!nonNegative(r.k1) || !nonNegative(r.b) || (r.b as number) > 1) fail(path, 'retrieval.k1/b', 'k1 必须非负且 b 必须在 [0,1]')
  const generationContext = validateContext(raw, path, anchors.chunkSize)
  // 连续区域是单一上下文单元：topK ≠ 1 意味着方法被偷换成了多段拼接
  if (generationContext.topK !== 1) fail(path, 'generationContext.topK', 'long-section-rag 的连续区域是单一上下文单元，必须为 1')
  return {
    name: raw.name as string,
    kind: 'long-section-rag',
    anchors,
    retrieval: { algorithm: 'bm25', topK: r.topK as number, k1: r.k1 as number, b: r.b as number },
    generationContext,
  }
}

/**
 * 语义树建树参数（§5 分块 / §8.1 输入上限）。
 * 分块口径直接决定树看到的证据块粒度，写错等于换了个实验，故逐项校验关系而非只查类型。
 */
function validateSemanticTreeParams(value: unknown, path: string): SemanticTreeParams {
  if (!obj(value)) fail(path, 'semanticTree', '缺失或不是对象')
  const raw = value as Record<string, unknown>
  if (!positiveInt(raw.maxInputChars)) fail(path, 'semanticTree.maxInputChars', '必须为正整数')
  if (!obj(raw.evidence)) fail(path, 'semanticTree.evidence', '缺失或不是对象')
  const e = raw.evidence as Record<string, unknown>
  if (!positiveInt(e.targetChars) || !positiveInt(e.maxChars) || !positiveInt(e.minChars)) {
    fail(path, 'semanticTree.evidence', 'targetChars/maxChars/minChars 必须为正整数')
  }
  const targetChars = e.targetChars as number
  const maxChars = e.maxChars as number
  const minChars = e.minChars as number
  // 三者乱序会产生「永远关闭不了的块」这类静默退化，配置期就拒绝
  if (minChars > targetChars || targetChars > maxChars) {
    fail(path, 'semanticTree.evidence', '必须满足 minChars ≤ targetChars ≤ maxChars')
  }
  return { evidence: { targetChars, maxChars, minChars }, maxInputChars: raw.maxInputChars as number }
}

/** 段落混合检索的旋钮必须齐全且在合理范围：缺一个就会静默用产品默认值，配置就不等于口径了。 */
function validateHybridKnobs(config: PaperMindConfig, path: string): void {
  if (!config.passage) return
  const require = (name: keyof PaperMindConfig, predicate: (v: unknown) => boolean, hint: string) => {
    const value = config[name]
    if (!predicate(value)) fail(path, `passage`, `${String(name)} ${hint}`)
  }
  require('minTokens', v => typeof v === 'number' && Number.isInteger(v) && v > 0, '必须存在且为正整数')
  require('maxTokens', v => typeof v === 'number' && Number.isInteger(v) && v > 0, '必须存在且为正整数')
  if (typeof config.maxTokens === 'number' && typeof config.minTokens === 'number' && config.maxTokens < config.minTokens) {
    fail(path, 'passage', 'maxTokens 必须不小于 minTokens')
  }
  require('maxInputChars', v => typeof v === 'number' && Number.isInteger(v) && v > 0, '必须存在且为正整数')
  require('rrfK', v => typeof v === 'number' && Number.isInteger(v) && v > 0, '必须存在且为正整数')
  require('sectionWeight', v => typeof v === 'number' && v >= 0 && v <= 1, '必须在 [0, 1]')
  require('neighbourFactor', v => typeof v === 'number' && v >= 0 && v <= 1, '必须在 [0, 1]')
  require('skipLimit', v => typeof v === 'number' && Number.isInteger(v) && v > 0, '必须存在且为正整数')
}

function validatePassageParams(value: unknown, path: string): PassageRuntimeParams {
  if (!obj(value)) fail(path, 'passage', '必须是对象')
  const embedder = (value as Record<string, unknown>).embedder
  if (!obj(embedder)) fail(path, 'passage.embedder', '缺失或不是对象')
  const e = embedder as Record<string, unknown>
  for (const key of ['model', 'revision', 'dtype'] as const) {
    if (typeof e[key] !== 'string' || !(e[key] as string).trim()) {
      fail(path, `passage.embedder.${key}`, '必须为非空字符串（显式 pin，禁止环境默认）')
    }
  }
  if (typeof e.dim !== 'number' || !Number.isInteger(e.dim) || e.dim <= 0) fail(path, 'passage.embedder.dim', '必须为正整数')
  return { embedder: { model: e.model as string, revision: e.revision as string, dtype: e.dtype as string, dim: e.dim as number } }
}

export function validatePaperMind(raw: Record<string, unknown>, path: string): ConfigFile {
  // 顶层键白名单：拼错的开关（passag / semanticTre）和写错层级的旋钮都不能静默失效。
  // 少了这道闸，一个拼错的 passage 会让整份配置照常展开、照常带着 `papermind-hybrid`
  // 这个名字去跑平铺管道——量出来的数字标着混合检索，比直接崩掉更糟。
  const allowedTop = new Set(['name', 'kind', 'semanticTree', 'passage', 'matrix'])
  for (const key of Object.keys(raw)) if (!allowedTop.has(key)) fail(path, key, '不是支持的 PaperMind 配置项')
  if (typeof raw.name !== 'string' || !raw.name) fail(path, 'name', '缺失或不是非空字符串')
  if (!obj(raw.matrix)) fail(path, 'matrix', '缺失或不是对象')
  const matrix = raw.matrix as Record<string, unknown>
  const allowed = new Set([
    'topK', 'minScore', 'chunkPages', 'minSectionPages', 'maxSectionPages', 'maxContextChars', 'forceFixedChunk', 'enableRewrite',
    // 段落混合检索旋钮（方案 §7）：与其它参数一样显式列出，拼错的键不能静默失效
    'minTokens', 'maxTokens', 'maxInputChars', 'rrfK', 'sectionWeight', 'neighbourFactor', 'skipLimit',
  ])
  for (const [key, values] of Object.entries(matrix)) {
    if (!allowed.has(key)) fail(path, `matrix.${key}`, '不是支持的 PaperMind 参数')
    if (!Array.isArray(values)) fail(path, `matrix.${key}`, '必须为 number/boolean 数组')
    const list = values as unknown[]
    if (list.some(v => typeof v !== 'number' && typeof v !== 'boolean')) fail(path, `matrix.${key}`, '必须为 number/boolean 数组')
    if (!list.length) fail(path, `matrix.${key}`, '展开为 0 个配置')
  }
  // 七项旋钮与 `passage` 块必须**共现**（方案 §7：旋钮消融 + 不可消融的嵌入器块）。
  // 上面的白名单只挡拼错的键名，挡不住「旋钮一个不差、整块 `passage` 却漏了」：那种配置会
  // 原样展开成若干条平铺臂，名字却还叫 papermind-hybrid——量出来的数字标着混合检索，
  // 实际一条 passage 参数都没下发。只在「恰好一边有」时报错：两者都缺席是合法的纯平铺配置
  // （`bench/configs/default.json`），两者都在则交给下面的 `validateHybridKnobs` 逐项校验。
  const hasKnob = PASSAGE_KNOB_KEYS.some(key => matrix[key] !== undefined)
  const hasPassage = raw.passage !== undefined
  if (hasKnob !== hasPassage) {
    fail(path, 'passage', hasKnob
      ? `段落旋钮 ${PASSAGE_KNOB_KEYS.filter(key => matrix[key] !== undefined).join('/')} 缺少配套的 passage 块：嵌入器不可消融，两者必须同时出现（否则会以混合检索之名跑平铺管道）`
      : `缺少段落混合检索的七项旋钮 ${PASSAGE_KNOB_KEYS.join('/')}：passage 块必须与它们同时出现`)
  }
  const file: ConfigFile = raw.kind === 'semantic-tree'
    ? {
        name: raw.name as string,
        kind: 'semantic-tree',
        semanticTree: validateSemanticTreeParams(raw.semanticTree, path),
        matrix: matrix as ConfigFile['matrix'],
      }
    : { name: raw.name as string, kind: 'papermind', matrix: matrix as ConfigFile['matrix'] }
  // 段落混合检索块：不可消融，校验后写回 ConfigFile，由 expandMatrix 原样带到每个展开点
  if (raw.passage !== undefined) file.passage = validatePassageParams(raw.passage, path)
  // 旋钮校验挂在本函数自己身上（而不是只挂在 loadConfigs 上）：配置即口径，
  // 任何拿到 ConfigFile 的入口（含单测直接调用）都必须面对同一道校验，
  // 而不是展开之后才在另一处补一刀。expandMatrix 同在本模块导出，不构成循环。
  if (file.passage) for (const config of expandMatrix(file)) validateHybridKnobs(config, path)
  return file
}

/** kind → 校验器分发；新基线一律单配置（无矩阵展开），非法 kind 在此显式拒绝。 */
const KIND_VALIDATORS: Record<string, (raw: Record<string, unknown>, path: string) => BenchConfig> = {
  'traditional-rag': validateTraditional,
  'hybrid-rerank': validateHybridRerank,
  'long-section-rag': validateLongSectionRag,
}

export async function loadConfigs(nameOrPath: string, configDir: string = DEFAULT_CONFIG_DIR()): Promise<BenchConfig[]> {
  const path = nameOrPath.endsWith('.json') || isAbsolute(nameOrPath) ? nameOrPath : join(configDir, `${nameOrPath}.json`)
  if (!existsSync(path)) throw new Error(`配置文件不存在：${path}（--config 接受配置名或 .json 路径）`)
  let raw: unknown
  try { raw = JSON.parse(await readFile(path, 'utf-8')) } catch (e) { throw new Error(`配置文件 ${path} 不是合法 JSON：${e instanceof Error ? e.message : String(e)}`) }
  if (!obj(raw)) fail(path, '根对象', '必须为对象')
  const record = raw as Record<string, unknown>
  // semantic-tree 走 PaperMind 的矩阵校验器（它只多一个建树参数块），其余 kind 走各自校验器
  const isMatrixKind = record.kind === undefined || record.kind === 'papermind' || record.kind === 'semantic-tree'
  if (!isMatrixKind && !KIND_VALIDATORS[record.kind as string]) fail(path, 'kind', '未知')
  if (!isMatrixKind) return [KIND_VALIDATORS[record.kind as string](record, path)]
  // validatePaperMind 已按「配置即口径」校验过一遍旋钮；这里对已展开的每个点再校验一次，
  // 保证校验对象正是调用方随后要跑的那份配置（重复校验无副作用）。
  // 两道 pass 是构造上同一件事：同一个 validateHybridKnobs 作用在同一份展开结果上，
  // 不是分工不同的两道闸——改动其中一处就等于同时改动两处。
  const configs = expandMatrix(validatePaperMind(record, path)).map(config => {
    validateHybridKnobs(config, path)
    return config
  })
  return configs
}

export function configLabel(config: BenchConfig): string { return config.name.replace(/[^\w.=,[\]-]/g, '_').replace(/[[\],=]/g, '.').replace(/\.+$/, '') }

/**
 * 该配置的**检索路径实际会加载**的 BGE-M3 tokenizer 身份。
 *
 * 受控物化器要复用检索侧那份词表（否则同一次跑批会把同一份词表加载两遍），前提是
 * 复用对象与契约身份同源；这里把每条路径的真实来源写清楚，让 CLI 只需比对而不必猜：
 *
 * - `chunking` / `anchors` 只有 `tokenizer: 'bge-m3'`，没有 model/revision 字段，
 *   各 runner 内部固定按 `BAAI/bge-m3@main` 加载——即契约身份。
 * - `hybrid-rerank` 的 dense embedding 另有一份 pin，但它只喂 embedding pipeline，
 *   分块走的是独立的 bge-m3@main 实例，故仍与契约同源。
 * - 传统 RAG 的 `bm25` / `jaccard` 同理；只有 `cosine` 会拿 embedding pin 的 tokenizer
 *   去分块，pin 不同即身份不同，必须如实报出——照着契约身份复用会让结果 meta 断言
 *   一份本次运行并未真正使用的 tokenizer（数字照样算出来，只是不可信）。
 */
export function retrievalTokenizerIdentity(config: BenchConfig): { model: string; revision: string } {
  const embedding = config.kind === 'traditional-rag' && config.retrieval.algorithm === 'cosine'
    ? config.retrieval.embedding
    : undefined
  if (embedding) return { model: embedding.model, revision: embedding.revision }
  return { model: CONTEXT_TOKENIZER_MODEL, revision: CONTEXT_TOKENIZER_REVISION }
}
