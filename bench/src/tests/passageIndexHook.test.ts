/**
 * 段落索引 hook 的 A/B/C 模式行为（方案 §3.0）。
 *
 * 三条不变量钉在这里：
 * 1. **零生成式 LLM 调用**：A/B/C 三个臂都不得调用 `client.complete`（阶段③ 被 `buildStructure:false` 砍掉）。
 * 2. **模式决定冷启动阶段**：A 连 embedder 都不碰、无向量；B 到阶段②；C 到阶段② 再加原生目录索引与节点向量。
 * 3. **目录失败与卡片失败是两回事**：目录解析/向量失败只写进 `outline.fallbackReason`，绝不冒充
 *    LLM 结构回落、绝不编造 LLM token 或成本，也不让整轮失败。
 */
import { describe, expect, it, vi } from 'vitest'
import { createPassageIndexHook, outlineNodeEmbedText, type HybridKnobs } from '../runner/passageIndexHook'
import type { LlmClient } from '../llmClient'
import type { EvalSample } from '../types'
import type { Embedder } from '../../../src/utils/embedder'
import type { PdfOutlineEntry } from '../../../src/utils/pdfOutline'

/** 与受控物化同一口径的确定性分词器：空白切词、1 词 1 token。 */
const tokenizer = { tokenize: (text: string) => text.split(/\s+/).filter(Boolean).map(word => `▁${word}`) }
const countTokens = (text: string) => tokenizer.tokenize(text).length

const PAGES = [
  'Abstract\nWe study retrieval under a fixed budget.',
  'Introduction\nRetrieval matters for search.',
  'Methods\nWe use BM25 and vectors.',
]

const KNOBS: HybridKnobs = {
  minTokens: 1,
  maxTokens: 30,
  maxInputChars: 120_000,
  rrfK: 60,
  sectionWeight: 0.5,
  neighbourFactor: 0.5,
  skipLimit: 20,
}

const SAMPLE: EvalSample = { paperId: 'p1', title: 'Paper 1', pages: PAGES, source: 'pdf-study', questions: [] }

/** 一个两级目录：Introduction（0）、Methods（1）→ Retrieval（1，Methods 的子节点）。 */
const OUTLINE: PdfOutlineEntry[] = [
  { id: '0', title: 'Introduction', page: 0, children: [] },
  { id: '1', title: 'Methods', page: 1, children: [{ id: '1.0', title: 'Retrieval', page: 1, children: [] }] },
]

function fakeEmbedder(): Embedder & { embedPassages: ReturnType<typeof vi.fn>; embedQuery: ReturnType<typeof vi.fn> } {
  return {
    id: 'fake@main#q8',
    embedQuery: vi.fn(async () => new Float32Array([1, 0])),
    embedPassages: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array([1, 0]))),
  } as Embedder & { embedPassages: ReturnType<typeof vi.fn>; embedQuery: ReturnType<typeof vi.fn> }
}

function stubClient(): { client: LlmClient; complete: ReturnType<typeof vi.fn> } {
  const complete = vi.fn(async () => '{}')
  return {
    complete,
    client: {
      complete,
      chat: vi.fn(async () => ''),
      stats: () => ({ hits: 0, misses: 0 }),
      latencies: () => [],
      requestTimings: () => [],
    } as unknown as LlmClient,
  }
}

