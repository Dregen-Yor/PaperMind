import type { QComparison } from './qComparison'

function display(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '—' : value.toFixed(2)
}

export function renderQComparison(comparison: QComparison): string {
  const { weights } = comparison.config
  const lines = [
    '## Q：全题回答质量与首 token 时延',
    '',
    `- 权重：answerF1AllQuestions ${weights.answerF1}；TTFT P50 ${weights.ttftP50}；TTFT P95 ${weights.ttftP95}`,
    '- 第一份输入是 full-context 参考；其自身 Q = 100，候选可以高于 100。',
    `- Q：${display(comparison.score)}`,
    '',
    '| 组成指标 | 参考 | 候选 |',
    '| --- | ---: | ---: |',
    `| answerF1AllQuestions | ${display(comparison.reference?.answerF1 ?? null)} | ${display(comparison.candidate?.answerF1 ?? null)} |`,
    `| timeToFirstTokenP50Ms | ${display(comparison.reference?.ttftP50 ?? null)} | ${display(comparison.candidate?.ttftP50 ?? null)} |`,
    `| timeToFirstTokenP95Ms | ${display(comparison.reference?.ttftP95 ?? null)} | ${display(comparison.candidate?.ttftP95 ?? null)} |`,
  ]
  if (comparison.reasons.length > 0) {
    lines.push('', 'Q 不可用：')
    for (const reason of comparison.reasons) lines.push(`- ${reason}`)
  }
  return `${lines.join('\n')}\n`
}
