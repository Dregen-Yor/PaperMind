import { parsePassageIndex, type PassageIndex, type PassageIndexRecord } from './passageIndex'

interface ParsedPaper {
  pages: string[]
  passageIndex?: PassageIndex
  rawIndex?: unknown
}

interface CacheEntry extends PassageIndexRecord {
  parsed: ParsedPaper
}

const MAX_PARSED_PAPERS = 8

/** Store-owned LRU: only valid v2 records retain parsed pages and decoded vectors. */
export function createParsedPaperCache() {
  const entries = new Map<string, CacheEntry>()
  return {
    get(paperId: string, record: PassageIndexRecord | null | undefined): ParsedPaper | undefined {
      const cached = entries.get(paperId)
      if (record && cached?.indexJson === record.indexJson && cached.pagesJson === record.pagesJson) {
        entries.delete(paperId)
        entries.set(paperId, cached)
        return cached.parsed
      }
      // Invalidate before parsing so a failed or missing replacement cannot revive old objects.
      entries.delete(paperId)
      if (!record) return undefined
      // Preserve the collection path's page JSON error boundary, including legacy records.
      const pages: string[] = JSON.parse(record.pagesJson)
      let rawIndex: unknown
      try {
        rawIndex = JSON.parse(record.indexJson)
      } catch {
        rawIndex = undefined
      }
      const passageIndex = parsePassageIndex(rawIndex)
      if (!passageIndex) return { pages, rawIndex }

      const parsed = { pages, passageIndex }
      entries.set(paperId, { indexJson: record.indexJson, pagesJson: record.pagesJson, parsed })
      if (entries.size > MAX_PARSED_PAPERS) entries.delete(entries.keys().next().value!)
      return parsed
    },
  }
}
