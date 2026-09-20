import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import type { EvalSample, QaQuestion } from '../types'
import {
  buildEvaluationContract,
  composeBaseSystemPrompt,
  isRetrievalEligible,
  llmEndpointIdentity,
  normalizeBaseUrl,
  systemPromptHash,
  CONTEXT_BUDGET_TOKENS,
  CONTEXT_TOKENIZER_MODEL,
  CONTEXT_TOKENIZER_REVISION,
  EVIDENCE_MAPPING_VERSION,
  METRIC_SCHEMA_VERSION,
  MRR_DEFINITION,
} from '../evaluationContract'

/** 固定字段的样本工厂，便于逐项变异出「数据集指纹变化」的用例。 */
function sample(overrides: Partial<EvalSample> = {}): EvalSample {
  return {
    paperId: 'p1',
    title: 'Paper 1',
    pages: ['page zero', 'page one'],
    source: 'qasper',
    questions: [
      { id: 'p1#0', question: 'Q1?', answers: ['a1'], evidencePages: [0], unanswerable: false, evidenceMapping: 'mapped' },
      { id: 'p1#1', question: 'Q2?', answers: ['a2'], evidencePages: [1], unanswerable: false, evidenceMapping: 'mapped' },
    ],
    ...overrides,
  }
}

describe('isRetrievalEligible', () => {
  it.each([
    [{ unanswerable: true, evidencePages: [0] }, false],
    [{ unanswerable: false, evidencePages: [] }, false],
    [{ unanswerable: false, evidencePages: [0], evidenceMapping: 'ambiguous' }, false],
    [{ unanswerable: false, evidencePages: [0], evidenceMapping: 'unmapped' }, false],
    [{ unanswerable: false, evidencePages: [0], evidenceMapping: 'mapped' }, true],
  ])('applies the fixed eligibility contract', (partial, expected) => {
    expect(isRetrievalEligible({ id: 'q', question: 'q', answers: ['a'], ...partial } as QaQuestion)).toBe(expected)
  })

  it('treats 真实页码标注（无 evidenceMapping 字段）为有效', () => {
    // smoke 冒烟集是人工标注的真实页号，从不写 evidenceMapping；它是明确映射而非缺失
    expect(isRetrievalEligible({ id: 'q', question: 'q', answers: ['a'], evidencePages: [0], unanswerable: false })).toBe(true)
  })
})

describe('buildEvaluationContract', () => {
  it('固定常量写入每一份契约', () => {
    const contract = buildEvaluationContract([sample()])
    expect(contract).toMatchObject({
      metricSchemaVersion: METRIC_SCHEMA_VERSION,
      mrrDefinition: MRR_DEFINITION,
      contextBudgetTokens: CONTEXT_BUDGET_TOKENS,
      contextTokenizer: CONTEXT_TOKENIZER_MODEL,
      contextTokenizerRevision: CONTEXT_TOKENIZER_REVISION,
      evidenceMappingVersion: EVIDENCE_MAPPING_VERSION,
    })
  })

  it('页面内容变化会改变 datasetFingerprint', () => {
    const before = buildEvaluationContract([sample()])
    // 只改原文，不改任何标注——语料变化必须可见
    const after = buildEvaluationContract([sample({ pages: ['page zero edited', 'page one'] })])
    expect(after.datasetFingerprint).not.toBe(before.datasetFingerprint)
  })

  it('有效题 ID 集合变化会改变 eligibleRetrievalQuestionIdsHash', () => {
    const before = buildEvaluationContract([sample()])
    const questions = sample().questions.map(q => q.id === 'p1#1' ? { ...q, evidenceMapping: 'ambiguous' as const } : q)
    const after = buildEvaluationContract([sample({ questions })])
    expect(after.eligibleRetrievalQuestionIdsHash).not.toBe(before.eligibleRetrievalQuestionIdsHash)
    expect(after.eligibleRetrievalQuestionCount).toBe(1)
  })

  it('同一组样本与 limit 多次构建得到完全相同的身份字段', () => {
    const a = buildEvaluationContract([sample()], 2)
    const b = buildEvaluationContract([sample()], 2)
    expect(a).toEqual(b)
    expect(a.datasetFingerprint).toBe(b.datasetFingerprint)
    expect(a.eligibleRetrievalQuestionIdsHash).toBe(b.eligibleRetrievalQuestionIdsHash)
  })

  it('limit 按 runner 的论文/问题顺序截取，决定指纹与有效题集合', () => {
    const first = sample({ paperId: 'p1' })
    const second = sample({
      paperId: 'p2',
      pages: ['second paper page'],
      questions: [{ id: 'p2#0', question: 'Q?', answers: ['x'], evidencePages: [0], unanswerable: false, evidenceMapping: 'mapped' }],
    })
    const limited = buildEvaluationContract([first, second], 2)
    expect(limited.eligibleRetrievalQuestionCount).toBe(2)
    // 只执行前两题（p1#0 / p1#1），第二篇完全不进入指纹
    const firstOnly = buildEvaluationContract([first], 2)
    expect(limited.datasetFingerprint).toBe(firstOnly.datasetFingerprint)
    expect(limited.eligibleRetrievalQuestionIdsHash).toBe(firstOnly.eligibleRetrievalQuestionIdsHash)
  })
})

