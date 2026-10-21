import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ GlobalWorkerOptions: { workerSrc: '' } }))
vi.mock('../utils/transformersEmbedder', () => ({ createTransformersEmbedder: vi.fn().mockRejectedValue(new Error('offline test')) }))
vi.mock('../utils/visualSummaryPdf', () => ({ renderSummaryPdf: vi.fn().mockResolvedValue([{ page: 0, width: 100, height: 100, data: 'data:image/png;base64,YQ==' }]) }))
vi.mock('../utils/visualSummary', async original => ({ ...await original<object>(), hashVisualSource: vi.fn().mockResolvedValue('visual-test-hash') }))


import PaperAbstractPanel from '../components/PaperAbstractPanel.vue'
import { useChatStore } from '../stores/chat'
import { normalizeDoclingDocument } from '../utils/doclingDocument'
import type { PaperAbstractReport } from '../utils/paperAbstract'

const db = () => (globalThis as any).mockDb
const response = (content: string) => ({ ok: true, json: async () => ({ choices: [{ message: { content }, finish_reason: 'stop' }] }) })
const denied = () => ({ ok: false, status: 401, text: async () => 'Invalid credential' })
const report = (content: string, truncated = false): PaperAbstractReport => ({ paperId: 'paper', content, truncated, sources: [], updatedAt: 1 })
const requests: Array<{ resolve: (value: unknown) => void; signal: AbortSignal }> = []
const tasks: Array<Promise<unknown>> = []
let reports: Map<string, PaperAbstractReport>
let wrapper: VueWrapper | undefined

beforeEach(() => {
  requests.length = 0
  tasks.length = 0
  reports = new Map()
  db().paper.readFile.mockResolvedValue('YQ==')
  db().documentSummary.get.mockReset().mockImplementation(async (_kind: string, _id: string, slot: string) => slot === 'materials' ? {
    sourceHash: 'visual-test-hash', payload: JSON.stringify({ version: 1, sourceHash: 'visual-test-hash', protocol: 'visual-materials-v2-padded-crops', items: [], coveredPages: [0], usage: [] }),
  } : null)
  db().documentSummary.save.mockReset().mockResolvedValue({})
  db().settings.get.mockResolvedValue(null)
  db().chat.listConversations.mockResolvedValue([])
  db().index.list.mockResolvedValue([])
  db().paper.get.mockImplementation(async (id: string) => ({ id, title: id }))
  db().paperAbstract.get.mockReset().mockImplementation(async (id: string) => reports.get(id) ?? null)
  db().paperAbstract.save.mockReset().mockImplementation(async (input: Omit<PaperAbstractReport, 'updatedAt'>) => {
    const saved = { ...input, updatedAt: 2 }
    reports.set(saved.paperId, saved)
    return saved
  })
  db().abstractCheckpoint.get.mockReset().mockResolvedValue(null)
  db().abstractCheckpoint.save.mockReset().mockResolvedValue(undefined)
  db().docling.convert.mockReset().mockResolvedValue({
    document: normalizeDoclingDocument({ texts: [{ text: 'Original evidence.', prov: [{ page_no: 1 }] }] }),
    sourceHash: 'a'.repeat(64), configHash: 'b'.repeat(64), cached: true,
  })
  vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise(resolve => {
    requests.push({ resolve, signal: init.signal })
  })))
})

afterEach(async () => {
  requests.forEach(request => request.resolve(response('Cleanup report')))
  await Promise.allSettled(tasks)
  wrapper?.unmount()
  wrapper = undefined
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function openPanel() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = useChatStore(pinia)
  await store.init()
  await store.updateProfile(store.chatProfileId, { apiKey: 'test', model: 'summary-model' })
  const generate = vi.spyOn(store, 'generatePaperAbstract')
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/paper/:paperId', component: PaperAbstractPanel, props: true },
    { path: '/other', component: { template: '<p>Other feature</p>' } },
  ] })
  await router.push('/paper/paper')
  wrapper = mount(RouterView, { global: { plugins: [pinia, router], stubs: {
    ElButton: { props: ['loading'], template: '<button :disabled="loading" @click="$emit(\'click\')"><slot /></button>' },
    ElIcon: true,
    MarkdownContent: { props: ['content'], template: '<div class="rendered-report">{{ content }}</div>' },
  } } })
  await flushPromises()
  async function start() {
    await wrapper!.get('button').trigger('click')
    const task = generate.mock.results.at(-1)!.value as Promise<PaperAbstractReport>
    tasks.push(task)
    await vi.waitFor(() => expect(requests).toHaveLength(tasks.length))
    return { task }
  }
  async function navigate(path: string) {
    await router.push(path)
    await flushPromises()
  }
  return { store, start, navigate }
}

