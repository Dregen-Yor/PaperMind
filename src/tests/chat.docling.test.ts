import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ GlobalWorkerOptions: { workerSrc: '' } }))
vi.mock('../utils/transformersEmbedder', () => ({ createTransformersEmbedder: vi.fn().mockRejectedValue(new Error('offline test')) }))
vi.mock('../utils/visualSummaryPdf', () => ({ renderSummaryPdf: vi.fn().mockResolvedValue([{ page: 0, width: 100, height: 100, data: 'data:image/png;base64,YQ==' }]) }))
vi.mock('../utils/visualSummary', async original => ({ ...await original<object>(), hashVisualSource: vi.fn().mockResolvedValue('visual-test-hash') }))

import { useChatStore } from '../stores/chat'
import { DEFAULT_DOCLING_SETTINGS, normalizeDoclingDocument } from '../utils/doclingDocument'
import { renderSummaryPdf } from '../utils/visualSummaryPdf'
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
  vi.mocked(renderSummaryPdf).mockReset().mockResolvedValue([{ page: 0, width: 100, height: 100, data: 'data:image/png;base64,YQ==' }])
  db().paper.readFile.mockReset().mockResolvedValue('YQ==')
  db().documentSummary.get.mockReset().mockImplementation(async (_kind: string, _id: string, slot: string) => slot === 'materials' ? {
    sourceHash: 'visual-test-hash', payload: JSON.stringify({ version: 1, sourceHash: 'visual-test-hash', protocol: 'visual-materials-v2-padded-crops', items: [], coveredPages: [0], usage: [] }),
  } : null)
  db().documentSummary.save.mockReset().mockResolvedValue({})
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
describe('native /abstract original-page integration', () => {
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
    expect(db().docling.convert).not.toHaveBeenCalled()
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('uses the active chat model and preserves paper/page references', async () => {
    const request = vi.fn().mockResolvedValue(ok('## 解读\nEvidence {{cite:text-1}}'))
    global.fetch = request
    const store = await configure(); const conv = await store.newConversation('t', ['paper'])
    await store.sendMessage(conv.id, '/abstract')
    const body = JSON.parse(request.mock.calls[0][1].body)
    expect(body.model).toBe('my-chat-model')
    expect(body.messages[1].content).toContainEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } })
    expect(conv.messages.at(-1)?.sources).toEqual([{ label: 'paper', paperId: 'paper' }])
    expect(store.abstractProgress[conv.id]).toBeUndefined()
    expect(db().index.get).not.toHaveBeenCalled()
    expect(db().docling.convert).not.toHaveBeenCalled()
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
  it('retries generation using already prepared materials without re-running localization', async () => {
    global.fetch = vi.fn().mockRejectedValueOnce(new Error('model unavailable')).mockResolvedValue(ok('# Complete report'))
    const store = await configure(); const conv = await store.newConversation('t', ['paper'])
    await expect(store.sendMessage(conv.id, '/abstract')).rejects.toThrow('model unavailable')
    await store.retryMessage(conv.id, conv.messages.at(-1)!.id)
    expect(conv.messages.at(-1)?.content).toBe('# Complete report')
    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(db().docling.convert).not.toHaveBeenCalled()
  })
  it('continues a truncated abstract using its original paper and avoids RAG', async () => {
    global.fetch = vi.fn().mockResolvedValue(ok('Beginning {{cite:text-1}}', 'length'))
    const store = await configure(); const conv = await store.newConversation('t', ['paper'])
    await store.sendMessage(conv.id, '/abstract')
    const target = conv.messages.at(-1)!
    conv.paperIds = ['another-paper']
    global.fetch = vi.fn().mockResolvedValue(ok(' Continued {{cite:text-1}}'))
    await store.continueMessage(conv.id, target.id)
    expect(db().paper.readFile).toHaveBeenLastCalledWith('paper')
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
    expect(db().docling.convert).not.toHaveBeenCalled()
    const firstBody = JSON.parse(vi.mocked(global.fetch).mock.calls[0][1]!.body as string)
    const nextBody = JSON.parse(vi.mocked(global.fetch).mock.calls[1][1]!.body as string)
    expect(firstBody.messages[0].content).toContain('Second partial')
    expect(nextBody.messages[0].content).not.toContain('Second partial')
  })
})

describe('/abstract run ownership', () => {
  it('locks the conversation while pages render, then cancels without late chat writes', async () => {
    let release!: (value: any) => void
    vi.mocked(renderSummaryPdf).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
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
    release([{ page: 0, width: 100, height: 100, data: 'data:image/png;base64,YQ==' }])
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(db().paperAbstract.save).not.toHaveBeenCalled()
    expect(conv.messages.at(-1)?.content).toBe('')
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
    expect(db().paper.readFile).toHaveBeenLastCalledWith('paper')
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
  await vi.waitFor(() => expect(conv.messages).toHaveLength(2))
  await store.stopConversationRun(conv.id)
  await chat
  expect(requests).toHaveLength(1)
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
  expect(db().docling.convert).not.toHaveBeenCalled()
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
  expect(db().paper.readFile).toHaveBeenLastCalledWith('paper')
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
