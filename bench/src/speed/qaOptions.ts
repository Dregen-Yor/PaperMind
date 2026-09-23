import type { LlmClientOptions } from '../llmClient'

export interface QaAnswerOptions {
  maxTokens: number
  temperature: number
  timeoutMs: number
  retryAttempts: number
  topP?: number
  thinking?: 'enabled' | 'disabled'
  stop?: string | string[]
}

export function parseQaGenerationEnv(env: Record<string, string | undefined>): Pick<LlmClientOptions, 'topP' | 'thinking'> {
  const rawTopP = env.BENCH_QA_TOP_P
  const rawThinking = env.BENCH_QA_THINKING
  const topP = rawTopP === undefined ? undefined : Number(rawTopP)
  if (topP !== undefined && (rawTopP?.trim() === '' || !Number.isFinite(topP) || topP < 0 || topP > 1)) {
    throw new Error(`BENCH_QA_TOP_P must be finite and within [0, 1], received: ${rawTopP}`)
  }
  if (rawThinking !== undefined && rawThinking !== 'enabled' && rawThinking !== 'disabled') {
    throw new Error(`BENCH_QA_THINKING must be enabled or disabled, received: ${rawThinking}`)
  }
  return { topP, thinking: rawThinking as 'enabled' | 'disabled' | undefined }
}

function nonNegativeInt(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer, received: ${raw}`)
  return value
}

export function resolveQaAnswerOptions(env: Record<string, string | undefined>): QaAnswerOptions {
  const timeoutMs = nonNegativeInt(env, 'BENCH_QA_REQUEST_TIMEOUT_MS', 120_000)
  if (timeoutMs === 0) throw new Error('BENCH_QA_REQUEST_TIMEOUT_MS must be a positive integer')
  return {
    maxTokens: 4096,
    temperature: 0,
    timeoutMs,
    retryAttempts: nonNegativeInt(env, 'BENCH_QA_RETRY_ATTEMPTS', 3),
    ...parseQaGenerationEnv(env),
    stop: undefined,
  }
}
