export function getTextNodes(root: HTMLElement): Text[] {
  const nodes: Text[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node) {
    if (node.textContent) nodes.push(node as Text)
    node = walker.nextNode()
  }
  return nodes
}

/** Keep each PDF text run separate so ranges never fill line ends or column gutters. */
export function getHighlightRanges(root: HTMLElement, start: number, end: number): Range[] {
  const ranges: Range[] = []
  let offset = 0
  for (const node of getTextNodes(root)) {
    let localStart = Math.max(0, start - offset)
    let localEnd = Math.min(node.length, end - offset)
    // Trim painted whitespace, but retain the original offsets for stored annotations.
    while (localStart < localEnd && /\s/.test(node.data[localStart])) localStart++
    while (localEnd > localStart && /\s/.test(node.data[localEnd - 1])) localEnd--
    if (localEnd > localStart) {
      const range = document.createRange()
      range.setStart(node, localStart)
      range.setEnd(node, localEnd)
      ranges.push(range)
    }
    offset += node.length
    if (offset >= end) break
  }
  return ranges
}

export interface HighlightRect {
  left: number
  top: number
  width: number
  height: number
}

/** Page-relative rectangles shared by painting, hit testing and the active outline. */
export function getHighlightRects(root: HTMLElement, start: number, end: number, pageRect: DOMRect): HighlightRect[] {
  return getHighlightRanges(root, start, end).flatMap(range =>
    Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0).map(rect => {
      const inset = Math.min(1.5, rect.height * 0.09)
      return { left: rect.left - pageRect.left, top: rect.top - pageRect.top + inset, width: rect.width, height: rect.height - inset * 2 }
    }),
  )
}
