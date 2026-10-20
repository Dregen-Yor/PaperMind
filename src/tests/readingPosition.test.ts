import { afterEach, describe, expect, it, vi } from 'vitest'
import { readReadingPosition, saveReadingPosition } from '../utils/readingPosition'

afterEach(() => vi.unstubAllGlobals())

describe('persisted reading position', () => {
  it.each(['not json', 'null', '{"page":0,"offset":0}', '{"page":2.5,"offset":0}', '{"page":2,"offset":2}', '{"page":2,"offset":"0.4"}'])('ignores malformed saved data %s', value => {
    vi.stubGlobal('localStorage', { getItem: () => value })
    expect(readReadingPosition('p', 10)).toBeNull()
  })
  it('clamps an old page to the current document length and retains a valid page offset', () => {
    vi.stubGlobal('localStorage', { getItem: () => '{"page":900,"offset":0.4}' })
    expect(readReadingPosition('p', 4)).toEqual({ page: 4, offset: .4 })
  })
  it('tolerates unavailable storage on both opening and leaving a paper', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('disabled') }, setItem: () => { throw new Error('full') } })
    expect(readReadingPosition('p', 4)).toBeNull()
    expect(() => saveReadingPosition('p', { page: 2, offset: .4 })).not.toThrow()
  })
})
