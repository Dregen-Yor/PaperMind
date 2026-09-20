import type { LlmClient } from '../llmClient'
import type { PerSampleRecord, QaQuestion } from '../types'
import { answerF1, isRefusal } from './answerF1'

/**
 * Rubric 版本号。嵌在 prompt 中，因此改动 rubric 会自动使缓存失效
 * （缓存 key 按 prompt 哈希）。改 rubric 必须 bump 此值。
 */
export const RUBRIC_VERSION = 'rubric-v1'

export interface JudgeScores {
  factuality: number
  completeness: number
  groundedness: number
}

export interface JudgeArgs {
  question: string
  /** evidence 原文。刻意不传参考答案——与 answerF1 同源会失去互补性 */
  evidence: string
  answer: string
  client: LlmClient
}

export function buildJudgePrompt(args: { question: string; evidence: string; answer: string }): string {
  return `[${RUBRIC_VERSION}] 你是学术问答质量评审。仅依据给出的论文原文片段评估回答，不要使用你自己的知识。

问题：
${args.question}

论文原文片段：
${args.evidence}

待评估回答：
${args.answer}

按三个维度各打 1-5 分（5 最好）：
- factuality：回答中的陈述是否与原文片段一致（有事实错误则低分）
- completeness：是否完整回答了问题（遗漏关键信息则低分）
- groundedness：是否只用了原文片段中的信息（引入片段外内容则低分）

只回 JSON，不要解释：{"factuality":N,"completeness":N,"groundedness":N}`
}

const DIMENSIONS = ['factuality', 'completeness', 'groundedness'] as const

export function parseJudgeResponse(raw: string): JudgeScores | null {
  try {
    const cleaned = raw.replace(/```json\n?|```/g, '').trim()
    const parsed = JSON.parse(cleaned) as Record<string, unknown>
    const out: Record<string, number> = {}
    for (const dim of DIMENSIONS) {
      const v = parsed[dim]
      // 越界或非数值一律作废——缺数据好过错数据
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 1 || v > 5) return null
      out[dim] = v
    }
    return out as unknown as JudgeScores
  } catch {
    return null
  }
}

export async function judgeAnswer(args: JudgeArgs): Promise<JudgeScores | null> {
  try {
    const raw = await args.client.complete(buildJudgePrompt(args))
    return parseJudgeResponse(raw)
  } catch {
    return null
  }
}

/** 用 judge 做「是否拒答」二分类，比正则表更宽容于表述变体。 */
export async function judgeUnanswerable(args: {
  question: string
  answer: string
  client: LlmClient
}): Promise<boolean | null> {
  const prompt = `[${RUBRIC_VERSION}] 判断下面的回答是否表达了「无法根据给定内容回答」。

问题：${args.question}

回答：${args.answer}

只回一个词：REFUSAL（表达了无法回答）或 ANSWERED（给出了实质回答）。`

  try {
    const raw = (await args.client.complete(prompt)).trim().toUpperCase()
    if (raw.includes('REFUSAL')) return true
    if (raw.includes('ANSWERED')) return false
    return null
  } catch {
    return null
  }
}

/**
 * 跨样本累计的 judge 口径状态，judgeSample 原地写入：
 * - `sawUnanswerable`：本轮是否出现过不可回答题，决定 meta.unanswerableMethod 是否落盘
 * - `usedPatternFallback`：judge 不可用或失败而回落到正则口径时置位
 */
export interface JudgeSampleState {
  sawUnanswerable: boolean
  usedPatternFallback: boolean
}

export interface JudgeSampleArgs {
  question: QaQuestion
  answer: string
  /** evidence 原文（已 join + trim）；可回答题在此为空时不调用 judge */
  evidenceText: string
  /** 未提供 judge 客户端时只跑 answerF1 与正则拒答口径 */
  judgeClient?: LlmClient
  /** 逐样本指标，judge 结果原地写入 */
  metrics: Record<string, number>
  /** 逐样本记录，judgeStatus 原地写入 */
  record: PerSampleRecord
  /** 跨样本累计状态，原地写入 */
  state: JudgeSampleState
}

/**
 * 打分阶段的唯一实现：不可回答题走「拒答判定」，可回答题走 answerF1 + 三维修分。
 * 逐样本 judgeStatus 状态机（completed / failed / skipped）与 judge 回落口径都在这里
 * 定义一次，禁止各 runner 复制后分叉。
 *
 * 刻意不在此处 catch：异常策略依 runner 而异——runQaTask 需把时延不变量破坏重新抛出
 * 让整轮失效，传统 RAG 不区分，因此外层 try/catch 留在各自调用点。
 */
export async function judgeSample(args: JudgeSampleArgs): Promise<void> {
  const { question, answer, evidenceText, judgeClient, metrics, record, state } = args
  if (question.unanswerable) {
    state.sawUnanswerable = true
    if (judgeClient) {
      const verdict = await judgeUnanswerable({ question: question.question, answer, client: judgeClient })
      // judge 不可用时回落到正则口径，并如实记录用了哪种
      if (verdict === null) {
        metrics.unanswerableAccuracy = isRefusal(answer) ? 1 : 0
        state.usedPatternFallback = true
        record.judgeStatus = 'failed'
      } else {
        metrics.unanswerableAccuracy = verdict ? 1 : 0
        record.judgeStatus = 'completed'
      }
    } else {
      metrics.unanswerableAccuracy = isRefusal(answer) ? 1 : 0
      state.usedPatternFallback = true
      record.judgeStatus = 'skipped'
    }
  } else {
    metrics.answerF1 = answerF1(answer, question.answers)
    if (judgeClient && evidenceText) {
      const scores = await judgeAnswer({ question: question.question, evidence: evidenceText, answer, client: judgeClient })
      if (scores) {
        metrics.judgeFactuality = scores.factuality
        metrics.judgeCompleteness = scores.completeness
        metrics.judgeGroundedness = scores.groundedness
        record.judgeStatus = 'completed'
      } else {
        // scores 为 null（非法/失败）时不写 judge 指标 → aggregate 自动从分母剔除，
        // 但状态如实记为 failed，检索指标与 answerF1 原样保留
        record.judgeStatus = 'failed'
      }
    } else {
      record.judgeStatus = 'skipped'
    }
  }
}
