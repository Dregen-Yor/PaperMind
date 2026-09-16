import { describe, it, expect, vi } from 'vitest'
import type { EvidenceBlock } from '../utils/evidenceBlock'
import {
  buildSemanticTree,
  parseSemanticTree,
  validateSemanticTree,
  buildSemanticTreePrompt,
  SemanticTreeBuildError,
  MAX_TREE_NODES,
  MAX_TREE_LEVEL1,
  MAX_TREE_LEVEL2,
  SEMANTIC_TREE_SCHEMA_VERSION,
  semanticTreeConfigHash,
  type SemanticNode,
  type SemanticTreeFailure,
} from '../utils/semanticTree'

const block = (order: number, overrides: Partial<EvidenceBlock> = {}): EvidenceBlock => {
  const id = `B${String(order + 1).padStart(3, '0')}`
  return {
    id,
    rawText: `text of ${id}`,
    normalizedText: `text of ${id}`,
    startPage: order,
    endPage: order,
    order,
    previousId: null,
    nextId: null,
    sourceType: 'body',
    ...overrides,
  }
}

const BLOCKS = Array.from({ length: 12 }, (_, i) => block(i))

const node = (overrides: Partial<SemanticNode> & { id: string }): SemanticNode => ({
  label: `label ${overrides.id}`,
  description: 'one sentence describing the role',
  relationToParent: 'constitutes',
  evidenceRefs: ['B001'],
  children: [],
  ...overrides,
})

/** 合法的两层树：root + 3 个一级模块，共 6 个二级证据簇。 */
function validTree(): unknown {
  return {
    root: node({
      id: 'r',
      label: '跨层表示对齐是本文核心主张',
      relationToParent: null,
      evidenceRefs: ['B001'],
      children: [1, 2, 3].map(i => node({
        id: `a${i}`,
        evidenceRefs: [`B002`, `B003`],
        children: [1, 2].map(j => node({
          id: `a${i}b${j}`,
          evidenceRefs: [`B00${2 + j}`],
        })),
      })),
    }),
  }
}

const failureOf = (value: unknown, blocks = BLOCKS): SemanticTreeFailure | undefined =>
  validateSemanticTree(value, blocks).failure

describe('parseSemanticTree', () => {
  it('剥离 ```json 代码围栏', () => {
    const result = parseSemanticTree('```json\n{"root":{"id":"r"}}\n```')
    expect(result).toEqual({ root: { id: 'r' } })
  })

  it('从前后夹杂的自然语言中取出最外层 JSON 对象', () => {
    const result = parseSemanticTree('好的，结果如下：\n{"root":{"id":"r"}}\n希望对你有帮助。')
    expect(result).toEqual({ root: { id: 'r' } })
  })

  it('不是 JSON 时抛语义树构建错误', () => {
    expect(() => parseSemanticTree('not json at all')).toThrow(SemanticTreeBuildError)
  })

  it('JSON 合法但不是对象时抛错', () => {
    expect(() => parseSemanticTree('[1,2,3]')).toThrow(SemanticTreeBuildError)
  })
})

describe('validateSemanticTree — 接受合法结构', () => {
  it('接受两层完整树', () => {
    const result = validateSemanticTree(validTree(), BLOCKS)
    expect(result.ok).toBe(true)
    expect(result.tree?.root.children).toHaveLength(3)
  })

  it('接受只有一层的简单论文（§6.2 不要求凑满分支）', () => {
    const result = validateSemanticTree({
      root: node({ id: 'r', relationToParent: null, children: [node({ id: 'a1' }), node({ id: 'a2' })] }),
    }, BLOCKS)
    expect(result.ok).toBe(true)
  })

  it('补全 schemaVersion 与 promptVersion', () => {
    const result = validateSemanticTree(validTree(), BLOCKS)
    expect(result.tree?.schemaVersion).toBe(SEMANTIC_TREE_SCHEMA_VERSION)
    expect(typeof result.tree?.promptVersion).toBe('string')
  })

  it('根节点没有 relationToParent 也合法', () => {
    const tree = validTree() as { root: SemanticNode }
    delete (tree.root as Partial<SemanticNode>).relationToParent
    expect(validateSemanticTree(tree, BLOCKS).ok).toBe(true)
  })
})

