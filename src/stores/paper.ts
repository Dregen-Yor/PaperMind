import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { Paper, KnowledgeBase, Highlight } from '../types/paper'

export type { Paper, KnowledgeBase, Highlight } from '../types/paper'

export const usePaperStore = defineStore('paper', () => {
  const papers = ref<Paper[]>([])
  const knowledgeBases = ref<KnowledgeBase[]>([])
  const highlightsByPaper = ref<Record<string, Highlight[]>>(Object.create(null))
  const activeHighlightPaperId = ref('')
  const highlights = computed(() => highlightsByPaper.value[activeHighlightPaperId.value] ?? [])
  const highlightLoads = new Map<string, Promise<Highlight[]>>()
  const highlightRevisions = new Map<string, number>()
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

  function paperContentUrl(id: string): Promise<string | null> {
    return window.db.paper.contentUrl(id)
  }

  function restorePaperFile(id: string, fileData: string): Promise<void> {
    return window.db.paper.restoreFile(id, fileData)
  }

  function getPapersByKb(kbId: string) {
    return computed(() => papers.value.filter(p => p.knowledgeBaseId === kbId))
  }

  function getPaper(id: string) {
    return papers.value.find(p => p.id === id)
  }

  // ---------- Highlights ----------

  function highlightPaperId(id: string) {
    return Object.keys(highlightsByPaper.value).find(paperId =>
      highlightsByPaper.value[paperId].some(h => h.id === id))
  }

  function publishHighlights(paperId: string, rows: Highlight[]) {
    highlightRevisions.set(paperId, (highlightRevisions.get(paperId) ?? 0) + 1)
    highlightsByPaper.value[paperId] = rows
  }

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
    if (!activeHighlightPaperId.value) activeHighlightPaperId.value = highlight.paperId
    await window.db.highlight.create(highlight)
    publishHighlights(highlight.paperId, [...(highlightsByPaper.value[highlight.paperId] ?? []), highlight])
    return highlight
  }

  async function getHighlights(paperId: string) {
    return loadHighlights(paperId)
  }

  async function loadHighlights(paperId: string): Promise<Highlight[]> {
    activeHighlightPaperId.value = paperId
    const pending = highlightLoads.get(paperId)
    if (pending) return pending
    const request = (async () => {
      // A read started before a successful write may contain an older snapshot.
      // Read again instead of replacing the persisted mutation with that snapshot.
      while (true) {
        const revision = highlightRevisions.get(paperId) ?? 0
        const rows = await window.db.highlight.listByPaper(paperId)
        if (revision !== (highlightRevisions.get(paperId) ?? 0)) continue
        highlightsByPaper.value[paperId] = rows
        return rows
      }
    })()
    highlightLoads.set(paperId, request)
    try {
      return await request
    } finally {
      if (highlightLoads.get(paperId) === request) highlightLoads.delete(paperId)
    }
  }

  async function updateHighlight(id: string, patch: Partial<Pick<Highlight, 'note'>>, paperId = highlightPaperId(id)) {
    await window.db.highlight.update(id, patch)
    if (paperId !== undefined) {
      publishHighlights(paperId, (highlightsByPaper.value[paperId] ?? []).map(h => h.id === id ? { ...h, ...patch } : h))
    }
  }

  async function removeHighlight(id: string, paperId = highlightPaperId(id)) {
    await window.db.highlight.remove(id)
    if (paperId !== undefined) {
      publishHighlights(paperId, (highlightsByPaper.value[paperId] ?? []).filter(h => h.id !== id))
    }
  }

  async function restoreHighlight(highlight: Highlight) {
    if (!activeHighlightPaperId.value) activeHighlightPaperId.value = highlight.paperId
    await window.db.highlight.create(highlight)
    const rows = highlightsByPaper.value[highlight.paperId] ?? []
    publishHighlights(highlight.paperId, [...rows.filter(h => h.id !== highlight.id), highlight]
      .sort((a, b) => a.createdAt - b.createdAt))
  }

  return {
    papers, knowledgeBases, loaded, init,
    addKnowledgeBase, removeKnowledgeBase,
    addPaper, removePaper, updatePaper, readPaperFile, paperContentUrl, restorePaperFile,
    getPapersByKb, getPaper, highlights, highlightsByPaper,
    addHighlight, getHighlights, loadHighlights, updateHighlight, removeHighlight, restoreHighlight,
  }
})
