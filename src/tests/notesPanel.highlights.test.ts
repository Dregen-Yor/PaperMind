import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import NotesPanel from '../components/NotesPanel.vue'
import { usePaperStore, type Highlight } from '../stores/paper'

const { confirm } = vi.hoisted(() => ({ confirm: vi.fn() }))
vi.mock('element-plus', () => ({ ElMessageBox: { confirm } }))

const first: Highlight = {
  id: 'a-note', paperId: 'a', text: 'Paper A selection', pageNum: 1,
  color: '#ffe66a', note: 'A note', startOffset: 0, endOffset: 5, createdAt: 1,
}
const second: Highlight = { ...first, id: 'b-note', paperId: 'b', text: 'Paper B selection', note: 'B note' }
const db = (globalThis as any).mockDb.highlight
let wrapper: VueWrapper | undefined

beforeEach(() => {
  db.listByPaper.mockReset()
  db.remove.mockReset().mockResolvedValue(undefined)
  db.update.mockReset().mockResolvedValue(undefined)
  confirm.mockReset().mockResolvedValue('confirm')
})
afterEach(() => { wrapper?.unmount(); wrapper = undefined })

function openNotes() {
  wrapper = mount(NotesPanel, {
    props: { paperId: 'a' },
    global: {
      plugins: [createPinia()],
      stubs: {
        'el-scrollbar': { template: '<div><slot /></div>' },
        'el-icon': true,
        'el-input': {
          props: ['modelValue'],
          emits: ['update:modelValue', 'blur'],
          template: '<textarea :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" @blur="$emit(\'blur\')" />',
        },
      },
    },
  })
}

describe('notes paper isolation', () => {
  it('shows the actual note for a highlight ID matching an object prototype property', async () => {
    db.listByPaper.mockResolvedValueOnce([{ ...first, id: '__proto__' }])
    openNotes()
    await flushPromises()
    expect((wrapper!.get('textarea').element as HTMLTextAreaElement).value).toBe('A note')
  })

  it('retains an unsubmitted draft when switching away and back to the same paper', async () => {
    db.listByPaper.mockResolvedValueOnce([{ ...first }]).mockResolvedValueOnce([{ ...second }])
      .mockResolvedValueOnce([{ ...first }])
    openNotes()
    await flushPromises()
    await wrapper!.get('textarea').setValue('Unsubmitted A draft')
    await wrapper!.setProps({ paperId: 'b' })
    await flushPromises()
    expect((wrapper!.get('textarea').element as HTMLTextAreaElement).value).toBe('B note')
    await wrapper!.setProps({ paperId: 'a' })
    await flushPromises()
    expect((wrapper!.get('textarea').element as HTMLTextAreaElement).value).toBe('Unsubmitted A draft')
  })

  it('keeps a newer edit when an earlier save finishes', async () => {
    let finish!: () => void
    db.listByPaper.mockResolvedValueOnce([{ ...first }])
    db.update.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    openNotes()
    await flushPromises()
    await wrapper!.get('textarea').setValue('First edit')
    await wrapper!.get('textarea').trigger('blur')
    await wrapper!.get('textarea').setValue('Newer edit')
    finish()
    await flushPromises()
    expect((wrapper!.get('textarea').element as HTMLTextAreaElement).value).toBe('Newer edit')
    expect(usePaperStore().highlights[0].note).toBe('First edit')
  })

  it('keeps the note row and reports a failed deletion', async () => {
    db.listByPaper.mockResolvedValueOnce([{ ...first }])
    db.remove.mockRejectedValueOnce(new Error('disk failure'))
    openNotes()
    await flushPromises()
    await wrapper!.get('.note-del').trigger('click')
    await flushPromises()
    expect(wrapper!.findAll('.note-item')).toHaveLength(1)
    expect(wrapper!.get('[role="alert"]').text()).toContain('删除高亮失败')
  })

  it('treats a cancelled deletion as a no-op', async () => {
    db.listByPaper.mockResolvedValueOnce([{ ...first }])
    confirm.mockRejectedValueOnce('cancel')
    openNotes()
    await flushPromises()
    await wrapper!.get('.note-del').trigger('click')
    await flushPromises()
    expect(wrapper!.findAll('.note-item')).toHaveLength(1)
    expect(wrapper!.find('[role="alert"]').exists()).toBe(false)
    expect(db.remove).not.toHaveBeenCalled()
  })

  it('deletes the captured A mark after confirmation finishes while B is open', async () => {
    let finish!: (value: string) => void
    confirm.mockImplementationOnce(() => new Promise<string>(resolve => { finish = resolve }))
    db.listByPaper.mockResolvedValueOnce([{ ...first }]).mockResolvedValueOnce([{ ...second }])
    openNotes()
    await flushPromises()
    await wrapper!.get('.note-del').trigger('click')
    await wrapper!.setProps({ paperId: 'b' })
    await flushPromises()
    finish('confirm')
    await flushPromises()
    expect(wrapper!.get('.note-text').text()).toBe('Paper B selection')
    expect(usePaperStore().highlightsByPaper.a).toEqual([])
    expect(db.remove).toHaveBeenCalledWith('a-note')
  })

  it('keeps failed note edits local and clears the error after a successful retry', async () => {
    db.listByPaper.mockResolvedValueOnce([{ ...first }])
    db.update.mockRejectedValueOnce(new Error('disk failure'))
    openNotes()
    await flushPromises()
    await wrapper!.get('textarea').setValue('Edited note')
    expect(usePaperStore().highlights[0].note).toBe('A note')
    await wrapper!.get('textarea').trigger('blur')
    await flushPromises()
    expect(wrapper!.get('[role="alert"]').text()).toContain('保存笔记失败')
    expect(usePaperStore().highlights[0].note).toBe('A note')
    await wrapper!.get('textarea').trigger('blur')
    await flushPromises()
    expect(usePaperStore().highlights[0].note).toBe('Edited note')
    expect(wrapper!.find('[role="alert"]').exists()).toBe(false)
  })

  it('reports a failed load without leaking an earlier paper into the notes', async () => {
    db.listByPaper.mockResolvedValueOnce([{ ...first }]).mockRejectedValueOnce(new Error('disk failure'))
    openNotes()
    await flushPromises()
    await wrapper!.setProps({ paperId: 'b' })
    await flushPromises()
    expect(wrapper!.findAll('.note-item')).toHaveLength(0)
    expect(wrapper!.get('[role="alert"]').text()).toContain('加载高亮失败')
  })

  it('clears paper A rows while paper B is loading', async () => {
    db.listByPaper.mockResolvedValueOnce([{ ...first }]).mockImplementationOnce(() => new Promise(() => {}))
    openNotes()
    await flushPromises()
    expect(wrapper!.get('.note-text').text()).toBe('Paper A selection')
    await wrapper!.setProps({ paperId: 'b' })
    expect(wrapper!.findAll('.note-item')).toHaveLength(0)
  })

  it('keeps B notes when the earlier A load resolves last', async () => {
    let finishA!: (rows: Highlight[]) => void
    db.listByPaper.mockImplementationOnce(() => new Promise<Highlight[]>(resolve => { finishA = resolve }))
      .mockResolvedValueOnce([{ ...second }])
    openNotes()
    await wrapper!.setProps({ paperId: 'b' })
    await flushPromises()
    expect(wrapper!.get('.note-text').text()).toBe('Paper B selection')
    finishA([{ ...first }])
    await flushPromises()
    expect(wrapper!.get('.note-text').text()).toBe('Paper B selection')
  })
})
