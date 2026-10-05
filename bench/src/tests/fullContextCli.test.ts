import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FullContextQaArgs } from '../runner/fullContextQa'

const state = vi.hoisted(() => ({
  runner: vi.fn(async (args: FullContextQaArgs) => ({
    task: 'qa', config: args.config,
    meta: { completed: 0, total: 0, timestamp: '2026-01-01T00:00:00.000Z' },
    metrics: {}, perSample: [], perPaper: [], errors: [],
  })),
  dataset: vi.fn(async () => [{ paperId: 'p', title: 'Paper', source: 'qasper', pages: ['evidence'], questions: [] }]),
  client: vi.fn(() => ({ stats: () => ({ hits: 0, misses: 0 }), cacheEnabled: () => false })),
  tokenizer: vi.fn(),
}))

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), execSync: () => 'test-sha',
}))
vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs')>()
  const overrides = { mkdirSync: vi.fn(), accessSync: vi.fn(), writeFileSync: vi.fn() }
  return { ...original, ...overrides, default: { ...original, ...overrides } }
})
vi.mock('../llmClient', async importOriginal => ({
  ...await importOriginal<typeof import('../llmClient')>(),
  resolveEnvConfig: () => ({ provider: 'openai', model: 'test', baseUrl: 'https://example.com/v1' }),
  createLlmClient: state.client,
}))
vi.mock('../datasets/qasper', () => ({ loadQasperDataset: state.dataset }))
vi.mock('../traditionalRag/embedding', () => ({ createBgeM3Tokenizer: state.tokenizer }))
vi.mock('../runner/fullContextQa', () => ({ runFullContextQaTask: state.runner }))
vi.mock('../report', () => ({ renderReport: () => 'report', renderComparison: vi.fn() }))
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ GlobalWorkerOptions: {}, getDocument: vi.fn() }))

const originalArgv = process.argv
function setup(config: string, speed = false) {
  vi.resetModules()
  vi.clearAllMocks()
  process.argv = ['node', 'bench/src/cli.ts', '--task', 'qa', '--dataset', 'qasper', '--config', config, '--mode', 'full-context', ...(speed ? ['--speed'] : [])]
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
}

afterEach(() => {
  process.argv = originalArgv
  vi.restoreAllMocks()
})

describe('full-context CLI with real configuration loading', () => {
  it.each([false, true])('accepts the expanded default PaperMind config (speed=%s)', async speed => {
    setup('default', speed)
    await import('../cli')
    expect(state.runner).toHaveBeenCalledTimes(1)
    const args = state.runner.mock.calls[0][0]
    expect(args.config.name).toBe('default')
    expect(args.config.kind).toBeUndefined()
    expect(Boolean(args.speed)).toBe(speed)
    expect(state.tokenizer).not.toHaveBeenCalled()
  })

  it.each(['rag-bm25', 'semantic-tree', 'hybrid-rerank', 'long-section-rag'])('rejects retrieval config %s before loading data or making requests', async config => {
    setup(config)
    await expect(import('../cli')).rejects.toThrow('--mode full-context 只接受 PaperMind 配置')
    expect(state.dataset).not.toHaveBeenCalled()
    expect(state.client).not.toHaveBeenCalled()
    expect(state.runner).not.toHaveBeenCalled()
  })

  it('keeps the separate rejection for passage-hybrid configs', async () => {
    setup('papermind-hybrid')
    await expect(import('../cli')).rejects.toThrow('--mode full-context 不支持段落混合配置')
    expect(state.dataset).not.toHaveBeenCalled()
    expect(state.client).not.toHaveBeenCalled()
  })
})
