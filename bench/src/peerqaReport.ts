import type { BenchResult } from './types'
import { percentile } from './metrics/aggregate'
import { PEERQA_QUALITY_DEFINITION } from './metrics/peerqaQuality'
import { SENTENCE_MAPPING_VERSION, SENTENCE_METRICS, SENTENCE_RETRIEVAL_DEFINITION } from './metrics/sentenceRetrieval'

const number = (value: number | undefined): string => Number.isFinite(value) ? value!.toFixed(4) : '—'
const cell = (r: BenchResult, key: string): string => number(r.metrics[key])
export const isPeerQaResult = (result: BenchResult): boolean => result.meta.peerqaQualityDefinition !== undefined
  || result.meta.sentenceRetrievalDefinition !== undefined || result.perSample.some(row => row.source === 'peerqa')

export function sentenceComparisonIssues(a: BenchResult, b: BenchResult): string[] {
  const issues: string[] = []
  const fields: Array<keyof BenchResult['meta']> = [
    'datasetFingerprint', 'sentenceRetrievalDefinition', 'sentenceEvidenceMappingVersion',
    'eligibleSentenceQuestionIdsHash', 'eligibleSentenceQuestionCount',
    'contextBudgetTokens', 'contextTokenizer', 'contextTokenizerRevision',
  ]
  for (const key of fields) {
    if (a.meta[key] === undefined || b.meta[key] === undefined) issues.push(`${key} 缺失`)
    else if (a.meta[key] !== b.meta[key]) issues.push(`${key} 不一致`)
  }
  for (const r of [a, b]) {
    if (r.meta.comparisonEligible !== true || r.meta.mode === 'full-context') issues.push(`${r.config.name} 不具备检索比较资格`)
    if (r.meta.sentenceRetrievalDefinition !== SENTENCE_RETRIEVAL_DEFINITION) issues.push(`${r.config.name} sentenceRetrievalDefinition 未知`)
    if (r.meta.sentenceEvidenceMappingVersion !== SENTENCE_MAPPING_VERSION) issues.push(`${r.config.name} sentenceEvidenceMappingVersion 未知`)
    const n = r.meta.eligibleSentenceQuestionCount
    if (!n) issues.push(`${r.config.name} 句子有效题分母为零或缺失`)
    for (const key of SENTENCE_METRICS) {
      if (r.metrics[`${key}SampleCount`] !== n) issues.push(`${r.config.name} ${key}SampleCount 与固定分母不一致`)
    }
  }
  return [...new Set(issues)]
}

