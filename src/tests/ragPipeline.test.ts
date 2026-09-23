import { describe, it, expect, vi } from 'vitest'
import type { IndexNode } from '../utils/pageIndex'
import type { ChatTurn } from '../utils/queryRewrite'
import type { Passage } from '../utils/passages'
import type { PassageIndex } from '../utils/passageIndex'
import type { StructureCard } from '../utils/structureCards'

// Node 环境缺 DOMMatrix，pageIndex 顶层会初始化 pdfjs worker
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: {},
  getDocument: vi.fn(),
}))

const {
  runRagPipeline,
  retrieveRagContext,
  generateRagAnswer,
  buildAnswerMessages,
  MATH_FORMAT_INSTRUCTION,
} =
  await import('../utils/ragPipeline')
const { materializeContext } = await import('../utils/contextTrace')
const { buildPassages, createEstimatingTokenCounter } = await import('../utils/passages')
const { buildTitleCards, cardsToIndexNodes } = await import('../utils/structureCards')
const { PASSAGE_INDEX_VERSION, passageConfigHash } = await import('../utils/passageIndex')

/** 与 contextTrace.test.ts 同款分词器：按空白切词并渲染为 ▁word。 */
const tokenizer = {
  tokenize: (text: string) => text.split(/\s+/).filter(Boolean).map(word => `▁${word}`),
}

function leaf(id: string, start: number, end: number): IndexNode {
  return { title: `S${id}`, nodeId: id, startPage: start, endPage: end, summary: `sum ${id}`, nodes: [] }
}

/** 多叶索引：scoreAndSelect 会实际发出打分请求 */
const multiLeafTree: IndexNode = {
  title: 'Paper', nodeId: 'root', startPage: 0, endPage: 3, summary: '', nodes: [leaf('0', 0, 1), leaf('1', 2, 3)],
}
/** 单叶索引：scoreAndSelect 短路，不发请求 */
const singleLeafTree: IndexNode = leaf('only', 0, 1)

const pages = ['p1', 'p2', 'p3', 'p4']
const EXPECTED_MATH_FORMAT_INSTRUCTION =
  '数学公式请使用 LaTeX：行内公式使用 $...$，独立公式使用 $$...$$。不要使用 \\(...\\) 或 \\[...\\] 包裹公式。'

describe('buildAnswerMessages', () => {
  it('pins the exact math-format instruction bytes', () => {
    expect(MATH_FORMAT_INSTRUCTION).toBe(EXPECTED_MATH_FORMAT_INSTRUCTION)
  })

  it('pins the exact messages for an empty context', () => {
    expect(buildAnswerMessages('', '问题', [], '你是助手')).toEqual([
      {
        role: 'system',
        content: `你是助手\n\n${EXPECTED_MATH_FORMAT_INSTRUCTION}`,
      },
      { role: 'user', content: '问题' },
    ])
  })

  it('pins the exact messages for non-empty context and a language-augmented prompt', () => {
    const systemPrompt = '你是助手\n\n请用英文作答。'
    const context = '第一段\n第二段'

    expect(buildAnswerMessages(context, 'What is it?', [], systemPrompt)).toEqual([
      {
        role: 'system',
        content: `${systemPrompt}\n\n${EXPECTED_MATH_FORMAT_INSTRUCTION}\n\n参考内容：\n${context}`,
      },
      { role: 'user', content: 'What is it?' },
    ])
  })

  it('keeps only the most recent generation history turns', () => {
    const history: ChatTurn[] = Array.from({ length: 21 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `turn-${index}`,
    }))

    expect(buildAnswerMessages('', 'current question', history, 'system')).toEqual([
      {
        role: 'system',
        content: `system\n\n${EXPECTED_MATH_FORMAT_INSTRUCTION}`,
      },
      ...history.slice(-19),
      { role: 'user', content: 'current question' },
    ])
  })

  it('passes the exported builder output unchanged to the generation model', async () => {
    const retrieval = {
      retrievals: [],
      retrievalQuery: 'query',
      rewritten: false,
      context: 'retrieved context',
      contextTruncated: false,
      sources: [],
      llmCalls: 0,
      treeRouted: false,
      queryRewriteLatencyMs: 0,
      retrievalLatencyMs: 0,
      pipelineStartedAt: 100,
    }
    const generate = vi.fn().mockResolvedValue('answer')

    await generateRagAnswer(retrieval, 'query', [{ role: 'user', content: 'earlier' }], generate, 'system')

    expect(generate).toHaveBeenCalledWith(
      buildAnswerMessages(retrieval.context, 'query', [{ role: 'user', content: 'earlier' }], 'system'),
    )
  })
})

