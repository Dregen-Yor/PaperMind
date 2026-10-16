import { createHash } from 'node:crypto'
import { normalizeDoclingSettings, type DoclingSettings, type DoclingRecord, type ParsedDocument } from '../src/utils/doclingDocument'
import { convertPdf } from './doclingClient'
import type { DoclingRepository } from './db/docling'

interface Dependencies {
  readPaper: (paperId: string) => { bytes: Uint8Array; name: string } | null
  getSettings: () => unknown
  repository: DoclingRepository
  convert?: (bytes: Uint8Array, name: string, settings: DoclingSettings) => Promise<ParsedDocument>
}
export function createDoclingFacade(deps: Dependencies) {
  const identity = (paperId: string) => {
    const settings = normalizeDoclingSettings(deps.getSettings())
    if (!settings.baseUrl) throw new Error('请先在设置中填写 Docling 服务地址')
    const paper = deps.readPaper(paperId)
    if (!paper) throw new Error('找不到论文 PDF 文件')
    const sourceHash = createHash('sha256').update(paper.bytes).digest('hex')
    const configHash = createHash('sha256').update(JSON.stringify({ version: 3, baseUrl: settings.baseUrl, ocr: settings.ocr, formula: settings.formula, timeoutSeconds: settings.timeoutSeconds })).digest('hex')
    return { paper, settings, sourceHash, configHash }
  }
  return {
    async convert(paperId: string): Promise<DoclingRecord> {
      const { paper, settings, sourceHash, configHash } = identity(paperId)
      const cached = deps.repository.get(paperId, sourceHash, configHash)
      if (cached) return cached
      const document = await (deps.convert ?? convertPdf)(paper.bytes, paper.name, settings)
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
