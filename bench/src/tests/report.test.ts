import { describe, it, expect } from 'vitest'
import type { BenchResult } from '../types'
import { renderReport, renderComparison, fmtDuration } from '../report'

function result(name: string, metrics: Record<string, number>, over: Partial<BenchResult> = {}): BenchResult {
  return {
    task: 'qa',
    config: { name },
    meta: {
      model: 'gpt-4o', timestamp: '2026-09-02T12:00:00.000Z', gitSha: 'abc1234',
      completed: 10, total: 10,
    },
    metrics,
    perSample: [],
    errors: [],
    ...over,
  }
}

describe('renderReport', () => {
  it('单结果渲染为含指标的 Markdown', () => {
    const md = renderReport([result('default', { evidenceRecall: 0.71, answerF1: 0.43 })])
    expect(md).toContain('| default |')
    expect(md).toContain('0.710')
    expect(md).toContain('evidenceRecall')
    expect(md).toContain('gpt-4o')
    expect(md).toContain('abc1234')
  })

  it('多结果一行一组配置，并标出主指标最优行', () => {
    const md = renderReport([
      result('topK=1', { evidenceRecall: 0.6 }),
      result('topK=2', { evidenceRecall: 0.8 }),
      result('topK=3', { evidenceRecall: 0.7 }),
    ])
    const bestLine = md.split('\n').find(l => l.includes('topK=2'))
    expect(bestLine).toContain('**')
  })

  it('打印 completed/total，让部分失败可见', () => {
    const md = renderReport([
      result('default', { evidenceRecall: 0.7 }, {
        meta: {
          model: 'gpt-4o', timestamp: '2026-09-02T12:00:00.000Z', gitSha: 'abc1234',
          completed: 95, total: 100,
        },
      }),
    ])
    expect(md).toContain('95/100')
  })

  it('有错误时列出按阶段的计数', () => {
    const md = renderReport([
      result('default', { evidenceRecall: 0.7 }, {
        errors: [
          { sampleId: 'a', stage: 'generate', message: 'timeout' },
          { sampleId: 'b', stage: 'generate', message: 'timeout' },
          { sampleId: 'c', stage: 'index', message: 'bad pdf' },
        ],
      }),
    ])
    expect(md).toContain('generate')
    expect(md).toContain('2')
    expect(md).toContain('index')
  })

  it('同配置同阶段的错误聚合为一行', () => {
    const md = renderReport([
      result('default', { evidenceRecall: 0.7 }, {
        errors: [
          { sampleId: 'a', stage: 'generate', message: 'timeout' },
          { sampleId: 'b', stage: 'generate', message: 'timeout' },
          { sampleId: 'c', stage: 'index', message: 'bad pdf' },
        ],
      }),
    ])
    expect(md).toContain('| default | generate | 2 | timeout |')
    expect(md).toContain('| default | index | 1 | bad pdf |')
  })

  it('空结果列表返回提示而非崩溃', () => {
    expect(renderReport([])).toContain('无结果')
  })

  it('unanswerableMethod 存在时在报表中标注口径', () => {
    const md = renderReport([
      result('default', { unanswerableAccuracy: 0.3 }, {
        meta: {
          model: 'gpt-4o', timestamp: '2026-09-02T12:00:00.000Z', gitSha: 'abc1234',
          completed: 10, total: 10, unanswerableMethod: 'pattern',
        },
      }),
    ])
    expect(md).toContain('pattern')
  })

  it('pattern 口径时打印拒答模式表版本，judge 口径不打印', () => {
    const base = { model: 'gpt-4o', timestamp: '2026-09-02T12:00:00.000Z', gitSha: 'abc1234', completed: 10, total: 10 }
    const pattern = renderReport([
      result('default', { unanswerableAccuracy: 0.3 }, { meta: { ...base, unanswerableMethod: 'pattern' } }),
    ])
    expect(pattern).toContain('拒答模式表版本')
    expect(pattern).toContain('v1')
    const judge = renderReport([
      result('default', { unanswerableAccuracy: 0.3 }, { meta: { ...base, unanswerableMethod: 'judge' } }),
    ])
    expect(judge).not.toContain('拒答模式表版本')
    const none = renderReport([result('default', { evidenceRecall: 0.7 })])
    expect(none).not.toContain('拒答模式表版本')
  })
})