describe('runRagPipeline', () => {
  it('caps the generation context at maxContextChars', async () => {
    const root: IndexNode = {
      title: 'Paper', nodeId: 'root', startPage: 0, endPage: 1, summary: '',
      nodes: [
        { title: 'A', nodeId: '0', startPage: 0, endPage: 0, summary: '', nodes: [] },
        { title: 'B', nodeId: '1', startPage: 1, endPage: 1, summary: '', nodes: [] },
      ],
    }
    const generate = vi.fn().mockResolvedValue('answer')
    const result = await runRagPipeline(
      [{ tree: root, pages: ['a'.repeat(40), 'b'.repeat(40)] }], 'q', [],
      vi.fn().mockResolvedValue('[{"id":0,"score":9},{"id":1,"score":8}]'), generate, 'system',
      { maxContextChars: 30 },
    )
    expect(result.context).toHaveLength(30)
    expect(result.contextTruncated).toBe(true)
    expect(generate.mock.calls[0][0][0].content).toContain('a'.repeat(30))
  })

  it('rejects a non-positive context limit', async () => {
    await expect(runRagPipeline([], 'q', [], vi.fn(), vi.fn(), 'system', { maxContextChars: 0 })).rejects.toThrow(/maxContextChars/)
  })
  it('无历史 + 单叶索引时只发生成这一次调用', async () => {
    const llm = vi.fn()
    const generate = vi.fn().mockResolvedValue('answer')

    const result = await runRagPipeline(
      [{ tree: singleLeafTree, pages }], '什么是注意力机制', [], llm, generate, 'sys',
    )

    expect(result.llmCalls).toBe(1)
    expect(llm).not.toHaveBeenCalled()
    expect(result.rewritten).toBe(false)
    expect(result.retrievalQuery).toBe('什么是注意力机制')
    expect(result.answer).toBe('answer')
    expect(result.sources).toEqual(['Pages 1–2: Sonly'])
  })

  it('历史达 2 轮 + 多叶索引时为改写/打分/生成三次调用', async () => {
    const llm = vi.fn()
      .mockResolvedValueOnce('自注意力机制的定义')          // rewriteQuery
      .mockResolvedValueOnce('[{"id":0,"score":9},{"id":1,"score":2}]') // scoreAndSelect
    const generate = vi.fn().mockResolvedValue('answer')

    const result = await runRagPipeline(
      [{ tree: multiLeafTree, pages }],
      '它的定义是什么',
      [{ role: 'user', content: '讲讲 transformer' }, { role: 'assistant', content: '好的' }],
      llm, generate, 'sys',
    )

    expect(result.llmCalls).toBe(3)
    expect(result.retrievalQuery).toBe('自注意力机制的定义')
    expect(result.rewritten).toBe(true)
    // score=2 未达 minScore 默认值 4，只选中首节点
    expect(result.retrievals[0].selected.map(n => n.nodeId)).toEqual(['0'])
  })

  it('enableRewrite=false 时跳过改写', async () => {
    const llm = vi.fn().mockResolvedValue('[{"id":0,"score":9}]')
    const generate = vi.fn().mockResolvedValue('answer')

    const result = await runRagPipeline(
      [{ tree: multiLeafTree, pages }],
      '原始问题',
      [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }],
      llm, generate, 'sys', { enableRewrite: false },
    )

    expect(result.llmCalls).toBe(2)
    expect(result.retrievalQuery).toBe('原始问题')
  })

  it('externalContext 提供时跳过改写与检索', async () => {
    const llm = vi.fn()
    const generate = vi.fn().mockResolvedValue('answer')

    const result = await runRagPipeline(
      [{ tree: multiLeafTree, pages }],
      '解释这段',
      [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }],
      llm, generate, 'sys', { externalContext: '用户划选的原文' },
    )

    expect(llm).not.toHaveBeenCalled()
    expect(result.llmCalls).toBe(1)
    expect(result.retrievals).toEqual([])
    expect(result.sources).toEqual([])
    expect(result.context).toBe('用户划选的原文')
    expect(generate.mock.calls[0][0][0].content).toContain('用户划选的原文')
  })

  it('system 提示词包含数学格式约束与参考内容，末条为当前提问', async () => {
    const llm = vi.fn().mockResolvedValue('[{"id":0,"score":9}]')
    const generate = vi.fn().mockResolvedValue('answer')

    await runRagPipeline(
      [{ tree: multiLeafTree, pages }], '问题', [{ role: 'user', content: '早先的话' }],
      llm, generate, '你是助手',
    )

    const messages = generate.mock.calls[0][0]
    expect(messages[0].role).toBe('system')
    expect(messages[0].content).toContain('你是助手')
    expect(messages[0].content).toContain(MATH_FORMAT_INSTRUCTION)
    expect(messages[0].content).toContain('参考内容：')
    expect(messages[1]).toEqual({ role: 'user', content: '早先的话' })
    expect(messages[messages.length - 1]).toEqual({ role: 'user', content: '问题' })
  })

  it('多篇论文的检索结果按入参顺序聚合，来源合并', async () => {
    const llm = vi.fn().mockResolvedValue('[{"id":0,"score":9},{"id":1,"score":8}]')
    const generate = vi.fn().mockResolvedValue('answer')

    const result = await runRagPipeline(
      [{ tree: multiLeafTree, pages }, { tree: singleLeafTree, pages }],
      '问题', [], llm, generate, 'sys',
    )

    expect(result.retrievals).toHaveLength(2)
    // 第一篇发一次打分，第二篇单叶短路；加生成共 2 次
    expect(result.llmCalls).toBe(2)
    expect(result.sources).toHaveLength(3)
    expect(result.context).toContain('---')
  })

  it('未注入 materializer 时结果里不存在页序 / token 字段（保持旧结果形状）', async () => {
    const result = await runRagPipeline(
      [{ tree: singleLeafTree, pages }], 'q', [], vi.fn(), vi.fn().mockResolvedValue('answer'), 'sys',
    )

    // 不是“值为 undefined”，而是键根本不出现：下游按字段缺席区分旧/新结果形状
    expect('contextPageOrder' in result).toBe(false)
    expect('contextTokenCount' in result).toBe(false)
  })
})

