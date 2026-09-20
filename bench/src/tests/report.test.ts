import { describe, it, expect } from 'vitest'
import type { BenchResult, PerSampleRecord } from '../types'
import {
  renderReport, renderComparison, fmtDuration, partitionResults,
  retrievalComparisonIssues,
  RETRIEVAL_SECTION_METRICS, RETRIEVAL_EXEMPT_METRICS, TIMING_SECTION_METRICS, TREE_SECTION_METRICS,
} from '../report'
import { REFUSAL_PATTERN_VERSION } from '../metrics/answerF1'

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

/** schema-v2 完整契约身份：门禁通过的最低标准，任一字段缺失/不一致都会被拒。 */
const SCHEMA_V2_META: Partial<BenchResult['meta']> = {
  metricSchemaVersion: 2,
  mrrDefinition: 'context-page-v1',
  contextBudgetTokens: 4096,
  contextTokenizer: 'BAAI/bge-m3',
  contextTokenizerRevision: 'main',
  evidenceMappingVersion: 'page-evidence-v1',
  datasetFingerprint: 'dataset-a',
  eligibleRetrievalQuestionIdsHash: 'eligible-a',
  comparisonEligible: true,
}

const SCHEMA_V2_METRICS: Record<string, number> = {
  contextPageMrr: 0.5,
  contextPageMrrSampleCount: 122,
  contextPageMrrEligibleCount: 122,
  evidenceRecall: 0.6,
  evidenceHitRate: 0.7,
  contextPrecision: 0.4,
}

function schemaV2Result(
  name: string,
  metrics: Record<string, number> = {},
  metaPatch: Partial<BenchResult['meta']> = {},
): BenchResult {
  return result(name, { ...SCHEMA_V2_METRICS, ...metrics }, {
    meta: { ...result(name, {}).meta, completed: 122, total: 122, ...SCHEMA_V2_META, ...metaPatch },
  })
}

function comparableResult(name: string, metaPatch: Partial<BenchResult['meta']> = {}): BenchResult {
  return schemaV2Result(name, {}, metaPatch)
}

const SPEED_META: Partial<BenchResult['meta']> = {
  speedMetricSchemaVersion: 1,
  speedDefinition: 'query-timeline-v1',
  datasetFingerprint: 'speed-dataset-a',
  executedQuestionIdsHash: 'executed-a',
  completedSpeedQuestionIdsHash: 'completed-a',
  completedSpeedQuestionCount: 2,
  streaming: true,
  llmCacheEnabled: false,
  queryConcurrency: 1,
  retryAttempts: 0,
  answerModelIdentity: 'answer-model-a',
  answerFramingIdentityHash: 'answer-framing-a',
  endpointIdentity: 'endpoint-a',
  generationSettingsHash: 'generation-a',
  executionEnvironmentFingerprint: 'environment-a',
}

const SPEED_METRICS: Record<string, number> = {
  evidenceReadyLatencyP50Ms: 100,
  evidenceReadyLatencyP95Ms: 200,
  timeToFirstTokenP50Ms: 300,
  timeToFirstTokenP95Ms: 400,
  fullAnswerLatencyP50Ms: 500,
  fullAnswerLatencyP95Ms: 600,
  avgOnlineTokensPerCompletedAnswer: 80,
  speedSampleCount: 2,
  onlineTokenSampleCount: 2,
}

function speedResult(
  name: string,
  metrics: Record<string, number> = {},
  metaPatch: Partial<BenchResult['meta']> = {},
): BenchResult {
  return schemaV2Result(name, { ...SPEED_METRICS, ...metrics }, { ...SPEED_META, ...metaPatch })
}

function fullContextSpeedResult(
  name: string,
  metrics: Record<string, number> = {},
  metaPatch: Partial<BenchResult['meta']> = {},
): BenchResult {
  const baseMetrics = { ...SPEED_METRICS, ...metrics }
  delete baseMetrics.evidenceReadyLatencyP50Ms
  delete baseMetrics.evidenceReadyLatencyP95Ms
  return fullContextResult(name, baseMetrics, { ...SPEED_META, ...metaPatch })
}

/** full-context 生成上限：刻意没有 mrrDefinition、没有八个契约字段，只有不合格声明。 */
function fullContextResult(
  name: string,
  metrics: Record<string, number> = {},
  metaPatch: Partial<BenchResult['meta']> = {},
): BenchResult {
  return result(name, { evidenceRecall: 0.9, ...metrics }, {
    meta: {
      model: 'gpt-4o', timestamp: '2026-09-02T12:00:00.000Z', gitSha: 'abc1234',
      completed: 10, total: 10,
      mode: 'full-context', retrievalAlgorithm: 'none',
      comparisonEligible: false, comparisonIneligibleReason: 'full-context-generation-ceiling',
      ...metaPatch,
    },
  })
}

function sampleStage(
  retrievalStatus: PerSampleRecord['retrievalStatus'],
  generationStatus: PerSampleRecord['generationStatus'],
): PerSampleRecord {
  return { id: 'q', paperId: 'p', source: 'qasper', metrics: {}, retrievalStatus, generationStatus }
}

/** 取 `heading` 所在区块（到下一个 `###` 为止），避免跨区块断言把别的表也算进来。 */
function sectionOf(md: string, heading: string): string {
  const start = md.indexOf(heading)
  expect(start).toBeGreaterThan(-1)
  const rest = md.slice(start)
  const end = rest.indexOf('\n### ', 1)
  return end === -1 ? rest : rest.slice(0, end)
}

