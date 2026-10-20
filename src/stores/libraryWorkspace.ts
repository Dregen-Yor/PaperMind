import { defineStore } from 'pinia'
import { ref } from 'vue'
import { usePaperStore, type Paper } from './paper'
import type { LibraryFilters } from '../utils/libraryFilters'

interface DeleteTask {
  paper: Paper
  state: 'waiting' | 'deleting' | 'error'
  error: string
}

// Session state and delayed mutations belong to the workspace, not a route instance.
export const useLibraryWorkspaceStore = defineStore('libraryWorkspace', () => {
  const papers = usePaperStore()
  const activeKbId = ref('')
  const searchQuery = ref('')
  const statusFilter = ref<LibraryFilters['status']>('all')
  const sortOrder = ref<LibraryFilters['sort']>('recent')
  const deletions = ref<DeleteTask[]>([])
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  function ensureKnowledgeBase() {
    if (!papers.knowledgeBases.some(kb => kb.id === activeKbId.value)) {
      activeKbId.value = papers.knowledgeBases.find(kb => kb.id === 'default')?.id
        ?? papers.knowledgeBases[0]?.id ?? ''
    }
  }

  function scheduleDelete(paper: Paper) {
    if (deletions.value.some(task => task.paper.id === paper.id)) return
    deletions.value.push({ paper, state: 'waiting', error: '' })
    timers.set(paper.id, setTimeout(() => { void commitDelete(paper.id) }, 5000))
  }

  function undoDelete(id: string) {
    const task = deletions.value.find(task => task.paper.id === id)
    if (!task || task.state !== 'waiting') return
    clearTimeout(timers.get(id))
    timers.delete(id)
    deletions.value = deletions.value.filter(task => task.paper.id !== id)
  }

  async function commitDelete(id: string) {
    const task = deletions.value.find(task => task.paper.id === id)
    if (!task || task.state === 'deleting') return
    clearTimeout(timers.get(id))
    timers.delete(id)
    task.state = 'deleting'
    task.error = ''
    try {
      await papers.removePaper(id)
      deletions.value = deletions.value.filter(task => task.paper.id !== id)
    } catch (error) {
      // The paper never left the source store: a failed write is visible again.
      task.state = 'error'
      task.error = error instanceof Error ? error.message : String(error)
    }
  }

  function dismissDeleteError(id: string) {
    deletions.value = deletions.value.filter(task => task.paper.id !== id || task.state !== 'error')
  }

  return {
    activeKbId, searchQuery, statusFilter, sortOrder, deletions,
    ensureKnowledgeBase, scheduleDelete, undoDelete, commitDelete, dismissDeleteError,
  }
})