describe('runRagPipeline timing', () => {
  /** 注入脚本化时钟：返回预设时间序列，用尽后保持末值，与 Math.max(0, …) 钳制兼容。 */
  function scriptedClock(ts: number[]): () => number {
    let i = 0
    return () => (i < ts.length ? ts[i++] : ts[ts.length - 1])
  }

  it('无历史 + 单叶检索：rewrite 为 0，retrieval/generation/总时长精确符合时钟差', async () => {
    const llm = vi.fn()
    const generate = vi.fn().mockResolvedValue('answer')

    // pipeline 起点 → 检索起点 → 检索完成 → 生成起点 → 生成完成 → 结束
    const now = scriptedClock([100, 100, 140, 140, 190, 190])
    const result = await runRagPipeline(
      [{ tree: singleLeafTree, pages }], 'q', [], llm, generate, 'sys', {},
      { now },
    )

    expect(result.timing.queryRewriteLatencyMs).toBe(0)
    expect(result.timing.retrievalLatencyMs).toBe(40)
    expect(result.timing.answerGenerationLatencyMs).toBe(50)
    expect(result.timing.queryEndToEndLatencyMs).toBe(90)
  })

  it('有历史触发 rewrite：rewrite 时长独立计入，retrieval 覆盖 rewrite + 评分 + 上下文', async () => {
    const llm = vi.fn()
      .mockResolvedValueOnce('自注意力机制的定义')          // rewriteQuery
      .mockResolvedValueOnce('[{"id":0,"score":9},{"id":1,"score":2}]') // scoreAndSelect
    const generate = vi.fn().mockResolvedValue('answer')

    // 起点 → 检索起点 → 改写起点 → 改写完成 → 检索完成 → 生成起点 → 生成完成 → 结束
    const now = scriptedClock([100, 100, 100, 130, 150, 150, 220, 220])
    const result = await runRagPipeline(
      [{ tree: multiLeafTree, pages }],
      '它的定义是什么',
      [{ role: 'user', content: '讲讲 transformer' }, { role: 'assistant', content: '好的' }],
      llm, generate, 'sys', {}, { now },
    )

    expect(result.rewritten).toBe(true)
    expect(result.timing.queryRewriteLatencyMs).toBe(30)
    // 检索起点在改写之前：rewrite + 评分 + 上下文处理 = 150 - 100
    expect(result.timing.retrievalLatencyMs).toBe(50)
    expect(result.timing.answerGenerationLatencyMs).toBe(70)
    expect(result.timing.queryEndToEndLatencyMs).toBe(120)
  })

  it('externalContext：不调用评分，仍返回有限且非负的 retrieval 与总时长', async () => {
    const llm = vi.fn()
    const generate = vi.fn().mockResolvedValue('answer')

    // 起点 → 检索起点 → 检索完成（仅本地上下文准备）→ 生成起点 → 生成完成 → 结束
    const now = scriptedClock([100, 100, 105, 105, 155, 155])
    const result = await runRagPipeline(
      [{ tree: multiLeafTree, pages }], '解释这段',
      [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }],
      llm, generate, 'sys', { externalContext: '用户划选的原文' }, { now },
    )

    expect(llm).not.toHaveBeenCalled()
    expect(result.timing.retrievalLatencyMs).toBe(5)
    expect(result.timing.answerGenerationLatencyMs).toBe(50)
    expect(result.timing.queryEndToEndLatencyMs).toBe(55)
    for (const v of Object.values(result.timing)) {
      expect(Number.isFinite(v)).toBe(true)
      expect(v).toBeGreaterThanOrEqual(0)
    }
  })

  it('生成失败：保留抛错行为，不返回伪 timing 结果', async () => {
    const llm = vi.fn()
    const generate = vi.fn().mockRejectedValue(new Error('upstream down'))

    await expect(
      runRagPipeline(
        [{ tree: singleLeafTree, pages }], 'q', [], llm, generate, 'sys', {},
        { now: scriptedClock([100, 100, 140]) },
      ),
    ).rejects.toThrow('upstream down')
  })
})

