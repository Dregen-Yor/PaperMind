import { describe, expect, it } from 'vitest'
import { getHighlightRanges } from '../utils/pdfHighlight'

function textLayer(...lines: string[]) {
  const layer = document.createElement('div')
  for (const line of lines) {
    const span = document.createElement('span')
    span.textContent = line
    layer.append(span, document.createElement('br'))
  }
  return layer
}

describe('PDF highlight text ranges', () => {
  it('keeps a partial selection inside its first and last characters', () => {
    const layer = textLayer('Clear text selection')
    const ranges = getHighlightRanges(layer, 6, 10)
    expect(ranges.map(range => range.toString())).toEqual(['text'])
    expect(ranges[0].startOffset).toBe(6)
    expect(ranges[0].endOffset).toBe(10)
  })

  it('measures each text run separately instead of spanning line ends or column gutters', () => {
    const layer = textLayer('First line', 'Second line', 'Short end')
    const ranges = getHighlightRanges(layer, 6, 26)
    expect(ranges.map(range => range.toString())).toEqual(['line', 'Second line', 'Short'])
    for (const range of ranges) expect(range.startContainer).toBe(range.endContainer)
  })

  it('trims line-edge whitespace without shifting saved page offsets', () => {
    const layer = textLayer('  first  ', '   ', ' second ')
    expect(getHighlightRanges(layer, 0, 20).map(range => range.toString())).toEqual(['first', 'second'])
    expect(getHighlightRanges(layer, 13, 16).map(range => range.toString())).toEqual(['sec'])
  })

  it('preserves offsets across marked-content wrappers and inline font changes', () => {
    const layer = textLayer('one ')
    const wrapper = document.createElement('span')
    wrapper.className = 'markedContent'
    const span = document.createElement('span')
    span.textContent = 'two'
    wrapper.append(span)
    layer.append(wrapper)
    expect(getHighlightRanges(layer, 2, 6).map(range => range.toString())).toEqual(['e', 'tw'])
  })

  it('ignores empty or out-of-page intervals when restoring saved highlights', () => {
    const layer = textLayer('text')
    expect(getHighlightRanges(layer, 4, 8)).toEqual([])
    expect(getHighlightRanges(layer, 2, 2)).toEqual([])
  })
})
