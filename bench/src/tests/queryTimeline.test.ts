import { describe, expect, it } from 'vitest'
import {
  assertCompletedSpeedRecord,
  startQueryTimeline,
} from '../speed/queryTimeline'
import type { QuerySpeedRecord, TokenSnapshot } from '../types'

function scriptedTimeline(ticks: number[], before: TokenSnapshot = {
  totalTokens: 100,
  incompleteRequestCount: 2,
}) {
  const now = () => ticks.shift()!
  return startQueryTimeline(now, before)
}

describe('query timeline', () => {
  it('records Evidence Ready, TTFT, Full Answer, and complete online tokens', () => {
    const timeline = scriptedTimeline([10, 20, 30, 40])

    timeline.markEvidenceReady()
    timeline.onVisibleText('hello')

    expect(timeline.complete(() => ({ totalTokens: 130, incompleteRequestCount: 2 }))).toEqual({
      evidenceReadyLatencyMs: 10,
      timeToFirstTokenMs: 20,
      fullAnswerLatencyMs: 30,
      onlineTokenCount: 30,
      tokenAccountingComplete: true,
    })
  })

  it('allows equal timestamps for each reached milestone', () => {
    const timeline = scriptedTimeline([10, 10, 10, 10])

    timeline.markEvidenceReady()
    timeline.onVisibleText('x')

    expect(timeline.complete(() => ({ totalTokens: 100, incompleteRequestCount: 2 }))).toEqual({
      evidenceReadyLatencyMs: 0,
      timeToFirstTokenMs: 0,
      fullAnswerLatencyMs: 0,
      onlineTokenCount: 0,
      tokenAccountingComplete: true,
    })
  })

  it('records only the first Evidence Ready and first visible text timestamps', () => {
    const timeline = scriptedTimeline([10, 20, 30, 40, 50, 60])

    timeline.markEvidenceReady()
    timeline.markEvidenceReady()
    timeline.onVisibleText('first')
    timeline.onVisibleText('second')

    expect(timeline.complete(() => ({ totalTokens: 101, incompleteRequestCount: 2 }))).toEqual({
      evidenceReadyLatencyMs: 10,
      timeToFirstTokenMs: 20,
      fullAnswerLatencyMs: 30,
      onlineTokenCount: 1,
      tokenAccountingComplete: true,
    })
  })

  it('ignores empty visible text callbacks while treating whitespace as visible text', () => {
    const timeline = scriptedTimeline([10, 20, 30, 40])

    timeline.markEvidenceReady()
    timeline.onVisibleText('')
    timeline.onVisibleText('  ')

    expect(timeline.complete(() => ({ totalTokens: 100, incompleteRequestCount: 2 }))).toMatchObject({
      timeToFirstTokenMs: 20,
      fullAnswerLatencyMs: 30,
    })
  })

  it('allows Evidence Ready for an empty context', () => {
    const timeline = scriptedTimeline([10, 20, 30, 40])

    timeline.markEvidenceReady()
    timeline.onVisibleText('answer')

    expect(timeline.complete(() => ({ totalTokens: 100, incompleteRequestCount: 2 }))).toMatchObject({
      evidenceReadyLatencyMs: 10,
    })
  })

  it('returns partial retrieval records without inventing later milestones', () => {
    const timeline = scriptedTimeline([10, 20])

    expect(timeline.partial({ totalTokens: 110, incompleteRequestCount: 2 })).toEqual({
      onlineTokenCount: 10,
      tokenAccountingComplete: true,
    })
  })

  it('returns partial stream records with only the reached milestones', () => {
    const timeline = scriptedTimeline([10, 20, 30])

    timeline.markEvidenceReady()
    timeline.onVisibleText('partial answer')

    expect(timeline.partial({ totalTokens: 120, incompleteRequestCount: 3 })).toEqual({
      evidenceReadyLatencyMs: 10,
      timeToFirstTokenMs: 20,
      tokenAccountingComplete: false,
    })
  })

  it('emits no token count when any request lacks usage telemetry', () => {
    const timeline = scriptedTimeline([10, 20, 30, 40])

    timeline.markEvidenceReady()
    timeline.onVisibleText('answer')

    expect(timeline.complete(() => ({ totalTokens: 130, incompleteRequestCount: 3 }))).toEqual({
      evidenceReadyLatencyMs: 10,
      timeToFirstTokenMs: 20,
      fullAnswerLatencyMs: 30,
      tokenAccountingComplete: false,
    })
  })

  it('rejects completed records with missing, non-finite, negative, or reversed time fields', () => {
    const valid: QuerySpeedRecord = {
      evidenceReadyLatencyMs: 10,
      timeToFirstTokenMs: 20,
      fullAnswerLatencyMs: 30,
      onlineTokenCount: 0,
      tokenAccountingComplete: true,
    }

    for (const record of [
      { ...valid, evidenceReadyLatencyMs: undefined },
      { ...valid, timeToFirstTokenMs: Number.NaN },
      { ...valid, fullAnswerLatencyMs: Number.POSITIVE_INFINITY },
      { ...valid, evidenceReadyLatencyMs: -1 },
      { ...valid, evidenceReadyLatencyMs: 21 },
      { ...valid, timeToFirstTokenMs: 9 },
    ]) {
      expect(() => assertCompletedSpeedRecord(record)).toThrow()
    }
  })

  it('allows generation-only completion without Evidence Ready', () => {
    const timeline = scriptedTimeline([10, 20, 30])
    timeline.onVisibleText('answer')

    expect(timeline.complete(() => ({ totalTokens: 110, incompleteRequestCount: 2 }), false)).toEqual({
      timeToFirstTokenMs: 10,
      fullAnswerLatencyMs: 20,
      onlineTokenCount: 10,
      tokenAccountingComplete: true,
    })
  })
})