describe('RAG 阶段拆分', () => {
  // 受控 token 预算的 materializer：与 benchmark 注入的是同一依赖（§4.1 / §5）
  const materialize = (maxTokens: number) =>
    (groups: Parameters<typeof materializeContext>[0]) => materializeContext(groups, tokenizer, maxTokens)

  it('生成失败时已完成的检索结果保持不变', async () => {
    // 两叶均高分：两个候选组都进入 materializer，页序覆盖第 1–2 页
    const complete = vi.fn().mockResolvedValue('[{"id":0,"score":9},{"id":1,"score":8}]')
    const retrieval = await retrieveRagContext(
      [{ tree: multiLeafTree, pages }], 'question', [], complete, {}, { materialize: materialize(2) },
    )
    expect(retrieval.contextPageOrder).toEqual([0, 1])
    expect(retrieval.contextTokenCount).toBe(2)
    expect(retrieval.context).toBe('p1 p2')

    await expect(
      generateRagAnswer(retrieval, 'question', [], async () => { throw new Error('generation failed') }, 'system'),
    ).rejects.toThrow('generation failed')

    // 生成抛错不得清空或改写已经算好的检索结果（§6.3）
    expect(retrieval.contextPageOrder).toEqual([0, 1])
    expect(retrieval.contextTokenCount).toBe(2)
    expect(retrieval.context).toBe('p1 p2')
  })

  it('生成提示词逐字使用 materializer 产出的上下文', async () => {
    const llm = vi.fn().mockResolvedValue('[{"id":0,"score":9},{"id":1,"score":8}]')
    const generate = vi.fn().mockResolvedValue('answer')

    const result = await runRagPipeline(
      [{ tree: multiLeafTree, pages }], 'question', [], llm, generate, 'system', {},
      { materialize: materialize(1) },
    )

    expect(generate.mock.calls[0][0][0].content).toContain(`参考内容：\n${result.context}`)
    expect(result.contextPageOrder).toEqual([0])
    expect(result.contextTokenCount).toBe(1)
  })

  it('externalContext 优先于 materializer：直接用外部文本且不产出页序 / token', async () => {
    const llm = vi.fn()
    const materializeSpy = vi.fn(materialize(1))

    const retrieval = await retrieveRagContext(
      [{ tree: multiLeafTree, pages }], '解释这段', [], llm,
      { externalContext: '用户划选的原文' }, { materialize: materializeSpy },
    )

    expect(llm).not.toHaveBeenCalled()
    // 外部上下文跳过检索，没有候选组可物化：materializer 根本不会被调用
    expect(materializeSpy).not.toHaveBeenCalled()
    expect(retrieval.context).toBe('用户划选的原文')
    expect(retrieval.contextPageOrder).toBeUndefined()
    expect(retrieval.contextTokenCount).toBeUndefined()
    // 未物化即回落字符语义：文本未超 maxContextChars，故为 false
    expect(retrieval.contextTruncated).toBe(false)
  })

  it('生成阶段不修改传入的检索结果（深冻结后成功与失败路径都安全）', async () => {
    /** 深冻结：一旦生成阶段试图写入任何嵌套字段，会立刻抛 TypeError 而非静默改坏检索结果。 */
    function deepFreeze<T>(value: T): T {
      if (value !== null && typeof value === 'object') {
        for (const key of Object.keys(value)) {
          deepFreeze((value as Record<string, unknown>)[key])
        }
        Object.freeze(value)
      }
      return value
    }

    // 用本测试私有的树，避免冻结共享 fixture 的叶节点
    const tree: IndexNode = {
      title: 'Paper', nodeId: 'root', startPage: 0, endPage: 3, summary: '',
      nodes: [leaf('l0', 0, 1), leaf('l1', 2, 3)],
    }
    const complete = vi.fn().mockResolvedValue('[{"id":0,"score":9},{"id":1,"score":8}]')
    const retrieval = await retrieveRagContext(
      [{ tree, pages }], 'question', [], complete, {}, { materialize: materialize(2) },
    )
    const before = JSON.stringify(retrieval)
    deepFreeze(retrieval)

    // 成功路径：冻结输入不得触发写入异常
    await expect(
      generateRagAnswer(retrieval, 'question', [], async () => 'answer', 'system'),
    ).resolves.toMatchObject({ answer: 'answer' })

    // 失败路径：抛出的必须是 generate 自身的错误，而不是冻结对象的写入错误
    await expect(
      generateRagAnswer(retrieval, 'question', [], async () => { throw new Error('generation failed') }, 'system'),
    ).rejects.toThrow('generation failed')

    expect(JSON.stringify(retrieval)).toBe(before)
  })
})