/** 取 `heading` 之后第一张表的表头单元格——断言「哪张表列了哪个指标」只能看表头。 */
function tableHeaderAfter(md: string, heading: string): string[] {
  const section = sectionOf(md, heading)
  const line = section.split('\n').find(l => l.trim().startsWith('|'))
  return (line ?? '').split('|').map(c => c.trim()).filter(c => c.length > 0)
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
    // 断言整行而非孤立数字：'2' 在 gitSha 与时间戳里本来就有，那样的断言永远不会失败
    const block = sectionOf(md, '### 失败样本')
    expect(block).toContain('| default | generate | 2 | timeout |')
    expect(block).toContain('| default | index | 1 | bad pdf |')
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
    // 断言整行（含真实版本号）：'v1' 在常驻的 `context-page-v1` 说明里本来就有，
    // 只查 'v1' 无法证明打印的是拒答模式表版本
    expect(pattern).toContain(`- 拒答模式表版本：\`${REFUSAL_PATTERN_VERSION}\``)
    const judge = renderReport([
      result('default', { unanswerableAccuracy: 0.3 }, { meta: { ...base, unanswerableMethod: 'judge' } }),
    ])
    expect(judge).not.toContain('拒答模式表版本')
    const none = renderReport([result('default', { evidenceRecall: 0.7 })])
    expect(none).not.toContain('拒答模式表版本')
  })
})

