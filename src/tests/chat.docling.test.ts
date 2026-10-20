import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ GlobalWorkerOptions: { workerSrc: '' } }))
vi.mock('../utils/transformersEmbedder', () => ({ createTransformersEmbedder: vi.fn().mockRejectedValue(new Error('offline test')) }))
import { useChatStore } from '../stores/chat'
import { DEFAULT_DOCLING_SETTINGS, normalizeDoclingDocument } from '../utils/doclingDocument'
import { buildEvidenceChunks } from '../utils/doclingAbstract'
const db = () => (globalThis as any).mockDb
const ok = (content: string, reason = 'stop') => ({ ok: true, json: async () => ({ choices: [{ message: { content }, finish_reason: reason }] }) })
const configure = async () => {
  const store = useChatStore(); await store.init()
  await store.setDoclingConfig({ ...DEFAULT_DOCLING_SETTINGS, baseUrl: 'http://localhost:5001' })
  await store.updateProfile(store.chatProfileId, { apiKey: 'test', model: 'my-chat-model' })
  return store
}
beforeEach(() => {
  setActivePinia(createPinia())
  db().settings.get.mockResolvedValue(null)
  db().chat.listConversations.mockResolvedValue([])
  db().index.list.mockResolvedValue([])
  db().index.get.mockClear()
  db().paper.get.mockImplementation(async (id: string) => ({ id, title: id }))
  db().docling.convert.mockReset().mockResolvedValue({ document: normalizeDoclingDocument({ texts: [{ text: 'Original evidence', prov: [{ page_no: 2 }] }] }), sourceHash: 'a'.repeat(64), configHash: 'b'.repeat(64), cached: true })
  db().docling.save.mockClear()
  db().abstractCheckpoint.get.mockReset().mockResolvedValue(null)
  db().abstractCheckpoint.save.mockReset().mockResolvedValue(undefined)
  db().paperAbstract.get.mockReset().mockResolvedValue(null)
  db().paperAbstract.save.mockReset().mockImplementation(async (report: any) => ({ ...report, updatedAt: 1 }))
  db().chat.updateMessage.mockClear()
})
describe('native /abstract Docling integration', () => {
  it('reuses a saved single-paper summary without a configured model or Docling service', async () => {
    db().paperAbstract.get.mockResolvedValue({
      paperId: 'paper', content: '# Existing report', sources: [{ label: '文1', paperId: 'paper' }],
      truncated: false, updatedAt: 1,
    })
    global.fetch = vi.fn()
    const store = useChatStore(); await store.init()
    const conv = await store.newConversation('t', ['paper'])
    await store.sendMessage(conv.id, '/abstract')
    expect(conv.messages.at(-1)?.content).toBe('# Existing report')
    expect(db().docling.convert).not.toHaveBeenCalled()
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('saves a new single-paper summary for direct use in another conversation', async () => {
    const reports = new Map<string, any>()
    db().paperAbstract.get.mockImplementation(async (id: string) => reports.get(id) ?? null)
    db().paperAbstract.save.mockImplementation(async (report: any) => {
      const saved = { ...report, updatedAt: 1 }
      reports.set(report.paperId, saved)
      return saved
    })
    global.fetch = vi.fn().mockResolvedValue(ok('# First report {{cite:text-1}}'))
    const store = await configure()
    const first = await store.newConversation('first', ['paper'])
    await store.sendMessage(first.id, '/abstract')
    const second = await store.newConversation('second', ['paper'])
    global.fetch = vi.fn().mockRejectedValue(new Error('model must not run again'))
    await store.sendMessage(second.id, '/abstract')
    expect(second.messages.at(-1)?.content).toBe(first.messages.at(-1)?.content)
    expect(reports.get('paper')?.content).toBe(first.messages.at(-1)?.content)
    expect(db().docling.convert).toHaveBeenCalledTimes(1)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('uses the active chat model and preserves paper/page references', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    const request = vi.fn().mockResolvedValue(ok('## 解读\nEvidence {{cite:text-1}}'))
    global.fetch = request
    const store = await configure(); const conv = await store.newConversation('t', ['paper'])
    await store.sendMessage(conv.id, '/abstract')
    const body = JSON.parse(request.mock.calls[0][1].body)
    expect(body.model).toBe('my-chat-model')
    expect(body.messages[0].content).toContain('中文')
    expect(conv.messages.at(-1)?.content).toContain('paper-source:paper:1')
    expect(store.abstractProgress[conv.id]).toBeUndefined()
    expect(db().index.get).not.toHaveBeenCalled()
    expect(timeout).toHaveBeenCalledWith(300_000)
    timeout.mockRestore()
  })
  it('retries a failed generation in place and reuses the successful parse', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('model unavailable'))
    const store = await configure(); const conv = await store.newConversation('t', ['paper'])
    await expect(store.sendMessage(conv.id, '/abstract')).rejects.toThrow('model unavailable')
    const failed = conv.messages.at(-1)!
    global.fetch = vi.fn().mockResolvedValue(ok('Recovered {{cite:text-1}}'))
    await store.retryMessage(conv.id, failed.id)
    expect(conv.messages).toHaveLength(2)
    expect(failed.error).toBe('')
    expect(failed.content).toContain('Recovered')
    expect(db().docling.save).not.toHaveBeenCalled()
  })
  it('retries a long abstract from the first unfinished evidence chunk', async () => {
    const document = normalizeDoclingDocument({ texts: [{ text: 'Evidence '.repeat(4000), prov: [{ page_no: 2 }] }] })
    db().docling.convert.mockResolvedValue({ document, sourceHash: 'a'.repeat(64), configHash: 'b'.repeat(64), cached: true })
    const saved = new Map<string, string>()
    db().abstractCheckpoint.get.mockImplementation(async (_paper: string, key: string, stage: string, position: number) => saved.get(`${key}:${stage}:${position}`) ?? null)
    db().abstractCheckpoint.save.mockImplementation(async (_paper: string, key: string, stage: string, position: number, content: string) => {
      saved.set(`${key}:${stage}:${position}`, content)
    })
    let calls = 0
    global.fetch = vi.fn(async (_url, init) => {
      calls++
      if (calls === 2) throw new Error('model unavailable')
      const prompt = JSON.parse(init.body).messages[1].content as string
      return ok(prompt.includes('提炼这一部分') ? `note-${calls}` : '# Complete report {{cite:text-1}}')
    }) as any
    const store = await configure(); const conv = await store.newConversation('t', ['paper'])
    await expect(store.sendMessage(conv.id, '/abstract')).rejects.toThrow('提炼论文内容（2/')
    const failed = conv.messages.at(-1)!
    expect(saved.size).toBe(1)
    await store.retryMessage(conv.id, failed.id)
    expect(failed.error).toBe('')
    expect(failed.content).toContain('Complete report')
    const mapRequests = vi.mocked(global.fetch).mock.calls.filter(call => JSON.parse(call[1]!.body as string).messages[1].content.includes('提炼这一部分'))
    expect(mapRequests).toHaveLength(buildEvidenceChunks(document).length + 1)
    expect(db().docling.convert).toHaveBeenCalledTimes(2)
  })
  it('continues a truncated abstract using its original paper and avoids RAG', async () => {
    global.fetch = vi.fn().mockResolvedValue(ok('Beginning {{cite:text-1}}', 'length'))
    const store = await configure(); const conv = await store.newConversation('t', ['paper'])
    await store.sendMessage(conv.id, '/abstract')
    const target = conv.messages.at(-1)!
    conv.paperIds = ['another-paper']
    global.fetch = vi.fn().mockResolvedValue(ok(' Continued {{cite:text-1}}'))
    await store.continueMessage(conv.id, target.id)
    expect(db().docling.convert.mock.calls.at(-1)[0]).toBe('paper')
    expect(target.content).toContain('Beginning')
    expect(target.content).toContain('Continued')
    expect(target.truncated).toBe(false)
    expect(db().paperAbstract.save).toHaveBeenLastCalledWith(expect.objectContaining({
      paperId: 'paper', content: target.content, truncated: false,
    }))
    expect(db().index.get).not.toHaveBeenCalled()
  })
  it('keeps separate titles and sources for multiple papers', async () => {
    global.fetch = vi.fn().mockResolvedValue(ok('解读 {{cite:text-1}}'))
    const store = await configure(); const conv = await store.newConversation('t', ['first', 'second'])
    await store.sendMessage(conv.id, '/abstract')
    expect(conv.messages.at(-1)?.content).toContain('## first')
    expect(conv.messages.at(-1)?.content).toContain('## second')
    expect(conv.messages.at(-1)?.sources?.map(s => s.paperId)).toEqual(['first', 'second'])
  })
  it('keeps completed papers when truncated and resumes the remaining original selection', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(ok('First complete {{cite:text-1}}'))
      .mockResolvedValueOnce(ok('Second partial {{cite:text-1}}', 'length'))
    const store = await configure(); const conv = await store.newConversation('t', ['first', 'second', 'third'])
    await store.sendMessage(conv.id, '/abstract')
    const target = conv.messages.at(-1)!
    expect(target.content).toContain('First complete')
    expect(target.content).toContain('Second partial')
    expect(target.truncated).toBe(true)
    expect(JSON.parse(target.context!)).toMatchObject({ paperIds: ['first', 'second', 'third'], index: 1 })
    expect(db().chat.updateMessage).toHaveBeenCalledWith(target.id, expect.objectContaining({ context: target.context, runStatus: 'completed' }))
    conv.paperIds = ['changed-selection']
    global.fetch = vi.fn().mockResolvedValueOnce(ok('Second continued {{cite:text-1}}'))
      .mockResolvedValueOnce(ok('Third complete {{cite:text-1}}'))
    await store.continueMessage(conv.id, target.id)
    expect(target.content).toContain('Second continued')
    expect(target.content).toContain('## third')
    expect(target.content.match(/## second/g)).toHaveLength(1)
    expect(target.truncated).toBe(false)
    expect(target.context).toBe('')
    expect(vi.mocked(window.db.docling.convert).mock.calls.map((call: any[]) => call[0])).toEqual(['first', 'second', 'second', 'third'])
    const firstBody = JSON.parse(vi.mocked(global.fetch).mock.calls[0][1]!.body as string)
    const nextBody = JSON.parse(vi.mocked(global.fetch).mock.calls[1][1]!.body as string)
    expect(firstBody.messages[1].content).toContain('Second partial')
    expect(nextBody.messages[1].content).not.toContain('Second partial')
  })
})

describe('/abstract run ownership', () => {
  it('locks the conversation and reserves its assistant while Docling waits, then cancels without late writes', async () => {
    let release!: (value: any) => void
    db().docling.convert.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    global.fetch = vi.fn().mockResolvedValue(ok('Late report'))
    const store = await configure()
    const conv = await store.newConversation('t', ['paper'])
    const pending = store.sendMessage(conv.id, '/abstract')
    await vi.waitFor(() => expect(release).toBeDefined())
    expect(conv.messages.map(message => message.role)).toEqual(['user', 'assistant'])
    expect(conv.messages.at(-1)?.runStatus).toBe('preparing')
    await expect(store.sendMessage(conv.id, 'second')).rejects.toThrow('正在生成回答')
    expect(await store.stopConversationRun(conv.id)).toBe(true)
    await pending
    expect(conv.messages.at(-1)?.runStatus).toBe('cancelled')
    release({ document: normalizeDoclingDocument({ texts: [{ text: 'Late evidence' }] }), cached: true })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(global.fetch).not.toHaveBeenCalled()
    expect(db().paperAbstract.save).not.toHaveBeenCalled()
    expect(db().abstractCheckpoint.save).not.toHaveBeenCalled()
  })

  it('retries the original selection after the conversation selection changes', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('model unavailable'))
    const store = await configure()
    const conv = await store.newConversation('t', ['paper'])
    await expect(store.sendMessage(conv.id, '/abstract')).rejects.toThrow()
    const target = conv.messages.at(-1)!
    conv.paperIds = ['changed']
    global.fetch = vi.fn().mockResolvedValue(ok('Recovered'))
    await store.retryMessage(conv.id, target.id)
    expect(db().docling.convert.mock.calls.at(-1)[0]).toBe('paper')
    expect(target.runStatus).toBe('completed')
    expect(conv.messages).toHaveLength(2)
  })
})