describe('retrieveRagContext 的段落路径', () => {
  const counter = createEstimatingTokenCounter()
  const passagePages = ['Abstract\nWe study retrieval on Europarl.', 'Methods\nWe use BM25 and dense encoders.']
  const passages = buildPassages(passagePages, counter, { minTokens: 1 })
  const cards = buildTitleCards(passages)
  const passageIndex: PassageIndex = {
    version: PASSAGE_INDEX_VERSION,
    stage: 1,
    passages,
    tree: cardsToIndexNodes(cards, passages),
    passageConfigHash: passageConfigHash({ schemaVersion: 2, segmentation: { minTokens: 1, maxTokens: 350 } }),
    separatorTokens: 2,
  }

  it('有 passageIndex 时走段落检索且检索阶段零 LLM 调用', async () => {
    const llm = vi.fn(async () => 'should not be called')
    const retrieval = await retrieveRagContext(
      [{ tree: passageIndex.tree, pages: passagePages, passageIndex }],
      'Europarl datasets',
      [],
      llm,
      {},
      {},
    )
    expect(retrieval.llmCalls).toBe(0)
    // 计数器之外再钉一次真实入参：只凭它，漏计数的分支仍会绿
    expect(llm).not.toHaveBeenCalled()
    expect(retrieval.retrievals[0].hybrid?.retrievalMode).toBe('bm25')
    expect(retrieval.retrievals[0].context).toContain('Europarl')
  })

  it('没有 passageIndex 时仍走旧路径（scoreAndSelect）', async () => {
    const llm = vi.fn(async () => JSON.stringify({ scores: [{ nodeId: 'root', score: 9 }] }))
    const retrieval = await retrieveRagContext(
      [{ tree: cardsToIndexNodes(cards, passages), pages: passagePages }],
      'Europarl',
      [],
      llm,
      {},
      {},
    )
    expect(retrieval.llmCalls).toBeGreaterThan(0)
    expect(retrieval.retrievals[0].hybrid).toBeUndefined()
  })

  it('多轮历史仍触发查询改写（段落路径不例外）', async () => {
    // 改写提示词（queryRewrite.ts）是全英文的，判据取它真实包含的 `Latest question:`，
    // 与生成提示词（含「参考内容：」）区分；llm 的入参是字符串，不是消息数组
    const llm = vi.fn(async (prompt: string) =>
      prompt.includes('Latest question:') ? 'rewritten query' : 'answer')
    const retrieval = await retrieveRagContext(
      [{ tree: passageIndex.tree, pages: passagePages, passageIndex }],
      'and the datasets?',
      [
        { role: 'user', content: 'What is this paper about?' },
        { role: 'assistant', content: 'It studies retrieval.' },
        { role: 'user', content: 'Which datasets?' },
        { role: 'assistant', content: 'Europarl.' },
      ],
      llm,
      {},
      {},
    )
    expect(retrieval.retrievalQuery).not.toBe('and the datasets?')
    // 改写输出要真的流回检索链路，而不是靠 mock 的回落分支或空串通过
    expect(retrieval.retrievalQuery).toBe('rewritten query')
  })

  it('混合论文逐篇分派：有段落索引的走段落路径，没有的仍走旧路径', async () => {
    // 过渡态：一篇已重建（v2 段落索引）、一篇仍是旧平面索引，各自按手上的索引分派
    const llm = vi.fn(async () => '[{"id":0,"score":9},{"id":1,"score":2}]')
    const retrieval = await retrieveRagContext(
      [
        { tree: passageIndex.tree, pages: passagePages, passageIndex },
        { tree: cardsToIndexNodes(cards, passages), pages: passagePages },
      ],
      'Europarl datasets',
      [],
      llm,
      {},
      {},
    )
    expect(retrieval.retrievals).toHaveLength(2)
    expect(retrieval.retrievals[0].hybrid).toBeDefined()
    expect(retrieval.retrievals[1].hybrid).toBeUndefined()
    // 只有旧路径那篇发出打分请求：段落那篇检索阶段零 LLM 调用
    expect(retrieval.llmCalls).toBe(1)
    expect(retrieval.treeRouted).toBe(false)
  })

  it('只有注入 deps.passage.embedder 才走得到依赖向量的 full 模式', async () => {
    // 同一篇论文、同一份索引：段落向量与卡片向量都在，差别只在 deps.passage 有没有被转发下去。
    // 少了这条用例，把 `deps.passage.embedder` 从转发里漏掉也照样全绿（检索静默退回词法）
    const dim = 4
    const unit = (seed: number) => {
      const vector = new Float32Array(dim)
      vector[seed % dim] = 1
      return vector
    }
    const embedder = {
      id: 'test-embedder',
      embedQuery: vi.fn(async () => unit(0)),
      embedPassages: vi.fn(async (texts: string[]) => texts.map((_, index) => unit(index))),
    }
    const denseIndex: PassageIndex = {
      ...passageIndex,
      stage: 3,
      embedderId: embedder.id,
      vectorDim: dim,
      passageVectors: passages.map((_, index) => unit(index)),
      cards,
      cardVectors: cards.map((_, index) => unit(index)),
    }
    const paper = { tree: denseIndex.tree, pages: passagePages, passageIndex: denseIndex }
    const llm = vi.fn(async () => 'should not be called')

    const dense = await retrieveRagContext(
      [paper], 'Europarl datasets', [], llm, {}, { passage: { embedder } },
    )
    expect(dense.retrievals[0].hybrid?.retrievalMode).toBe('full')
    // 模式名之外再钉一次入参：模型真的被调用过，而不是模式名碰巧对上
    expect(embedder.embedQuery).toHaveBeenCalledTimes(1)

    // 正对照：同一篇论文不注入 deps 时一路向量都不读。卡片在索引里，所以词法模式是
    // 「BM25 + 卡片文本 BM25」（方案 §4 的降级表），而不是裸 bm25
    const lexical = await retrieveRagContext([paper], 'Europarl datasets', [], llm, {}, {})
    expect(lexical.retrievals[0].hybrid?.retrievalMode).toBe('bm25+card-lexical')
    expect(embedder.embedQuery).toHaveBeenCalledTimes(1)
  })

  it('转发 sectionWeight：卡片先验的权重真的改变融合选段（R42）', async () => {
    // 手工索引：4 段各 40 token、预算 45 → 只有融合第一名放得下，选段结果就是融合名次的直接读数。
    // 两路名次故意错开：BM25（查询 'alpha'）为 P02 > P01 > P03 > P04（只有 P02 命中该词），
    // 卡片词法先验为 P01 > P03 > P04 > P02（卡片标题里 alpha 分别出现 3 / 1 / 1 / 0 次）。
    // 于是 sectionWeight=0 时卡片路不计权（等于关掉卡片先验）→ BM25 第一名 P02 胜出；
    // sectionWeight=1 时 P01 的卡片第 1 名压过 P02 的卡片第 4 名，把 BM25 第 2 名抬成融合第一。
    // 两次检索的入参只差 sectionWeight，结果不同只可能来自这条转发（未转发时两次都吃默认 0.5）。
    const makePassage = (order: number, text: string, subsection: string): Passage => {
      const id = `P${String(order + 1).padStart(2, '0')}`
      return {
        id,
        order,
        pieces: [{ page: order, text }],
        text,
        searchText: text,
        // 预算只放得下一段：40 ≤ 45，任意两段 40 + 2 + 40 > 45
        tokenCount: 40,
        prevId: order > 0 ? `P${String(order).padStart(2, '0')}` : null,
        nextId: order < 3 ? `P${String(order + 2).padStart(2, '0')}` : null,
        subsection,
      }
    }
    const fusionPassages = [
      makePassage(0, 'Overview of the ranking protocol.', 'Overview'),
      makePassage(1, 'We evaluate on the alpha dataset.', 'Evaluation'),
      makePassage(2, 'Notes on the evaluation metrics.', 'Metrics'),
      makePassage(3, 'Ablation details and caveats.', 'Ablation'),
    ]
    const fusionCards: StructureCard[] = [
      { id: 'S1', range: ['P01', 'P01'], title: 'Alpha alpha alpha retrieval', summary: '', keyTerms: [] },
      { id: 'S2', range: ['P03', 'P03'], title: 'Alpha notes', summary: '', keyTerms: [] },
      { id: 'S3', range: ['P04', 'P04'], title: 'Alpha caveats', summary: '', keyTerms: [] },
      { id: 'S4', range: ['P02', 'P02'], title: 'Beta baseline', summary: '', keyTerms: [] },
    ]
    const fusionIndex: PassageIndex = {
      version: PASSAGE_INDEX_VERSION,
      stage: 3,
      passages: fusionPassages,
      cards: fusionCards,
      tree: cardsToIndexNodes(fusionCards, fusionPassages),
      passageConfigHash: passageConfigHash({ schemaVersion: 2, segmentation: { minTokens: 1, maxTokens: 350 } }),
      separatorTokens: 2,
    }
    const paper = {
      tree: fusionIndex.tree,
      pages: fusionPassages.map(passage => passage.text),
      passageIndex: fusionIndex,
    }
    const llm = vi.fn(async () => 'should not be called')

    const cardPriorOff = await retrieveRagContext(
      [paper], 'alpha', [], llm, {}, { passage: { maxTokens: 45, sectionWeight: 0 } },
    )
    const cardPriorOn = await retrieveRagContext(
      [paper], 'alpha', [], llm, {}, { passage: { maxTokens: 45, sectionWeight: 1 } },
    )

    // 卡片路真的在（否则 sectionWeight 只是一个被忽略的数字），且两次真的走了同一条融合路径
    expect(cardPriorOff.retrievals[0].hybrid?.retrievalMode).toBe('bm25+card-lexical')
    expect(cardPriorOn.retrievals[0].hybrid?.retrievalMode).toBe('bm25+card-lexical')
    expect(cardPriorOff.retrievals[0].hybrid?.selectedPassageIds).toEqual(['P02'])
    expect(cardPriorOn.retrievals[0].hybrid?.selectedPassageIds).toEqual(['P01'])
    expect(llm).not.toHaveBeenCalled()
  })
})
