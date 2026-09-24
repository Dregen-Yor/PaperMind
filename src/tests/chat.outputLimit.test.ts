import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

// chat.ts (via pageIndex.ts) pulls in pdfjs-dist which needs DOMMatrix — mock it in Node
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  default: {},
  GlobalWorkerOptions: { workerSrc: '' },
}))

import {
  useChatStore, UNLIMITED_MAX_TOKENS, CAPPED_MAX_TOKENS_DEFAULT, ANTHROPIC_LEGACY_MAX_TOKENS,
} from '../stores/chat'

const mockDb = () => (globalThis as any).mockDb

/** `init()` 里的一次性迁移标记（chat.ts 的内部常量，此处按字面量断言）。 */
const MIGRATED_FLAG_KEY = 'llm_max_tokens_unlimited_migrated'

/** 一份落库形态的 profile（已是普通对象，键序无关）。 */
const savedProfile = (patch: Record<string, unknown>) => ({
  id: 'p1', name: '默认配置', provider: 'openai', model: 'gpt-4o', apiKey: '',
  baseUrl: 'https://api.openai.com/v1', temperature: 0.7, maxTokens: UNLIMITED_MAX_TOKENS,
  topK: 0, systemPrompt: '', ...patch,
})

/** 非流式补全响应：不传 `onToken` 时 `requestCompletion` 走 JSON 分支。 */
const json = (payload: unknown) => ({ ok: true, status: 200, json: () => Promise.resolve(payload) })
const openaiReply = () => json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] })
const anthropicReply = () => json({ content: [{ text: 'ok' }], stop_reason: 'end_turn' })
const ollamaReply = () => json({ message: { content: 'ok' }, done_reason: 'stop' })

/** 建 store → init → 把默认 profile 改成目标 provider / 上限。 */
async function storeWith(patch: Record<string, unknown>) {
  const store = useChatStore()
  await store.init()
  await store.updateProfile(store.chatProfile.id, patch)
  return store
}

/** 最近一次请求的 JSON body。 */
function lastBody() {
  return JSON.parse((global.fetch as any).mock.calls.at(-1)![1].body)
}

/** 历次请求体里的 `max_tokens` 序列（用来观察 Anthropic 的降级重试）。 */
function tokenBodies(): number[] {
  return (global.fetch as any).mock.calls.map((call: any[]) => JSON.parse(call[1].body).max_tokens)
}

async function complete(store: ReturnType<typeof useChatStore>) {
  await store.requestCompletion([{ role: 'user', content: 'hi' }])
}

