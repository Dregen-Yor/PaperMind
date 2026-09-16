import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfigs } from '../config'

let dir: string

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pm-semantic-tree-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const write = (name: string, content: unknown) => {
  const path = join(dir, `${name}.json`)
  writeFileSync(path, JSON.stringify(content))
  return path
}

const valid = {
  name: 'semantic-tree',
  kind: 'semantic-tree',
  matrix: { topK: [2], minScore: [4] },
  semanticTree: {
    evidence: { targetChars: 2400, maxChars: 3200, minChars: 1600 },
    maxInputChars: 120000,
  },
}

describe('loadConfigs — semantic-tree 配置', () => {
  it('接受合法的语义树配置并保留 kind 与建树参数', async () => {
    const configs = await loadConfigs(write('cfg', valid))
    expect(configs).toHaveLength(1)
    expect(configs[0]).toMatchObject({
      name: 'semantic-tree',
      kind: 'semantic-tree',
      topK: 2,
      minScore: 4,
      semanticTree: { evidence: { targetChars: 2400, maxChars: 3200, minChars: 1600 }, maxInputChars: 120000 },
    })
  })

  it('矩阵展开的每个配置都带 kind 与建树参数', async () => {
    const configs = await loadConfigs(write('cfg', { ...valid, matrix: { topK: [1, 2] } }))
    expect(configs).toHaveLength(2)
    expect(configs.every(c => c.kind === 'semantic-tree' && c.semanticTree)).toBe(true)
  })

  it('缺少 semanticTree 时拒绝', async () => {
    await expect(loadConfigs(write('cfg', { name: 'x', kind: 'semantic-tree', matrix: {} })))
      .rejects.toThrow(/semanticTree/)
  })

  it('maxChars 小于 targetChars 时拒绝', async () => {
    const bad = { ...valid, semanticTree: { ...valid.semanticTree, evidence: { targetChars: 3000, maxChars: 2000, minChars: 100 } } }
    await expect(loadConfigs(write('cfg', bad))).rejects.toThrow(/evidence/)
  })

  it('minChars 大于 targetChars 时拒绝', async () => {
    const bad = { ...valid, semanticTree: { ...valid.semanticTree, evidence: { targetChars: 2000, maxChars: 3000, minChars: 2500 } } }
    await expect(loadConfigs(write('cfg', bad))).rejects.toThrow(/evidence/)
  })

  it('非正整数 maxInputChars 时拒绝', async () => {
    const bad = { ...valid, semanticTree: { ...valid.semanticTree, maxInputChars: 0 } }
    await expect(loadConfigs(write('cfg', bad))).rejects.toThrow(/maxInputChars/)
  })

  it('缺少 evidence 时拒绝', async () => {
    const bad = { ...valid, semanticTree: { maxInputChars: 120000 } }
    await expect(loadConfigs(write('cfg', bad))).rejects.toThrow(/semanticTree/)
  })
})
