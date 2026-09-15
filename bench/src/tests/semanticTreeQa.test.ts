import { describe, it, expect, vi } from 'vitest'
import type { EvalSample, SemanticTreeParams } from '../types'
import type { IndexNode } from '../../../src/utils/pageIndex'

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: {},
  getDocument: vi.fn(),
}))

const { runQaTask } = await import('../runner/qa')
const { createSemanticTreeHook } = await import('../runner/semanticTreeQa')

function leaf(id: string, start: number, end: number): IndexNode {
  return { title: `S${id}`, nodeId: id, startPage: start, endPage: end, summary: '', nodes: [] }
}

const tree: IndexNode = {
  title: 'P', nodeId: 'root', startPage: 0, endPage: 0, summary: '',
  nodes: [leaf('0', 0, 0)],
}

const sample: EvalSample = {
  paperId: 'p1',
  title: 'Paper 1',
  pages: ['ATTENTION_IS_ALL_YOU_NEED_MARKER'],
  source: 'qasper',
  questions: [
    { id: 'p1#0', question: 'Q1?', answers: ['8'], evidencePages: [0], unanswerable: false },
  ],
}

/** 小到足以让单页文本恰好落进一个证据块，URL 断言不依赖默认分块参数。 */
const params: SemanticTreeParams = {
  evidence: { targetChars: 40, maxChars: 60, minChars: 20 },
  maxInputChars: 100_000,
}

const TREE_JSON = JSON.stringify({
  root: {
    id: 'r', label: '核心主张', description: '论文的中心结论', relationToParent: null,
    evidenceRefs: ['B001'],
    children: [{
      id: 'a1', label: '对齐机制', description: '支撑该主张的机制', relationToParent: 'constitutes',
      evidenceRefs: ['B001'], children: [],
    }],
  },
})

const baseTiming = {
  queryRewriteLatencyMs: 0,
  retrievalLatencyMs: 20,
  answerGenerationLatencyMs: 30,
  queryEndToEndLatencyMs: 50,
}

/** 统计型 fake client：complete 成功时计一次 miss，供 hook 算缓存差值。 */
function fakeClient(completion: () => Promise<string>) {
  let hits = 0
  let misses = 0
  return {
    complete: vi.fn(async () => {
      const out = await completion()
      misses++
      return out
    }),
    chat: vi.fn(),
    stats: () => ({ hits, misses }),
    latencies: () => [],
    requestTimings: () => [],
  }
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    buildIndex: vi.fn().mockResolvedValue(tree),
    runPipeline: vi.fn().mockResolvedValue({
      answer: '8',
      retrievals: [{
        context: 'CONTEXT_MARKER_9c2e',
        sources: ['Pages 1–1: S0'],
        selected: [leaf('0', 0, 0)],
        scores: [{ id: 0, score: 9 }],
        degraded: false,
        llmCalled: true,
        timing: baseTiming,
        semantic: {
          selectedNodeCount: 1,
          selectedNodeIds: ['a1'],
          evidenceBlockIds: ['B001'],
          expandedBlockIds: ['B001'],
          insufficientEvidence: false,
          routableNodeCount: 2,
        },
      }],
      retrievalQuery: 'Q1?',
      rewritten: false,
      context: 'CONTEXT_MARKER_9c2e',
      sources: ['Pages 1–1: S0'],
      llmCalls: 2,
      treeRouted: true,
      contextTruncated: false,
      timing: baseTiming,
    }),
    ...overrides,
  }
}

const baseArgs = {
  samples: [sample],
  config: { name: 'semantic-tree', kind: 'semantic-tree' as const },
  systemPrompt: 'sys',
  gitSha: 'sha',
  model: 'm',
}

