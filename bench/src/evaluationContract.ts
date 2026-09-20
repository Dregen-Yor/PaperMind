/**
 * 版本化评测契约：固定指标/tokenizer/预算常量、数据集与有效题指纹、比较身份。
 *
 * 横向检索比较只有在「同一份原文、同一有效题集合、同一指标版本、同一 tokenizer、
 * 同一上下文预算」下才成立，因此这些量必须由一份可序列化的契约显式携带，
 * 而不是散落在各 runner 里靠约定对齐。
 */
import { createHash } from 'node:crypto'
import type { EvalSample, QaQuestion } from './types'

/** 指标 schema 版本。2 = Context Page MRR（最终页序）取代候选排序 MRR。 */
export const METRIC_SCHEMA_VERSION = 2 as const
/** 新 MRR 口径标识；旧结果的 `mrr` 记为 legacy-candidate-mrr，禁止与新口径算差值。 */
export const MRR_DEFINITION = 'context-page-v1' as const
/** 受控最终上下文预算（BGE-M3 tokenizer token 数），横向检索实验统一冻结。 */
export const CONTEXT_BUDGET_TOKENS = 4096
export const CONTEXT_TOKENIZER_MODEL = 'BAAI/bge-m3'
export const CONTEXT_TOKENIZER_REVISION = 'main'
/** QASPER evidence 页面映射口径版本；映射规则变化会让旧结果不可比较。 */
export const EVIDENCE_MAPPING_VERSION = 'page-evidence-v1'

export interface EvaluationContract {
  metricSchemaVersion: typeof METRIC_SCHEMA_VERSION
  mrrDefinition: typeof MRR_DEFINITION
  contextBudgetTokens: number
  contextTokenizer: string
  contextTokenizerRevision: string
  evidenceMappingVersion: string
  datasetFingerprint: string
  eligibleRetrievalQuestionIdsHash: string
  eligibleRetrievalQuestionCount: number
}

/**
 * 有效检索题的固定契约：可回答、有 non-empty evidencePages，且 evidence 映射明确
 * （既非 ambiguous 也非 unmapped）。
 * smoke 冒烟集是人工标注的真实页号，不写 evidenceMapping——那是明确映射而非缺失。
 */
export function isRetrievalEligible(question: QaQuestion): boolean {
  return !question.unanswerable
    && question.evidencePages.length > 0
    && question.evidenceMapping !== 'ambiguous'
    && question.evidenceMapping !== 'unmapped'
}

const sha256 = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')

/**
 * 按 runner 的执行顺序选出实际执行的 (sample, question)。
 * 逐篇按 samples 顺序、逐题按 questions 顺序，累计到 limit 即停——
 * 与 runQaTask / traditionalRagQa / strongBaselineQa 的切片语义逐字一致，
 * 否则指纹会覆盖到未执行的题目，横向比较就失去意义。
 */
function executedQuestions(
  samples: EvalSample[],
  limit?: number,
): Array<{ sample: EvalSample; question: QaQuestion }> {
  const out: Array<{ sample: EvalSample; question: QaQuestion }> = []
  let total = 0
  for (const sample of samples) {
    if (limit !== undefined && total >= limit) break
    for (const question of sample.questions) {
      if (limit !== undefined && total >= limit) break
      total++
      out.push({ sample, question })
    }
  }
  return out
}

/**
 * 构造一次运行的身份契约。
 *
 * `datasetFingerprint` 的规范数组逐题包含 `paperId` / `source` / 全量 `pages` /
 * 题号 / 题干 / 参考答案 / `evidencePages` / `unanswerable` / `evidenceMapping`，
 * 让语料与标注任一侧的变化都可见；`evidenceMapping` 用 `?? null` 固化键，
 * 避免 `undefined` 在 `JSON.stringify` 下被丢键而与「缺字段」混淆。
 * 规范数组按键字面量顺序序列化，故键序稳定、指纹可复现。
 */
export function buildEvaluationContract(samples: EvalSample[], limit?: number): EvaluationContract {
  const executed = executedQuestions(samples, limit)
  const canonical = executed.map(({ sample, question }) => ({
    paperId: sample.paperId,
    source: sample.source,
    pages: sample.pages,
    questionId: question.id,
    question: question.question,
    answers: question.answers,
    evidencePages: question.evidencePages,
    unanswerable: question.unanswerable,
    evidenceMapping: question.evidenceMapping ?? null,
  }))
  const eligibleIds = executed
    .filter(({ question }) => isRetrievalEligible(question))
    .map(({ question }) => question.id)

  return {
    metricSchemaVersion: METRIC_SCHEMA_VERSION,
    mrrDefinition: MRR_DEFINITION,
    contextBudgetTokens: CONTEXT_BUDGET_TOKENS,
    contextTokenizer: CONTEXT_TOKENIZER_MODEL,
    contextTokenizerRevision: CONTEXT_TOKENIZER_REVISION,
    evidenceMappingVersion: EVIDENCE_MAPPING_VERSION,
    datasetFingerprint: sha256(canonical),
    eligibleRetrievalQuestionIdsHash: sha256(eligibleIds),
    eligibleRetrievalQuestionCount: eligibleIds.length,
  }
}