describe('renderComparison', () => {
  it('输出指标差值与方向', () => {
    const md = renderComparison(
      result('before', { evidenceRecall: 0.6, answerF1: 0.5 }),
      result('after', { evidenceRecall: 0.8, answerF1: 0.4 }),
    )
    expect(md).toContain('evidenceRecall')
    expect(md).toContain('+0.200')
    expect(md).toContain('-0.100')
  })

  it('只在一侧出现的指标也列出', () => {
    const md = renderComparison(
      result('before', { evidenceRecall: 0.6 }),
      result('after', { mrr: 0.9 }),
    )
    expect(md).toContain('mrr')
  })

  it('时延字段标注越低越好', () => {
    const md = renderComparison(
      result('before', { retrievalLatencyP50Ms: 100 }),
      result('after', { retrievalLatencyP50Ms: 80 }),
    )
    expect(md).toContain('时延字段')
    expect(md).toContain('越低越好')
  })
})

describe('fmtDuration', () => {
  it('毫秒级显示 N ms', () => {
    expect(fmtDuration(500)).toBe('500 ms')
  })
  it('秒级显示 x.xx s', () => {
    expect(fmtDuration(1500)).toBe('1.50 s')
  })
  it('分钟级显示 Xm Ys', () => {
    expect(fmtDuration(1_750_000)).toBe('29m 10s')
  })
  it('非法值渲染为 —', () => {
    expect(fmtDuration(NaN)).toBe('—')
    expect(fmtDuration(-1)).toBe('—')
  })
})

describe('renderReport 耗时与缓存', () => {
  function timedResult(name: string, over: Partial<BenchResult> = {}): BenchResult {
    return {
      task: 'qa',
      config: { name },
      meta: {
        model: 'gpt-4o', timestamp: '2026-09-05T10:00:00.000Z', gitSha: 'abc1234',
        completed: 10, total: 10,
        startedAt: '2026-09-05T09:30:00.000Z',
        finishedAt: '2026-09-05T10:00:00.000Z',
        runWallClockMs: 1_750_000,
        cacheHits: 125, cacheMisses: 269, cacheHitRate: 0.317,
      },
      metrics: {
        evidenceRecall: 0.7,
        indexBuildLatencyP50Ms: 3200, indexBuildLatencyP95Ms: 8100,
        retrievalLatencyP50Ms: 900, retrievalLatencyP95Ms: 3000,
        answerGenerationLatencyP50Ms: 3500, answerGenerationLatencyP95Ms: 9000,
        queryEndToEndLatencyP50Ms: 4700, queryEndToEndLatencyP95Ms: 11200,
        llmNetworkLatencyP50Ms: 3500, llmNetworkLatencyP95Ms: 9000,
      },
      perSample: [],
      errors: [],
      ...over,
    }
  }

  it('单结果输出「耗时与缓存」区块，含 wall-clock、缓存行与时延表', () => {
    const md = renderReport([timedResult('default')])
    expect(md).toContain('### 耗时与缓存')
    expect(md).toContain('整轮 wall-clock 29m 10s')
    expect(md).toContain('125 hits / 394 requests')
    expect(md).toContain('31.7%')
    expect(md).toContain('索引 P50/P95')
    expect(md).toContain('3.20 s / 8.10 s')
    expect(md).toContain('900 ms / 3.00 s')
    expect(md).toContain('4.70 s / 11.20 s')
  })

  it('矩阵结果每个配置一行，含 per-config wall-clock', () => {
    const md = renderReport([
      timedResult('a', { meta: { ...timedResult('a').meta, runWallClockMs: 600_000 } }),
      timedResult('b'),
    ])
    expect(md).toContain('- **a**：运行区间')
    expect(md).toContain('10m 0s')
    expect(md).toContain('| a |')
    expect(md).toContain('| b |')
  })

  it('启用 judge 时缓存标注为 RAG 缓存，避免被误读为整轮全部流量', () => {
    const md = renderReport([
      timedResult('default', { meta: { ...timedResult('default').meta, cacheScope: 'rag' as const } }),
    ])
    // 前缀从「缓存」替换为「RAG 缓存」；数值子串两者都有，断言否定需针对旧前缀整体
    expect(md).toContain('RAG 缓存 125 hits / 394 requests（31.7%）')
    expect(md).not.toContain('，缓存 125 hits')
  })

  it('无完成题或字段缺失时渲染 —，而非 0 ms', () => {
    // completed=0 时 withPercentiles 从空数组不产生字段，报表必须渲染 — 而非 0 ms
    const empty = timedResult('empty', {
      meta: { ...timedResult('empty').meta, completed: 0, total: 5 },
      metrics: { evidenceRecall: 0 },
    })
    const md = renderReport([empty])
    expect(md).toContain('| empty | — | — | — | — | — |')
  })

  it('旧 JSON（无新 meta/perPaper）仍可渲染且不抛错', () => {
    const old = result('legacy', { evidenceRecall: 0.7 })
    const md = renderReport([old])
    expect(md).toContain('legacy')
    expect(md).not.toContain('### 耗时与缓存')
  })

  it('summary 结果不渲染耗时区块（HF 摘要无时延元数据）', () => {
    const summary: BenchResult = {
      task: 'summary',
      config: { name: 'default' },
      meta: { model: 't5', timestamp: '2026-09-05T10:00:00.000Z', gitSha: 'x', completed: 3, total: 3 },
      metrics: { rougeL: 0.3 },
      perSample: [],
      errors: [],
    }
    expect(renderReport([summary])).not.toContain('### 耗时与缓存')
  })
})