describe('createSemanticTreeHook — 建树（§8.1 / §11.4）', () => {
  it('每篇论文恰好一次建树调用', async () => {
    const client = fakeClient(async () => TREE_JSON)
    const hook = createSemanticTreeHook({ params, client })
    await hook(sample)
    expect(client.complete).toHaveBeenCalledTimes(1)
  })

  it('返回可挂载到论文上的语义树与证据块', async () => {
    const client = fakeClient(async () => TREE_JSON)
    const hook = createSemanticTreeHook({ params, client })
    const out = await hook(sample)
    expect(out.semantic?.tree.root.label).toBe('核心主张')
    expect(out.semantic?.blocks).toHaveLength(1)
    expect(out.semantic?.blocks[0].id).toBe('B001')
  })

  it('记录建树耗时、输入输出 token 与缓存差', async () => {
    let clock = 1000
    const client = fakeClient(async () => TREE_JSON)
    const hook = createSemanticTreeHook({ params, client, now: () => (clock += 250) })
    const out = await hook(sample)
    expect(out.latencyMs).toBeGreaterThan(0)
    expect(out.inputTokens).toBeGreaterThan(0)
    expect(out.outputTokens).toBeGreaterThan(0)
    expect(out.cacheMisses).toBe(1)
    expect(out.failed).toBeUndefined()
  })

  it('模型输出非法时记 failed，不抛出、不返回半成品树', async () => {
    const client = fakeClient(async () => '不是 JSON')
    const hook = createSemanticTreeHook({ params, client })
    const out = await hook(sample)
    expect(out.failed).toBe(true)
    expect(out.semantic).toBeUndefined()
  })

  it('结构校验失败发生在模型已返回之后，这次调用的成本必须照记', async () => {
    const client = fakeClient(async () => JSON.stringify({
      root: { id: 'r', label: '根', description: 'd', relationToParent: null, evidenceRefs: ['B999'], children: [] },
    }))
    const hook = createSemanticTreeHook({ params, client })
    const out = await hook(sample)
    expect(out.failed).toBe(true)
    // 调用已经真发出去、输入 token 也已消耗，记成 0 会系统性低估失败方案的成本
    expect(out.llmCalls).toBe(1)
    expect(out.inputTokens).toBeGreaterThan(0)
    expect(out.outputTokens).toBeGreaterThan(0)
  })

  it('调用前就失败的场景（输入超限）不计任何调用成本', async () => {
    const client = fakeClient(async () => TREE_JSON)
    const hook = createSemanticTreeHook({
      params: { ...params, maxInputChars: 10 },
      client,
    })
    const out = await hook(sample)
    expect(out.failed).toBe(true)
    expect(out.llmCalls).toBe(0)
    expect(out.inputTokens).toBe(0)
    expect(client.complete).not.toHaveBeenCalled()
  })

  it('模型请求异常时记 failed，不抛出', async () => {
    const client = fakeClient(async () => { throw new Error('network down') })
    const hook = createSemanticTreeHook({ params, client })
    await expect(hook(sample)).resolves.toMatchObject({ failed: true })
  })

  it('引用不存在证据块的树整体作废', async () => {
    const client = fakeClient(async () => JSON.stringify({
      root: { id: 'r', label: '根', description: 'd', relationToParent: null, evidenceRefs: ['B999'], children: [] },
    }))
    const hook = createSemanticTreeHook({ params, client })
    const out = await hook(sample)
    expect(out.failed).toBe(true)
    expect(out.semantic).toBeUndefined()
  })
})

