import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runHybridRerankQaTask } from '../runner/hybridRerankQa'
import { runLongSectionQaTask } from '../runner/longSectionQa'
import type { LlmClient } from '../llmClient'

const client: LlmClient = {
  complete: async () => '', chat: async () => '', stats: () => ({ hits: 0, misses: 0 }), latencies: () => [], requestTimings: () => [],
}

const hybridConfig = {
  name: 'hybrid-rerank', kind: 'hybrid-rerank' as const,
  chunking: { tokenizer: 'bge-m3' as const, chunkSize: 4, overlap: 1 },
  retrieval: {
    bm25: { topK: 3, k1: 1.2, b: 0.75 },
    dense: { topK: 3, embedding: { model: 'BAAI/bge-m3', revision: 'main', queryPrefix: '', normalize: true as const, maxLength: 8192 } },
    rrf: { k: 60, topK: 4 },
    reranker: { model: 'test/reranker', revision: 'main', topK: 3, maxLength: 512 },
  },
  generationContext: { topK: 2, maxTokens: 16 },
}

const longConfig = {
  name: 'long-section-rag', kind: 'long-section-rag' as const,
  anchors: { tokenizer: 'bge-m3' as const, chunkSize: 4, overlap: 1 },
  retrieval: { algorithm: 'bm25' as const, topK: 3, k1: 1.2, b: 0.75 },
  generationContext: { topK: 1, maxTokens: 8 },
}

const sample = {
  paperId: 'p', title: 'p', source: 'smoke' as const,
  pages: [
    'alpha beta gamma delta\nepsilon zeta eta theta',
    'iota kappa lambda mu\nnu xi omicron pi',
  ],
  questions: [
    { id: 'q1', question: 'alpha', answers: ['x'], evidencePages: [0], unanswerable: false },
    { id: 'q2', question: 'zeta', answers: ['y'], evidencePages: [0, 1], unanswerable: false },
  ],
}

describe('hybrid-rerank runner', () => {
  const deps = {
    tokenizer: { tokenize: (text: string) => text.split(/\s+/).filter(Boolean).map(w => `▁${w}`) },
    // dense 返回固定打分：与 BM25 召回相交可验证 RRF 去重与融合次序
    denseProvider: { embed: async (texts: string[]) => texts.map((_, i) => [1, i, 0]) },
    reranker: { score: async (pairs: Array<{ query: string; document: string }>) => pairs.map(p => -p.document.length) },
  }

  it('propagates page spans, respects token budget and computes MRR on the full final ordering', async () => {
    const result = await runHybridRerankQaTask({
      samples: [sample], config: hybridConfig, client, systemPrompt: 's', gitSha: 'x', model: 'm', deps,
      generateAnswer: async (_system, question) => `ans:${question}`,
    })
    expect(result.meta.retrievalAlgorithm).toBe('hybrid-rerank')
    expect(result.meta.baselineFamily).toBe('strong')
    expect(result.meta.candidateGranularity).toContain('4-token')
    expect(result.errors).toEqual([])
    expect(result.perSample).toHaveLength(2)
    for (const record of result.perSample) {
      expect(record.selectedPages!.every(p => p >= 0 && p <= 1)).toBe(true)
      expect(record.metrics.mrr).toBeDefined()
    }
    // 指标样本数在聚合层：MRR 有 2 个有效观测
    expect(result.metrics.mrrSampleCount).toBe(2)
    // 每问恰好 1 次生成调用；索引阶段 0 次 LLM 调用
    expect(result.perSample.every(r => r.metrics.llmCalls === 1)).toBe(true)
    expect(result.perPaper!.every(p => p.indexLlmCalls === 0 && p.leafCount === result.perPaper![0].leafCount)).toBe(true)
  })

  it('records rerank failures as retrieve errors instead of silently falling back', async () => {
    const result = await runHybridRerankQaTask({
      samples: [sample], config: hybridConfig, client, systemPrompt: 's', gitSha: 'x', model: 'm',
      deps: { ...deps, reranker: { score: async () => { throw new Error('reranker exploded') } } },
      generateAnswer: async () => 'a',
    })
    expect(result.errors).toHaveLength(2)
    expect(result.errors.every(e => e.stage === 'retrieve' && e.message.startsWith('rerank 失败：reranker exploded'))).toBe(true)
    expect(result.perSample).toHaveLength(0)
  })

  it('stops adding candidates that would exceed the token budget', async () => {
    // maxTokens=3：4-token 段一进来就超预算 → 只选 1 段（不截断单个候选）
    const result = await runHybridRerankQaTask({
      samples: [sample], config: { ...hybridConfig, generationContext: { topK: 2, maxTokens: 3 } }, client, systemPrompt: 's', gitSha: 'x', model: 'm', deps,
      generateAnswer: async () => 'a',
    })
    for (const record of result.perSample) expect(record.metrics.contextTokens).toBeLessThanOrEqual(3)
  })
})

