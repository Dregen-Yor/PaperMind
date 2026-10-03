import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PaperMindConfig } from '../types'
import type { QaTaskArgs } from '../runner/qa'
import type { PassageIndexHookOptions } from '../runner/passageIndexHook'

const state = vi.hoisted(() => ({
  configs: [] as PaperMindConfig[],
  qaArgs: [] as QaTaskArgs[],
  hookArgs: [] as PassageIndexHookOptions[],
  writes: [] as string[],
}))

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), execSync: () => 'test-sha',
}))
vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs')>()
  const overrides = {
    mkdirSync: vi.fn(), accessSync: vi.fn(),
    writeFileSync: (_path: unknown, data: string) => { state.writes.push(data) },
  }
  return { ...original, ...overrides, default: { ...original, ...overrides } }
})
vi.mock('../args', async importOriginal => ({
  ...await importOriginal<typeof import('../args')>(),
  parseArgs: () => ({ task: 'qa', dataset: 'qasper', config: 'test', judge: false, useCache: true, speed: false, mode: 'rag' }),
}))
vi.mock('../config', async importOriginal => ({
  ...await importOriginal<typeof import('../config')>(), loadConfigs: async () => state.configs,
}))
vi.mock('../llmClient', async importOriginal => ({
  ...await importOriginal<typeof import('../llmClient')>(),
  resolveEnvConfig: () => ({ provider: 'openai', model: 'test', baseUrl: 'https://example.com/v1' }),
  createLlmClient: () => ({ stats: () => ({ hits: 0, misses: 0 }) }),
}))
vi.mock('../datasets/qasper', () => ({
  loadQasperDataset: async () => [{ paperId: 'p', title: 'Paper', source: 'qasper', pages: ['raw evidence'], questions: [] }],
}))
vi.mock('../traditionalRag/embedding', () => ({ createBgeM3Tokenizer: async () => ({ tokenize: (text: string) => text.split(/\s+/) }) }))
vi.mock('../../../src/utils/transformersEmbedder', () => ({
  createTransformersEmbedder: async () => ({ id: 'fake', embedQuery: vi.fn(), embedPassages: vi.fn() }),
}))
vi.mock('@huggingface/transformers', () => ({}))
vi.mock('../hub', () => ({ applyHfEndpoint: vi.fn() }))
vi.mock('../runner/passageIndexHook', () => ({
  createPassageIndexHook: (args: PassageIndexHookOptions) => { state.hookArgs.push(args); return vi.fn() },
}))
vi.mock('../runner/qa', () => ({
  DEFAULT_SYSTEM_PROMPT: 'system',
  runQaTask: async (args: QaTaskArgs) => {
    state.qaArgs.push(args)
    return { task: 'qa', config: args.config, meta: { completed: 1, total: 1, timestamp: '2026-01-01T00:00:00.000Z' }, metrics: {}, perSample: [], perPaper: [], errors: [] }
  },
}))
vi.mock('../report', () => ({ renderReport: () => 'report', renderComparison: vi.fn() }))
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ GlobalWorkerOptions: {}, getDocument: vi.fn() }))

afterEach(() => vi.restoreAllMocks())

describe('heading experiment CLI forwarding', () => {
  it('passes explicit zero and positive weights through HybridKnobs and QA runtime, and writes actual config values', async () => {
    vi.resetModules()
    state.qaArgs.length = 0
    state.hookArgs.length = 0
    state.writes.length = 0
    const base: PaperMindConfig = {
      name: 'heading', passage: { embedder: { model: 'Xenova/bge-small-en-v1.5', revision: 'main', dtype: 'q8', dim: 384 } },
      minTokens: 120, maxTokens: 350, maxInputChars: 120000,
      rrfK: 60, sectionWeight: 0.5, neighbourFactor: 0.5, skipLimit: 20,
    }
    state.configs = [0, 0.25, 0.5].map(headingWeight => ({ ...base, headingWeight }))
    state.configs.push({ ...base })
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await import('../cli')

    const expected = [0, 0.25, 0.5, undefined]
    expect(state.hookArgs.map(args => args.knobs.headingWeight)).toEqual(expected)
    expect(state.qaArgs.map(args => args.passage?.headingWeight)).toEqual(expected)
    expect(Object.hasOwn(state.hookArgs[0].knobs, 'headingWeight')).toBe(true)
    expect(Object.hasOwn(state.qaArgs[0].passage!, 'headingWeight')).toBe(true)
    expect(Object.hasOwn(state.hookArgs[3].knobs, 'headingWeight')).toBe(false)
    expect(Object.hasOwn(state.qaArgs[3].passage!, 'headingWeight')).toBe(false)
    expect(state.writes.map(data => JSON.parse(data).config.headingWeight)).toEqual(expected)
    expect(state.qaArgs.every(args => args.passage?.contextBudgetTokens === 4096)).toBe(true)
  })
})
