import { defineStore } from 'pinia'
import { ref } from 'vue'

interface DraftContext {
  id: number
  text: string
}

export interface ChatDraft {
  input: string
  inputRevision: number
  contexts: DraftContext[]
}

/** Composer state belongs to a conversation for the lifetime of this app session. */
export const useChatDraftStore = defineStore('chatDrafts', () => {
  const drafts = ref(new Map<string, ChatDraft>())
  const sending = ref(new Set<string>())
  let revision = 0

  function read(id: string): ChatDraft | undefined {
    return drafts.value.get(id)
  }

  function setInput(id: string, input: string) {
    const current = read(id)
    drafts.value.set(id, { input, inputRevision: ++revision, contexts: current?.contexts ?? [] })
  }

  function addContext(id: string, text: string) {
    const current = read(id)
    drafts.value.set(id, { input: current?.input ?? '', inputRevision: current?.inputRevision ?? 0,
      contexts: [...(current?.contexts ?? []), { id: ++revision, text }] })
  }

  function removeContext(id: string, index: number) {
    const current = read(id)
    if (!current) return
    drafts.value.set(id, { ...current, contexts: current.contexts.filter((_, position) => position !== index) })
  }

  function hasDraft(id: string) {
    const draft = read(id)
    return !!draft && (!!draft.input.trim() || draft.contexts.length > 0)
  }

  /** Consume only the saved submission, keeping edits made while persistence was pending. */
  function consume(id: string, submitted: ChatDraft) {
    const current = read(id)
    if (!current) return
    const consumedIds = new Set(submitted.contexts.map(context => context.id))
    drafts.value.set(id, { ...current,
      input: current.inputRevision === submitted.inputRevision ? '' : current.input,
      contexts: current.contexts.filter(context => !consumedIds.has(context.id)),
    })
  }

  function remove(id: string) {
    drafts.value.delete(id)
  }

  function setSending(id: string, active: boolean) {
    if (active) sending.value.add(id)
    else sending.value.delete(id)
  }

  return { read, setInput, addContext, removeContext, hasDraft, consume, remove, sending, setSending }
})