/**
 * 端点身份与生效 prompt 指纹（§6.5）：断点签名要能区分「换了端点」与「改了 prompt」，
 * 但**绝不能**把凭据写进去。这两个量的变异直接决定旧断点复不复用，写错会让
 * 换端点后的结果沿用旧断点，把两次运行混成一份。
 */
describe('实验身份：端点与生效 prompt', () => {
  it('端点身份只取 provider + 规范化 base URL：同一端点不同写法同身份', () => {
    const plain = llmEndpointIdentity('openai', 'https://api.openai.com/v1')
    // 尾部斜杠、host 大小写、URL 里的 fragment 都是同一端点的不同写法
    expect(llmEndpointIdentity('openai', 'https://api.openai.com/v1/')).toBe(plain)
    expect(llmEndpointIdentity('openai', 'https://API.OpenAI.com/v1///')).toBe(plain)
    expect(llmEndpointIdentity('openai', 'https://api.openai.com/v1#frag')).toBe(plain)
    expect(normalizeBaseUrl('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1')
    // 路径大小写有路由语义，不做小写归一
    expect(normalizeBaseUrl('https://api.openai.com/V1')).toBe('https://api.openai.com/V1')
  })

  it('URL 里的 userinfo 是凭据：规范化先剥掉，带与不带同身份', () => {
    // 若 base URL 写成 user:pass@host，凭据就成了 SHA-256 的输入——虽然不可逆，
    // 但「凭据不可能进入身份」这句话就不成立了，且轮换凭据会白白扰动断点签名
    const plain = llmEndpointIdentity('openai', 'https://api.openai.com/v1')
    expect(llmEndpointIdentity('openai', 'https://user:pass@api.openai.com/v1')).toBe(plain)
    expect(normalizeBaseUrl('https://user:pass@api.openai.com/v1')).toBe('https://api.openai.com/v1')
  })

  it('provider 或 base URL 任一不同即身份不同', () => {
    const base = llmEndpointIdentity('openai', 'https://api.openai.com/v1')
    expect(llmEndpointIdentity('anthropic', 'https://api.openai.com/v1')).not.toBe(base)
    expect(llmEndpointIdentity('openai', 'https://openrouter.ai/api/v1')).not.toBe(base)
    expect(llmEndpointIdentity('ollama', 'http://localhost:11434')).not.toBe(base)
  })

  it('凭据不进入端点身份', () => {
    // 直接重算指纹输入：身份只能是 provider + 规范化 base URL。
    // 一旦有人把 API key 混进 update()，这条断言即失效——这是「凭据不落盘」的机器证明。
    const expected = createHash('sha256').update('openai\0https://api.openai.com/v1').digest('hex')
    expect(llmEndpointIdentity('openai', 'https://api.openai.com/v1')).toBe(expected)
    // 环境里存在凭据也不改变身份：函数不读环境变量，只吃显式入参
    process.env.BENCH_LLM_API_KEY = 'not-a-real-key'
    try {
      expect(llmEndpointIdentity('openai', 'https://api.openai.com/v1')).toBe(expected)
    } finally {
      delete process.env.BENCH_LLM_API_KEY
    }
  })

  it('生效 prompt 指纹：拼装顺序与语言指令的有无都必须改变身份', () => {
    const lang = '请用论文原文语言（英文）作答。'
    expect(composeBaseSystemPrompt('基础 prompt')).toBe('基础 prompt')
    expect(composeBaseSystemPrompt('基础 prompt', lang)).toBe(`基础 prompt\n\n${lang}`)
    expect(systemPromptHash(composeBaseSystemPrompt('基础 prompt', lang)))
      .not.toBe(systemPromptHash(composeBaseSystemPrompt('基础 prompt')))
    expect(systemPromptHash('a\nb')).not.toBe(systemPromptHash('b\na'))
  })
})
