import { createHash } from 'node:crypto'
import type { DoclingCredentials, OfficialDoclingConfig } from '../src/types/doclingConfig'
import { normalizeDoclingCredentials, OFFICIAL_DOCLING_CONFIG } from '../src/utils/doclingConfig'
import { isParsedDocument, type ParsedDocument } from '../src/utils/doclingDocument'
import type { ParsedSummaryInput } from '../src/utils/parsedSummary'
import type { PreviewSnapshot } from '../src/types/webPreview'
import type { DocumentSummaryRecord, DocumentSummaryWrite, SummarySourceKind } from '../src/types/documentSummary'
import { officialDoclingConfigHash } from './docling'

const PROTOCOL = 'parsed-materials-v1'
interface Dependencies {
  readPaper: (id: string) => { base64: string; title: string; name: string } | null
  getSnapshot: (id: string) => PreviewSnapshot | null
  getCredentials: () => unknown
  getOfficialConfig?: () => OfficialDoclingConfig
  convertPdf: (bytes: Uint8Array, name: string, credentials: DoclingCredentials) => Promise<ParsedDocument>
  parseHtml: (snapshot: PreviewSnapshot) => Promise<ParsedDocument>
  repository: {
    get: (kind: SummarySourceKind, id: string, slot: 'materials') => DocumentSummaryRecord | null
    save: (record: DocumentSummaryWrite) => unknown
    saveAsset: (kind: SummarySourceKind, id: string, data: string) => string
    readAsset: (id: string) => string | null
  }
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

/** Source access and parsing stay in the main process; credentials never enter cached materials. */
export function createSummaryParser(deps: Dependencies) {
  const pending = new Map<string, Promise<ParsedSummaryInput>>()
  let pdfQueue: Promise<unknown> = Promise.resolve()
  function identity(kind: SummarySourceKind, sourceId: string) {
    if (!['paper', 'web'].includes(kind) || typeof sourceId !== 'string' || !sourceId || sourceId.length > 200) throw new Error('摘要来源无效')
    const paper = kind === 'paper' ? deps.readPaper(sourceId) : null
    const snapshot = kind === 'web' ? deps.getSnapshot(sourceId) : null
    if (!paper && !snapshot) throw new Error('摘要原文已不存在')
    const credentials = kind === 'paper' ? normalizeDoclingCredentials(deps.getCredentials()) : null
    const sourceHash = paper ? hash(paper.base64) : `${sourceId}:${snapshot!.contentHash}:${snapshot!.capturedAt}`
    const parserKey = hash(JSON.stringify({ protocol: PROTOCOL, kind,
      ...(credentials ? { officialConfigHash: officialDoclingConfigHash(deps.getOfficialConfig?.() ?? OFFICIAL_DOCLING_CONFIG) }
        : { htmlParser: 'html-native-mhtml-v2' }),
    }))
    return { kind, sourceId, sourceHash, parserKey, title: paper?.title ?? snapshot!.title, paper, snapshot, credentials }
  }
  function hydrate(input: ParsedSummaryInput): ParsedSummaryInput {
    const hydrated = structuredClone(input)
    for (const item of hydrated.document.items) for (const image of item.images) {
      if (image.assetId) {
        const data = deps.repository.readAsset(image.assetId)
        if (!data) throw new Error('已保存的摘要原图缺失，需要重新解析')
        image.data = data
      }
    }
    return hydrated
  }
  function parse(kind: SummarySourceKind, sourceId: string): Promise<ParsedSummaryInput> {
    const source = identity(kind, sourceId)
    const key = `${kind}:${sourceId}:${source.sourceHash}:${source.parserKey}`
    const existing = pending.get(key)
    if (existing) return existing
    const check = () => {
      const current = identity(kind, sourceId)
      if (current.sourceHash !== source.sourceHash || current.parserKey !== source.parserKey) throw new Error('原文或解析配置已变化，请重新生成摘要')
    }
    const run = async (): Promise<ParsedSummaryInput> => {
      check()
      const cached = deps.repository.get(kind, sourceId, 'materials')
      if (cached?.sourceHash === source.sourceHash) {
        try {
          const saved = JSON.parse(cached.payload)
          if (saved.protocol === PROTOCOL && saved.input?.kind === kind && saved.input.sourceId === sourceId
            && saved.input.sourceHash === source.sourceHash && saved.input.parserKey === source.parserKey && isParsedDocument(saved.input.document)) {
            return hydrate({ ...saved.input, title: source.title })
          }
        } catch { /* Invalid or incomplete material caches are rebuilt from the immutable source. */ }
      }
      const document = source.paper
        ? await deps.convertPdf(new Uint8Array(Buffer.from(source.paper.base64, 'base64')), source.paper.name, source.credentials!)
        : await deps.parseHtml(source.snapshot!)
      check()
      if (!isParsedDocument(document) || !document.items.length) throw new Error('原文未解析出可用于摘要的材料')
      const input: ParsedSummaryInput = { kind, sourceId, title: source.title, sourceHash: source.sourceHash, parserKey: source.parserKey, document: structuredClone(document) }
      for (const item of input.document.items) for (const image of item.images) {
        if (image.data) {
          image.assetId = deps.repository.saveAsset(kind, sourceId, image.data)
          delete image.data
        }
      }
      check()
      deps.repository.save({ kind, sourceId, slot: 'materials', sourceHash: source.sourceHash, payload: JSON.stringify({ protocol: PROTOCOL, input }) })
      return hydrate(input)
    }
    const task = kind === 'paper' ? pdfQueue.then(run) : Promise.resolve().then(run)
    if (kind === 'paper') pdfQueue = task.catch(() => {})
    pending.set(key, task)
    void task.finally(() => { if (pending.get(key) === task) pending.delete(key) }).catch(() => {})
    return task
  }
  return { parse }
}
