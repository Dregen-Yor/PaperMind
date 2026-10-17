import { describe, expect, it, vi } from 'vitest'
import { createWebQaController } from '../composables/useWebQa'
import type { WebQaMessage, WebQaSavedSession } from '../types/webQa'

const oldHtml = '<html><main>旧页</main></html>'
const source = { finalUrl: 'https://example.org/old', title: '旧页', html: oldHtml, capturedAt: 1, contentHash: 'hash', byteLength: 32 }

function harness() {
  const data = new Map<string, WebQaSavedSession>()
  const snapshots = new Map([['snap-1', source], ['snap-2', { ...source, html: '<html><main>新页</main></html>' }]])
  const repository = {
    listSessions: vi.fn(async (pageId: string) => [...data.values()].filter(s => s.pageId === pageId)
      .map(({ messages: _messages, ...summary }) => structuredClone(summary))),
    getSession: vi.fn(async (id: string) => structuredClone(data.get(id) ?? null)),
    getSnapshot: vi.fn(async (id: string) => structuredClone(snapshots.get(id) ?? null)),
    createSession: vi.fn(async (input: any) => {
      const snapshot = snapshots.get(input.snapshotId)!
      const detail: WebQaSavedSession = { id: input.sessionId, pageId: 'page-1', snapshotId: input.snapshotId,
        finalUrl: snapshot.finalUrl, title: snapshot.title, capturedAt: snapshot.capturedAt,
        byteLength: snapshot.byteLength, createdAt: input.createdAt, updatedAt: input.createdAt,
        firstQuestion: input.question, messages: [] }
      data.set(detail.id, detail)
      insertTurn(detail, input)
      return structuredClone(detail)
    }),
    appendTurn: vi.fn(async (input: any) => {
      const detail = data.get(input.sessionId)!
      insertTurn(detail, input)
      return structuredClone(detail)
    }),
    updateMessage: vi.fn(async (id: string, patch: Partial<WebQaMessage>) => {
      for (const session of data.values()) {
        const message = session.messages.find(m => m.id === id)
        if (message) Object.assign(message, patch)
      }
    }),
    ensureAssistantForLastUser: vi.fn(async (id: string, assistantId: string, modelId: string) => {
      const detail = data.get(id)!
      detail.messages.push({ id: assistantId, sessionId: id, role: 'assistant', content: '', status: 'interrupted',
        error: '上次回答未开始，请重试。', modelId, createdAt: Date.now() })
      return structuredClone(detail)
    }),
  }
  function insertTurn(detail: WebQaSavedSession, input: any) {
    detail.messages.push({ id: input.questionId, sessionId: detail.id, role: 'user', content: input.question,
      status: 'completed', error: '', modelId: '', createdAt: input.createdAt })
    detail.messages.push({ id: input.assistantId, sessionId: detail.id, role: 'assistant', content: '',
      status: 'streaming', error: '', modelId: input.modelId, createdAt: input.createdAt + 1 })
  }
  const profile = { id: 'model-a', name: 'Model A', provider: 'openai' as const, model: 'model-a',
    apiKey: 'test', baseUrl: 'https://api.example.org', systemPrompt: '请用中文回答',
    temperature: 0, maxTokens: 0, topK: 0 }
  const requestCompletion = vi.fn(async (_messages: Array<{ role: string; content: string }>,
    _profileId?: string, _options?: { signal?: AbortSignal; onToken?: (token: string) => void }) =>
    ({ content: '回答', truncated: false }))
  const qa = createWebQaController({ repository, getProfile: () => profile, requestCompletion })
  return { qa, data, snapshots, repository, profile, requestCompletion }
}

