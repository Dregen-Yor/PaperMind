import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export interface Paper {
  id: string
  title: string
  authors: string[]
  abstract: string
  year: number
  tags: string[]
  status: 'unread' | 'reading' | 'done'
  fileName: string
  fileHash: string
  addedAt: number
  knowledgeBaseId: string
}

export interface KnowledgeBase {
  id: string
  name: string
  description: string
  color: string
  createdAt: number
}

export interface Highlight {
  id: string
  paperId: string
  text: string
  pageNum: number
  color: string
  note: string
  startOffset: number
  endOffset: number
  createdAt: number
}

export const usePaperStore = defineStore('paper', () => {
  const papers = ref<Paper[]>([])
  const knowledgeBases = ref<KnowledgeBase[]>([])
  const highlights = ref<Highlight[]>([])
  const loaded = ref(false)

  async function init() {
    if (loaded.value) return
    knowledgeBases.value = await window.db.kb.list()
    papers.value = await window.db.paper.list()
    loaded.value = true
  }

  async function addKnowledgeBase(name: string, description: string, color: string) {
    const kb: KnowledgeBase = { id: crypto.randomUUID(), name, description, color, createdAt: Date.now() }
    await window.db.kb.create(kb)
    knowledgeBases.value.push(kb)
    return kb
  }

  async function removeKnowledgeBase(id: string) {
    await window.db.kb.remove(id)
    knowledgeBases.value = knowledgeBases.value.filter(k => k.id !== id)
    papers.value = papers.value.filter(p => p.knowledgeBaseId !== id)
  }

  // paper includes fileData (base64); it is written to disk in the main process and not kept in memory
  async function addPaper(paper: Omit<Paper, 'id' | 'addedAt'> & { fileData: string }) {
    const id = crypto.randomUUID()
    const addedAt = Date.now()
    await window.db.paper.create({ ...paper, id, addedAt })
    const { fileData, ...meta } = paper
    papers.value.unshift({ ...meta, id, addedAt } as Paper)
    return id
  }

  async function removePaper(id: string) {
    await window.db.paper.remove(id)
    papers.value = papers.value.filter(p => p.id !== id)
  }

  async function updatePaper(id: string, patch: Partial<Paper>) {
    await window.db.paper.update(id, patch)
    const idx = papers.value.findIndex(p => p.id === id)
    if (idx !== -1) papers.value[idx] = { ...papers.value[idx], ...patch }
  }

  // read PDF binary (base64) on demand
  function readPaperFile(id: string): Promise<string | null> {
    return window.db.paper.readFile(id)
  }

  function getPapersByKb(kbId: string) {
    return computed(() => papers.value.filter(p => p.knowledgeBaseId === kbId))
  }

  function getPaper(id: string) {
    return papers.value.find(p => p.id === id)
  }

  // ---------- Highlights ----------

  async function addHighlight(h: {
    paperId: string
    text: string
    pageNum: number
    color: string
    note: string
    startOffset: number
    endOffset: number
  }) {
    const highlight = { id: crypto.randomUUID(), ...h, createdAt: Date.now() }
    await window.db.highlight.create(highlight)
    highlights.value.push(highlight)
    return highlight
  }

  async function getHighlights(paperId: string) {
    return window.db.highlight.listByPaper(paperId)
  }

  async function loadHighlights(paperId: string) {
    highlights.value = await window.db.highlight.listByPaper(paperId)
  }

  async function updateHighlight(id: string, patch: Partial<Pick<Highlight, 'note'>>) {
    await window.db.highlight.update(id, patch)
    const idx = highlights.value.findIndex(h => h.id === id)
    if (idx !== -1) highlights.value[idx] = { ...highlights.value[idx], ...patch }
  }

  async function removeHighlight(id: string) {
    await window.db.highlight.remove(id)
    highlights.value = highlights.value.filter(h => h.id !== id)
  }

  async function restoreHighlight(highlight: Highlight) {
    await window.db.highlight.create(highlight)
    if (!highlights.value.some(h => h.id === highlight.id)) {
      highlights.value = [...highlights.value, highlight].sort((a, b) => a.createdAt - b.createdAt)
    }
  }

  return {
    papers, knowledgeBases, loaded, init,
    addKnowledgeBase, removeKnowledgeBase,
    addPaper, removePaper, updatePaper, readPaperFile,
    getPapersByKb, getPaper, highlights,
    addHighlight, getHighlights, loadHighlights, updateHighlight, removeHighlight, restoreHighlight,
  }
})
