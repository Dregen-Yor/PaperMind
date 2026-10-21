import { defineStore } from 'pinia'
import { computed, reactive, ref } from 'vue'
import { ElMessageBox } from 'element-plus'
import { usePaperStore } from './paper'
import { useChatStore } from './chat'
import { useVisualSummaryStore } from './visualSummary'
import { parsePdfMeta } from '../utils/pdfUtils'

export type ImportStatus = 'pending' | 'parsing' | 'saving' | 'done' | 'error' | 'skipped'

interface ImportTarget {
  id: string
  name: string
}

export interface ImportItem {
  id: string
  name: string
  targetName: string
  status: ImportStatus
  error?: string
}

interface ImportBatch {
  target: ImportTarget
  entries: { file: File; item: ImportItem }[]
  resolve: (openPaperId: string) => void
}

export const useLibraryImportStore = defineStore('libraryImport', () => {
  const papers = usePaperStore()
  const chats = useChatStore()
  const items = ref<ImportItem[]>([])
  const showPanel = ref(false)
  const running = ref(false)
  const queue: ImportBatch[] = []
  const doneCount = computed(() => items.value.filter(item =>
    item.status === 'done' || item.status === 'error' || item.status === 'skipped',
  ).length)
  const allDone = computed(() => items.value.length > 0 && doneCount.value === items.value.length)
  const hasError = computed(() => items.value.some(item => item.status === 'error'))
  const percent = computed(() => items.value.length ? Math.round(doneCount.value / items.value.length * 100) : 0)

  function enqueue(files: File[], target: ImportTarget): Promise<string> {
    if (!files.length) return Promise.resolve('')
    if (!running.value) items.value = []
    const entries = files.map(file => ({
      file,
      item: reactive<ImportItem>({
        id: crypto.randomUUID(), name: file.name, targetName: target.name, status: 'pending',
      }),
    }))
    items.value.push(...entries.map(entry => entry.item))
    showPanel.value = true
    const completion = new Promise<string>(resolve => {
      queue.push({ target: { ...target }, entries, resolve })
    })
    if (!running.value) {
      running.value = true
      void drainQueue()
    }
    return completion
  }

  async function drainQueue() {
    while (queue.length) {
      const batch = queue.shift()!
      let openPaperId = ''
      for (const { file, item } of batch.entries) {
        try {
          item.status = 'parsing'
          const meta = await parsePdfMeta(file)
          const existing = papers.papers.find(paper => paper.fileHash && paper.fileHash === meta.fileHash)
          if (existing) {
            if (!await papers.paperContentUrl(existing.id)) {
              item.status = 'saving'
              await papers.restorePaperFile(existing.id, meta.fileData)
              void useVisualSummaryStore().preparePaper(existing.id, { ...chats.chatProfile }).catch(() => {})
              item.status = 'done'
              openPaperId = existing.id
              continue
            }
            try {
              await ElMessageBox.confirm(
                `《${existing.title || existing.fileName}》已在库中，是否打开现有条目？`,
                '重复导入',
                { type: 'info', confirmButtonText: '打开现有条目', cancelButtonText: '跳过' },
              )
              openPaperId = existing.id
              item.status = 'done'
            } catch {
              item.status = 'skipped'
            }
            continue
          }

          if (!papers.knowledgeBases.some(kb => kb.id === batch.target.id)) {
            throw new Error(`目标知识库「${batch.target.name}」已不存在，请重新选择知识库后导入`)
          }
          item.status = 'saving'
          const id = await papers.addPaper({
            ...meta, fileName: file.name, knowledgeBaseId: batch.target.id, status: 'unread', tags: [],
          })
          item.status = 'done'
          // Indexing remains independent of the import queue.
          chats.indexPaper(id).catch(() => {})
          // Preparation has its own queue and never rolls back a successful import.
          void useVisualSummaryStore().preparePaper(id, { ...chats.chatProfile }).catch(() => {})
        } catch (error) {
          item.status = 'error'
          item.error = error instanceof Error ? error.message : '未知错误'
        }
      }
      batch.resolve(openPaperId)
    }
    running.value = false
  }

  return { items, showPanel, running, doneCount, allDone, hasError, percent, enqueue }
})
