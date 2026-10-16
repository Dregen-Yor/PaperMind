import { describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ default: {}, GlobalWorkerOptions: { workerSrc: '' } }))
vi.mock('../utils/transformersEmbedder', () => ({
  createTransformersEmbedder: vi.fn().mockRejectedValue(new Error('scenario does not load an embedder')),
}))

import { useChatStore } from '../stores/chat'

const db = () => (globalThis as any).mockDb
const frame = (text: string) => new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`)
const finish = () => new TextEncoder().encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')

async function runScenario(action: 'fail' | 'stop') {
  setActivePinia(createPinia())
  db().chat.listConversations.mockResolvedValue([])
  db().chat.addMessage.mockClear()
  db().chat.updateMessage.mockClear()
  db().settings.get.mockResolvedValue(null)
  db().index.list.mockResolvedValue([])
  const store = useChatStore()
  await store.init()
  const conversation = await store.newConversation('Scenario', [])
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let requestAborted = false
  global.fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({ start(c) { controller = c } })
    init.signal?.addEventListener('abort', () => {
      requestAborted = true
      controller.error(new DOMException('Aborted', 'AbortError'))
    }, { once: true })
    return { ok: true, status: 200, body }
  }) as any

  const send = store.sendMessage(conversation.id, '请概括这篇论文的贡献').catch(() => undefined)
  await vi.waitFor(() => expect(controller).toBeDefined())
  controller.enqueue(frame('已经生成的前半段。'))
  await vi.waitFor(() => expect(conversation.messages.some(m => m.role === 'assistant' && m.content.includes('前半段'))).toBe(true))

  const stopAvailable = typeof (store as any).stopConversationRun === 'function'
  if (action === 'stop' && stopAvailable) {
    await (store as any).stopConversationRun(conversation.id)
  } else if (action === 'stop') {
    controller.enqueue(frame('后半段仍在继续。'))
    controller.enqueue(finish())
    controller.close()
  } else {
    controller.error(new Error('network down'))
  }
  await send

  const assistant = conversation.messages.filter(m => m.role === 'assistant')
  const persisted = db().chat.addMessage.mock.calls.map((call: any[]) => call[0])
    .filter((message: any) => message.role === 'assistant')
  const updates = db().chat.updateMessage.mock.calls.map((call: any[]) => call[1])
  return {
    action, stopAvailable, requestAborted,
    visibleAssistantCount: assistant.length,
    visibleContent: assistant.at(-1)?.content ?? '',
    visibleError: assistant.at(-1)?.error ?? '',
    persistedAssistantCount: persisted.length,
    persistedPartial: persisted.some((message: any) => String(message.content).includes('前半段'))
      || updates.some((patch: any) => String(patch.content).includes('前半段')),
    status: (assistant.at(-1) as any)?.runStatus ?? null,
  }
}

describe('repeatable chat lifecycle scenario', () => {
  it('runs the same scripted conversation through a network failure and a stop action', async () => {
    const results = [await runScenario('fail'), await runScenario('stop')]
    expect(results[0]).toMatchObject({
      action: 'fail', visibleAssistantCount: 1, visibleContent: '已经生成的前半段。',
      persistedPartial: true, status: 'failed',
    })
    expect(results[1]).toMatchObject({
      action: 'stop', stopAvailable: true, requestAborted: true,
      visibleAssistantCount: 1, visibleContent: '已经生成的前半段。',
      persistedPartial: true, status: 'cancelled',
    })
    console.log(`CHAT_LIFECYCLE_RESULT=${JSON.stringify(results)}`)
  })
})