describe('createPassageIndexHook — A/B/C 模式', () => {
  it('A（lexical）：无向量、不碰 embedder、零 LLM 调用', async () => {
    const embedder = fakeEmbedder()
    const { client, complete } = stubClient()
    const hook = createPassageIndexHook({ knobs: KNOBS, client, embedder, countTokens, modelIdentity: 'm', mode: 'lexical' })

    const info = await (await hook(SAMPLE)).ready
    expect(info.index.stage).toBe(1)
    expect(info.index.passageVectors).toBeUndefined()
    expect(info.index.cards).toBeUndefined()
    expect(info.index.cardVectors).toBeUndefined()
    expect(info.outline).toBeUndefined()
    // 即使注入了 embedder，lexical 臂也不得使用它（「A 不加载嵌入器」由 hook 兜底，不靠 CLI 自觉）
    expect(embedder.embedPassages).not.toHaveBeenCalled()
    expect(embedder.embedQuery).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
  })

  it('B（hybrid-raw）：产出段落向量、无卡片、零 LLM 调用', async () => {
    const embedder = fakeEmbedder()
    const { client, complete } = stubClient()
    const hook = createPassageIndexHook({ knobs: KNOBS, client, embedder, countTokens, modelIdentity: 'm', mode: 'hybrid-raw' })

    const info = await (await hook(SAMPLE)).ready
    expect(info.index.stage).toBe(2)
    expect(info.index.passageVectors).toHaveLength(info.index.passages.length)
    expect(info.index.cards).toBeUndefined()
    expect(info.outline).toBeUndefined()
    expect(complete).not.toHaveBeenCalled()
  })

  it('C（hybrid-outline）：段落向量 + 可用 outline 与节点向量，零 LLM 调用', async () => {
    const embedder = fakeEmbedder()
    const { client, complete } = stubClient()
    const hook = createPassageIndexHook({
      knobs: KNOBS, client, embedder, countTokens, modelIdentity: 'm', mode: 'hybrid-outline',
      outlineIndex: () => OUTLINE,
    })

    const info = await (await hook(SAMPLE)).ready
    expect(info.index.stage).toBe(2)
    expect(info.index.passageVectors).toHaveLength(info.index.passages.length)
    expect(info.outline?.available).toBe(true)
    expect(info.outline?.fallbackReason).toBeUndefined()
    // nodes 是顶层根节点（Retrieval 嵌在 Methods 下），展平后共 3 个
    expect(info.outline?.nodes).toHaveLength(2)
    expect(info.outline?.nodes[1].children).toHaveLength(1)
    expect(info.outline?.nodeVectors.size).toBe(3)

    // 节点文本 = [...path, title].join(' > ')：根节点是纯标题，子节点带祖先链
    const nodeTextBatch = embedder.embedPassages.mock.calls
      .map(call => call[0] as string[])
      .find(texts => texts.includes('Methods > Retrieval'))
    expect(nodeTextBatch).toEqual(['Introduction', 'Methods', 'Methods > Retrieval'])
    // 导出函数与索引期实际编码的文本一致（Task 5 打分必须复用同一措辞）
    expect(outlineNodeEmbedText(info.outline!.nodes[1].children[0])).toBe('Methods > Retrieval')

    expect(complete).not.toHaveBeenCalled()
  })

  it('C 缺目录：available:false + fallbackReason，不记 LLM 回落/成本，不失败', async () => {
    const embedder = fakeEmbedder()
    const { client, complete } = stubClient()
    const hook = createPassageIndexHook({
      knobs: KNOBS, client, embedder, countTokens, modelIdentity: 'm', mode: 'hybrid-outline',
    })

    const info = await (await hook(SAMPLE)).ready
    expect(info.outline?.available).toBe(false)
    expect(info.outline?.fallbackReason).toBeTruthy()
    expect(info.outline?.nodes).toEqual([])
    expect(info.outline?.nodeVectors.size).toBe(0)
    // 目录失败不是卡片失败：不得写 LLM 结构回落，也不得编造 token / 成本
    expect(info.coldStart.coldStartStructureFallback).toBeUndefined()
    expect(info.coldStart.coldStartStructureCallMs).toBeUndefined()
    expect(info.coldStart.coldStartStructureInputTokens).toBeUndefined()
    expect(info.coldStart.coldStartStructureTokensEstimated).toBeUndefined()
    expect(complete).not.toHaveBeenCalled()
  })

  it('C 目录非法（条目页为 null）：available:false，理由取自 PdfOutlineIndexError', async () => {
    const embedder = fakeEmbedder()
    const { client } = stubClient()
    const bad: PdfOutlineEntry[] = [{ id: '0', title: 'Bad', page: null, children: [] }]
    const hook = createPassageIndexHook({
      knobs: KNOBS, client, embedder, countTokens, modelIdentity: 'm', mode: 'hybrid-outline',
      outlineIndex: () => bad,
    })

    const info = await (await hook(SAMPLE)).ready
    expect(info.outline?.available).toBe(false)
    expect(info.outline?.fallbackReason).toBe('null-page')
  })

  it('lexicalReady 是阶段① 快照：ready 解析前即可用，且不被后续阶段改写', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const embedder: Embedder = {
      id: 'gated@main#q8',
      embedQuery: vi.fn(async () => new Float32Array([1, 0])),
      embedPassages: vi.fn(async (texts: string[]) => {
        await gate
        return texts.map(() => new Float32Array([1, 0]))
      }),
    }
    const { client } = stubClient()
    const hook = createPassageIndexHook({ knobs: KNOBS, client, embedder, countTokens, modelIdentity: 'm', mode: 'hybrid-raw' })

    const handle = await hook(SAMPLE)
    // 阶段① 已落盘：快照此刻就可用，与后台阶段是否完成无关
    expect(handle.lexicalReady.index.stage).toBe(1)
    expect(handle.lexicalReady.coldStart.coldStartPassageCount).toBeGreaterThan(0)

    let readyResolved = false
    void handle.ready.then(() => { readyResolved = true })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(readyResolved).toBe(false)

    release()
    const info = await handle.ready
    expect(info.index.stage).toBe(2)
    // 快照稳定：后续阶段写的是自己那份 coldStart，没有回头改写 lexicalReady
    expect(handle.lexicalReady.coldStart.coldStartEmbedPassagesMs).toBeUndefined()
    expect(info.coldStart.coldStartEmbedPassagesMs).toBeGreaterThanOrEqual(0)
  })
})
