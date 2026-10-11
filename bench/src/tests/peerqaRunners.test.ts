import { describe, expect, it, vi } from 'vitest'
import { normalizePeerQa } from '../datasets/peerqa'
import { buildEvaluationContract } from '../evaluationContract'
import { buildSpeedRunContract } from '../speed/contract'
import { materializeContext, type ContextGroup } from '../../../src/utils/contextTrace'
import type { IndexNode } from '../../../src/utils/pageIndex'
import type { StreamingLlmClient } from '../llmClient'
import type { BenchResult, TraditionalRagConfig } from '../types'

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ GlobalWorkerOptions: {}, getDocument: vi.fn() }))
const { runQaTask } = await import('../runner/qa')
const { runTraditionalRagQaTask } = await import('../runner/traditionalRagQa')
const { runStrongBaselineQaTask } = await import('../runner/strongBaselineQa')
const { runFullContextQaTask } = await import('../runner/fullContextQa')

const sample = () => normalizePeerQa(Array.from({ length: 5 }, (_, i) => ({
  paper_id: 'p', question_id: `q${i}`, question: `Question ${i}`, answerable: true,
  answer_evidence_mapped: [{ idx: [0, 1] }], answer_free_form: 'Alpha result.',
})), [
  { paper_id: 'p', idx: 0, pidx: 0, sidx: 0, type: 'sentence', content: 'Alpha result.' },
  { paper_id: 'p', idx: 1, pidx: 0, sidx: 1, type: 'sentence', content: 'Beta conclusion!' },
]).samples[0]
const tree: IndexNode = { title: 'p', nodeId: 'root', startPage: 0, endPage: 0, summary: '', nodes: [] }
const traditional: TraditionalRagConfig = {
  name: 'traditional', kind: 'traditional-rag', chunking: { tokenizer: 'bge-m3', chunkSize: 16, overlap: 0 },
  retrieval: { algorithm: 'jaccard', topK: 1 }, generationContext: { topK: 1, maxTokens: 4096 },
}

async function run(kind: 'papermind' | 'traditional' | 'strong' | 'full', indexFailure: boolean | 'retrieve' = false, trace = true): Promise<{ result: BenchResult; prompts: string[] }> {
  const input = sample()
  const evaluationContract = { ...buildEvaluationContract([input]), contextBudgetTokens: 17, contextTokenizer: 'test-char' }
  let clock = 0
  let tokens = 0
  const prompts: string[] = []
  const client: StreamingLlmClient = {
    complete: async () => '[]', chat: async () => 'Alpha result.',
    stats: () => ({ hits: 0, misses: 0 }), latencies: () => [], requestTimings: () => [],
    tokenSnapshot: () => ({ totalTokens: tokens, incompleteRequestCount: 0 }),
    cacheEnabled: () => false,
    chatStream: async (messages, onText) => {
      prompts.push(messages[0].content)
      const i = Number(messages.at(-1)!.content.match(/Question (\d)/)![1])
      clock += [10, 30, 999, 20, 60][i]
      onText('')
      onText('Alpha')
      if (i === 2) throw new Error('stream timeout')
      clock += (i + 1) * 20
      onText(' result.')
      tokens += 10
      return { content: 'Alpha result.' }
    },
  }
  const speed = {
    contract: buildSpeedRunContract({ datasetFingerprint: evaluationContract.datasetFingerprint, executedQuestionIds: input.questions.map(q => q.id),
      provider: 'openai', model: 'mock', baseUrl: 'https://mock.invalid/v1', retryAttempts: 0, answerSystemPrompt: 'system',
      generationSettings: { temperature: 0 }, environment: { platform: 'test', arch: 'test', nodeVersion: 'test' } }),
    now: () => clock,
  }
  const common = { samples: [input], client, systemPrompt: 'system', gitSha: 'test', model: 'mock', now: () => clock, speed }
  const materialize = (groups: ContextGroup[]) => {
    if (indexFailure === 'retrieve') throw new Error('context unavailable')
    clock += 5
    return materializeContext(groups, { tokenize: text => [...text] }, 17, trace)
  }
  const build = async () => {
    clock += 1000
    if (indexFailure === true) throw new Error('index unavailable')
    return tree
  }
  let result: BenchResult
  if (kind === 'papermind') result = await runQaTask({ ...common, config: { name: kind }, materialize, evaluationContract, deps: { buildIndex: build } })
  else if (kind === 'traditional') result = await runTraditionalRagQaTask({ ...common, config: traditional, materialize, evaluationContract,
    deps: { tokenizer: { tokenize: text => text ? [text] : [] }, buildRetriever: async chunks => {
      await build()
      return { chunks, score: async () => [{ id: 0, score: 1 }] }
    } } })
  else if (kind === 'strong') result = await runStrongBaselineQaTask({ ...common, materialize, evaluationContract, llmEndpointIdentity: 'mock', systemPromptHash: 'system',
    meta: { config: { name: kind }, retrievalAlgorithm: 'long-section-rag', baselineFamily: 'strong' },
    retrieval: { granularity: 'paragraph', build: async () => {
      await build()
      return { leafCount: 1, retrieve: async () => ({ contextGroups: [{ pieces: [{ page: 0, text: input.pages[0] }] }] }) }
    } } })
  else result = await runFullContextQaTask({ ...common, config: { name: kind } })
  return { result, prompts }
}