describe('validateSemanticTree — 规模限制（§6.2）', () => {
  const withLevel1 = (count: number) => ({
    root: node({
      id: 'r',
      relationToParent: null,
      children: Array.from({ length: count }, (_, i) => node({ id: `a${i}` })),
    }),
  })

  it(`拒绝超过 ${MAX_TREE_LEVEL1} 个一级模块`, () => {
    expect(failureOf(withLevel1(MAX_TREE_LEVEL1))).toBeUndefined()
    expect(failureOf(withLevel1(MAX_TREE_LEVEL1 + 1))).toBe('size-limit')
  })

  it(`拒绝超过 ${MAX_TREE_LEVEL2} 个二级证据簇`, () => {
    const withLevel2 = (perParent: number) => ({
      root: node({
        id: 'r',
        relationToParent: null,
        children: [1, 2].map(i => node({
          id: `a${i}`,
          children: Array.from({ length: perParent }, (_, j) => node({ id: `a${i}b${j}` })),
        })),
      }),
    })
    expect(failureOf(withLevel2(MAX_TREE_LEVEL2 / 2))).toBeUndefined()
    expect(failureOf(withLevel2(MAX_TREE_LEVEL2 / 2 + 1))).toBe('size-limit')
  })

  it(`接受恰好 ${MAX_TREE_NODES} 个节点、拒绝更多`, () => {
    const build = (level1: number, perParent: number) => ({
      root: node({
        id: 'r',
        relationToParent: null,
        children: Array.from({ length: level1 }, (_, i) => node({
          id: `a${i}`,
          children: Array.from({ length: perParent }, (_, j) => node({ id: `a${i}b${j}` })),
        })),
      }),
    })
    // 1 + 5 + 10 = 16，两层上限同时用满，合法
    expect(failureOf(build(5, 2))).toBeUndefined()
    // 1 + 5 + 15 = 21，二级超出 10 的上限
    expect(failureOf(build(5, 3))).toBe('size-limit')
  })

  it('拒绝第三层节点', () => {
    expect(failureOf({
      root: node({
        id: 'r',
        relationToParent: null,
        children: [node({ id: 'a1', children: [node({ id: 'a1b1', children: [node({ id: 'deep' })] })] })],
      }),
    })).toBe('size-limit')
  })
})

describe('validateSemanticTree — 结构完整性（§8.3）', () => {
  it('拒绝重复的节点 ID', () => {
    expect(failureOf({
      root: node({
        id: 'r',
        relationToParent: null,
        children: [node({ id: 'dup' }), node({ id: 'dup' })],
      }),
    })).toBe('invalid-structure')
  })

  it('拒绝根节点缺失', () => {
    expect(failureOf({})).toBe('invalid-structure')
  })

  it('拒绝非根节点缺少 relationToParent', () => {
    expect(failureOf({
      root: node({ id: 'r', relationToParent: null, children: [node({ id: 'a1', relationToParent: null })] }),
    })).toBe('invalid-structure')
  })

  it('拒绝未知的语义关系', () => {
    expect(failureOf({
      root: node({ id: 'r', relationToParent: null, children: [node({ id: 'a1', relationToParent: 'resembles' as never })] }),
    })).toBe('invalid-structure')
  })

  it('拒绝空 label 或空 description', () => {
    expect(failureOf({ root: node({ id: 'r', relationToParent: null, children: [node({ id: 'a1', label: '   ' })] }) }))
      .toBe('invalid-structure')
    expect(failureOf({ root: node({ id: 'r', relationToParent: null, children: [node({ id: 'a1', description: '' })] }) }))
      .toBe('invalid-structure')
  })

  it('拒绝引用了不存在的证据块', () => {
    expect(failureOf({
      root: node({ id: 'r', relationToParent: null, children: [node({ id: 'a1', evidenceRefs: ['B999'] })] }),
    })).toBe('invalid-evidence-ref')
  })

  it('拒绝 evidenceRefs 不是字符串数组', () => {
    expect(failureOf({
      root: node({ id: 'r', relationToParent: null, children: [node({ id: 'a1', evidenceRefs: [1] as never })] }),
    })).toBe('invalid-structure')
  })

  it('拒绝 children 不是数组', () => {
    expect(failureOf({
      root: node({ id: 'r', relationToParent: null, children: 'nope' as never }),
    })).toBe('invalid-structure')
  })
})

