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
  db().chat.updateMessage.mockClear()
})
describe('native /abstract Docling integration', () => {
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
    expect(db().chat.addMessage.mock.calls.at(-1)[0].context).toBe(target.context)
    conv.paperIds = ['changed-selection']
    global.fetch = vi.fn().mockResolvedValueOnce(ok('Second continued {{cite:text-1}}'))
      .mockResolvedValueOnce(ok('Third complete {{cite:text-1}}'))
    await store.continueMessage(conv.id, target.id)
    expect(target.content).toContain('Second continued')
    expect(target.content).toContain('## third')
    expect(target.content.match(/## second/g)).toHaveLength(1)
    expect(target.truncated).toBe(false)
    expect(target.context).toBe('')
    expect(vi.mocked(window.db.docling.convert).mock.calls.map(call => call[0])).toEqual(['first', 'second', 'second', 'third'])
    const firstBody = JSON.parse(vi.mocked(global.fetch).mock.calls[0][1]!.body as string)
    const nextBody = JSON.parse(vi.mocked(global.fetch).mock.calls[1][1]!.body as string)
    expect(firstBody.messages[1].content).toContain('Second partial')
    expect(nextBody.messages[1].content).not.toContain('Second partial')
  })
})
