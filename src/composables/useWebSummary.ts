import { computed, reactive, ref, watch, type Ref } from 'vue'
import { useVisualSummaryStore } from '../stores/visualSummary'
import { useChatStore, type LLMProfile } from '../stores/chat'
import { renderSummaryPdf } from '../utils/visualSummaryPdf'
import type { VisualSummaryInput } from '../utils/visualSummary'
import type { WebSnapshotPreview } from '../types/webQa'

// These tasks outlive their view. Closing the preview must not close the separate
// snapshot renderer or cancel the model request.
const pending = new WeakMap<object, Map<string, Promise<VisualSummaryInput>>>()
const captures = new WeakMap<object, Record<string, { busy: boolean; error: string; pageId: string }>>()
const revisions = new WeakMap<object, Map<string, number>>()
export function webSummaryHash(snapshot: WebSnapshotPreview) {
  return `${snapshot.id}:${snapshot.contentHash}:${snapshot.capturedAt}`
}

export function useWebSummary(selected: Ref<WebSnapshotPreview | null>) {
  const store = useVisualSummaryStore()
  const chat = useChatStore()
  if (!pending.has(store)) pending.set(store, new Map())
  if (!captures.has(store)) captures.set(store, reactive({}))
  if (!revisions.has(store)) revisions.set(store, new Map())
  const sourceRevisions = revisions.get(store)!
  const tasks = pending.get(store)!
  const captureStates = captures.get(store)!
  const cacheLoading = ref(false)
  const cacheError = ref('')
  const state = computed(() => selected.value ? store.states[`web:${selected.value.id}`] : undefined)
  const capture = computed(() => selected.value ? captureStates[selected.value.id] : undefined)
  const busy = computed(() => !!(capture.value?.busy || state.value?.preparing || state.value?.generating))
  const error = computed(() => capture.value?.error || state.value?.error || cacheError.value)
  const progress = computed(() => capture.value?.busy ? '正在从已保存的网页快照准备原文页面…' : state.value?.progress || '正在处理原文…')
  let version = 0
  watch(selected, async snapshot => {
    const current = ++version
    cacheError.value = ''
    cacheLoading.value = !!snapshot
    if (!snapshot) return
    try { await store.load('web', snapshot.id, webSummaryHash(snapshot)) }
    catch (cause) { if (version === current) cacheError.value = cause instanceof Error ? cause.message : '摘要读取失败' }
    finally { if (version === current) cacheLoading.value = false }
  }, { immediate: true })

  async function inputFor(snapshot: WebSnapshotPreview): Promise<VisualSummaryInput> {
    const key = webSummaryHash(snapshot)
    const existing = tasks.get(key)
    if (existing) return existing
    const revision = sourceRevisions.get(snapshot.id) ?? 0
    const check = () => { if ((sourceRevisions.get(snapshot.id) ?? 0) !== revision) throw new Error('任务已取消') }
    const run = (async () => {
      captureStates[snapshot.id] = { busy: true, error: '', pageId: snapshot.pageId }
      try {
        if (!snapshot.hasOriginalAppearance && !snapshot.hasSummaryVisual) throw new Error('此网页没有原貌快照，请更新缓存后生成摘要')
        const pdf = await window.preview.summaryPdf(snapshot.id)
        check()
        const pages = await renderSummaryPdf(pdf)
        check()
        return { kind: 'web' as const, sourceId: snapshot.id, title: snapshot.title, sourceHash: key, pages }
      } catch (cause) {
        if ((sourceRevisions.get(snapshot.id) ?? 0) === revision) captureStates[snapshot.id].error = cause instanceof Error ? cause.message : '网页页面准备失败'
        throw cause
      } finally { if ((sourceRevisions.get(snapshot.id) ?? 0) === revision) captureStates[snapshot.id].busy = false }
    })()
    tasks.set(key, run)
    try { return await run } finally { if (tasks.get(key) === run) tasks.delete(key) }
  }

  async function prepare(snapshot: WebSnapshotPreview) {
    const source = { ...snapshot }
    const profile = JSON.parse(JSON.stringify(chat.chatProfile)) as LLMProfile
    return store.prepare(await inputFor(source), profile)
  }
  async function generate(force = false) {
    if (!selected.value) throw new Error('请先保存或选择网页快照')
    const source = { ...selected.value }
    const profile = JSON.parse(JSON.stringify(chat.chatProfile)) as LLMProfile
    return store.generate(await inputFor(source), profile, force)
  }
  function cancel(sourceId = selected.value?.id) {
    if (!sourceId) return
    sourceRevisions.set(sourceId, (sourceRevisions.get(sourceId) ?? 0) + 1)
    if (captureStates[sourceId]) { captureStates[sourceId].busy = false; captureStates[sourceId].error = '' }
    for (const key of tasks.keys()) if (key.startsWith(`${sourceId}:`)) tasks.delete(key)
    store.cancel('web', sourceId)
  }
  function cancelPage(pageId: string) {
    for (const [sourceId, capture] of Object.entries(captureStates)) if (capture.pageId === pageId) cancel(sourceId)
    if (selected.value?.pageId === pageId) cancel(selected.value.id)
  }
  return { state, busy, error, progress, cacheLoading, prepare, generate, cancel, cancelPage }
}
