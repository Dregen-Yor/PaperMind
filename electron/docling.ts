import { createHash } from 'node:crypto'
import type { DoclingCredentials, OfficialDoclingConfig } from '../src/types/doclingConfig'
import { normalizeDoclingCredentials, OFFICIAL_DOCLING_CONFIG } from '../src/utils/doclingConfig'
import type { DoclingRecord, ParsedDocument } from '../src/utils/doclingDocument'
import { convertPdf } from './doclingClient'
import type { DoclingRepository } from './db/docling'

interface Dependencies {
  readPaper: (paperId: string) => { bytes: Uint8Array; name: string } | null
  getCredentials: () => unknown
  getOfficialConfig?: () => OfficialDoclingConfig
  repository: DoclingRepository
  convert?: (bytes: Uint8Array, name: string, credentials: DoclingCredentials) => Promise<ParsedDocument>
}

export function officialDoclingConfigHash(config: OfficialDoclingConfig = OFFICIAL_DOCLING_CONFIG): string {
  return createHash('sha256').update(JSON.stringify({ pipelineVersion: 4, officialConfig: config })).digest('hex')
}

export function createDoclingFacade(deps: Dependencies) {
  const identity = (paperId: string) => {
    const credentials = normalizeDoclingCredentials(deps.getCredentials())
    const paper = deps.readPaper(paperId)
    if (!paper) throw new Error('找不到论文 PDF 文件')
    const sourceHash = createHash('sha256').update(paper.bytes).digest('hex')
    const configHash = officialDoclingConfigHash(deps.getOfficialConfig?.() ?? OFFICIAL_DOCLING_CONFIG)
    return { paper, credentials, sourceHash, configHash }
  }
  return {
    async convert(paperId: string): Promise<DoclingRecord> {
      const { paper, credentials, sourceHash, configHash } = identity(paperId)
      const cached = deps.repository.get(paperId, sourceHash, configHash)
      if (cached) return cached
      const document = await (deps.convert ?? convertPdf)(paper.bytes, paper.name, credentials)
      return { document, sourceHash, configHash, cached: false }
    },
    save(paperId: string, record: DoclingRecord): DoclingRecord {
      const current = identity(paperId)
      if (record.sourceHash !== current.sourceHash || record.configHash !== current.configHash) throw new Error('论文或 Docling 配置已变化，请重新生成解读')
      return deps.repository.save(paperId, record)
    },
    readAsset: deps.repository.readAsset,
  }
}
