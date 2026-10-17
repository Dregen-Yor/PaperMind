import { ref } from 'vue'
import type { DbApi } from '../types/ipcContract'
import type { PreviewApi, PreviewBounds } from '../types/webPreview'
import type { WebPageSummary, WebSnapshotPreview } from '../types/webQa'
import type { createWebQaController } from './useWebQa'

type QaController = ReturnType<typeof createWebQaController>
type WebRepository = Pick<DbApi['webQa'], 'listPages' | 'archive' | 'getPreview' | 'removePage'>
const zeroBounds = { x: 0, y: 0, width: 0, height: 0 }

export function useWebPageHistory(preview: PreviewApi, repository: WebRepository, qa: QaController) {
  const pages = ref<WebPageSummary[]>([])
  const selectedPage = ref<WebPageSummary | null>(null)
  const selectedSnapshotPreview = ref<WebSnapshotPreview | null>(null)
  const mode = ref<'live' | 'cached'>('live')

  async function refreshPages() {
    pages.value = await repository.listPages()
    if (selectedPage.value) selectedPage.value = pages.value.find(p => p.id === selectedPage.value?.id) ?? null
  }

  async function useArchivedPage(page: WebPageSummary) {
    selectedPage.value = page
    selectedSnapshotPreview.value = await repository.getPreview(page.latestSnapshotId)
    qa.selectSnapshot(page.id, page.latestSnapshotId)
    await qa.refresh().catch(() => {})
    await refreshPages().catch(() => {})
  }

  async function openExplicit(url: string, bounds: PreviewBounds) {
    mode.value = 'live'
    selectedSnapshotPreview.value = null
    const snapshot = await preview.openAndCapture(url, bounds)
    const page = await repository.archive(snapshot, Date.now())
    await useArchivedPage(page)
    return page
  }

  async function saveCurrent() {
    const snapshot = await preview.captureSnapshot()
    const page = await repository.archive(snapshot, Date.now())
    mode.value = 'live'
    await useArchivedPage(page)
    return page
  }

  async function selectPage(id: string) {
    const page = pages.value.find(p => p.id === id)
    if (!page) throw new Error('网页历史不存在')
    const cached = await repository.getPreview(page.latestSnapshotId)
    if (!cached) throw new Error('网页缓存不存在')
    await preview.setBounds(zeroBounds)
    selectedPage.value = page
    selectedSnapshotPreview.value = cached
    mode.value = 'cached'
    qa.selectSnapshot(page.id, page.latestSnapshotId)
    await qa.refresh().catch(() => {})
  }

  async function selectSession(id: string) {
    await qa.load(id)
    const session = qa.currentSession.value
    if (!session) throw new Error('网页会话不存在')
    const cached = await repository.getPreview(session.snapshotId)
    if (!cached) throw new Error('网页缓存不存在')
    await preview.setBounds(zeroBounds)
    selectedPage.value = pages.value.find(p => p.id === session.pageId) ?? selectedPage.value
    selectedSnapshotPreview.value = cached
    mode.value = 'cached'
    await qa.refresh().catch(() => {})
  }

  async function refreshPage(bounds: PreviewBounds) {
    if (!selectedPage.value) throw new Error('请先选择网页')
    return openExplicit(selectedPage.value.canonicalUrl, bounds)
  }

  async function removePage(id: string) {
    await repository.removePage(id)
    if (selectedPage.value?.id === id) {
      selectedPage.value = null
      selectedSnapshotPreview.value = null
      qa.selectSnapshot('', '')
      mode.value = 'live'
      await preview.close().catch(() => {})
    }
    await refreshPages()
  }

  return { pages, selectedPage, selectedSnapshotPreview, sessions: qa.sessions, mode,
    refreshPages, openExplicit, saveCurrent, selectPage, selectSession, refreshPage, removePage }
}