export function renderPeerQaReport(results: BenchResult[], speedLines: string[]): string {
  const lines = ['## PeerQA 评测', '', '> 单篇论文、索引已就绪；输入为官方解析文本组成的伪页，当前结果不评测 PDF 解析或真实页码。', '', '### 句子检索', '',
    '| 方法 | Sentence Recall | Annotated Precision | All Gold Coverage | 有效题 | 证据映射 |',
    '| --- | ---: | ---: | ---: | ---: | ---: |']
  for (const r of results.filter(r => r.meta.mode !== 'full-context')) {
    lines.push(`| ${r.config.name} | ${cell(r, 'sentenceEvidenceRecall')} | ${cell(r, 'annotatedSentencePrecision')} | ${cell(r, 'allGoldSentenceCoverage')} | ${r.meta.eligibleSentenceQuestionCount ?? '—'} | ${r.meta.mappedSentenceEvidenceQuestionCount ?? '—'}/${r.meta.sentenceEvidenceQuestionCount ?? '—'} |`)
  }
  lines.push('', '> 以最终预算截断后、完整覆盖的源句子计算；Annotated Precision 只衡量已标注证据，其他句子可能仍有帮助。失败题计零。full-context 单独作为回答上限。', '', '### 回答质量', '',
    '| 方法 | Native ROUGE-L | AlignScore | Prometheus (归一化) | Answerability Macro-F1 | 完成率 | 评分覆盖 Align / Prometheus |',
    '| --- | ---: | ---: | ---: | ---: | ---: | --- |')
  for (const r of results) {
    const refs = r.meta.peerqaReferenceQuestionIds?.length ?? 0
    const scoring = r.meta.peerqaModelScoring
    lines.push(`| ${r.config.name}${r.meta.mode === 'full-context' ? '（全文上限）' : ''} | ${cell(r, 'peerqaRougeL')} | ${scoring?.alignScoreModel ? cell(r, 'peerqaAlignScore') : '—'} | ${scoring?.prometheusModel ? cell(r, 'peerqaPrometheus') : '—'} | ${cell(r, 'peerqaAnswerabilityMacroF1')} | ${cell(r, 'peerqaCompletionRate')} | ${scoring?.alignScoreModel ? r.metrics.peerqaAlignScoreCoverageCount ?? 0 : '—'}/${refs} / ${scoring?.prometheusModel ? r.metrics.peerqaPrometheusCoverageCount ?? 0 : '—'}/${refs} |`)
  }
  lines.push('')
  for (const r of results) {
    lines.push(`> ${r.config.name}：参考答案 ${r.meta.peerqaReferenceQuestionIds?.length ?? 0} 题；Answerability ${r.meta.peerqaExpectedQuestionIds?.length ?? '—'} 题；质量口径 \`${r.meta.peerqaQualityDefinition ?? '—'}\`。`)
    const scoring = r.meta.peerqaModelScoring
    if (scoring) lines.push(`> 模型：AlignScore \`${scoring.alignScoreModel ?? '—'}\`；Prometheus \`${scoring.prometheusModel ?? '—'}\`。`)
    const prep = r.meta.peerqaPreparation
    if (prep) lines.push(`> 数据准备：输入 ${prep.inputQuestions} 题；无标签 ${prep.unlabeledQuestions} 题；已标注但缺论文文本 ${prep.missingPaperQuestions} 题。实际执行 ${r.meta.total} 题。`)
    lines.push(`> 可回答 ${r.metrics.peerqaAnswerableQuestionCount ?? '—'} 题；不可回答 ${r.metrics.peerqaUnanswerableQuestionCount ?? '—'} 题。`)
    lines.push(`> 可回答题的证据：无标注 ${r.metrics.peerqaNoEvidenceQuestionCount ?? '—'} 题；歧义 ${r.metrics.peerqaAmbiguousEvidenceQuestionCount ?? '—'} 题；未映射 ${r.metrics.peerqaUnmappedEvidenceQuestionCount ?? '—'} 题。`)
    if (r.meta.sentenceRetrievalDefinition) lines.push(`> 检索口径 \`${r.meta.sentenceRetrievalDefinition}\`，预算 ${r.meta.contextBudgetTokens ?? '—'} tokens，分词器 \`${r.meta.contextTokenizer ?? '—'}@${r.meta.contextTokenizerRevision ?? '—'}\`。`)
  }
  lines.push('', '> Native ROUGE-L 使用项目的文本归一化，与论文 rouge_score 数值不直接等同。AlignScore/Prometheus 由原模型离线评分后通过 `npm run bench:peerqa:score` 导入；缺失评分按参考答案固定分母计零，未配置模型显示 —。通用 --judge 不替代这两个模型。', '')
  if (results.some(r => r.meta.judgeModel)) {
    lines.push('| 方法 | 通用 Judge Factuality | Completeness | Groundedness |', '| --- | ---: | ---: | ---: |')
    for (const r of results) {
      lines.push(`| ${r.config.name} | ${cell(r, 'judgeFactuality')} | ${cell(r, 'judgeCompleteness')} | ${cell(r, 'judgeGroundedness')} |`)
    }
    lines.push('')
    for (const r of results) if (r.meta.judgeModel) lines.push(`> ${r.config.name} 通用 Judge 有效评分 ${r.metrics.judgeFactualitySampleCount ?? 0}/${r.meta.total} 道尝试题；模型 \`${r.meta.judgeModel}\`。`)
    lines.push('')
  }
  lines.push('### 延迟与完成诊断', '', '> TTFT 从在线请求入口到客户端收到首个非空回答正文；Full Answer 到成功结束整个回答流。两者的 P50/P95 共用成功完成题集合，采用最近秩法；不包含建索引、Judge 或界面绘制。', '', ...speedLines)
  if (!speedLines.length) lines.push('> 本轮未启用 `--speed`，没有真实流式 TTFT / Full Answer P50/P95。')
  lines.push('', '| 方法 | 尝试 / 完成 | 失败率 | 超时题 | 回答词数 P50 / P95 |', '| --- | ---: | ---: | ---: | ---: |')
  for (const r of results) {
    const rows = r.perSample.filter(row => row.source === 'peerqa')
    const successful = rows.filter(row => row.generationStatus === 'completed')
    const words = successful.map(row => row.answer?.trim().split(/\s+/u).filter(Boolean).length ?? 0)
    const timeouts = new Set(r.errors.filter(e => ['retrieve', 'generate', 'stream'].includes(e.stage)
      && /timeout|timed out|超时/i.test(e.message)).map(e => e.sampleId)).size
    lines.push(`| ${r.config.name} | ${rows.length} / ${successful.length} | ${number(rows.length ? 1 - successful.length / rows.length : undefined)} | ${timeouts} | ${words.length ? `${percentile(words, 50)} / ${percentile(words, 95)}` : '—'} |`)
  }
  if (results.some(r => r.errors.length)) {
    lines.push('', '| 方法 | 失败阶段 | 题数 |', '| --- | --- | ---: |')
    for (const r of results) for (const stage of new Set(r.errors.map(e => e.stage))) {
      lines.push(`| ${r.config.name} | ${stage} | ${new Set(r.errors.filter(e => e.stage === stage).map(e => e.sampleId)).size} |`)
    }
  }
  return lines.join('\n') + '\n'
}

