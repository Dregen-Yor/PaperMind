import { describe, expect, it } from 'vitest'
import { renderQComparison } from '../scoring/qReport'
import { buildQComparison } from '../scoring/qComparison'
import { qConfig, qFixture } from './qFixture'

describe('renderQComparison', () => {
  it('renders weights, reference baseline, components, and display precision', () => {
    const comparison = buildQComparison(qFixture('reference', 'full-context'), qFixture('candidate'), qConfig)
    const report = renderQComparison(comparison)
    expect(report).toContain('100.00')
    expect(report).toContain('0.6')
    expect(report).toContain('0.2')
    expect(report).toContain('answerF1AllQuestions')
    expect(report).toContain('timeToFirstTokenP50Ms')
    expect(report).toContain('timeToFirstTokenP95Ms')
  })

  it('renders unavailable score and all reasons without inventing zero', () => {
    const comparison = buildQComparison(qFixture('reference', 'full-context'), qFixture('candidate'), qConfig)
    comparison.score = null
    comparison.reasons = ['first reason', 'second reason']
    const report = renderQComparison(comparison)
    expect(report).toContain('—')
    expect(report).toContain('first reason')
    expect(report).toContain('second reason')
  })
})
