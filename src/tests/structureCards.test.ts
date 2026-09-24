import { describe, expect, it, vi } from 'vitest'
import { buildPassages, createEstimatingTokenCounter } from '../utils/passages'
import {
  MAX_KEY_TERMS, MIN_STRUCTURE_CARDS, StructureCardError,
  buildStructureCardPrompt, buildStructureCards, buildTitleCards, cardsToIndexNodes,
  parseStructureCards, validateStructureCards,
} from '../utils/structureCards'

const counter = createEstimatingTokenCounter()
// 六段（P01–P06）：Abstract / Introduction（两段正文）/ Methods / Experiments（两段正文）。
// valid 卡片引用到 P05/P06，故每个主题小节都要有两段正文，否则 fixture 只有四段。
const PAGES = [
  'Abstract\nWe study retrieval.\n\nIntroduction\nRetrieval matters a lot.\n\nIt also matters for question answering.\n\nMethods\nWe use BM25 and a dense encoder.\n\nExperiments\nWe evaluate on Europarl and MultiUN.\n\nWe also compare against strong baselines.',
]
const passages = buildPassages(PAGES, counter, { minTokens: 1 })

const valid = {
  paper: { title: 'Retrieval Study', summary: 'A study of retrieval.' },
  sections: [
    { id: 'S1', range: ['P01', 'P02'], title: 'Motivation for retrieval', summary: 'Retrieval matters.', keyTerms: ['retrieval', 'motivation'] },
    { id: 'S2', range: ['P03', 'P04'], title: 'BM25 and dense encoders', summary: 'We use BM25.', keyTerms: ['bm25', 'encoder'] },
    { id: 'S3', range: ['P05', 'P06'], title: 'Europarl evaluation setup', summary: 'Europarl and MultiUN.', keyTerms: ['datasets', 'evaluation data'] },
  ],
}

describe('buildStructureCardPrompt', () => {
  it('包含每一个段落 ID 与段落原文', () => {
    const prompt = buildStructureCardPrompt(passages)
    for (const passage of passages) {
      expect(prompt).toContain(`[${passage.id}]`)
      expect(prompt).toContain(passage.text.slice(0, 20))
    }
  })
})

describe('validateStructureCards', () => {
  it('合法输出通过并保留 paper', () => {
    const result = validateStructureCards(valid, passages)
    expect(result.ok).toBe(true)
    expect(result.cards).toHaveLength(3)
    expect(result.paper?.title).toBe('Retrieval Study')
  })

  it('卡片数低于下限判非法', () => {
    const few = { sections: valid.sections.slice(0, MIN_STRUCTURE_CARDS - 1).map((s, i) => ({ ...s, range: i === 0 ? ['P01', 'P06'] : s.range })) }
    expect(validateStructureCards(few, passages).failure).toBe('invalid-structure')
  })

  it('范围有遗漏或重叠判非法', () => {
    const overlap = { sections: [valid.sections[0], { ...valid.sections[1], range: ['P02', 'P04'] }, valid.sections[2]] }
    expect(validateStructureCards(overlap, passages).ok).toBe(false)
  })

  it('范围乱序判非法', () => {
    const shuffled = { sections: [valid.sections[1], valid.sections[0], valid.sections[2]] }
    expect(validateStructureCards(shuffled, passages).ok).toBe(false)
  })

  it('引用不存在的段落判非法', () => {
    const bogus = { sections: [valid.sections[0], { ...valid.sections[1], range: ['P99', 'P04'] }, valid.sections[2]] }
    expect(validateStructureCards(bogus, passages).ok).toBe(false)
  })

  it('通用章节名判非法', () => {
    const generic = { sections: [{ ...valid.sections[0], title: 'Introduction' }, valid.sections[1], valid.sections[2]] }
    expect(validateStructureCards(generic, passages).failure).toBe('invalid-structure')
  })

  it('keyTerms 越界或含空串判非法', () => {
    const tooMany = { sections: [{ ...valid.sections[0], keyTerms: Array.from({ length: MAX_KEY_TERMS + 1 }, (_, i) => `t${i}`) }, valid.sections[1], valid.sections[2]] }
    expect(validateStructureCards(tooMany, passages).ok).toBe(false)
    const blank = { sections: [{ ...valid.sections[0], keyTerms: ['ok', '  '] }, valid.sections[1], valid.sections[2]] }
    expect(validateStructureCards(blank, passages).ok).toBe(false)
  })

  it('缺 sections 数组判非法', () => {
    expect(validateStructureCards({ paper: {} }, passages).failure).toBe('invalid-structure')
  })
})