export function renderPeerQaComparison(a: BenchResult, b: BenchResult, speedLines: string[]): string {
  const issues = sentenceComparisonIssues(a, b)
  const qualityIssues: string[] = []
  for (const key of ['datasetFingerprint', 'peerqaQualityDefinition', 'peerqaExpectedQuestionIds', 'peerqaReferenceQuestionIds'] as const) {
    if (a.meta[key] === undefined || b.meta[key] === undefined || JSON.stringify(a.meta[key]) !== JSON.stringify(b.meta[key])) qualityIssues.push(`${key} 缺失或不一致`)
  }
  if ([a, b].some(r => r.meta.peerqaQualityDefinition !== PEERQA_QUALITY_DEFINITION)) qualityIssues.push('PeerQA quality definition 未知')
  for (const r of [a, b]) {
    if (r.metrics.peerqaRougeLSampleCount !== r.meta.peerqaReferenceQuestionIds?.length) qualityIssues.push(`${r.config.name} peerqaRougeLSampleCount 与参考分母不一致`)
    if (r.metrics.peerqaAnswerabilitySampleCount !== r.meta.peerqaExpectedQuestionIds?.length) qualityIssues.push(`${r.config.name} peerqaAnswerabilitySampleCount 与问题分母不一致`)
  }
  const lines = [`## PeerQA 对比：${a.config.name} → ${b.config.name}`, '', '### 句子检索对比', '']
  if (issues.length) lines.push('> 句子检索不可比较；差值显示 —。', ...issues.map(issue => `> - ${issue}`), '')
  const table = (keys: readonly string[], suppress: (key: string) => boolean) => {
    lines.push('| 指标 | A | B | 差值（B - A） |', '| --- | ---: | ---: | ---: |')
    for (const key of keys) {
      const av = a.metrics[key]
      const bv = b.metrics[key]
      lines.push(`| ${key} | ${number(av)} | ${number(bv)} | ${suppress(key) || !Number.isFinite(av) || !Number.isFinite(bv) ? '—' : `${bv - av >= 0 ? '+' : ''}${number(bv - av)}`} |`)
    }
  }
  table(SENTENCE_METRICS, () => issues.length > 0)
  lines.push('', '### 回答质量对比', '')
  if (qualityIssues.length) lines.push(...qualityIssues.map(issue => `> - ${issue}`), '')
  table(['peerqaRougeL', 'peerqaAnswerabilityMacroF1', 'peerqaCompletionRate', 'peerqaAlignScore', 'peerqaPrometheus'], key => {
    if (qualityIssues.length) return true
    const model = key === 'peerqaAlignScore' ? 'alignScoreModel' : key === 'peerqaPrometheus' ? 'prometheusModel' : undefined
    return model !== undefined && (!a.meta.peerqaModelScoring?.[model] || a.meta.peerqaModelScoring[model] !== b.meta.peerqaModelScoring?.[model])
  })
  lines.push('', ...speedLines)
  return lines.join('\n') + '\n'
}