/**
 * 契约的 9 个身份字段 → `BenchResult.meta` 片段，让结果 JSON 能追溯到产生每个数字的
 * 指标版本与坐标。三个 runner 引擎共用同一份透传口径，禁止各自挑选字段。
 */
export function contractMeta(contract: EvaluationContract): EvaluationContract {
  return {
    metricSchemaVersion: contract.metricSchemaVersion,
    mrrDefinition: contract.mrrDefinition,
    contextBudgetTokens: contract.contextBudgetTokens,
    contextTokenizer: contract.contextTokenizer,
    contextTokenizerRevision: contract.contextTokenizerRevision,
    evidenceMappingVersion: contract.evidenceMappingVersion,
    datasetFingerprint: contract.datasetFingerprint,
    eligibleRetrievalQuestionIdsHash: contract.eligibleRetrievalQuestionIdsHash,
    eligibleRetrievalQuestionCount: contract.eligibleRetrievalQuestionCount,
  }
}

/**
 * 固定分母不变量（§7）：有效题必须逐题产出 contextPageMrr 观测（失败也补 0），
 * 观测数与契约中的有效题数不一致即说明有题被静默丢弃，结果不可横向比较——直接抛出
 * 让整轮失效。三个 runner 引擎必须在同一处强制，避免复制后各自放宽。
 */
export function assertContextPageDenominator(
  counts: Record<string, number>,
  contract: EvaluationContract,
): void {
  const sampleCount = counts.contextPageMrr ?? 0
  if (sampleCount !== contract.eligibleRetrievalQuestionCount) {
    throw new Error(
      `contextPageMrr 观测数 ${sampleCount} 与评测契约有效题数 `
      + `${contract.eligibleRetrievalQuestionCount} 不一致，固定分母不变量被破坏`,
    )
  }
}

/**
 * —— 实验身份：端点与生效 prompt（§6.5）——
 *
 * 断点签名必须能区分「换了端点」「改了 prompt」与「改了生成参数」，否则换端点后的
 * 续跑会复用旧断点，把两次运行的数字混成一份。两个身份量都由 CLI 在启动时算出，
 * 它们只会进断点签名与结果 meta，**绝不包含 API key 或任何凭据**。
 */

/**
 * base URL 规范化：只做「同一端点的不同写法必须得到同一身份」这一件事。
 * host 大小写与尾部斜杠对端点语义无影响（`https://API.Openai.com/v1/` 与
 * `https://api.openai.com/v1` 是同一处），而**路径大小写有路由语义**
 * （`/v1` 与 `/V1` 可能是不同挂载点），故只能小写 scheme 与 host。
 * fragment 不会发给服务端，一并去掉。
 * userinfo（`user:pass@`）也一并去掉：它是凭据，正是本函数下游身份声称「不可能进入」的东西；
 * 且凭据轮换不该扰动签名，故带不带 userinfo 必须得到同一身份。
 * 非标准 URL（自定义串）不加猜测，只按尾斜杠等价归一。
 */
export function normalizeBaseUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl)
    url.protocol = url.protocol.toLowerCase()
    url.hostname = url.hostname.toLowerCase()
    url.username = ''
    url.password = ''
    url.hash = ''
    return url.toString().replace(/\/+$/, '')
  } catch {
    return baseUrl.trim().replace(/\/+$/, '')
  }
}

/**
 * 端点身份指纹。入参只有 provider 与 base URL 两项——**没有 key 参数位置**，
 * 这是「凭据不可能进入身份」的结构性保证，而不是靠调用方自觉不传。
 * 第二道保证同向：base URL 里若写了 `user:pass@host`，规范化会先剥掉 userinfo，
 * 凭据连当摘要输入的资格都没有。
 */
export function llmEndpointIdentity(provider: string, baseUrl: string): string {
  return createHash('sha256').update(`${provider}\0${normalizeBaseUrl(baseUrl)}`).digest('hex')
}

/**
 * 生效 system prompt 的基座：调用方 prompt + 样本级语言覆盖指令，
 * 拼装顺序与 `runner/qa.ts`、`runner/traditionalRagQa.ts`、`runner/strongBaselineQa.ts`
 * 内部逐字一致（后者在基座之后再由 runner 追加数学格式约束与检索到的上下文）。
 * 由 CLI 调用并由测试对 runner 实际报文做同源断言，防止两处各拼一份后悄悄分叉。
 */
export function composeBaseSystemPrompt(systemPrompt: string, answerLanguageInstruction?: string): string {
  return answerLanguageInstruction ? `${systemPrompt}\n\n${answerLanguageInstruction}` : systemPrompt
}

/** 生效 prompt 指纹：任何一处 prompt 改动都必须让旧强基线断点失效。 */
export function systemPromptHash(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex')
}
