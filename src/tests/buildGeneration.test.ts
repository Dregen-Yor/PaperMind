import { describe, expect, it } from 'vitest'
import { createBuildGeneration } from '../utils/buildGeneration'

describe('createBuildGeneration', () => {
  it('begin 返回的代次在无失效时一直有效', () => {
    const generation = createBuildGeneration()
    const token = generation.begin('p1')
    expect(generation.isCurrent('p1', token)).toBe(true)
  })

  it('invalidate 之后旧代次作废，新代次有效', () => {
    const generation = createBuildGeneration()
    const stale = generation.begin('p1')
    generation.invalidate('p1')
    const fresh = generation.begin('p1')
    expect(generation.isCurrent('p1', stale)).toBe(false)
    expect(generation.isCurrent('p1', fresh)).toBe(true)
  })

  it('不同论文互不影响', () => {
    const generation = createBuildGeneration()
    const p1 = generation.begin('p1')
    const p2 = generation.begin('p2')
    generation.invalidate('p1')
    expect(generation.isCurrent('p1', p1)).toBe(false)
    expect(generation.isCurrent('p2', p2)).toBe(true)
  })

  it('invalidateAll 让所有在途构建作废（切换索引 profile 时用）', () => {
    const generation = createBuildGeneration()
    const p1 = generation.begin('p1')
    const p2 = generation.begin('p2')
    generation.invalidateAll()
    expect(generation.isCurrent('p1', p1)).toBe(false)
    expect(generation.isCurrent('p2', p2)).toBe(false)
    expect(generation.isCurrent('p1', generation.begin('p1'))).toBe(true)
  })

  it('从未 begin 过的论文对任意代号都不有效（避免默认 0 蒙对）', () => {
    const generation = createBuildGeneration()
    expect(generation.isCurrent('unknown', 1)).toBe(false)
    expect(generation.isCurrent('unknown', 0)).toBe(false)
  })
})
