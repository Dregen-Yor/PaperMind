import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { calculateQ, parseQConfig, type QComponents } from '../scoring/qScore'

const config = parseQConfig({
  schemaVersion: 1,
  formula: 'weighted-geometric-relative-v1',
  baselineMode: 'full-context',
  weights: { answerF1: 0.6, ttftP50: 0.2, ttftP95: 0.2 },
})

const baseline: QComponents = {
  answerF1: 0.8,
  ttftP50: 1_000,
  ttftP95: 2_000,
}

describe('parseQConfig', () => {
  it('parses the checked-in scoring configuration', () => {
    const path = join(process.cwd(), 'bench/configs/scoring/q-score.json')
    const parsed = parseQConfig(JSON.parse(readFileSync(path, 'utf8')))

    expect(parsed).toEqual(config)
  })

  it('returns a clone and does not normalize weights', () => {
    const input = {
      schemaVersion: 1 as const,
      formula: 'weighted-geometric-relative-v1' as const,
      baselineMode: 'full-context' as const,
      weights: { answerF1: 0.6, ttftP50: 0.2, ttftP95: 0.2 },
    }
    const parsed = parseQConfig(input)

    expect(parsed).not.toBe(input)
    expect(parsed.weights).not.toBe(input.weights)
    expect(parsed.weights).toEqual(input.weights)
  })

  it.each([
    null,
    [],
    {},
    { ...config, schemaVersion: 2 },
    { ...config, formula: 'other' },
    { ...config, baselineMode: 'other' },
    { ...config, weights: null },
    { ...config, weights: { answerF1: 0.6, ttftP50: 0.4 } },
    { ...config, weights: { ...config.weights, extra: 1 } },
    { ...config, weights: { answerF1: '0.6', ttftP50: 0.2, ttftP95: 0.2 } },
    { ...config, weights: { answerF1: Number.NaN, ttftP50: 0.2, ttftP95: 0.2 } },
    { ...config, weights: { answerF1: Number.POSITIVE_INFINITY, ttftP50: 0.2, ttftP95: 0.2 } },
    { ...config, weights: { answerF1: 0, ttftP50: 0.5, ttftP95: 0.5 } },
    { ...config, weights: { answerF1: -0.1, ttftP50: 0.5, ttftP95: 0.6 } },
    { ...config, weights: { answerF1: 0.6, ttftP50: 0.2, ttftP95: 0.200000002 } },
  ])('rejects invalid configuration %#', invalid => {
    expect(() => parseQConfig(invalid)).toThrow()
  })
})

describe('calculateQ', () => {
  it('returns 100 for the reference itself', () => {
    expect(calculateQ(baseline, baseline, config)).toBeCloseTo(100)
  })

  it('combines quality and latency as a weighted geometric score', () => {
    const value = { answerF1: 0.76, ttftP50: 500, ttftP95: 1_000 }
    expect(calculateQ(value, baseline, config)).toBeCloseTo(100 * 0.95 ** 0.6 * 2 ** 0.4)
  })

  it('is invariant when both latency inputs use seconds instead of milliseconds', () => {
    const value = { answerF1: 0.76, ttftP50: 500, ttftP95: 1_000 }
    const secondsValue = { ...value, ttftP50: 0.5, ttftP95: 1 }
    const secondsBaseline = { ...baseline, ttftP50: 1, ttftP95: 2 }
    expect(calculateQ(secondsValue, secondsBaseline, config)).toBeCloseTo(calculateQ(value, baseline, config))
  })

  it('responds to changed weights without mutating inputs', () => {
    const value = { answerF1: 0.4, ttftP50: 500, ttftP95: 1_000 }
    const qualityHeavy = parseQConfig({ ...config, weights: { answerF1: 0.8, ttftP50: 0.1, ttftP95: 0.1 } })
    const before = structuredClone(value)

    expect(calculateQ(value, baseline, qualityHeavy)).not.toBe(calculateQ(value, baseline, config))
    expect(value).toEqual(before)
  })

  it('returns zero for zero value quality after validating all inputs', () => {
    expect(calculateQ({ ...baseline, answerF1: 0 }, baseline, config)).toBe(0)
    expect(() => calculateQ({ answerF1: 0, ttftP50: 2, ttftP95: 1 }, baseline, config)).toThrow()
    expect(() => calculateQ(
      { ...baseline, answerF1: 0 },
      baseline,
      { ...config, weights: { ...config.weights, answerF1: 0 } },
    )).toThrow()
  })

  it('rejects zero reference quality', () => {
    expect(() => calculateQ(baseline, { ...baseline, answerF1: 0 }, config)).toThrow()
  })

  it('subtracts logarithms so extreme finite ratios can cancel', () => {
    const value = { answerF1: 0.8, ttftP50: Number.MIN_VALUE, ttftP95: Number.MAX_VALUE }
    const reference = { answerF1: 0.8, ttftP50: 1, ttftP95: 1 }
    const latencyOnly = parseQConfig({
      ...config,
      weights: { answerF1: 0.0000000002, ttftP50: 0.4999999999, ttftP95: 0.4999999999 },
    })

    expect(calculateQ(value, reference, latencyOnly)).toBeGreaterThan(0)
    expect(calculateQ(value, reference, latencyOnly)).toBeLessThan(Number.POSITIVE_INFINITY)
  })

  it('rejects a non-finite final score produced by valid finite extremes', () => {
    const value = { answerF1: 1, ttftP50: Number.MIN_VALUE, ttftP95: Number.MIN_VALUE }
    const reference = {
      answerF1: Number.MIN_VALUE,
      ttftP50: Number.MAX_VALUE,
      ttftP95: Number.MAX_VALUE,
    }

    expect(() => calculateQ(value, reference, config)).toThrow(/finite/)
  })

  it.each([
    { ...baseline, answerF1: -0.1 },
    { ...baseline, answerF1: 1.1 },
    { ...baseline, answerF1: Number.NaN },
    { ...baseline, ttftP50: 0 },
    { ...baseline, ttftP50: Number.POSITIVE_INFINITY },
    { ...baseline, ttftP95: -1 },
    { ...baseline, ttftP50: 2_001 },
  ])('rejects invalid value components %#', value => {
    expect(() => calculateQ(value, baseline, config)).toThrow()
  })

  it.each([
    { ...baseline, answerF1: Number.POSITIVE_INFINITY },
    { ...baseline, ttftP50: Number.NaN },
    { ...baseline, ttftP95: 0 },
    { ...baseline, ttftP50: 2_001 },
  ])('rejects invalid reference components %#', reference => {
    expect(() => calculateQ(baseline, reference, config)).toThrow()
  })
})
