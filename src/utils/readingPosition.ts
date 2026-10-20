export interface ReadingPosition { page: number; offset: number }
const key = (paperId: string) => `papermind:reading-position:${encodeURIComponent(paperId)}`

export function readReadingPosition(paperId: string, totalPages: number): ReadingPosition | null {
  try {
    const raw = JSON.parse(window.localStorage.getItem(key(paperId)) ?? 'null')
    if (!raw || !Number.isSafeInteger(raw.page) || raw.page < 1 || !Number.isFinite(raw.offset)
      || raw.offset < 0 || raw.offset > 1 || totalPages < 1) return null
    return { page: Math.min(raw.page, totalPages), offset: raw.offset }
  } catch { return null }
}

export function saveReadingPosition(paperId: string, position: ReadingPosition) {
  try { window.localStorage.setItem(key(paperId), JSON.stringify(position)) } catch { /* Reading remains available if local storage is disabled. */ }
}