it('cancelling a chat-owned summary does not cancel an independent summary-tab job', async () => {
  const requests: Array<{ signal: AbortSignal; resolve: (value: any) => void }> = []
  global.fetch = vi.fn((_url, init) => new Promise((resolve, reject) => {
    const signal = init!.signal as AbortSignal
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    requests.push({ signal, resolve })
  })) as any
  const store = await configure()
  const tab = store.generatePaperAbstract('paper')
  await vi.waitFor(() => expect(requests).toHaveLength(1))
  const conv = await store.newConversation('t', ['paper'])
  const chat = store.sendMessage(conv.id, '/abstract')
  await vi.waitFor(() => expect(requests).toHaveLength(2))
  await store.stopConversationRun(conv.id)
  await chat
  expect(requests[1].signal.aborted).toBe(true)
  expect(requests[0].signal.aborted).toBe(false)
  expect(db().paperAbstract.save).not.toHaveBeenCalled()
  requests[0].resolve(ok('Independent report'))
  expect((await tab).content).toContain('Independent report')
  expect(db().paperAbstract.save).toHaveBeenCalledTimes(1)
  expect(conv.messages.at(-1)?.runStatus).toBe('cancelled')
})

it('keeps completed papers when a later paper fails and continues from that paper', async () => {
  global.fetch = vi.fn().mockResolvedValueOnce(ok('First complete')).mockRejectedValueOnce(new Error('second failed'))
  const store = await configure()
  const conv = await store.newConversation('t', ['first', 'second'])
  await expect(store.sendMessage(conv.id, '/abstract')).rejects.toThrow('second failed')
  const target = conv.messages.at(-1)!
  expect(target.content).toContain('First complete')
  expect(JSON.parse(target.context!)).toMatchObject({ index: 1, paperIds: ['first', 'second'] })
  global.fetch = vi.fn().mockResolvedValue(ok('Second completed'))
  await store.continueMessage(conv.id, target.id)
  expect(target.content).toContain('First complete')
  expect(target.content).toContain('Second completed')
  expect(db().docling.convert.mock.calls.map((call: any[]) => call[0])).toEqual(['first', 'second', 'second'])
})