describe('parseStructureCards', () => {
  it('剥离代码围栏与前后解释文字', () => {
    expect(parseStructureCards('```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(parseStructureCards('好的：{"a":1} 以上。')).toEqual({ a: 1 })
  })

  it('无 JSON 或 JSON 非法时抛 invalid-json', () => {
    expect(() => parseStructureCards('没有 JSON')).toThrow(StructureCardError)
    expect(() => parseStructureCards('{oops}')).toThrow(StructureCardError)
  })
})

describe('buildStructureCards', () => {
  const llm = vi.fn(async () => JSON.stringify(valid))

  it('恰好一次调用并返回卡片与元信息', async () => {
    const result = await buildStructureCards(passages, llm)
    expect(llm).toHaveBeenCalledTimes(1)
    expect(result.cards).toHaveLength(3)
    expect(result.meta.llmCalls).toBe(1)
    expect(result.meta.inputChars).toBeGreaterThan(0)
  })

  it('输入超上限直接 input-too-large 且零成本', async () => {
    const sparse = vi.fn(async () => '')
    await expect(buildStructureCards(passages, sparse, { maxInputChars: 10 })).rejects.toMatchObject({
      reason: 'input-too-large',
      cost: undefined,
    })
    expect(sparse).not.toHaveBeenCalled()
  })

  it('调用失败带 request-failed 与已发生成本', async () => {
    const failing = vi.fn(async () => { throw new Error('boom') })
    await expect(buildStructureCards(passages, failing)).rejects.toMatchObject({
      reason: 'request-failed',
      cost: { llmCalls: 1 },
    })
  })

  it('校验不通过带 invalid-structure 与已发生成本', async () => {
    const bad = vi.fn(async () => JSON.stringify({ sections: [] }))
    await expect(buildStructureCards(passages, bad)).rejects.toMatchObject({
      reason: 'invalid-structure',
      cost: { llmCalls: 1 },
    })
  })

  it('没有段落时按 no-passages 回落', async () => {
    await expect(buildStructureCards([], llm)).rejects.toMatchObject({ reason: 'no-passages' })
  })
})

describe('buildTitleCards', () => {
  it('按标题行分小节，每小节一张只有标题的卡片，覆盖全部段落', () => {
    const cards = buildTitleCards(passages)
    expect(cards.length).toBeGreaterThan(0)
    expect(cards[0].range[0]).toBe(passages[0].id)
    expect(cards[cards.length - 1].range[1]).toBe(passages[passages.length - 1].id)
    for (const card of cards) {
      expect(card.summary).toBe('')
      expect(card.keyTerms).toEqual([])
    }
  })
})

describe('cardsToIndexNodes', () => {
  it('由卡片推导叶节点，页区间来自覆盖段落', () => {
    const tree = cardsToIndexNodes(buildTitleCards(passages), passages)
    expect(tree.nodes.length).toBeGreaterThan(0)
    for (const node of tree.nodes) {
      expect(node.startPage).toBeGreaterThanOrEqual(0)
      expect(node.endPage).toBeGreaterThanOrEqual(node.startPage)
      expect(node.nodes).toEqual([])
    }
    expect(tree.startPage).toBe(0)
    expect(tree.nodes[tree.nodes.length - 1].endPage).toBe(tree.endPage)
  })
})
