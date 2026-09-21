import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import PdfViewer from '../components/PdfViewer.vue'
import type { Highlight } from '../stores/paper'

const { getDocument } = vi.hoisted(() => ({ getDocument: vi.fn() }))
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: {},
  getDocument,
  TextLayer: class {
    container: HTMLElement
    constructor({ container }: { container: HTMLElement }) { this.container = container }
    async render() {
      for (const [index, text] of ['First line of text', 'Second line of text'].entries()) {
        const span = document.createElement('span')
        span.dataset.line = String(index)
        span.textContent = text
        this.container.append(span)
      }
    }
  },
}))

const first: Highlight = {
  id: 'h1', paperId: 'p1', pageNum: 1, text: 'First line', startOffset: 0, endOffset: 10,
  color: '#ffe66a', note: '', createdAt: 1,
}
const adjacent: Highlight = { ...first, id: 'h2', text: 'of text', startOffset: 10, endOffset: 18, createdAt: 2 }
let wrapper: VueWrapper | undefined
let stored: Highlight[]
const db = (globalThis as any).mockDb.highlight

beforeEach(() => {
  vi.useFakeTimers()
  stored = [{ ...first }, { ...adjacent }]
  db.listByPaper.mockImplementation(async (paperId: string) => stored.filter(h => h.paperId === paperId).map(h => ({ ...h })))
  db.remove.mockReset().mockImplementation(async (id: string) => { stored = stored.filter(h => h.id !== id) })
  db.create.mockReset().mockImplementation(async (h: Highlight) => { stored.push({ ...h }); return h })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('selection-popup') ? new DOMRect(0, 0, 192, 38) : new DOMRect(0, 0, 600, 800)
  })
  // jsdom has no layout engine. Supply glyph geometry at the browser boundary.
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value() {
      const line = Number(this.startContainer.parentElement?.dataset.line ?? 0)
      return [new DOMRect(20 + this.startOffset * 10, 100 + line * 24, (this.endOffset - this.startOffset) * 10, 20)]
    },
  })
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true, value() { return this.getClientRects()[0] },
  })
  getDocument.mockReset().mockImplementation(() => ({ promise: Promise.resolve({
    numPages: 1,
    getPage: async () => ({
      getViewport: () => ({ width: 600, height: 800, scale: 1 }),
      render: () => ({ promise: Promise.resolve() }),
      getTextContent: async () => ({}),
    }),
  }) }))
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  document.getSelection()?.removeAllRanges()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete (Range.prototype as any).getClientRects
  delete (Range.prototype as any).getBoundingClientRect
})

async function openViewer() {
  wrapper = mount(PdfViewer, {
    props: { src: '/fixture.pdf', paperId: 'p1' },
    attachTo: document.body,
    global: {
      plugins: [createPinia()],
      stubs: {
        'el-button': { template: '<button><slot /></button>' },
        'el-icon': { template: '<span><slot /></span>' },
      },
    },
  })
  await flushPromises()
  return wrapper
}

async function clickMark(x = 55, y = 110) {
  const layer = wrapper!.get('.text-layer')
  layer.element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: x, clientY: y }))
  layer.element.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0, clientX: x, clientY: y }))
  await layer.trigger('mouseup', { button: 0, clientX: x, clientY: y })
}

function button(label: string) {
  const match = wrapper!.findAll('button').find(b => b.text() === label)
  expect(match, `button ${label}`).toBeDefined()
  return match!
}