describe('validateSemanticTree — 通用章节名检视（§7.2）', () => {
  it.each([
    'Introduction',
    'Related Work',
    'Method',
    '  3. Experiments  ',
    'Results',
    'Conclusion',
    '引言',
    '2 相关工作',
    '实验设置',
  ])('拒绝以通用章节名充当节点名：%s', label => {
    expect(failureOf({
      root: node({ id: 'r', relationToParent: null, children: [node({ id: 'a1', label })] }),
    })).toBe('generic-label')
  })

  it('接受论文特有的语义命名', () => {
    expect(validateSemanticTree({
      root: node({ id: 'r', relationToParent: null, children: [node({ id: 'a1', label: '跨层表示对齐机制' })] }),
    }, BLOCKS).ok).toBe(true)
  })
})

describe('validateSemanticTree — 诊断指标（§11.4）', () => {
  it('统计节点数、层数与每层规模', () => {
    const { diagnostics } = validateSemanticTree(validTree(), BLOCKS)
    expect(diagnostics).toMatchObject({ nodeCount: 1 + 3 + 6, depth: 2, level1Count: 3, level2Count: 6 })
  })

  it('统计证据块覆盖率', () => {
    const { diagnostics } = validateSemanticTree({
      root: node({ id: 'r', relationToParent: null, evidenceRefs: ['B001', 'B002'], children: [] }),
    }, BLOCKS)
    expect(diagnostics.evidenceCoverage).toBeCloseTo(2 / 12)
    expect(diagnostics.referencedBlockCount).toBe(2)
  })

  it('统计被多个节点共引的证据块（§6.5 多重归属）', () => {
    const { diagnostics } = validateSemanticTree({
      root: node({
        id: 'r',
        relationToParent: null,
        evidenceRefs: ['B001'],
        children: [node({ id: 'a1', evidenceRefs: ['B001'] }), node({ id: 'a2', evidenceRefs: ['B005'] })],
      }),
    }, BLOCKS)
    expect(diagnostics.sharedBlockCount).toBe(1)
  })

  it('统计引用跨越非连续区块的节点（跨章节取证）', () => {
    const { diagnostics } = validateSemanticTree({
      root: node({
        id: 'r',
        relationToParent: null,
        evidenceRefs: ['B002', 'B008'],
        children: [],
      }),
    }, BLOCKS)
    expect(diagnostics.crossSectionNodeCount).toBe(1)
  })

  it('连续引用不计入跨区块节点', () => {
    const { diagnostics } = validateSemanticTree({
      root: node({ id: 'r', relationToParent: null, evidenceRefs: ['B002', 'B003', 'B004'], children: [] }),
    }, BLOCKS)
    expect(diagnostics.crossSectionNodeCount).toBe(0)
  })
})

describe('buildSemanticTreePrompt（§7.1 只按语义构造）', () => {
  const prompt = buildSemanticTreePrompt(BLOCKS)

  it('按原文顺序列出每个证据块及其稳定 ID', () => {
    for (const b of BLOCKS) expect(prompt).toContain(b.id)
    expect(prompt.indexOf('B001')).toBeLessThan(prompt.indexOf('B002'))
  })

  it('明确禁止以章节标题或页码连续性构造父子结构', () => {
    expect(prompt).toMatch(/不得|禁止/)
    expect(prompt).toContain('章节')
    expect(prompt).toContain('页码')
  })

  it('给出结构化输出契约与语义关系词表', () => {
    expect(prompt).toContain('relationToParent')
    expect(prompt).toContain('evidenceRefs')
    expect(prompt).toContain('constitutes')
    expect(prompt).toContain('limits')
  })

  it('写明节点数与层数上限', () => {
    expect(prompt).toContain(String(MAX_TREE_NODES))
  })
})