describe('PeerQA runner source and streaming integration', () => {
  it.each(['papermind', 'traditional', 'strong'] as const)('%s scores only final emitted sentences and keeps retrieval on generation failure', async kind => {
    const { result, prompts } = await run(kind)
    expect(prompts).toHaveLength(5)
    for (const prompt of prompts) {
      expect(prompt).toContain('Alpha result. Bet')
      expect(prompt).not.toContain('Beta conclusion!')
      expect(prompt).not.toContain('evidenceSentenceIds')
    }
    expect(result.metrics.sentenceEvidenceRecall).toBe(0.5)
    expect(result.metrics.sentenceEvidenceRecallSampleCount).toBe(5)
    expect(result.perSample[2].contextSentenceIds).toEqual(['p/0/0'])
    expect(result.perSample[2].generationStatus).toBe('failed')
    expect(result.metrics.peerqaRougeL).toBe(0.8)
    expect(result.metrics.speedSampleCount).toBe(4)
    expect(result.meta.completedSpeedQuestionCount).toBe(4)
    expect(result.metrics.timeToFirstTokenP50Ms).toBe(25)
    expect(result.metrics.timeToFirstTokenP95Ms).toBe(65)
    expect(result.metrics.fullAnswerLatencyP50Ms).toBe(75)
    expect(result.metrics.fullAnswerLatencyP95Ms).toBe(165)
    expect(result.perSample[2].speed?.fullAnswerLatencyMs).toBeUndefined()
  })

  it.each(['papermind', 'traditional', 'strong'] as const)('%s retains index failures as zero observations', async kind => {
    const { result, prompts } = await run(kind, true)
    expect(prompts).toHaveLength(0)
    expect(result.metrics.sentenceEvidenceRecallSampleCount).toBe(5)
    expect(result.metrics.sentenceEvidenceRecall).toBe(0)
    expect(result.metrics.peerqaRougeL).toBe(0)
    expect(result.metrics.speedSampleCount).toBe(0)
    expect(result.metrics.timeToFirstTokenP50Ms).toBeUndefined()
  })

  it.each(['papermind', 'traditional', 'strong'] as const)('%s makes missing provenance fatal instead of a retrieval miss', async kind => {
    await expect(run(kind, false, false)).rejects.toThrow(/provenance/)
  })

  it.each(['papermind', 'traditional', 'strong'] as const)('%s retains retrieval failures in the frozen sentence denominator', async kind => {
    const { result } = await run(kind, 'retrieve')
    expect(result.metrics.sentenceEvidenceRecallSampleCount).toBe(5)
    expect(result.metrics.sentenceEvidenceRecall).toBe(0)
    expect(result.errors.filter(error => error.stage === 'retrieve')).toHaveLength(5)
    expect(result.metrics.speedSampleCount).toBe(0)
  })

  it('full context has answer quality and latency but no sentence retrieval rank', async () => {
    const { result, prompts } = await run('full')
    expect(prompts[0]).toContain('Beta conclusion!')
    expect(result.metrics.sentenceEvidenceRecall).toBeUndefined()
    expect(result.meta.comparisonEligible).toBe(false)
    expect(result.metrics.peerqaRougeL).toBe(0.8)
    expect(result.metrics.timeToFirstTokenP50Ms).toBe(20)
    expect(result.metrics.timeToFirstTokenP95Ms).toBe(60)
    expect(result.metrics.fullAnswerLatencyP50Ms).toBe(70)
    expect(result.metrics.fullAnswerLatencyP95Ms).toBe(160)
  })
})
