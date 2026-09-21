import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ default: {}, GlobalWorkerOptions: { workerSrc: '' } }))

import { useChatStore } from '../stores/chat'

const mockDb = () => (globalThis as any).mockDb
const llm = (content: string) => ({
  ok: true,
  json: () => Promise.resolve({ choices: [{ message: { content }, finish_reason: 'stop' }] }),
})
/** 生成阶段自 T5（#6）起走流式：回答请求按 OpenAI 兼容 SSE 返回，打分仍是 JSON。 */
const sse = (content: string) => {
  const body = `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
    + `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`
    + 'data: [DONE]\n\n'
  return { ok: true, status: 200, body: new Response(body).body }
}
const INDEX_JSON = JSON.stringify({
  title: 'R', nodeId: 'root', startPage: 0, endPage: 3, summary: '',
  nodes: [
    { title: 'A', nodeId: '0', startPage: 0, endPage: 1, summary: 'a', nodes: [] },
    { title: 'B', nodeId: '1', startPage: 2, endPage: 3, summary: 'b', nodes: [] },
  ],
})

describe('来源芯片与跳转一致性（#1）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockDb().chat.listConversations.mockResolvedValue([])
    mockDb().chat.addMessage.mockClear()
    mockDb().settings.get.mockResolvedValue(null)
    mockDb().index.list.mockResolvedValue(['p1'])
    mockDb().index.get.mockResolvedValue({ indexJson: INDEX_JSON, pagesJson: JSON.stringify(['p0', 'p1', 'p2', 'p3']) })
  })

  it('芯片文本页区间与 startPage 一致，且带 paperId', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(llm('[{"id":0,"score":9},{"id":1,"score":2}]')) // 打分
      .mockResolvedValueOnce(sse('答案')) // 生成
    const store = useChatStore()
    await store.init()
    const conv = await store.newConversation('t', ['p1'])
    await store.sendMessage(conv.id, '问题')

    const assistant = conv.messages.find(m => m.role === 'assistant')!
    expect(assistant.sources!.length).toBeGreaterThan(0)
    for (const ref of assistant.sources!) {
      const match = /^Pages (\d+)/.exec(ref.label)
      if (match && ref.startPage !== undefined) expect(Number(match[1])).toBe(ref.startPage + 1)
      expect(ref.paperId).toBe('p1')
      expect(typeof ref.endPage).toBe('number')
    }
  })

  it('检索无来源时不产生任何芯片数据', async () => {
    global.fetch = vi.fn().mockResolvedValue(sse('答案')) as any
    const store = useChatStore()
    await store.init()
    const conv = await store.newConversation('t', []) // 未选论文 → 无来源
    await store.sendMessage(conv.id, '问题')
    expect(conv.messages.find(m => m.role === 'assistant')!.sources).toBeUndefined()
  })
})
