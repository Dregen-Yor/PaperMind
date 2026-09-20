import type { QuerySpeedRecord, QueryTimeline, TokenSnapshot } from '../types'

export type MonotonicClock = () => number

/**
 * Validate a completed query-timeline record without repairing its values.
 * A completed record may omit Evidence Ready only for generation-only runs.
 */
export function assertCompletedSpeedRecord(record: QuerySpeedRecord, evidenceRequired = true): void {
  if (typeof record.tokenAccountingComplete !== 'boolean') {
    throw new Error('completed speed record is missing token accounting status')
  }

  const requiredFields: Array<[string, number | undefined]> = [
    ['timeToFirstTokenMs', record.timeToFirstTokenMs],
    ['fullAnswerLatencyMs', record.fullAnswerLatencyMs],
  ]
  if (evidenceRequired) requiredFields.unshift(['evidenceReadyLatencyMs', record.evidenceReadyLatencyMs])

  for (const [name, value] of requiredFields) {
    if (value === undefined) throw new Error(`completed speed record is missing ${name}`)
  }

  const allTimeFields: Array<[string, number | undefined]> = [
    ['evidenceReadyLatencyMs', record.evidenceReadyLatencyMs],
    ['timeToFirstTokenMs', record.timeToFirstTokenMs],
    ['fullAnswerLatencyMs', record.fullAnswerLatencyMs],
  ]
  for (const [name, value] of allTimeFields) {
    if (value === undefined) continue
    if (!Number.isFinite(value)) throw new Error(`completed speed record has non-finite ${name}`)
    if (value < 0) throw new Error(`completed speed record has negative ${name}`)
  }

  const evidenceReady = record.evidenceReadyLatencyMs
  const firstToken = record.timeToFirstTokenMs!
  const fullAnswer = record.fullAnswerLatencyMs!
  if (evidenceReady !== undefined && evidenceReady > firstToken) {
    throw new Error('completed speed record has reversed Evidence Ready and TTFT')
  }
  if (firstToken > fullAnswer) {
    throw new Error('completed speed record has reversed TTFT and Full Answer')
  }

  if (record.onlineTokenCount !== undefined && (!Number.isFinite(record.onlineTokenCount) || record.onlineTokenCount < 0)) {
    throw new Error('completed speed record has invalid online token count')
  }
  if (record.tokenAccountingComplete && record.onlineTokenCount === undefined) {
    throw new Error('completed speed record is missing online token count')
  }
  if (!record.tokenAccountingComplete && record.onlineTokenCount !== undefined) {
    throw new Error('incomplete token accounting cannot include online token count')
  }
}

export function startQueryTimeline(now: MonotonicClock, before: TokenSnapshot): QueryTimeline {
  const startedAt = now()
  let evidenceReadyAt: number | undefined
  let firstVisibleTextAt: number | undefined
  let completed = false

  const tokenDelta = (after: TokenSnapshot): Pick<QuerySpeedRecord, 'onlineTokenCount' | 'tokenAccountingComplete'> => {
    const tokenAccountingComplete = after.incompleteRequestCount === before.incompleteRequestCount
    return tokenAccountingComplete
      ? { onlineTokenCount: after.totalTokens - before.totalTokens, tokenAccountingComplete }
      : { tokenAccountingComplete }
  }

  const reachedMilestones = (finishedAt?: number): QuerySpeedRecord => ({
    ...(evidenceReadyAt === undefined ? {} : { evidenceReadyLatencyMs: evidenceReadyAt - startedAt }),
    ...(firstVisibleTextAt === undefined ? {} : { timeToFirstTokenMs: firstVisibleTextAt - startedAt }),
    ...(finishedAt === undefined ? {} : { fullAnswerLatencyMs: finishedAt - startedAt }),
    tokenAccountingComplete: false,
  })

  return {
    markEvidenceReady() {
      if (completed || evidenceReadyAt !== undefined) return
      evidenceReadyAt = now()
    },

    onVisibleText(delta: string) {
      if (completed || firstVisibleTextAt !== undefined || delta.length === 0) return
      firstVisibleTextAt = now()
    },

    complete(readAfter: () => TokenSnapshot, evidenceRequired = true) {
      if (completed) throw new Error('query timeline is already complete')
      completed = true
      // Capture t3 before telemetry access so readAfter overhead is not in Full Answer.
      const finishedAt = now()
      const record = {
        ...reachedMilestones(finishedAt),
        ...tokenDelta(readAfter()),
      }
      assertCompletedSpeedRecord(record, evidenceRequired)
      return record
    },

    partial(after: TokenSnapshot) {
      return {
        ...reachedMilestones(),
        ...tokenDelta(after),
      }
    },
  }
}