describe('renderComparison', () => {
  // 门禁要求身份字段齐全：只有 schema-v2 结果之间才允许算受控检索指标差值，
  // 因此本用例改用合规 fixture，legacy→legacy 的拒绝行为由下方门禁用例覆盖。
  it('输出指标差值与方向', () => {
    const md = renderComparison(
      schemaV2Result('before', { evidenceRecall: 0.6, answerF1: 0.5 }),
      schemaV2Result('after', { evidenceRecall: 0.8, answerF1: 0.4 }),
    )
    expect(md).toContain('evidenceRecall')
    expect(md).toContain('+0.200')
    expect(md).toContain('-0.100')
    expect(md).not.toContain('不可比较')
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

  it('计数行抑制差值时给出脚注，避免「—」被读成渲染 bug', () => {
    const md = renderComparison(comparableResult('a'), comparableResult('b'))
    expect(md).toContain('| contextPageMrrSampleCount | 122 | 122 | — |')
    expect(md).toContain('是分母计数行，恒不输出差值')
    // 表里没有计数行时不该平白多一条脚注
    const legacy = renderComparison(
      result('before', { evidenceRecall: 0.6 }),
      result('after', { evidenceRecall: 0.8 }),
    )
    expect(legacy).not.toContain('是分母计数行，恒不输出差值')
  })
})

describe('renderComparison — 横向比较门禁（§8）', () => {
  it.each([
    ['metric schema', { metricSchemaVersion: 1 }],
    ['MRR definition', { mrrDefinition: 'legacy-candidate-mrr' }],
    ['context budget', { contextBudgetTokens: 2048 }],
    ['tokenizer model', { contextTokenizer: 'other/tokenizer' }],
    ['tokenizer revision', { contextTokenizerRevision: 'other' }],
    ['eligible IDs', { eligibleRetrievalQuestionIdsHash: 'other' }],
    ['dataset', { datasetFingerprint: 'other' }],
    ['evidence mapping', { evidenceMappingVersion: 'other' }],
  ])('refuses Context Page MRR delta for mismatched %s', (_label, patch) => {
    const md = renderComparison(comparableResult('a'), comparableResult('b', patch))
    expect(md).toContain('不可比较')
    // 关键：拒绝时不得留下任何 contextPageMrr 家族的差值行。计数行是唯一仍带
    // contextPageMrr 字样的行，因此这条正则真正守护的是「计数的差值也一并抑制」。
    expect(md).not.toMatch(/contextPageMrr.*[+-]0\./)
    // 受控 MRR 值本身也不输出差值：否则 0.500 → 0.500 的 +0.000 会被读成一次合法比较
    expect(md).toContain('| MRR (context-page-v1) | 0.500 | 0.500 | — |')
  })

  it('allows deltas when every retrieval identity field and denominator match', () => {
    const md = renderComparison(comparableResult('a'), comparableResult('b'))
    expect(md).not.toContain('不可比较')
    expect(md).toContain('MRR (context-page-v1)')
    expect(md).toContain('| MRR (context-page-v1) | 0.500 | 0.500 | +0.000 |')
    // 分母计数的差值恒不输出：样本数差不是质量信号，放进「差值」列会被读成改进
    expect(md).toContain('| contextPageMrrSampleCount | 122 | 122 | — |')
  })

  it('refuses comparison when sample count is below eligible count', () => {
    const bad = comparableResult('b')
    bad.metrics.contextPageMrrSampleCount = 121
    bad.metrics.contextPageMrrEligibleCount = 122
    expect(renderComparison(comparableResult('a'), bad)).toContain('样本数')
  })

  it('refuses comparison when sample count exceeds eligible count', () => {
    // 样本数 > 有效题数说明有题被重复计数：同样是固定分母被破坏，必须拒绝而不是只拒「偏少」
    const bad = comparableResult('b')
    bad.metrics.contextPageMrrSampleCount = 123
    bad.metrics.contextPageMrrEligibleCount = 122
    expect(renderComparison(comparableResult('a'), bad)).toContain('样本数')
  })

  it('refuses two full-context results that omit every identity field', () => {
    const md = renderComparison(fullContextResult('a'), fullContextResult('b'))
    expect(md).toContain('不可比较')
  })

  it('refuses two legacy results even though their fields trivially match', () => {
    const md = renderComparison(
      result('before', { evidenceRecall: 0.6 }),
      result('after', { evidenceRecall: 0.8 }),
    )
    expect(md).toContain('不可比较')
    // 独立断言资格原因：legacy 的 comparisonEligible 为 undefined，必须走 `!== true` 被拒，
    // 而不是只因为八个字段缺失才被拒（否则换成 `=== false` 这条路径就无人覆盖）
    expect(md).toContain('不具备检索比较资格')
  })

  it('refuses a schema-v2 pair whose comparisonEligible is missing', () => {
    // 身份字段全齐、计数也完整，只缺 comparisonEligible：`!== true` 与 `=== false` 在此分叉，
    // 必须按「不具备资格」拒绝，否则 undefined 会被静默当成合格
    const a = comparableResult('a')
    const b = comparableResult('b')
    delete a.meta.comparisonEligible
    delete b.meta.comparisonEligible
    const md = renderComparison(a, b)
    expect(md).toContain('不可比较')
    expect(md).toContain('不具备检索比较资格')
  })

  it('refuses a legacy-vs-schema-v2 pair', () => {
    const md = renderComparison(result('before', { evidenceRecall: 0.6 }), comparableResult('after'))
    expect(md).toContain('不可比较')
  })

  it('refuses an otherwise-identical result that declares itself ineligible', () => {
    // 身份字段全齐、计数也完整，但一侧 comparisonEligible=false：必须拒绝而非只看身份字段
    const md = renderComparison(comparableResult('a'), comparableResult('b', { comparisonEligible: false }))
    expect(md).toContain('不可比较')
    expect(md).toContain('不具备检索比较资格')
  })

  it('refuses when both sides omit an identity field even if both claim eligibility', () => {
    // 两侧都缺同一字段时 undefined === undefined，只比相等会让缺失身份静默通过
    const a = comparableResult('a')
    const b = comparableResult('b')
    delete a.meta.contextTokenizerRevision
    delete b.meta.contextTokenizerRevision
    const md = renderComparison(a, b)
    expect(md).toContain('不可比较')
    expect(md).toContain('contextTokenizerRevision 缺失')
  })

  it('refuses a run with zero eligible questions as such, not as an incomplete count', () => {
    // 没有有效题时聚合根本不输出 SampleCount，`undefined !== 0` 会把「没有观测」
    // 报成「观测偏少」，读者于是去找一份并不存在的缺失数据
    const empty = comparableResult('b')
    empty.metrics.contextPageMrrEligibleCount = 0
    delete empty.metrics.contextPageMrrSampleCount
    const md = renderComparison(comparableResult('a'), empty)
    expect(md).toContain('不可比较')
    expect(md).toContain('分母为 0')
    expect(md).not.toContain('样本数不完整')
  })
})

describe('renderReport — 检索排名与版本契约（§9）', () => {
  it('输出 Context Page MRR 主表：四个受控指标 + 有效题数 + 阶段失败数', () => {
    const r = comparableResult('semantic-tree', { retrievalAlgorithm: 'semantic-tree' })
    r.perSample = [
      sampleStage('completed', 'completed'),
      sampleStage('failed', 'skipped'),     // 索引失败：检索失败，生成从未开始
      sampleStage('ineligible', 'skipped'), // 非有效题：不适用，不是失败
      sampleStage('completed', 'failed'),   // 生成失败但检索观测保留
    ]
    const md = renderReport([r])
    expect(md).toContain('MRR (context-page-v1)')
    expect(md).toContain('Recall')
    expect(md).toContain('Hit Rate')
    expect(md).toContain('Precision')
    expect(md).toContain('有效题数')
    expect(md).toContain('检索失败')
    expect(md).toContain('生成失败')
    // skipped 与 ineligible 都不计入失败，故检索、生成各恰好 1
    expect(md).toContain('| 122 | 1 | 1 |')
  })

  it('schema-v2 行的 answerF1 在回答质量伴侣表中可见', () => {
    // §9 检索主表只放四个受控检索口径；answerF1 等若不另列，新运行就再也看不到这些数字
    const r = schemaV2Result('semantic-tree', {
      answerF1: 0.43, unanswerableAccuracy: 0.31, judgeFactuality: 0.8,
    })
    const md = renderReport([r])
    expect(md).toContain('回答质量')
    expect(md).toContain('| semantic-tree | 122/122 | 0.430 | 0.800 | 0.310 |')
    // 检索主表已覆盖的口径不得在伴侣表重复出现：断言表头（列不存在），
    // 而不是断言某一行文本——后者会因为别的原因通过，守不住「列没加进来」这件事
    const header = tableHeaderAfter(md, '### 回答质量')
    for (const key of [...RETRIEVAL_SECTION_METRICS, ...RETRIEVAL_EXEMPT_METRICS]) {
      expect(header).not.toContain(key)
    }
  })

  it('full-context 生成上限行展示 answerF1 与 judge 三维', () => {
    const fc = fullContextResult('full-context', {
      answerF1: 0.52, judgeFactuality: 0.9, judgeCompleteness: 0.8, judgeGroundedness: 0.7,
    })
    const md = renderReport([fc])
    const ceiling = md.indexOf('生成上限')
    expect(ceiling).toBeGreaterThan(-1)
    const block = md.slice(ceiling)
    expect(block).toContain('answerF1')
    expect(block).toContain('judgeFactuality')
    expect(block).toContain('judgeCompleteness')
    expect(block).toContain('judgeGroundedness')
    expect(block).toContain('0.520')
    expect(block).toContain('full-context-generation-ceiling')
  })

  it('full-context 上限行列由结果推导：unanswerableAccuracy / contextTokens 可见，时延不外露', () => {
    // 上限表曾是手写指标清单，runner 新增的指标（如 unanswerableAccuracy）会在报表里消失。
    // 列改为从结果推导后，除「耗时与缓存」区块真的渲染了的时延族外，任何指标都必须出现。
    // fixture 因此必须带上运行区间：时延的排除是条件性的，没有这两个字段时区块不渲染，
    // 排除反而会让数值无处可看（该条件本身由本 describe 末尾的用例守住）。
    const fc = fullContextResult('full-context', {
      answerF1: 0.52, unanswerableAccuracy: 0.31, contextTokens: 2500,
      retrievalLatencyP50Ms: 900, retrievalLatencyP95Ms: 3000,
    }, {
      startedAt: '2026-09-05T09:30:00.000Z', finishedAt: '2026-09-05T10:00:00.000Z',
    })
    const md = renderReport([fc])
    const ceiling = md.indexOf('生成上限')
    expect(ceiling).toBeGreaterThan(-1)
    const block = md.slice(ceiling)
    expect(block).toContain('unanswerableAccuracy')
    expect(block).toContain('0.310')
    expect(block).toContain('contextTokens')
    expect(block).toContain('2500')
    // 时延由「耗时与缓存」区块统一展示，上限表不重复列
    expect(block).not.toContain('retrievalLatencyP50Ms')
    expect(block).not.toContain('retrievalLatencyP95Ms')
  })

  it('打印统一预算、tokenizer 与指标定义版本', () => {
    const md = renderReport([comparableResult('semantic-tree')])
    expect(md).toContain('context-page-v1')
    expect(md).toContain('4096')
    expect(md).toContain('BAAI/bge-m3')
    expect(md).toContain('main')
  })

  it('full-context 进入独立生成上限区块，不出现在检索排名表', () => {
    const md = renderReport([
      comparableResult('semantic-tree', { retrievalAlgorithm: 'semantic-tree' }),
      fullContextResult('full-context'),
    ])
    const start = md.indexOf('检索排名')
    const ceiling = md.indexOf('生成上限')
    expect(start).toBeGreaterThan(-1)
    expect(ceiling).toBeGreaterThan(start)
    expect(md).toContain('full-context-generation-ceiling')
    expect(md.slice(start, ceiling)).not.toContain('full-context')
  })

  it('comparisonEligible=false 的 schema-v2 结果不进检索排名表', () => {
    const ineligible = comparableResult('ineligible-run', {
      comparisonEligible: false, comparisonIneligibleReason: 'other-reason',
    })
    const md = renderReport([comparableResult('semantic-tree'), ineligible])
    const start = md.indexOf('检索排名')
    const ceiling = md.indexOf('生成上限')
    expect(start).toBeGreaterThan(-1)
    expect(ceiling).toBeGreaterThan(start)
    expect(md.slice(start, ceiling)).not.toContain('ineligible-run')
    expect(md.slice(ceiling)).toContain('ineligible-run')
  })

  it('legacy 结果独占历史区块，mrr 列标注为 Legacy candidate MRR', () => {
    const md = renderReport([result('old-run', { mrr: 0.9, evidenceRecall: 0.5 })])
    // 断言列名而非只断字符串：段落说明里也含该字样，只断字符串会让「列没改名」照样通过
    expect(md).toContain('| evidenceRecall | Legacy candidate MRR |')
    // legacy 不进新检索排名：既无新口径 MRR，也不会被当作新 MRR 最优行加粗
    expect(md).not.toContain('MRR (context-page-v1)')
    expect(md).not.toContain('检索排名')
    expect(md).not.toContain('**old-run**')
  })

  it('full-context 即使 evidenceRecall 最高也不被加粗为最优', () => {
    const md = renderReport([
      schemaV2Result('semantic-tree', { evidenceRecall: 0.2 }),
      fullContextResult('full-context', { evidenceRecall: 0.99 }),
    ])
    const ceiling = md.indexOf('生成上限')
    expect(ceiling).toBeGreaterThan(-1)
    expect(md.slice(ceiling)).toContain('| full-context |')
    expect(md.slice(0, ceiling)).not.toContain('**full-context**')
  })
})

describe('renderReport — 指标单一归属（§9）', () => {
  const TIMING_METRICS: Record<string, number> = {
    indexBuildLatencyP50Ms: 3200, indexBuildLatencyP95Ms: 8100,
    retrievalLatencyP50Ms: 900, retrievalLatencyP95Ms: 3000,
    answerGenerationLatencyP50Ms: 3500, answerGenerationLatencyP95Ms: 9000,
    queryEndToEndLatencyP50Ms: 4700, queryEndToEndLatencyP95Ms: 11200,
    llmNetworkLatencyP50Ms: 2100, llmNetworkLatencyP95Ms: 4500,
  }

  const TREE_METRICS: Record<string, number> = {
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

  /**
   * schema-v2 行，同时带耗时与树指标（运行区间齐备，「耗时与缓存」区块会渲染）。
   * `overrides` 供归属探针逐键覆盖单个指标：只改一个值才能证明「这个数字是那个键渲染的」。
   */
  function ownedResult(overrides: Record<string, number> = {}): BenchResult {
    return schemaV2Result('semantic-tree', { ...TIMING_METRICS, ...TREE_METRICS, answerF1: 0.43, ...overrides }, {
      retrievalAlgorithm: 'semantic-tree',
      startedAt: '2026-09-05T09:30:00.000Z',
      finishedAt: '2026-09-05T10:00:00.000Z',
    })
  }

  it('耗时与树指标只由各自区块渲染，回答质量表一个都不列', () => {
    const md = renderReport([ownedResult()])
    const timing = sectionOf(md, '### 详细耗时与缓存诊断（Legacy timing）')
    const tree = sectionOf(md, '### 语义树诊断')
    // 归属区块确实渲染了两张表——否则「排除」等于把数字删掉，而不是搬家
    expect(tableHeaderAfter(md, '### 详细耗时与缓存诊断（Legacy timing）')).toContain('LLM 网络 P50/P95')
    expect(tableHeaderAfter(md, '### 语义树诊断')).toContain('树使用率')

    // 十个时延键的渲染结果：单元格成对展示 P50/P95，五个单元格即覆盖全部十个键。
    // 每个结果在整份报表里恰好出现一次（长度 2 = 一处），说明它只有一个来源。
    const timingCells = [
      '3.20 s / 8.10 s', '900 ms / 3.00 s', '3.50 s / 9.00 s', '4.70 s / 11.20 s', '2.10 s / 4.50 s',
    ]
    for (const rendered of timingCells) {
      expect(timing).toContain(rendered)
      expect(md.split(rendered)).toHaveLength(2)
    }

    // 十五个树键的渲染结果（按 TreeSection 里每个键的 fmt / fmtPct / fmtTokens 口径写死）
    const treeCells: Record<string, string> = {
      avgTreeNodeCount: '12.500', avgTreeDepth: '2.000',
      avgTreeLevel1Count: '3.500', avgTreeLevel2Count: '8.000',
      treeEvidenceCoverage: '0.820', treeSharedBlockRate: '0.160', treeCrossSectionNodeRate: '0.330',
      treeBuildFailureRate: '5%', avgTreeBuildInputTokens: '41.0k', avgTreeBuildOutputTokens: '1200',
      treeUsedRate: '94%', treeDegradationRate: '6%', selectedNodeCount: '1.700',
      treeBuildLatencyP50Ms: '4.20 s / 9.00 s', treeBuildLatencyP95Ms: '4.20 s / 9.00 s',
    }
    for (const [key, rendered] of Object.entries(treeCells)) {
      // 清单与本节列一一对应：往 TREE_SECTION_METRICS 里加键而没加期望值会在这里暴露
      expect(TREE_SECTION_METRICS).toContain(key)
      expect(tree).toContain(rendered)
      expect(md.split(rendered)).toHaveLength(2)
    }

    // 断言表头而不是断言行文本：旧实现把这两族整族列成伴侣表的列，只有表头能证明它没回来
    const answerHeader = tableHeaderAfter(md, '### 回答质量')
    for (const key of [...TIMING_SECTION_METRICS, ...TREE_SECTION_METRICS]) {
      expect(answerHeader).not.toContain(key)
    }
  })

  it('只带 evidenceHit 别名的行，命中率列仍显示数值', () => {
    // 只有「按数据来源」表经 renameSourceRates 改写过别名；检索主表直接读指标，
    // 两个键都要认，否则该值会渲染成「—」并在报表里彻底消失
    const r = schemaV2Result('semantic-tree', { evidenceHit: 0.66 })
    delete r.metrics.evidenceHitRate
    const md = renderReport([r])
    expect(md).toContain('| semantic-tree | — | 0.500 | 0.600 | 0.660 | 0.400 | 122 | 0 | 0 |')
  })

  it('耗时区块未渲染时，时延指标留在上限表而不是凭空消失', () => {
    // 排除只对「归属区块渲染同一行」的指标成立：没有运行区间就没有耗时区块，
    // 此时若仍排除时延，上限行的这两个数字在整个报表里再也看不到
    const fc = fullContextResult('full-context', {
      retrievalLatencyP50Ms: 900, retrievalLatencyP95Ms: 3000,
    })
    const md = renderReport([fc])
    expect(md).not.toContain('### 详细耗时与缓存诊断（Legacy timing）')
    expect(tableHeaderAfter(md, '### 生成上限')).toContain('retrievalLatencyP50Ms')
  })

  it('语义树区块未渲染时，树指标留在上限表而不是凭空消失', () => {
    // 与上一条对称：hasTree 只看建树失败率与平均节点数，只带这两个之外的树指标时
    // 区块根本不渲染；此时若仍按 TREE_SECTION_METRICS 整族排除，上限行携带的
    // 这两个数字在整个报表里再也看不到（「归属区块不存在却照排除」正是消失的来源）
    const fc = fullContextResult('full-context', { treeUsedRate: 0.94, selectedNodeCount: 1.7 })
    const md = renderReport([fc])
    expect(md).not.toContain('### 语义树诊断')
    const header = tableHeaderAfter(md, '### 生成上限')
    expect(header).toContain('treeUsedRate')
    expect(header).toContain('selectedNodeCount')
  })

  it('TIMING_SECTION_METRICS 里每个键都被「耗时与缓存」区块真的渲染', () => {
    // 归属清单不能是无人验证的声明：往常量里加一个区块根本不渲染的键，
    // 该指标会从整份报表里消失而全部用例照样绿。逐键探测把这条不变量变成断言。
    for (const [index, key] of TIMING_SECTION_METRICS.entries()) {
      // 每个键一个只属于它的毫秒值：断言失败时期望字符串本身就点名了没被渲染的键
      const value = 1_000 + 137 * index
      const md = renderReport([ownedResult({ [key]: value })])
      expect(sectionOf(md, '### 详细耗时与缓存诊断（Legacy timing）'), `耗时区块没有渲染 ${key}`)
        .toContain(fmtDuration(value))
    }
  })

  it('TREE_SECTION_METRICS 里每个键都被「语义树诊断」区块真的渲染', () => {
    // 建树时延一项展开成 P50/P95 两列：cell() 要求两个键同时给出，故这对键共用同一份探测值
    const latencyPair = {
      metrics: { treeBuildLatencyP50Ms: 221_000, treeBuildLatencyP95Ms: 224_000 },
      expected: '3m 41s / 3m 44s',
    }
    // 每个键一个只属于它的探测值与期望渲染结果（按 renderTreeSection 的 fmt / fmtPct /
    // fmtTokens / cell 口径写死）：断言失败时期望字符串本身就点名了没被渲染的键
    const probes: Record<string, { metrics: Record<string, number>; expected: string }> = {
      avgTreeNodeCount: { metrics: { avgTreeNodeCount: 211.5 }, expected: '211.500' },
      avgTreeDepth: { metrics: { avgTreeDepth: 212.5 }, expected: '212.500' },
      avgTreeLevel1Count: { metrics: { avgTreeLevel1Count: 213.5 }, expected: '213.500' },
      avgTreeLevel2Count: { metrics: { avgTreeLevel2Count: 214.5 }, expected: '214.500' },
      treeEvidenceCoverage: { metrics: { treeEvidenceCoverage: 0.821 }, expected: '0.821' },
      treeSharedBlockRate: { metrics: { treeSharedBlockRate: 0.822 }, expected: '0.822' },
      treeCrossSectionNodeRate: { metrics: { treeCrossSectionNodeRate: 0.823 }, expected: '0.823' },
      treeBuildFailureRate: { metrics: { treeBuildFailureRate: 0.824 }, expected: '82.4%' },
      treeBuildLatencyP50Ms: latencyPair,
      treeBuildLatencyP95Ms: latencyPair,
      avgTreeBuildInputTokens: { metrics: { avgTreeBuildInputTokens: 821_000 }, expected: '821.0k' },
      avgTreeBuildOutputTokens: { metrics: { avgTreeBuildOutputTokens: 822_500 }, expected: '822.5k' },
      treeUsedRate: { metrics: { treeUsedRate: 0.825 }, expected: '82.5%' },
      treeDegradationRate: { metrics: { treeDegradationRate: 0.826 }, expected: '82.6%' },
      selectedNodeCount: { metrics: { selectedNodeCount: 215.5 }, expected: '215.500' },
    }
    for (const key of TREE_SECTION_METRICS) {
      const probe = probes[key]
      expect(probe, `TREE_SECTION_METRICS 里的 ${key} 没有对应的渲染期望——它并不属于「语义树诊断」区块`)
        .toBeDefined()
      const md = renderReport([ownedResult(probe!.metrics)])
      expect(sectionOf(md, '### 语义树诊断'), `语义树诊断区块没有渲染 ${key}`)
        .toContain(probe!.expected)
    }
  })

  it('RETRIEVAL_SECTION_METRICS 里每个列键都被「检索排名」表真的渲染', () => {
    // 与上面两条同理：列清单同样禁止夹带不渲染的键（那个数字会被伴侣表一并排除而彻底消失）
    const probes: Record<string, { value: number; expected: string }> = {
      contextPageMrr: { value: 0.601, expected: '0.601' },
      // 「有效题数」列读 `meta.eligibleRetrievalQuestionCount ?? metrics.contextPageMrrEligibleCount`，
      // 探针因此必须让 meta 那条路径缺席，否则被证明的是 meta 字段而不是这个指标键
      contextPageMrrEligibleCount: { value: 601, expected: '601' },
      evidenceRecall: { value: 0.602, expected: '0.602' },
      evidenceHit: { value: 0.603, expected: '0.603' },
      evidenceHitRate: { value: 0.604, expected: '0.604' },
      contextPrecision: { value: 0.605, expected: '0.605' },
    }
    for (const key of RETRIEVAL_SECTION_METRICS) {
      const probe = probes[key]
      expect(probe, `RETRIEVAL_SECTION_METRICS 里的 ${key} 没有对应的列——检索主表并不渲染它`)
        .toBeDefined()
      const r = schemaV2Result('semantic-tree', { [key]: probe!.value })
      // Hit Rate 列读 `evidenceHitRate ?? evidenceHit`：探别名时必须让主名缺席，
      // 否则渲染的是主名，别名那条退化路径始终没有覆盖
      if (key === 'evidenceHit') delete r.metrics.evidenceHitRate
      const md = renderReport([r])
      expect(sectionOf(md, '### 检索排名'), `检索排名表没有渲染 ${key}`).toContain(probe!.expected)
    }
  })
})

describe('renderReport — 排名表加粗门禁（§8）', () => {
  it('身份坐标不一致的两行不加粗，并点名不一致的坐标', () => {
    const md = renderReport([
      schemaV2Result('a', { contextPageMrr: 0.6 }, { contextBudgetTokens: 4096 }),
      schemaV2Result('b', { contextPageMrr: 0.4 }, { contextBudgetTokens: 2048 }),
    ])
    const ranking = sectionOf(md, '### 检索排名')
    // 门禁原话照搬，读者不必猜是哪一项坐标分叉
    expect(ranking).toContain('contextBudgetTokens 不一致')
    // MRR 列与配置名都不得加粗：两次不同预算的实验之间没有「最优」
    expect(ranking).not.toMatch(/\*\*0\./)
    expect(ranking).not.toContain('**a**')
    expect(ranking).not.toContain('**b**')
  })

  it('身份完全一致时仍然加粗最优行（门禁不是把加粗一关了事）', () => {
    const md = renderReport([
      schemaV2Result('a', { contextPageMrr: 0.4 }),
      schemaV2Result('b', { contextPageMrr: 0.7 }),
    ])
    const ranking = sectionOf(md, '### 检索排名')
    expect(ranking).not.toContain('跨行不可比')
    expect(ranking).toContain('| **b** | — | **0.700** |')
  })
})

describe('partitionResults（§9）', () => {
  it('分区完整且互斥，资格判定先于 schema 判定', () => {
    const schema = schemaV2Result('schema')
    const ceiling = fullContextResult('ceiling')
    const legacy = result('legacy', { evidenceRecall: 0.5 })
    // 同时带 mrrDefinition 与 comparisonEligible=false：先测 schema 就会把它误归检索行
    const ineligibleSchema = schemaV2Result('ineligible-schema', {}, {
      comparisonEligible: false, comparisonIneligibleReason: 'other',
    })
    const input = [schema, ceiling, legacy, ineligibleSchema]
    const { retrievalRows, ceilingRows, legacyRows } = partitionResults(input)
    const partition = [...retrievalRows, ...ceilingRows, ...legacyRows]
    expect(partition).toHaveLength(input.length)
    expect(new Set(partition).size).toBe(input.length)
    for (const r of input) expect(partition).toContain(r)
    expect(retrievalRows).toEqual([schema])
    expect(ceilingRows).toEqual([ceiling, ineligibleSchema])
    expect(legacyRows).toEqual([legacy])
  })
})

describe('renderReport — query-timeline speed', () => {
  it('renders retrieval speed with exactly six time values and one token mean', () => {
    const md = renderReport([speedResult('papermind', { answerF1: 0.5 })])
    const header = tableHeaderAfter(md, '### 检索方法速度（query-timeline-v1）')

    expect(header).toEqual([
      '方法',
      'Evidence Ready P50', 'P95',
      'TTFT P50', 'P95',
      'Full Answer P50', 'P95',
      'Avg Online Tokens',
    ])
    expect(sectionOf(md, '### 检索方法速度（query-timeline-v1）')).toContain(
      '| papermind | 100 ms | 200 ms | 300 ms | 400 ms | 500 ms | 600 ms | 80 |',
    )

    const answerHeader = tableHeaderAfter(md, '### 回答质量（检索口径之外）')
    for (const key of Object.keys(SPEED_METRICS)) expect(answerHeader).not.toContain(key)
  })

  it('keeps counts and all failure-stage totals outside the seven-value table', () => {
    const run = speedResult('papermind')
    run.metrics.onlineTokenSampleCount = 1
    delete run.metrics.avgOnlineTokensPerCompletedAnswer
    run.errors = [
      { sampleId: 'q1', stage: 'retrieve', message: 'retrieve failed' },
      { sampleId: 'q2', stage: 'generate', message: 'generate failed' },
      { sampleId: 'q3', stage: 'stream', message: 'stream failed' },
      { sampleId: 'q4', stage: 'judge', message: 'judge failed' },
      { sampleId: 'q6', stage: 'judge', message: 'judge failed without a status record' },
    ]
    run.perSample = [
      { id: 'q4', paperId: 'p', source: 'smoke', metrics: {}, judgeStatus: 'failed' },
      { id: 'q5', paperId: 'p', source: 'smoke', metrics: {}, judgeStatus: 'failed' },
    ]

    const md = renderReport([run])
    const speed = sectionOf(md, '### 检索方法速度（query-timeline-v1）')
    const diagnostics = sectionOf(md, '### Query-timeline 支持计数与失败诊断')

    expect(speed).toContain('| papermind | 100 ms | 200 ms | 300 ms | 400 ms | 500 ms | 600 ms | — |')
    expect(tableHeaderAfter(md, '### Query-timeline 支持计数与失败诊断')).toEqual([
      '方法', 'Speed 样本', 'Completed 契约', 'Token 完整',
      'Retrieval 失败', 'Generation 失败', 'Stream 失败', 'Judge 失败',
    ])
    expect(diagnostics).toContain('| papermind | 2 | 2 | 1/2 | 1 | 1 | 1 | 3 |')
    expect(diagnostics).toContain('token accounting 不完整')
    expect(speed).not.toContain('Speed 样本')
    expect(speed).not.toContain('失败')
  })

  it('keeps full-context only in a separate generation-ceiling speed table with no Evidence Ready value', () => {
    const md = renderReport([
      speedResult('papermind'),
      fullContextSpeedResult('full-context'),
    ])
    const retrievalSpeed = sectionOf(md, '### 检索方法速度（query-timeline-v1）')
    const ceilingSpeed = sectionOf(md, '### 生成上限速度（query-timeline-v1）')

    expect(retrievalSpeed).toContain('| papermind |')
    expect(retrievalSpeed).not.toContain('| full-context |')
    expect(ceilingSpeed).toContain('| full-context | — | — | 300 ms | 400 ms | 500 ms | 600 ms | 80 |')
    expect(ceilingSpeed).toContain('不参与检索方法速度排名或 delta')

    const qualityCeilingHeader = tableHeaderAfter(md, '### 生成上限（不参与检索排名）')
    for (const key of Object.keys(SPEED_METRICS)) expect(qualityCeilingHeader).not.toContain(key)
  })

  it('labels old timing as legacy diagnostics and never admits it to query-timeline reporting', () => {
    const legacy = result('legacy', {
      evidenceRecall: 0.7,
      evidenceReadyLatencyP50Ms: 5,
      timeToFirstTokenP50Ms: 10,
      fullAnswerLatencyP50Ms: 20,
      retrievalLatencyP50Ms: 100,
      retrievalLatencyP95Ms: 200,
    }, {
      meta: {
        ...result('legacy', {}).meta,
        startedAt: '2026-09-05T09:30:00.000Z',
        finishedAt: '2026-09-05T10:00:00.000Z',
      },
    })

    const report = renderReport([legacy])
    expect(report).toContain('### 详细耗时与缓存诊断（Legacy timing）')
    expect(report).toContain('| legacy |')
    expect(report).not.toContain('### 检索方法速度（query-timeline-v1）')
    expect(report).toContain('缺少 `speedDefinition: \'query-timeline-v1\'`')

    const comparison = renderComparison(legacy, speedResult('current'))
    expect(comparison).not.toContain('### Query-timeline 速度对比')
    expect(comparison).not.toContain('Evidence Ready P50')
    expect(comparison).toContain('Legacy timing 不进入 query-timeline 速度 delta')
  })
})

describe('renderComparison — query-timeline speed gate', () => {
  it.each([
    ['dataset fingerprint', { datasetFingerprint: 'other' }],
    ['executed IDs', { executedQuestionIdsHash: 'other' }],
    ['completed speed IDs', { completedSpeedQuestionIdsHash: 'other' }],
    ['speed schema', { speedMetricSchemaVersion: 2 }],
    ['answer model', { answerModelIdentity: 'other' }],
    ['answer framing', { answerFramingIdentityHash: 'other' }],
    ['endpoint', { endpointIdentity: 'other' }],
    ['generation settings', { generationSettingsHash: 'other' }],
    ['retry count', { retryAttempts: 1 }],
    ['streaming', { streaming: false }],
    ['cache mode', { llmCacheEnabled: true }],
    ['concurrency', { queryConcurrency: 2 }],
    ['environment', { executionEnvironmentFingerprint: 'other' }],
  ])('suppresses every speed delta when %s differs', (_label, rawPatch) => {
    const patch = rawPatch as Partial<BenchResult['meta']>
    const md = renderComparison(
      speedResult('a', { evidenceReadyLatencyP50Ms: 100 }),
      speedResult('b', { evidenceReadyLatencyP50Ms: 80 }, patch),
    )

    expect(md).toContain('### Query-timeline 速度对比')
    expect(md).toContain('速度不可比较')
    expect(md).toContain('| Evidence Ready P50 | 100 ms | 80 ms | — |')
  })

  it('does not admit a non-query-timeline speed definition to the speed comparison table', () => {
    const md = renderComparison(
      speedResult('a'),
      speedResult('b', { evidenceReadyLatencyP50Ms: 80 }, {
        speedDefinition: 'other' as BenchResult['meta']['speedDefinition'],
      }),
    )
    expect(md).not.toContain('### Query-timeline 速度对比')
    expect(md).not.toContain('Evidence Ready P50')
    expect(md).toContain('两侧都必须声明 `speedDefinition: \'query-timeline-v1\'`')
  })

  it('rejects unequal speedSampleCount and same-sized cohorts with different completed IDs', () => {
    const unequalCount = speedResult('b', { speedSampleCount: 1 })
    const countReport = renderComparison(speedResult('a'), unequalCount)
    expect(countReport).toContain('speedSampleCount')
    expect(countReport).toContain('| TTFT P50 | 300 ms | 300 ms | — |')

    const differentIds = speedResult('b', {}, { completedSpeedQuestionIdsHash: 'same-count-other-ids' })
    const idReport = renderComparison(speedResult('a'), differentIds)
    expect(idReport).toContain('completedSpeedQuestionIdsHash 不一致')
    expect(idReport).toContain('| Full Answer P50 | 500 ms | 500 ms | — |')
  })

  it('keeps speed and retrieval comparison gates independent in both directions', () => {
    const retrievalMismatch = speedResult(
      'b',
      { evidenceReadyLatencyP50Ms: 80, contextPageMrr: 0.6 },
      { contextBudgetTokens: 2048 },
    )
    const speedAllowed = renderComparison(speedResult('a'), retrievalMismatch)
    expect(speedAllowed).toContain('| Evidence Ready P50 | 100 ms | 80 ms | -20 ms |')
    expect(speedAllowed).toContain('| MRR (context-page-v1) | 0.500 | 0.600 | — |')

    const speedMismatch = speedResult(
      'b',
      { evidenceReadyLatencyP50Ms: 80, contextPageMrr: 0.6 },
      { endpointIdentity: 'other' },
    )
    expect(retrievalComparisonIssues(speedResult('a'), speedMismatch)).toEqual([])
    const qualityAllowed = renderComparison(speedResult('a'), speedMismatch)
    expect(qualityAllowed).toContain('| Evidence Ready P50 | 100 ms | 80 ms | — |')
    expect(qualityAllowed).toContain('| MRR (context-page-v1) | 0.500 | 0.600 | +0.100 |')
  })

  it('suppresses only the token delta when token accounting is incomplete', () => {
    const incomplete = speedResult('b', {
      evidenceReadyLatencyP50Ms: 80,
      avgOnlineTokensPerCompletedAnswer: 70,
      onlineTokenSampleCount: 1,
    })
    const md = renderComparison(speedResult('a'), incomplete)

    expect(md).not.toContain('速度不可比较')
    expect(md).toContain('| Evidence Ready P50 | 100 ms | 80 ms | -20 ms |')
    expect(md).toContain('| Avg Online Tokens | 80 | 70 | — |')
    expect(md).toContain('token accounting 不完整，仅抑制 Avg Online Tokens delta')
  })

  it('states speed-resource and quality directions explicitly', () => {
    const md = renderComparison(speedResult('a'), speedResult('b'))
    expect(md).toContain('Evidence Ready、TTFT、Full Answer 与 Avg Online Tokens 均为越低越好')
    expect(md).toContain('质量指标越高越好')
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

  it('单结果输出详细 Legacy timing 诊断区块，含 wall-clock、缓存行与时延表', () => {
    const md = renderReport([timedResult('default')])
    expect(md).toContain('### 详细耗时与缓存诊断（Legacy timing）')
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
    expect(md).not.toContain('### 详细耗时与缓存诊断（Legacy timing）')
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
    expect(renderReport([summary])).not.toContain('### 详细耗时与缓存诊断（Legacy timing）')
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