it('retries even a completed cached summary against its original selection', async () => {
  db().paperAbstract.get.mockResolvedValue({ paperId: 'paper', content: 'Cached', sources: [], truncated: false, updatedAt: 1 })
  const store = await configure()
  const conv = await store.newConversation('t', ['paper'])
  await store.sendMessage(conv.id, '/abstract')
  const target = conv.messages.at(-1)!
  conv.paperIds = ['changed']
  global.fetch = vi.fn().mockResolvedValue(ok('Regenerated'))
  await store.retryMessage(conv.id, target.id)
  expect(db().docling.convert.mock.calls.at(-1)[0]).toBe('paper')
})

it('preserves the resume checkpoint when a continuation fails before producing another paper', async () => {
  global.fetch = vi.fn().mockResolvedValueOnce(ok('First complete')).mockResolvedValueOnce(ok('Second partial', 'length'))
  const store = await configure()
  const conv = await store.newConversation('t', ['first', 'second', 'third'])
  await store.sendMessage(conv.id, '/abstract')
  const target = conv.messages.at(-1)!
  const checkpoint = target.context
  global.fetch = vi.fn().mockRejectedValue(new Error('continuation failed'))
  await expect(store.continueMessage(conv.id, target.id)).rejects.toThrow('continuation failed')
  expect(target.context).toBe(checkpoint)
  expect(target.content).toContain('Second partial')
})