describe('runQaTask — 语义树模式（§11.2 / §11.4）', () => {
  const hookArgs = (deps: ReturnType<typeof makeDeps>, semanticTree: unknown) => ({
    ...baseArgs,
    client: fakeClient(async () => TREE_JSON) as never,
    deps: deps as never,
    semanticTree: semanticTree as never,
  })

  it('把语义树挂到论文上交给生产 RAG 管线', async () => {
    const deps = makeDeps()
    const hook = createSemanticTreeHook({ params, client: fakeClient(async () => TREE_JSON) })
    await runQaTask(hookArgs(deps, hook))

    const papers = deps.runPipeline.mock.calls[0][0]
    expect(papers[0].semantic.tree.root.label).toBe('核心主张')
    expect(papers[0].semantic.blocks[0].id).toBe('B001')
  })

  it('perPaper 写入树结构、覆盖率与建树成本诊断', async () => {
    const deps = makeDeps()
    const hook = createSemanticTreeHook({ params, client: fakeClient(async () => TREE_JSON) })
    const result = await runQaTask(hookArgs(deps, hook))

    const paper = result.perPaper![0]
    expect(paper).toMatchObject({
      evidenceBlockCount: 1,
      treeNodeCount: 2,
      treeDepth: 1,
      treeLevel1Count: 1,
      treeLevel2Count: 0,
      treeEvidenceCoverage: 1,
      treeBuildLlmCalls: 1,
      treeBuildFailed: 0,
    })
    expect(paper.treeBuildInputTokens).toBeGreaterThan(0)
    expect(paper.treeBuildOutputTokens).toBeGreaterThan(0)
    expect(paper.treeBuildLatencyMs).toBeGreaterThanOrEqual(0)
  })

  it('树诊断聚合为报表指标，含失败率与 P50/P95', async () => {
    const deps = makeDeps()
    const hook = createSemanticTreeHook({ params, client: fakeClient(async () => TREE_JSON) })
    const result = await runQaTask(hookArgs(deps, hook))

    expect(result.metrics.treeBuildFailureRate).toBe(0)
    expect(result.metrics.avgTreeNodeCount).toBe(2)
    expect(result.metrics.treeEvidenceCoverage).toBe(1)
    expect(result.metrics.treeBuildLatencyP50Ms).toEqual(expect.any(Number))
    expect(result.metrics.treeBuildLatencyP95Ms).toEqual(expect.any(Number))
    expect(result.meta.retrievalAlgorithm).toBe('semantic-tree')
  })

  it('逐问记录选中节点数与树是否被使用', async () => {
    const deps = makeDeps()
    const hook = createSemanticTreeHook({ params, client: fakeClient(async () => TREE_JSON) })
    const result = await runQaTask(hookArgs(deps, hook))

    expect(result.perSample[0].metrics).toMatchObject({
      treeUsed: 1,
      treeDegraded: 0,
      selectedNodeCount: 1,
      routableNodeCount: 2,
    })
    expect(result.metrics.treeUsedRate).toBe(1)
    expect(result.metrics.selectedNodeCount).toBe(1)
  })

  it('建树失败时仍完成评测：该篇回落平面路径且失败率如实记录', async () => {
    const deps = makeDeps({
      runPipeline: vi.fn().mockResolvedValue({
        answer: '8',
        retrievals: [{
          context: 'FLAT_CONTEXT',
          sources: ['Pages 1–1: S0'],
          selected: [leaf('0', 0, 0)],
          scores: [{ id: 0, score: 9 }],
          degraded: false,
          llmCalled: true,
          timing: baseTiming,
        }],
        retrievalQuery: 'Q1?', rewritten: false, context: 'FLAT_CONTEXT',
        sources: ['Pages 1–1: S0'], llmCalls: 2, treeRouted: false,
        contextTruncated: false, timing: baseTiming,
      }),
    })
    const hook = createSemanticTreeHook({ params, client: fakeClient(async () => '不是 JSON') })
    const result = await runQaTask(hookArgs(deps, hook))

    expect(deps.runPipeline.mock.calls[0][0][0].semantic).toBeUndefined()
    expect(result.errors).toHaveLength(0)
    expect(result.perPaper![0].treeBuildFailed).toBe(1)
    expect(result.metrics.treeBuildFailureRate).toBe(1)
    expect(result.perSample[0].metrics.treeUsed).toBe(0)
    expect(result.perSample[0].metrics.treeDegraded).toBe(1)
  })

  it('路由本身失败时 treeDegraded 必须记 1，不能因为根节点有证据就算成功', async () => {
    const deps = makeDeps({
      runPipeline: vi.fn().mockResolvedValue({
        answer: '8',
        retrievals: [{
          context: 'ROOT_CONTEXT',
          sources: ['Pages 1–1: 核心主张'],
          selected: [leaf('0', 0, 0)],
          // 打分 JSON 解析失败：pipeline 已降级，但 semantic.insufficientEvidence 仍是 false
          scores: [],
          degraded: true,
          degradedReason: 'invalid-json',
          llmCalled: true,
          timing: baseTiming,
          semantic: {
            selectedNodeCount: 1,
            selectedNodeIds: ['r'],
            evidenceBlockIds: ['B001'],
            expandedBlockIds: ['B001'],
            insufficientEvidence: false,
            routableNodeCount: 2,
            usedFlatFallback: false,
            droppedBlockCount: 0,
          },
        }],
        retrievalQuery: 'Q1?', rewritten: false, context: 'ROOT_CONTEXT',
        sources: ['Pages 1–1: 核心主张'], llmCalls: 2, treeRouted: true,
        contextTruncated: false, timing: baseTiming,
      }),
    })
    const hook = createSemanticTreeHook({ params, client: fakeClient(async () => TREE_JSON) })
    const result = await runQaTask(hookArgs(deps, hook))

    expect(result.perSample[0].metrics.treeUsed).toBe(1)
    expect(result.perSample[0].metrics.treeDegraded).toBe(1)
    expect(result.metrics.treeDegradationRate).toBe(1)
  })

  it('树取证失败但已在同一次调用里回落平面时，同样计入降级', async () => {
    const deps = makeDeps({
      runPipeline: vi.fn().mockResolvedValue({
        answer: '8',
        retrievals: [{
          context: 'FLAT_CONTEXT',
          sources: ['Pages 1–1: S0'],
          selected: [leaf('0', 0, 0)],
          scores: [{ id: 0, score: 9 }],
          degraded: false,
          llmCalled: true,
          timing: baseTiming,
          semantic: {
            selectedNodeCount: 0,
            selectedNodeIds: [],
            evidenceBlockIds: [],
            expandedBlockIds: [],
            insufficientEvidence: true,
            routableNodeCount: 2,
            usedFlatFallback: true,
            droppedBlockCount: 0,
          },
        }],
        retrievalQuery: 'Q1?', rewritten: false, context: 'FLAT_CONTEXT',
        sources: ['Pages 1–1: S0'], llmCalls: 2, treeRouted: true,
        contextTruncated: false, timing: baseTiming,
      }),
    })
    const hook = createSemanticTreeHook({ params, client: fakeClient(async () => TREE_JSON) })
    const result = await runQaTask(hookArgs(deps, hook))

    expect(result.perSample[0].metrics.treeDegraded).toBe(1)
    // 回落用的平面打分与平面路径同域，MRR 仍然成立
    expect(result.perSample[0].metrics.mrr).toBe(1)
  })

  it('未提供 hook 时不产生任何树诊断字段', async () => {
    const deps = makeDeps()
    const result = await runQaTask({ ...baseArgs, client: fakeClient(async () => TREE_JSON) as never, deps: deps as never })

    expect(result.perPaper![0].treeNodeCount).toBeUndefined()
    expect(result.metrics.treeBuildFailureRate).toBeUndefined()
    expect(result.meta.retrievalAlgorithm).toBe('papermind-llm')
  })
})
