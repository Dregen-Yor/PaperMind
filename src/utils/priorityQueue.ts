/**
 * 确定性最大堆：并列时按 `order` 升序出队（方案 §4.4 要求同分按段落 order 升序）。
 * 预算填充需要「取最大分 → 追加邻段 → 再取最大分」，用堆避免每轮重排。
 */
export interface HeapEntry {
  score: number
  order: number
}

export interface MaxHeap<T extends HeapEntry> {
  readonly size: number
  push(entry: T): void
  pop(): T | undefined
}

export function createMaxHeap<T extends HeapEntry>(): MaxHeap<T> {
  const items: T[] = []
  const better = (a: T, b: T): boolean => a.score > b.score || (a.score === b.score && a.order < b.order)
  const swap = (i: number, j: number) => {
    const temp = items[i]
    items[i] = items[j]
    items[j] = temp
  }
  const bubbleUp = (from: number) => {
    let i = from
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (!better(items[i], items[parent])) break
      swap(i, parent)
      i = parent
    }
  }
  const sinkDown = (from: number) => {
    let i = from
    for (;;) {
      const left = i * 2 + 1
      const right = left + 1
      let best = i
      if (left < items.length && better(items[left], items[best])) best = left
      if (right < items.length && better(items[right], items[best])) best = right
      if (best === i) break
      swap(i, best)
      i = best
    }
  }
  return {
    get size() {
      return items.length
    },
    push(entry: T) {
      items.push(entry)
      bubbleUp(items.length - 1)
    },
    pop(): T | undefined {
      const top = items[0]
      if (top === undefined) return undefined
      const last = items.pop() as T
      if (items.length > 0) {
        items[0] = last
        sinkDown(0)
      }
      return top
    },
  }
}