describe('web QA run lifecycle', () => {
  it('requires an archived snapshot and writes the turn before calling the model', async () => {
    const h = harness()
    expect(await h.qa.send('未归档')).toBe(false)
    expect(h.requestCompletion).not.toHaveBeenCalled()
    h.qa.selectSnapshot('page-1', 'snap-1')
    h.requestCompletion.mockImplementationOnce(async () => {
      expect(h.repository.createSession).toHaveBeenCalledOnce()
      expect(h.data.values().next().value?.messages.map((m: WebQaMessage) => m.role)).toEqual(['user', 'assistant'])
      return { content: '回答', truncated: false }
    })
    expect(await h.qa.send('第一问')).toBe(true)
    expect(h.qa.currentSession.value?.messages.at(-1)?.status).toBe('completed')
  })

  it('keeps a saved turn when navigation interrupts its transaction result', async () => {
    const h = harness()
    h.qa.selectSnapshot('page-1', 'snap-1')
    const save = h.repository.createSession.getMockImplementation()!
    let finish!: () => void
    h.repository.createSession.mockImplementationOnce(async input => {
      await new Promise<void>(resolve => { finish = resolve })
      return save(input)
    })
    const pending = h.qa.send('保存中的问题')
    await vi.waitFor(() => expect(h.repository.createSession).toHaveBeenCalledOnce())
    h.qa.newSession()
    finish()
    expect(await pending).toBe(false)
    expect(h.data.size).toBe(1)
    expect(h.requestCompletion).not.toHaveBeenCalled()
  })

  it('keeps a saved turn if history refresh fails', async () => {
    const h = harness()
    h.qa.selectSnapshot('page-1', 'snap-1')
    h.repository.listSessions.mockRejectedValueOnce(new Error('列表读取失败'))
    expect(await h.qa.send('保留问题')).toBe(true)
    expect(h.data.size).toBe(1)
  })

  it('uses the original snapshot across new versions and new sessions', async () => {
    const h = harness()
    h.qa.selectSnapshot('page-1', 'snap-1')
    await h.qa.send('旧页第一问')
    const oldId = h.qa.currentSession.value!.id
    h.qa.newSession()
    h.qa.selectSnapshot('page-1', 'snap-2')
    await h.qa.send('新页第一问')
    await h.qa.load(oldId)
    await h.qa.send('旧页第二问')
    expect(h.requestCompletion.mock.calls[2][0].some(m => m.content.includes(oldHtml))).toBe(true)
    expect(h.requestCompletion.mock.calls[2][0].some(m => m.content.includes('新页'))).toBe(false)
    expect(h.repository.appendTurn).toHaveBeenCalledOnce()
  })

  it('does not call the model after a failed local transaction', async () => {
    const h = harness()
    h.qa.selectSnapshot('page-1', 'snap-1')
    h.repository.createSession.mockRejectedValueOnce(new Error('磁盘写入失败'))
    expect(await h.qa.send('问题')).toBe(false)
    expect(h.requestCompletion).not.toHaveBeenCalled()
    expect(h.data.size).toBe(0)
  })

  it('marks a cancelled partial answer and retries without including that partial text', async () => {
    const h = harness()
    h.qa.selectSnapshot('page-1', 'snap-1')
    h.requestCompletion.mockImplementationOnce((_messages, _profileId, options) => new Promise((_resolve, reject) => {
      options?.onToken?.('部分回答')
      options?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    }))
    const pending = h.qa.send('原问题')
    await vi.waitFor(() => expect(h.requestCompletion).toHaveBeenCalledOnce())
    h.qa.stop()
    expect(await pending).toBe(false)
    expect(h.qa.currentSession.value?.messages.at(-1)?.status).toBe('cancelled')
    expect(await h.qa.retry()).toBe(true)
    expect(h.requestCompletion.mock.calls[1][0].some(m => m.content === '部分回答')).toBe(false)
  })

  it('recovers a user-only legacy turn on load', async () => {
    const h = harness()
    h.qa.selectSnapshot('page-1', 'snap-1')
    await h.qa.send('旧问题')
    const id = h.qa.currentSession.value!.id
    h.data.get(id)!.messages.pop()
    await h.qa.load(id)
    expect(h.repository.ensureAssistantForLastUser).toHaveBeenCalledOnce()
    expect(await h.qa.retry()).toBe(true)
  })

  it('marks an abandoned streaming answer interrupted when opening its history', async () => {
    const h = harness()
    h.qa.selectSnapshot('page-1', 'snap-1')
    await h.qa.send('问题')
    const id = h.qa.currentSession.value!.id
    h.data.get(id)!.messages.at(-1)!.status = 'streaming'
    await h.qa.load(id)
    expect(h.qa.currentSession.value?.messages.at(-1)?.status).toBe('interrupted')
  })

  it('does not downgrade a completed answer if its display refresh fails', async () => {
    const h = harness()
    h.qa.selectSnapshot('page-1', 'snap-1')
    h.repository.getSession.mockRejectedValueOnce(new Error('读取失败'))
    expect(await h.qa.send('问题')).toBe(true)
    expect(h.data.values().next().value?.messages.at(-1)?.status).toBe('completed')
  })
})