describe('PDF highlight cancellation', () => {
  it('cancels only the clicked record and restores the same record on undo, without rerendering the PDF', async () => {
    await openViewer()
    const canvas = wrapper!.get('canvas').element
    await clickMark()
    expect(wrapper!.findAll('.pdf-highlight-focus')).toHaveLength(1)
    await button('取消高亮').trigger('click')
    await flushPromises()
    expect(stored.map(h => h.id)).toEqual(['h2'])
    expect(wrapper!.findAll('.pdf-highlight-overlay')).toHaveLength(1)
    expect(wrapper!.text()).toContain('已取消高亮')
    expect(wrapper!.get('canvas').element).toBe(canvas)
    await button('撤销').trigger('click')
    await flushPromises()
    expect(stored.find(h => h.id === 'h1')).toEqual(first)
    expect(wrapper!.findAll('.pdf-highlight-overlay')).toHaveLength(1)
    expect(wrapper!.text()).not.toContain('已取消高亮')
  })

  it('cancels all lines of one record', async () => {
    stored = [{ ...first, endOffset: 37 }]
    await openViewer()
    await clickMark(55, 134)
    expect(wrapper!.findAll('.pdf-highlight-focus')).toHaveLength(2)
    await button('取消高亮').trigger('click')
    await flushPromises()
    expect(stored).toEqual([])
    expect(wrapper!.find('.pdf-highlight-overlay').exists()).toBe(false)
  })

  it('positions the menu outside the whole multi-line target', async () => {
    stored = [{ ...first, endOffset: 37 }]
    await openViewer()
    await clickMark(55, 134)
    await flushPromises()
    const popup = wrapper!.get('.selection-popup').element as HTMLElement
    expect(Number.parseFloat(popup.style.top) + 38).toBeLessThanOrEqual(100)
  })

  it('preserves selection behavior when dragging across a highlight', async () => {
    await openViewer()
    const layer = wrapper!.get('.text-layer')
    const node = layer.element.querySelector('span')!.firstChild!
    layer.element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 40, clientY: 110 }))
    const range = document.createRange()
    range.setStart(node, 1)
    range.setEnd(node, 8)
    document.getSelection()!.addRange(range)
    layer.element.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0, clientX: 100, clientY: 110 }))
    await layer.trigger('mouseup', { button: 0, clientX: 100, clientY: 110 })
    expect(button('高亮').exists()).toBe(true)
    expect(wrapper!.text()).not.toContain('取消高亮')
    expect(document.getSelection()!.toString()).toBe('irst li')
  })

  it('does not treat a drag with no selected text as a click', async () => {
    await openViewer()
    const layer = wrapper!.get('.text-layer')
    layer.element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 20, clientY: 110 }))
    layer.element.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0, clientX: 55, clientY: 110 }))
    await layer.trigger('mouseup', { button: 0, clientX: 55, clientY: 110 })
    expect(wrapper!.text()).not.toContain('取消高亮')
  })

  it.each(['Escape', 'scroll', 'outside'])('dismisses the target on %s', async (action) => {
    await openViewer()
    await clickMark()
    expect(button('取消高亮').exists()).toBe(true)
    if (action === 'Escape') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    else if (action === 'scroll') await wrapper!.get('.pdf-scroll').trigger('scroll')
    else document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await flushPromises()
    expect(wrapper!.text()).not.toContain('取消高亮')
    expect(wrapper!.find('.pdf-highlight-focus').exists()).toBe(false)
  })

  it('leaves the mark intact when deletion fails', async () => {
    await openViewer()
    db.remove.mockRejectedValueOnce(new Error('disk failure'))
    await clickMark()
    await button('取消高亮').trigger('click')
    await flushPromises()
    expect(stored).toHaveLength(2)
    expect(wrapper!.findAll('.pdf-highlight-overlay')).toHaveLength(1)
    expect(wrapper!.text()).toContain('取消高亮失败')
    expect(wrapper!.text()).not.toContain('已取消高亮')
  })

  it('prevents duplicate deletion while persistence is pending', async () => {
    await openViewer()
    let finish!: () => void
    db.remove.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    await clickMark()
    const cancel = button('取消高亮')
    await cancel.trigger('click')
    await cancel.trigger('click')
    expect(db.remove).toHaveBeenCalledTimes(1)
    expect(wrapper!.text()).not.toContain('已取消高亮')
    finish()
    await flushPromises()
  })

  it('only undoes the latest cancellation', async () => {
    await openViewer()
    await clickMark()
    await button('取消高亮').trigger('click')
    await flushPromises()
    await clickMark(150)
    await button('取消高亮').trigger('click')
    await flushPromises()
    await button('撤销').trigger('click')
    await flushPromises()
    expect(stored.map(h => h.id)).toEqual(['h2'])
  })

  it('expires undo after eight seconds without restoring the deleted record', async () => {
    await openViewer()
    await clickMark()
    await button('取消高亮').trigger('click')
    await flushPromises()
    await vi.advanceTimersByTimeAsync(8000)
    expect(wrapper!.text()).not.toContain('撤销')
    expect(stored.map(h => h.id)).toEqual(['h2'])
  })

  it('allows retrying a failed undo without duplicating the restored record', async () => {
    await openViewer()
    await clickMark()
    await button('取消高亮').trigger('click')
    await flushPromises()
    db.create.mockRejectedValueOnce(new Error('disk failure'))
    await button('撤销').trigger('click')
    await flushPromises()
    expect(stored.map(h => h.id)).toEqual(['h2'])
    expect(wrapper!.text()).toContain('恢复高亮失败')
    await button('撤销').trigger('click')
    await flushPromises()
    expect(stored.filter(h => h.id === 'h1')).toHaveLength(1)
  })

  it('keeps cancellation after zoom and reopening the document', async () => {
    await openViewer()
    await clickMark()
    await button('取消高亮').trigger('click')
    await flushPromises()
    await wrapper!.get('[aria-label="放大论文"]').trigger('click')
    await flushPromises()
    await clickMark()
    expect(wrapper!.find('.selection-popup').exists()).toBe(false)
    wrapper!.unmount()
    await openViewer()
    await clickMark()
    expect(wrapper!.text()).not.toContain('取消高亮')
    await clickMark(150)
    expect(button('取消高亮').exists()).toBe(true)
  })

  it('never offers cancellation in the gap between selected lines', async () => {
    stored = [{ ...first, endOffset: 37 }]
    await openViewer()
    await clickMark(55, 122)
    expect(wrapper!.find('.selection-popup').exists()).toBe(false)
  })

  it('targets the newest overlapping record and leaves the older record clickable', async () => {
    stored = [{ ...first }, { ...first, id: 'newer', startOffset: 2, endOffset: 8, createdAt: 3 }]
    await openViewer()
    await clickMark()
    await button('取消高亮').trigger('click')
    await flushPromises()
    expect(stored.map(h => h.id)).toEqual(['h1'])
    await clickMark()
    expect(button('取消高亮').exists()).toBe(true)
    await wrapper!.get('[aria-label="放大论文"]').trigger('click')
    await flushPromises()
    expect(wrapper!.find('.selection-popup').exists()).toBe(false)
  })

  it('does not apply a pending undo to a different document', async () => {
    await openViewer()
    await clickMark()
    await button('取消高亮').trigger('click')
    await flushPromises()
    let finish!: () => void
    db.create.mockImplementationOnce((record: Highlight) => new Promise<Highlight>(resolve => {
      finish = () => { stored.push(record); resolve(record) }
    }))
    await button('撤销').trigger('click')
    stored.push({ ...first, id: 'other', paperId: 'p2', text: 'other paper' })
    await wrapper!.setProps({ paperId: 'p2', src: '/other.pdf' })
    await flushPromises()
    finish()
    await flushPromises()
    expect(wrapper!.findAll('.pdf-highlight-overlay')).toHaveLength(1)
    expect(wrapper!.text()).not.toContain('撤销')
    await clickMark()
    await button('发送到对话').trigger('click')
    expect(wrapper!.emitted('select-text')).toEqual([['other paper']])
  })

  it('does not apply a pending deletion to a different document', async () => {
    await openViewer()
    let finish!: () => void
    db.remove.mockImplementationOnce((id: string) => new Promise<void>(resolve => {
      finish = () => { stored = stored.filter(h => h.id !== id); resolve() }
    }))
    await clickMark()
    await button('取消高亮').trigger('click')
    stored.push({ ...first, id: 'other', paperId: 'p2' })
    await wrapper!.setProps({ paperId: 'p2', src: '/other.pdf' })
    await flushPromises()
    finish()
    await flushPromises()
    expect(wrapper!.findAll('.pdf-highlight-overlay')).toHaveLength(1)
    expect(wrapper!.text()).not.toContain('已取消高亮')
    await clickMark()
    await button('取消高亮').trigger('click')
    await flushPromises()
    expect(stored.map(h => h.id)).toEqual(['h2'])
  })

  it('retains the latest document if an earlier highlight load finishes late', async () => {
    let finish!: (rows: Highlight[]) => void
    db.listByPaper.mockImplementationOnce(() => new Promise<Highlight[]>(resolve => { finish = resolve }))
    await openViewer()
    stored.push({ ...first, id: 'other', paperId: 'p2', text: 'other paper' })
    await wrapper!.setProps({ paperId: 'p2', src: '/other.pdf' })
    await flushPromises()
    finish([{ ...first }])
    await flushPromises()
    await clickMark()
    await button('发送到对话').trigger('click')
    expect(wrapper!.emitted('select-text')).toEqual([['other paper']])
  })

  it('gives newly saved highlights an identity that can be cancelled', async () => {
    stored = []
    await openViewer()
    const node = wrapper!.get('.text-layer span').element.firstChild!
    const range = document.createRange()
    range.setStart(node, 0)
    range.setEnd(node, 10)
    document.getSelection()!.addRange(range)
    await wrapper!.get('.text-layer').trigger('mouseup', { button: 0, clientX: 55, clientY: 110 })
    await button('高亮').trigger('click')
    await flushPromises()
    expect(stored).toHaveLength(1)
    expect(stored[0].id).toBeTruthy()
    expect(wrapper!.findAll('.pdf-highlight-overlay')).toHaveLength(1)
    await clickMark()
    await button('取消高亮').trigger('click')
    await flushPromises()
    expect(stored).toEqual([])
  })

  it('does not paint a new highlight when saving fails', async () => {
    stored = []
    await openViewer()
    db.create.mockRejectedValueOnce(new Error('disk failure'))
    const node = wrapper!.get('.text-layer span').element.firstChild!
    const range = document.createRange()
    range.setStart(node, 0)
    range.setEnd(node, 10)
    document.getSelection()!.addRange(range)
    await wrapper!.get('.text-layer').trigger('mouseup', { button: 0, clientX: 55, clientY: 110 })
    await button('高亮').trigger('click')
    await flushPromises()
    expect(stored).toEqual([])
    expect(wrapper!.find('.pdf-highlight-overlay').exists()).toBe(false)
    expect(wrapper!.text()).toContain('保存高亮失败')
  })
})
