import { describe, expect, it, vi } from 'vitest'
import { createWebQaController } from '../composables/useWebQa'
import type { WebQaMessage, WebQaSessionDetail } from '../types/webQa'

const oldHtml = '<html><main>旧页</main></html>'
const source = { finalUrl: 'https://example.org/old', title: '旧页', html: oldHtml, capturedAt: 1, contentHash: 'hash', byteLength: 32 }

function harness() {
  const data = new Map<string, WebQaSessionDetail>()
  const captureSnapshot = vi.fn(async () => ({ ...source }))
  const repository = {
    list: vi.fn(async () => [...data.values()].map(({ snapshot: _snapshot, messages: _messages, ...summary }) => ({ ...summary }))),
    get: vi.fn(async (id: string) => structuredClone(data.get(id) ?? null)),
    create: vi.fn(async (input: any) => {
      const detail: WebQaSessionDetail = {
        id: input.sessionId, snapshotId: input.sessionId, snapshot: input.snapshot,
        finalUrl: input.snapshot.finalUrl, title: input.snapshot.title,
        capturedAt: input.snapshot.capturedAt, byteLength: input.snapshot.byteLength,
        createdAt: input.createdAt, updatedAt: input.createdAt,
        messages: [{ id: input.messageId, sessionId: input.sessionId, role: 'user', content: input.question,
          status: 'completed', error: '', modelId: '', createdAt: input.createdAt }],
      }
      data.set(detail.id, detail)
      return structuredClone(detail)
    }),
    addMessage: vi.fn(async (message: WebQaMessage) => { data.get(message.sessionId)!.messages.push(structuredClone(message)) }),
    updateMessage: vi.fn(async (id: string, patch: Partial<WebQaMessage>) => {
      for (const session of data.values()) {
        const message = session.messages.find(m => m.id === id)
        if (message) Object.assign(message, patch)
      }
    }),
    remove: vi.fn(async (id: string) => { data.delete(id) }),
  }
  const profile = { id: 'model-a', name: 'Model A', provider: 'openai' as const, model: 'model-a',
    apiKey: 'test', baseUrl: 'https://api.example.org', systemPrompt: '请用中文回答',
    temperature: 0, maxTokens: 0, topK: 0 }
  const requestCompletion = vi.fn(async (
    _messages: Array<{ role: string; content: string }>,
    _profileId?: string,
    _options?: { signal?: AbortSignal; onToken?: (token: string) => void },
  ) => ({ content: '回答', truncated: false }))
  const qa = createWebQaController({ preview: { captureSnapshot }, repository, getProfile: () => profile, requestCompletion })
  return { qa, data, captureSnapshot, repository, profile, requestCompletion }
}

describe('web QA run lifecycle', () => {
  it('accepts only one initial send while the page snapshot is being captured', async () => {
    const h = harness()
    let finishCapture!: (snapshot: typeof source) => void
    h.captureSnapshot.mockImplementationOnce(() => new Promise(resolve => { finishCapture = resolve }))
    const first = h.qa.send('第一问')
    expect(await h.qa.send('重复提交')).toBe(false)
    finishCapture({ ...source })
    expect(await first).toBe(true)
    expect(h.repository.create).toHaveBeenCalledTimes(1)
    expect(h.requestCompletion).toHaveBeenCalledTimes(1)
  })

  it('captures once and keeps the original snapshot after the visible page changes', async () => {
    const h = harness()
    expect(await h.qa.send('第一问')).toBe(true)
    h.captureSnapshot.mockResolvedValueOnce({ ...source, html: '<html><main>新页</main></html>' })
    expect(await h.qa.send('第二问')).toBe(true)
    expect(h.captureSnapshot).toHaveBeenCalledTimes(1)
    const second = h.requestCompletion.mock.calls[1][0]
    expect(second.some(m => m.content.includes(oldHtml))).toBe(true)
    expect(second.some(m => m.content.includes('新页'))).toBe(false)
    expect(second.map(m => m.content)).toContain('第一问')
    expect(second.map(m => m.content)).toContain('回答')
    expect(h.qa.currentSession.value?.messages).toHaveLength(4)
  })

  it('does not call the model if the initial local save fails', async () => {
    const h = harness()
    h.repository.create.mockRejectedValueOnce(new Error('磁盘写入失败'))
    expect(await h.qa.send('问题')).toBe(false)
    expect(h.requestCompletion).not.toHaveBeenCalled()
    expect(h.qa.error.value).toContain('磁盘写入失败')
  })

  it('keeps a failed question and retries without sending the failed answer as history', async () => {
    const h = harness()
    h.requestCompletion.mockRejectedValueOnce(new Error('context length exceeded'))
    expect(await h.qa.send('失败问题')).toBe(false)
    expect(h.qa.error.value).toContain('更长上下文')
    expect(h.qa.currentSession.value?.messages.at(-1)?.status).toBe('failed')
    expect(await h.qa.retry()).toBe(true)
    const retryMessages = h.requestCompletion.mock.calls[1][0]
    expect(retryMessages.at(-1)?.content).toBe('失败问题')
    expect(retryMessages.filter(m => m.content === '失败问题')).toHaveLength(1)
    expect(h.qa.currentSession.value?.messages.at(-1)?.status).toBe('completed')
  })

  it('keeps a draft out of storage when the model profile is not configured', async () => {
    const h = harness()
    h.profile.apiKey = ''
    expect(await h.qa.send('留在输入框')).toBe(false)
    expect(h.captureSnapshot).not.toHaveBeenCalled()
    expect(h.repository.create).not.toHaveBeenCalled()
    expect(h.qa.error.value).toContain('模型')
  })

  it('marks a stopped stream as cancelled and can retry the same question', async () => {
    const h = harness()
    h.requestCompletion.mockImplementationOnce((_messages, _profileId, options) => new Promise<{ content: string; truncated: boolean }>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    }))
    const pending = h.qa.send('停止这次回答')
    await vi.waitFor(() => expect(h.requestCompletion).toHaveBeenCalledOnce())
    h.qa.stop()
    expect(await pending).toBe(false)
    expect(h.qa.currentSession.value?.messages.at(-1)?.status).toBe('cancelled')
    expect(await h.qa.retry()).toBe(true)
    expect(h.requestCompletion.mock.calls[1][0].at(-1)?.content).toBe('停止这次回答')
  })

  it('uses a new page only after starting a new session and restores the old one unchanged', async () => {
    const h = harness()
    await h.qa.send('旧页第一问')
    const oldId = h.qa.currentSession.value!.id
    h.qa.newSession()
    const newHtml = '<html><main>新页</main></html>'
    h.captureSnapshot.mockResolvedValueOnce({ ...source, finalUrl: 'https://example.org/new', html: newHtml })
    await h.qa.send('新页第一问')
    const newId = h.qa.currentSession.value!.id
    expect(newId).not.toBe(oldId)
    expect(h.requestCompletion.mock.calls[0][0].some(m => m.content.includes(oldHtml))).toBe(true)
    expect(h.requestCompletion.mock.calls[1][0].some(m => m.content.includes(newHtml))).toBe(true)
    expect(h.requestCompletion.mock.calls[1][0].some(m => m.content.includes(oldHtml))).toBe(false)
    await h.qa.load(oldId)
    await h.qa.send('旧页第二问')
    expect(h.requestCompletion.mock.calls[2][0].some(m => m.content.includes(oldHtml))).toBe(true)
    expect(h.captureSnapshot).toHaveBeenCalledTimes(2)
  })
})