describe('paper summary survives feature navigation', () => {
  it('reattaches progress and the saved result when returning before completion without starting a second job', async () => {
    const { store, start, navigate } = await openPanel()
    const { task } = await start()
    await navigate('/other')
    await navigate('/paper/paper')
    expect(wrapper!.find('.abstract-progress').exists()).toBe(true)
    expect(wrapper!.get('button').attributes('disabled')).toBeDefined()
    const joined = store.generatePaperAbstract('paper', true)
    requests[0].resolve(response('Background report'))
    await Promise.all([task, joined])
    await flushPromises()
    expect(wrapper!.get('.rendered-report').text()).toContain('Background report')
    expect(requests[0].signal.aborted).toBe(false)
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(db().paperAbstract.save).toHaveBeenCalledTimes(1)
  })

  it('lets the user stop a PDF summary and rejects a late model response', async () => {
    const { start } = await openPanel()
    const { task } = await start()
    const stop = wrapper!.findAll('button').find(button => button.text() === '停止')
    expect(stop).toBeDefined()
    await stop!.trigger('click')
    expect(requests[0].signal.aborted).toBe(true)
    requests[0].resolve(response('Cancelled late result'))
    await task.catch(() => {})
    await flushPromises()
    expect(reports.has('paper')).toBe(false)
    expect(wrapper!.text()).not.toContain('Cancelled late result')
  })
  it('displays a report completed while another feature was open', async () => {
    const { start, navigate } = await openPanel()
    const { task } = await start()
    await navigate('/other')
    requests[0].resolve(response('Finished in background'))
    await task
    await navigate('/paper/paper')
    expect(wrapper!.get('.rendered-report').text()).toContain('Finished in background')
    expect(wrapper!.find('.abstract-progress').exists()).toBe(false)
  })

  it('keeps a background error visible after return and clears it for a successful retry', async () => {
    const { start, navigate } = await openPanel()
    const { task } = await start()
    await navigate('/other')
    requests[0].resolve(denied())
    await task.catch(() => {})
    await navigate('/paper/paper')
    expect(wrapper!.get('[role="alert"]').text()).toContain('401')
    const retry = await start()
    expect(wrapper!.find('[role="alert"]').exists()).toBe(false)
    requests[1].resolve(response('Recovered report'))
    await retry.task
    await flushPromises()
    expect(wrapper!.get('.rendered-report').text()).toContain('Recovered report')
  })

  it('retains the saved report when regeneration fails after the panel was remounted', async () => {
    reports.set('paper', report('Old report'))
    const { start, navigate } = await openPanel()
    const { task } = await start()
    await navigate('/other')
    await navigate('/paper/paper')
    expect(wrapper!.get('.rendered-report').text()).toContain('Old report')
    expect(wrapper!.find('.abstract-progress').exists()).toBe(true)
    requests[0].resolve(denied())
    await task.catch(() => {})
    await flushPromises()
    expect(wrapper!.get('.rendered-report').text()).toContain('Old report')
    expect(wrapper!.get('[role="alert"]').text()).toContain('401')
    expect(reports.get('paper')!.content).toBe('Old report')
  })

  it('keeps two papers independent when switching between their active jobs', async () => {
    const { start, navigate } = await openPanel()
    const first = await start()
    await navigate('/paper/second')
    const second = await start()
    await navigate('/paper/paper')
    expect(wrapper!.find('.abstract-progress').exists()).toBe(true)
    await navigate('/paper/second')
    requests[0].resolve(response('First paper report'))
    await first.task
    await flushPromises()
    expect(wrapper!.find('.rendered-report').exists()).toBe(false)
    expect(wrapper!.find('.abstract-progress').exists()).toBe(true)
    requests[1].resolve(response('Second paper report'))
    await second.task
    await flushPromises()
    expect(wrapper!.get('.rendered-report').text()).toContain('Second paper report')
    await navigate('/paper/paper')
    expect(wrapper!.get('.rendered-report').text()).toContain('First paper report')
  })

  it('does not let a late initial cache read hide a newly completed report', async () => {
    let resolveCache!: (value: PaperAbstractReport) => void
    db().paperAbstract.get.mockImplementationOnce(() => new Promise(resolve => { resolveCache = resolve }))
    const { store } = await openPanel()
    const task = store.generatePaperAbstract('paper')
    tasks.push(task)
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    requests[0].resolve(response('New report'))
    await task
    resolveCache(report('Stale report'))
    await flushPromises()
    expect(wrapper!.get('.rendered-report').text()).toContain('New report')
    expect(wrapper!.text()).not.toContain('Stale report')
  })

  it('stays busy across navigation until the generated report has been saved', async () => {
    let finishSave!: (value: PaperAbstractReport) => void
    db().paperAbstract.save.mockImplementationOnce(() => new Promise(resolve => { finishSave = resolve }))
    const { start, navigate } = await openPanel()
    const { task } = await start()
    requests[0].resolve(response('Awaiting save'))
    await vi.waitFor(() => expect(finishSave).toBeDefined())
    await navigate('/other')
    await navigate('/paper/paper')
    // Settle before assertions so a failing test cannot leave the job pending.
    const wasBusy = wrapper!.get('button').attributes('disabled') !== undefined
    const showedProgress = wrapper!.find('.abstract-progress').exists()
    finishSave(report('Saved report'))
    await task
    await flushPromises()
    expect(wasBusy).toBe(true)
    expect(showedProgress).toBe(true)
    expect(wrapper!.get('.rendered-report').text()).toContain('Saved report')
  })

  it('continues a partial report in the background and removes the continuation action after completion', async () => {
    reports.set('paper', report('Beginning', true))
    const { start, navigate } = await openPanel()
    const { task } = await start()
    await navigate('/other')
    await navigate('/paper/paper')
    requests[0].resolve(response('Ending'))
    await task
    await flushPromises()
    expect(wrapper!.get('.rendered-report').text()).toContain('Beginning')
    expect(wrapper!.get('.rendered-report').text()).toContain('Ending')
    expect(wrapper!.find('.abstract-continuation').exists()).toBe(false)
    expect(reports.get('paper')!.truncated).toBe(false)
  })

  it('shows a report regenerated from chat instead of retaining an older summary-tab result', async () => {
    const { store, start, navigate } = await openPanel()
    const { task } = await start()
    requests[0].resolve(response('Original panel report'))
    await task
    const conversation = await store.newConversation('Summary chat', ['paper'])
    await store.sendMessage(conversation.id, '/abstract')
    const retry = store.retryMessage(conversation.id, conversation.messages.at(-1)!.id)
    tasks.push(retry)
    await vi.waitFor(() => expect(requests).toHaveLength(2))
    requests[1].resolve(response('Regenerated from chat'))
    await retry
    await flushPromises()
    expect(wrapper!.get('.rendered-report').text()).toContain('Regenerated from chat')
    await navigate('/other')
    await navigate('/paper/paper')
    expect(wrapper!.get('.rendered-report').text()).toContain('Regenerated from chat')
  })

  it('preserves the old report and exposes a background save failure after return', async () => {
    reports.set('paper', report('Previously saved'))
    db().paperAbstract.save.mockRejectedValueOnce(new Error('Disk full'))
    const { start, navigate } = await openPanel()
    const { task } = await start()
    await navigate('/other')
    requests[0].resolve(response('Unsaved replacement'))
    await task.catch(() => {})
    await navigate('/paper/paper')
    expect(wrapper!.get('[role="alert"]').text()).toContain('Disk full')
    expect(wrapper!.get('.rendered-report').text()).toContain('Previously saved')
    expect(reports.get('paper')!.content).toBe('Previously saved')
    expect(wrapper!.get('button').attributes('disabled')).toBeUndefined()
  })
})