describe('renderReport — 语义树诊断区块（§11.4）', () => {
  const treeResult = (metrics: Record<string, number>) => result('semantic-tree', metrics, {
    config: { name: 'semantic-tree', kind: 'semantic-tree' },
    meta: {
      model: 'gpt-4o', timestamp: '2026-09-15T12:00:00.000Z', gitSha: 'abc1234',
      completed: 10, total: 10, retrievalAlgorithm: 'semantic-tree',
    },
  })

  const treeMetrics = {
    evidenceRecall: 0.9,
    treeBuildFailureRate: 0.05,
    avgTreeNodeCount: 12.5,
    avgTreeDepth: 2,
    avgTreeLevel1Count: 3.5,
    avgTreeLevel2Count: 8,
    treeEvidenceCoverage: 0.82,
    treeSharedBlockRate: 0.16,
    treeCrossSectionNodeRate: 0.33,
    treeBuildLatencyP50Ms: 4200,
    treeBuildLatencyP95Ms: 9000,
    avgTreeBuildInputTokens: 41000,
    avgTreeBuildOutputTokens: 1200,
    treeUsedRate: 0.94,
    treeDegradationRate: 0.06,
    selectedNodeCount: 1.7,
  }

  it('有树指标时渲染诊断表，覆盖结构、成本与降级', () => {
    const md = renderReport([treeResult(treeMetrics)])
    expect(md).toContain('### 语义树诊断')
    expect(md).toContain('12.500')          // 平均节点数
    expect(md).toContain('5%')              // 建树失败率
    expect(md).toContain('4.20 s / 9.00 s') // 建树 P50/P95
    expect(md).toContain('0.820')           // 证据块覆盖率
    expect(md).toContain('94%')             // 树使用率
    expect(md).toContain('41.0k')           // 平均建树输入 token
  })

  it('无树结果时不渲染该区块（不污染既有基线报表）', () => {
    const md = renderReport([result('default', { evidenceRecall: 0.7 })])
    expect(md).not.toContain('### 语义树诊断')
  })
})