describe('long-section-rag runner', () => {
  const tokenizer = { tokenize: (text: string) => text.split(/\s+/).filter(Boolean).map(w => `▁${w}`) }
  // 手工章节：页 0 一节，页 1 一节
  const deps = {
    tokenizer,
    detectSections: () => [
      { title: 'A', startToken: 0, endToken: 8, startPage: 0, endPage: 0 },
      { title: 'B', startToken: 8, endToken: 16, startPage: 1, endPage: 1 },
    ],
  }

  it('returns one contiguous region as the single context unit and maps all covered pages', async () => {
    const result = await runLongSectionQaTask({
      samples: [sample], config: longConfig, client, systemPrompt: 's', gitSha: 'x', model: 'm', deps,
      generateAnswer: async (_system, question) => `ans:${question}`,
    })
    expect(result.meta.retrievalAlgorithm).toBe('long-section-rag')
    expect(result.meta.candidateGranularity).toBe('contiguous section region')
    expect(result.errors).toEqual([])
    for (const record of result.perSample) {
      // 连续区域是单一上下文单元；token 预算由 runner 内部断言（tokenCount 口径），
      // metrics.contextTokens 是字符/4 的成本代理，与预算不同量纲，不做比较
      expect(record.selectedPages).toHaveLength(1)
      expect(record.selectedPages![0]).toBe(0)
      expect(record.metrics.contextTokens).toBeGreaterThan(0)
    }
  })

  it('never crosses section boundaries even when the budget is huge', async () => {
    const result = await runLongSectionQaTask({
      samples: [sample], config: { ...longConfig, generationContext: { topK: 1, maxTokens: 4096 } }, client, systemPrompt: 's', gitSha: 'x', model: 'm', deps,
      generateAnswer: async () => 'a',
    })
    // 区域不能同时覆盖两页（章节边界即页边界）
    expect(result.perSample.every(r => r.selectedPages!.length === 1)).toBe(true)
  })

  it('falls back to the next ranked anchor deterministically when the best has no region', async () => {
    // 两锚点 BM25 同分（各含 1 次 zirconium）→ id 序：锚点 0 首位。
    // 注入的 detectSections 只覆盖页 1（token [2,6)）：锚点 0 起点在页 0 无章节，
    // 回退到锚点 1（起点 token 3 在页 1 章节内）
    const fallbackSample = {
      paperId: 'p2', title: 'p2', source: 'smoke' as const,
      pages: ['zirconium alpha', 'beta gamma delta epsilon'],
      questions: [{ id: 'qz', question: 'zirconium', answers: ['x'], evidencePages: [1], unanswerable: false }],
    }
    let calls = 0
    const result = await runLongSectionQaTask({
      samples: [fallbackSample], config: longConfig, client, systemPrompt: 's', gitSha: 'x', model: 'm',
      deps: { ...deps, detectSections: () => { calls++; return [{ title: 'B', startToken: 2, endToken: 6, startPage: 1, endPage: 1 }] } },
      generateAnswer: async () => 'a',
    })
    expect(calls).toBeGreaterThan(0)
    // 首选锚点无区域 → 回退到后续锚点（页 1 章节），证据页 1 被完整覆盖
    expect(result.perSample).toHaveLength(1)
    expect(result.perSample[0].selectedPages).toEqual([1])
    expect(result.metrics.evidenceRecall).toBe(1)
  })

  it('records a retrieve error when no anchor resolves', async () => {
    const result = await runLongSectionQaTask({
      samples: [sample], config: longConfig, client, systemPrompt: 's', gitSha: 'x', model: 'm',
      deps: { ...deps, detectSections: () => [] },
      generateAnswer: async () => 'a',
    })
    expect(result.errors.every(e => e.stage === 'retrieve' && e.message.includes('无法解析'))).toBe(true)
    expect(result.perSample).toHaveLength(0)
  })

  it('resumes completed questions from an atomic checkpoint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'strong-checkpoint-'))
    const checkpointPath = join(dir, 'long.json')
    try {
      const firstCalls: string[] = []
      const first = await runLongSectionQaTask({
        samples: [sample], config: longConfig, client, systemPrompt: 's', gitSha: 'x', model: 'm', deps,
        checkpointPath,
        generateAnswer: async (_system, question) => {
          firstCalls.push(question)
          if (question === 'zeta') throw new Error('temporary failure')
          return `ans:${question}`
        },
      })
      expect(first.perSample.map(record => record.id)).toEqual(['q1'])
      expect(first.errors).toHaveLength(1)

      const resumedCalls: string[] = []
      const progress: string[] = []
      const resumed = await runLongSectionQaTask({
        samples: [sample], config: longConfig, client, systemPrompt: 's', gitSha: 'x', model: 'm', deps,
        checkpointPath,
        onProgress: event => progress.push(`${event.status}:${event.sampleId}`),
        generateAnswer: async (_system, question) => {
          resumedCalls.push(question)
          return `ans:${question}`
        },
      })
      expect(firstCalls).toEqual(['alpha', 'zeta'])
      expect(resumedCalls).toEqual(['zeta'])
      expect(progress).toContain('resumed:q1')
      expect(resumed.perSample.map(record => record.id)).toEqual(['q1', 'q2'])
      expect(resumed.errors).toEqual([])
      expect(resumed.meta.completed).toBe(2)
      expect(resumed.meta.total).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
