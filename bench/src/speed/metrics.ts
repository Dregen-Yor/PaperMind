import { mean, percentile } from '../metrics/aggregate'
import type { PerSampleRecord } from '../types'
import { completedSpeedRecords, type SpeedAggregationOptions } from './contract'

/**
 * Aggregates the seven query-timeline speed metrics over one exact completed cohort.
 * Counts are always emitted for comparison gates and diagnostics, while headline values are absent for an empty cohort.
 */
export function aggregateSpeedMetrics(
  records: PerSampleRecord[],
  options: SpeedAggregationOptions = {},
): Record<string, number> {
  const evidenceRequired = options.evidenceRequired ?? true
  const completed = completedSpeedRecords(records, { evidenceRequired })
  const tokenComplete = completed.filter(record => record.speed.tokenAccountingComplete)
  const metrics: Record<string, number> = {
    speedSampleCount: completed.length,
    onlineTokenSampleCount: tokenComplete.length,
  }

  if (completed.length === 0) return metrics

  if (evidenceRequired) {
    const evidenceReady = completed.map(record => record.speed.evidenceReadyLatencyMs!)
    metrics.evidenceReadyLatencyP50Ms = percentile(evidenceReady, 50)
    metrics.evidenceReadyLatencyP95Ms = percentile(evidenceReady, 95)
  }

  const firstToken = completed.map(record => record.speed.timeToFirstTokenMs!)
  const fullAnswer = completed.map(record => record.speed.fullAnswerLatencyMs!)
  metrics.timeToFirstTokenP50Ms = percentile(firstToken, 50)
  metrics.timeToFirstTokenP95Ms = percentile(firstToken, 95)
  metrics.fullAnswerLatencyP50Ms = percentile(fullAnswer, 50)
  metrics.fullAnswerLatencyP95Ms = percentile(fullAnswer, 95)

  if (tokenComplete.length === completed.length) {
    metrics.avgOnlineTokensPerCompletedAnswer = mean(tokenComplete.map(record => record.speed.onlineTokenCount!))
  }

  return metrics
}
