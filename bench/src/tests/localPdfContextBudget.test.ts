// @vitest-environment node
import { expect, it } from 'vitest'
import { graphemePrefixWithinBudget } from '../localPdf/context'

it('finds the longest legal prefix despite nonmonotonic token counts', () => {
  const counts = [0, 1, 4, 2, 5]
  expect(graphemePrefixWithinBudget('', 'abcd', s => counts[s.length], 2)).toBe(3)
})
it('never cuts a grapheme and handles full, empty and impossible fits', () => {
  const text = 'a👩‍🔬e\u0301'
  const calls: string[] = []
  expect(graphemePrefixWithinBudget('', text, s => { calls.push(s); return s.length }, 5)).toBe(1)
  expect(calls.every(s => ['', 'a', 'a👩‍🔬', text].includes(s))).toBe(true)
  expect(graphemePrefixWithinBudget('x', '', s => s.length, 1)).toBe(0)
  expect(graphemePrefixWithinBudget('', text, s => s.length, 100)).toBe(text.length)
  expect(graphemePrefixWithinBudget('base', 'abc', s => s.length, 1)).toBe(0)
})
it('does not re-tokenize every shorter prefix when a near-end prefix fits', () => {
  let calls = 0
  expect(graphemePrefixWithinBudget('', 'a'.repeat(100), s => { calls++; return s.length }, 99)).toBe(99)
  expect(calls).toBe(2)
})
