import { performance } from 'node:perf_hooks'
import type { EvaluationContract } from '../evaluationContract'
import type { LlmClientOptions, StreamingLlmClient } from '../llmClient'
import type { SpeedRunnerOptions } from './generate'
import {
  buildSpeedRunContract,
  type BuildSpeedRunContractArgs,
  type SpeedGenerationSettings,
  type SpeedRunContract,
} from './contract'

export interface BuildSpeedExecutionPolicyArgs {
  evaluationContract: EvaluationContract
  executedQuestionIds: string[]
  provider: string
  model: string
  baseUrl: string
  retryAttempts: number
  answerSystemPrompt: string
  maxTokens?: number
  stop?: string | string[]
  environment: BuildSpeedRunContractArgs['environment']
  localExecution?: boolean
  env?: Record<string, string | undefined>
}

export interface SpeedExecutionPolicy {
  answerClientOverrides: Pick<LlmClientOptions, 'useCache' | 'retryAttempts' | 'maxTokens' | 'temperature'>
  generationSettings: SpeedGenerationSettings
  now: () => number
  queryConcurrency: 1
  contract: SpeedRunContract
  runnerOptions: SpeedRunnerOptions
}

export function isLocalExecutionEndpoint(provider: string, baseUrl: string): boolean {
  if (provider.toLowerCase() === 'ollama') return true
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '')
    return hostname === 'localhost'
      || hostname.endsWith('.localhost')
      || hostname === '::1'
      || /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(hostname)
      || /^127(?:\.\d{1,3}){3}$/.test(hostname)
  } catch {
    return false
  }
}

export function resolveQaClientCachePolicy(args: {
  speed: boolean
  useCache: boolean
}): { answerUseCache: boolean; judgeUseCache: boolean } {
  return {
    answerUseCache: args.speed ? false : args.useCache,
    // Judge work happens after the answer timeline and uses a separate client.
    judgeUseCache: args.useCache,
  }
}

export function assertSpeedAnswerClient(client: Pick<StreamingLlmClient, 'cacheEnabled'>): void {
  if (client.cacheEnabled()) {
    throw new Error('speed mode requires the answer-client response cache to be disabled')
  }
}

export function assertStrongSpeedPolicy(args: {
  speed: boolean
  checkpointPath?: string
  client: Pick<StreamingLlmClient, 'cacheEnabled'>
}): void {
  if (!args.speed) return
  if (args.checkpointPath) {
    throw new Error('speed mode cannot use checkpointPath or resume checkpoint entries')
  }
  assertSpeedAnswerClient(args.client)
}

export function buildSpeedExecutionPolicy(args: BuildSpeedExecutionPolicyArgs): SpeedExecutionPolicy {
  const generationSettings: SpeedGenerationSettings = {
    temperature: 0,
    maxTokens: args.maxTokens,
    stop: args.stop,
  }
  const contract = buildSpeedRunContract({
    datasetFingerprint: args.evaluationContract.datasetFingerprint,
    executedQuestionIds: args.executedQuestionIds,
    provider: args.provider,
    model: args.model,
    baseUrl: args.baseUrl,
    retryAttempts: args.retryAttempts,
    answerSystemPrompt: args.answerSystemPrompt,
    generationSettings,
    environment: args.environment,
    localExecution: args.localExecution,
    env: args.env,
  })

  const answerClientOverrides: SpeedExecutionPolicy['answerClientOverrides'] = {
    useCache: false,
    retryAttempts: args.retryAttempts,
    maxTokens: args.maxTokens,
    temperature: generationSettings.temperature,
  }
  const now = () => performance.now()
  const runnerOptions: SpeedRunnerOptions = {
    contract,
    now,
  }

  return {
    answerClientOverrides,
    generationSettings,
    now,
    queryConcurrency: 1,
    contract,
    runnerOptions,
  }
}
