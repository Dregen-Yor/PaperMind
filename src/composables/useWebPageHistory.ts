import { ref } from 'vue'
import type { DbApi } from '../types/ipcContract'
import type { PreviewApi, PreviewBounds } from '../types/webPreview'
import type { WebPageSummary, WebSnapshotPreview } from '../types/webQa'
import type { createWebQaController } from './useWebQa'

type QaController = ReturnType<typeof createWebQaController>
type WebRepository = Pick<DbApi['webQa'], 'listPages' | 'archive' | 'getPreview' | 'findAppearance' | 'removePage'>
const zeroBounds = { x: 0, y: 0, width: 0, height: 0 }

export function useWebPageHistory(preview: PreviewApi, repository: WebRepository, qa: QaController) {
  const pages = ref<WebPageSummary[]>([])
  const selectedPage = ref<WebPageSummary | null>(null)
  const selectedSnapshotPreview = ref<WebSnapshotPreview | null>(null)
  const mode = ref<'live' | 'cached'>('live')
  const nativeCached = ref(false)
  const cacheLoadError = ref('')
  const appearanceNotice = ref('')
  let selectionVersion = 0

  async function showSnapshot(snapshot: WebSnapshotPreview, bounds: PreviewBounds,
    version: number, appearance?: WebSnapshotPreview | null): Promise<void> {
    if (version !== selectionVersion) return
    cacheLoadError.value = ''
    appearanceNotice.value = ''
    const matchingAppearance = !snapshot.hasOriginalAppearance && appearance?.hasOriginalAppearance
      && appearance.contentHash === snapshot.contentHash ? appearance : null
    const display = matchingAppearance ?? snapshot
    const notice = matchingAppearance ? '外观来自同内容缓存；当前问答仍依据原快照' : ''
    let shown = false
    let errorMessage = ''
    try {
      shown = await preview.showCached(display.id, bounds)
      if (display.hasOriginalAppearance && !shown) errorMessage = '原貌缓存无法加载，已改用阅读内容。'
    } catch (error) {
      errorMessage = `原貌缓存加载失败，已改用阅读内容：${error instanceof Error ? error.message : String(error)}`
    }
    if (version !== selectionVersion) return
    nativeCached.value = shown
    cacheLoadError.value = errorMessage
    appearanceNotice.value = shown ? notice : ''
    if (!shown) await preview.setBounds(zeroBounds)
  }

  async function refreshPages() {
    pages.value = await repository.listPages()
    if (selectedPage.value) selectedPage.value = pages.value.find(p => p.id === selectedPage.value?.id) ?? null
  }

  async function useArchivedPage(page: WebPageSummary, version: number) {
    const cached = await repository.getPreview(page.latestSnapshotId)
    if (version !== selectionVersion) throw new Error('网页选择已变化')
    selectedPage.value = page
    selectedSnapshotPreview.value = cached
    qa.selectSnapshot(page.id, page.latestSnapshotId)
    await qa.refresh().catch(() => {})
    await refreshPages().catch(() => {})
    if (version !== selectionVersion) throw new Error('网页选择已变化')
  }

  async function openExplicit(url: string, bounds: PreviewBounds) {
    const version = ++selectionVersion
    mode.value = 'live'
    nativeCached.value = false
    cacheLoadError.value = ''
    appearanceNotice.value = ''
    selectedSnapshotPreview.value = null
    const snapshot = await preview.openAndCapture(url, bounds)
    if (version !== selectionVersion) throw new Error('网页选择已变化')
    const page = await repository.archive(snapshot, Date.now())
    if (version !== selectionVersion) throw new Error('网页选择已变化')
    await useArchivedPage(page, version)
    return page
  }

  async function openLive(url: string, bounds: PreviewBounds) {
    const version = ++selectionVersion
    mode.value = 'live'
    nativeCached.value = false
    cacheLoadError.value = ''
    appearanceNotice.value = ''
    await preview.open(url, bounds)
    if (version !== selectionVersion) throw new Error('网页选择已变化')
  }

  async function saveCurrent() {
    const version = ++selectionVersion
    const snapshot = await preview.captureSnapshot()
    if (version !== selectionVersion) throw new Error('网页选择已变化')
    const page = await repository.archive(snapshot, Date.now())
    if (version !== selectionVersion) throw new Error('网页选择已变化')
    mode.value = 'live'
    await useArchivedPage(page, version)
    return page
  }

  async function selectPage(id: string, bounds: PreviewBounds): Promise<boolean> {
    const version = ++selectionVersion
    const page = pages.value.find(p => p.id === id)
    if (!page) throw new Error('网页历史不存在')
    const cached = await repository.getPreview(page.latestSnapshotId)
    if (!cached) throw new Error('网页缓存不存在')
    if (version !== selectionVersion) return false
    await showSnapshot(cached, bounds, version)
    if (version !== selectionVersion) return false
    selectedPage.value = page
    selectedSnapshotPreview.value = cached
    mode.value = 'cached'
    qa.selectSnapshot(page.id, page.latestSnapshotId)
    await qa.refresh().catch(() => {})
    return version === selectionVersion
  }

  async function selectSession(id: string, bounds: PreviewBounds): Promise<boolean> {
    const version = ++selectionVersion
    await qa.load(id)
    if (version !== selectionVersion) return false
    const session = qa.currentSession.value
    if (!session) throw new Error('网页会话不存在')
    const cached = await repository.getPreview(session.snapshotId)
    if (!cached) throw new Error('网页缓存不存在')
    const page = pages.value.find(p => p.id === session.pageId) ?? selectedPage.value
    const appearance = !cached.hasOriginalAppearance
      ? await repository.findAppearance(session.pageId, cached.contentHash) : null
    if (version !== selectionVersion) return false
    await showSnapshot(cached, bounds, version, appearance)
    if (version !== selectionVersion) return false
    selectedPage.value = page
    selectedSnapshotPreview.value = cached
    mode.value = 'cached'
    await qa.refresh().catch(() => {})
    return version === selectionVersion
  }

  async function refreshPage(bounds: PreviewBounds) {
    if (!selectedPage.value) throw new Error('请先选择网页')
    return openExplicit(selectedPage.value.canonicalUrl, bounds)
  }

  async function removePage(id: string) {
    ++selectionVersion
    await repository.removePage(id)
    if (selectedPage.value?.id === id) {
      selectedPage.value = null
      selectedSnapshotPreview.value = null
      nativeCached.value = false
      cacheLoadError.value = ''
      appearanceNotice.value = ''
      qa.selectSnapshot('', '')
      mode.value = 'live'
      await preview.close().catch(() => {})
    }
    await refreshPages()
  }

  return { pages, selectedPage, selectedSnapshotPreview, sessions: qa.sessions, mode, nativeCached, cacheLoadError, appearanceNotice,
    refreshPages, openExplicit, openLive, saveCurrent, selectPage, selectSession, refreshPage, removePage }
}