describe('buildSemanticTree', () => {
  const llmReturning = (payload: unknown) => vi.fn(async () => JSON.stringify(payload))

  it('整篇论文只发一次 LLM 调用', async () => {
    const llm = llmReturning(validTree())
    await buildSemanticTree(BLOCKS, llm)
    expect(llm).toHaveBeenCalledTimes(1)
  })

  it('返回校验后的树与构建元信息', async () => {
    const llm = llmReturning(validTree())
    const { tree, meta } = await buildSemanticTree(BLOCKS, llm, { now: (() => { let t = 0; return () => (t += 25) })() })
    expect(tree.root.children).toHaveLength(3)
    expect(meta).toMatchObject({ llmCalls: 1, nodeCount: 10, depth: 2, level1Count: 3, level2Count: 6 })
    expect(meta.latencyMs).toBe(25)
    expect(meta.inputTokens).toBeGreaterThan(0)
    expect(meta.outputTokens).toBeGreaterThan(0)
  })

  it('输入超过上下文预算时不发请求，直接以 unsupported 失败（§8.2 降级）', async () => {
    const llm = llmReturning(validTree())
    await expect(buildSemanticTree(BLOCKS, llm, { maxInputChars: 10 }))
      .rejects.toMatchObject({ reason: 'input-too-large' })
    expect(llm).not.toHaveBeenCalled()
  })

  it('LLM 抛错时以 llm-failed 失败', async () => {
    const llm = vi.fn(async () => { throw new Error('network down') })
    await expect(buildSemanticTree(BLOCKS, llm)).rejects.toMatchObject({ reason: 'llm-failed' })
  })

  it('输出非法结构时以 invalid-structure 失败，绝不写入半成品树', async () => {
    const llm = llmReturning({ root: node({ id: 'r', relationToParent: null, children: [node({ id: 'a', evidenceRefs: ['B999'] })] }) })
    await expect(buildSemanticTree(BLOCKS, llm)).rejects.toMatchObject({ reason: 'invalid-evidence-ref' })
  })

  it('没有可用证据块时不发请求', async () => {
    const llm = llmReturning(validTree())
    await expect(buildSemanticTree([], llm)).rejects.toMatchObject({ reason: 'no-evidence' })
    expect(llm).not.toHaveBeenCalled()
  })
})

describe('semanticTreeConfigHash — 建树缓存身份（§10.3）', () => {
  const baseConfig = () => ({
    schemaVersion: SEMANTIC_TREE_SCHEMA_VERSION,
    promptVersion: 'v1',
    evidence: { targetChars: 2400, maxChars: 3200, minChars: 1600 },
    maxInputChars: 120_000,
    model: 'openai:gpt-4o@https://api.openai.com/v1',
  })

  it('同一配置得到同一个指纹', () => {
    expect(semanticTreeConfigHash(baseConfig())).toBe(semanticTreeConfigHash(baseConfig()))
  })

  it.each([
    ['schema 版本', { schemaVersion: 2 }],
    ['提示词版本', { promptVersion: 'v2' }],
    ['建树模型或端点', { model: 'openai:gpt-4o-mini@https://api.openai.com/v1' }],
    ['输入字符上限', { maxInputChars: 60_000 }],
    ['证据块目标长度', { evidence: { targetChars: 1200, maxChars: 3200, minChars: 1600 } }],
    ['证据块最大长度', { evidence: { targetChars: 2400, maxChars: 4800, minChars: 1600 } }],
    ['证据块最小长度', { evidence: { targetChars: 2400, maxChars: 3200, minChars: 800 } }],
  ])('%s 变化都会让指纹失效', (_name, patch) => {
    const changed = { ...baseConfig(), ...patch }
    expect(semanticTreeConfigHash(changed)).not.toBe(semanticTreeConfigHash(baseConfig()))
  })

  it('字段构造顺序不影响指纹（序列化不依赖键序）', () => {
    const reordered = {
      model: 'openai:gpt-4o@https://api.openai.com/v1',
      maxInputChars: 120_000,
      evidence: { minChars: 1600, maxChars: 3200, targetChars: 2400 },
      promptVersion: 'v1',
      schemaVersion: SEMANTIC_TREE_SCHEMA_VERSION,
    }
    expect(semanticTreeConfigHash(reordered)).toBe(semanticTreeConfigHash(baseConfig()))
  })
})