describe('输出长度上限（0 = 不限制）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockDb().chat.listConversations.mockResolvedValue([])
    mockDb().settings.get.mockResolvedValue(null)
    mockDb().settings.set.mockClear()
    mockDb().index.list.mockResolvedValue([])
  })

  it('出厂配置默认不限制输出长度', async () => {
    const store = useChatStore()
    await store.init()
    expect(UNLIMITED_MAX_TOKENS).toBe(0)
    expect(store.profiles[0].maxTokens).toBe(UNLIMITED_MAX_TOKENS)
  })

  it('openai：不限制时不发送 max_tokens，显式设了上限才发送', async () => {
    global.fetch = vi.fn().mockResolvedValue(openaiReply()) as any
    const store = await storeWith({ provider: 'openai', maxTokens: UNLIMITED_MAX_TOKENS })

    await complete(store)
    expect('max_tokens' in lastBody()).toBe(false)

    await store.updateProfile(store.chatProfile.id, { maxTokens: 2048 })
    await complete(store)
    expect(lastBody().max_tokens).toBe(2048)
  })

  it('anthropic：不限制时发兜底上限（Messages API 的 max_tokens 必填，无法省略）', async () => {
    global.fetch = vi.fn().mockResolvedValue(anthropicReply()) as any
    const store = await storeWith({
      provider: 'anthropic', model: 'claude-3-5-sonnet',
      baseUrl: 'https://api.anthropic.com', maxTokens: UNLIMITED_MAX_TOKENS,
    })

    await complete(store)
    expect(lastBody().max_tokens).toBe(CAPPED_MAX_TOKENS_DEFAULT)

    await store.updateProfile(store.chatProfile.id, { maxTokens: 1024 })
    await complete(store)
    expect(lastBody().max_tokens).toBe(1024)
  })

  it('anthropic：老模型拒绝兜底上限时降级到 4096，并记住不再撞第二次', async () => {
    const rejected = {
      ok: false, status: 400, statusText: 'Bad Request',
      json: () => Promise.resolve({
        error: { message: 'max_tokens: 8192 > 4096, which is the maximum allowed number of output tokens for claude-3-opus-20240229' },
      }),
    }
    global.fetch = vi.fn().mockResolvedValueOnce(rejected).mockResolvedValue(anthropicReply()) as any
    const store = await storeWith({
      provider: 'anthropic', model: 'claude-3-opus-20240229',
      baseUrl: 'https://api.anthropic.com', maxTokens: UNLIMITED_MAX_TOKENS,
    })

    await complete(store)
    expect(tokenBodies()).toEqual([CAPPED_MAX_TOKENS_DEFAULT, ANTHROPIC_LEGACY_MAX_TOKENS])

    // 上限已经探明，下一次直接按 4096 发送，不再先失败一轮
    await complete(store)
    expect(tokenBodies()).toEqual([
      CAPPED_MAX_TOKENS_DEFAULT, ANTHROPIC_LEGACY_MAX_TOKENS, ANTHROPIC_LEGACY_MAX_TOKENS,
    ])
  })

  it('anthropic：用户显式设的上限被拒时原样报错，不替他改配置', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 400, statusText: 'Bad Request',
      json: () => Promise.resolve({ error: { message: 'max_tokens: 16000 > 4096, which is the maximum allowed' } }),
    }) as any
    const store = await storeWith({
      provider: 'anthropic', model: 'claude-3-haiku-20240307',
      baseUrl: 'https://api.anthropic.com', maxTokens: 16000,
    })

    await expect(complete(store)).rejects.toThrow(/16000/)
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('openai：o 系 / gpt-5 设了上限时改发 max_completion_tokens，且不带 temperature', async () => {
    global.fetch = vi.fn().mockResolvedValue(openaiReply()) as any
    const store = await storeWith({ provider: 'openai', model: 'openai/o3-mini', maxTokens: 2048 })

    await complete(store)
    expect(lastBody().max_completion_tokens).toBe(2048)
    expect('max_tokens' in lastBody()).toBe(false)
    // o 系只接受默认温度，显式发 0.7 同样会被拒
    expect('temperature' in lastBody()).toBe(false)
  })

  it('ollama：不限制时不发送 num_predict，设了上限则与 top_k 一起进入 options', async () => {
    global.fetch = vi.fn().mockResolvedValue(ollamaReply()) as any
    const store = await storeWith({
      provider: 'ollama', baseUrl: 'http://localhost:11434',
      topK: 40, maxTokens: UNLIMITED_MAX_TOKENS,
    })

    await complete(store)
    expect(lastBody().options).toEqual({ top_k: 40 })

    await store.updateProfile(store.chatProfile.id, { maxTokens: 2048 })
    await complete(store)
    expect(lastBody().options).toEqual({ top_k: 40, num_predict: 2048 })
  })

  it('升级迁移：落库的旧默认 4096 视为从未显式设置，迁到不限制并回写', async () => {
    const store = useChatStore()
    mockDb().settings.get.mockImplementation((key: string) =>
      key === 'llm_profiles' ? Promise.resolve([savedProfile({ maxTokens: 4096 })]) : Promise.resolve(null))
    await store.init()

    expect(store.profiles[0].maxTokens).toBe(UNLIMITED_MAX_TOKENS)
    expect(mockDb().settings.set).toHaveBeenCalledWith(
      'llm_profiles',
      [expect.objectContaining({ id: 'p1', maxTokens: UNLIMITED_MAX_TOKENS })],
    )
    expect(mockDb().settings.set).toHaveBeenCalledWith(MIGRATED_FLAG_KEY, true)
  })

  it('升级迁移：用户显式设过的非默认上限原样保留，且不重复写盘', async () => {
    const store = useChatStore()
    mockDb().settings.get.mockImplementation((key: string) =>
      key === 'llm_profiles' ? Promise.resolve([savedProfile({ maxTokens: 2048 })]) : Promise.resolve(null))
    await store.init()

    expect(store.profiles[0].maxTokens).toBe(2048)
    expect(mockDb().settings.set).not.toHaveBeenCalledWith('llm_profiles', expect.anything())
  })

  it('升级迁移只跑一次：之后用户显式设回 4096 不会被下次启动抹掉', async () => {
    const store = useChatStore()
    mockDb().settings.get.mockImplementation((key: string) => {
      if (key === 'llm_profiles') return Promise.resolve([savedProfile({ maxTokens: 4096 })])
      if (key === MIGRATED_FLAG_KEY) return Promise.resolve(true)
      return Promise.resolve(null)
    })
    await store.init()

    expect(store.profiles[0].maxTokens).toBe(4096)
  })

  it('非法上限（备份导入的小数 / 字符串）不会变成非法请求体', async () => {
    global.fetch = vi.fn().mockResolvedValue(openaiReply()) as any
    const store = await storeWith({ provider: 'openai', maxTokens: 0.5 })

    await complete(store)
    expect('max_tokens' in lastBody()).toBe(false)
  })
})
