import { describe, expect, it, vi } from 'vitest'
import { createDoclingFacade } from '../../electron/docling'
import { OFFICIAL_DOCLING_CONFIG } from '../utils/doclingConfig'
import { normalizeDoclingDocument } from '../utils/doclingDocument'
const fixture = () => {
  let credentials = { apiKey: 'key' }
  let officialConfig = structuredClone(OFFICIAL_DOCLING_CONFIG)
  const document = normalizeDoclingDocument({ texts: [{ text: 'Evidence' }] })
  const repository = { get: vi.fn().mockReturnValue(null), save: vi.fn((_id, record) => record), readAsset: vi.fn(), exportBackup: vi.fn(), importBackup: vi.fn() }
  const convert = vi.fn().mockResolvedValue(document)
  const deps = { readPaper: () => ({ bytes: new Uint8Array([1, 2]), name: 'p.pdf' }), getCredentials: () => credentials, repository, convert, getOfficialConfig: () => officialConfig }
  const facade = createDoclingFacade(deps)
  return {
    facade, repository, convert,
    setCredentials: (value: unknown) => { credentials = value as typeof credentials },
    setOfficialConfig: (value: typeof officialConfig) => { officialConfig = value },
  }
}
describe('Docling cache orchestration', () => {
  it('uses file and parsing configuration fingerprints and reuses valid cache', async () => {
    const { facade, repository, convert } = fixture()
    const first = await facade.convert('paper')
    expect(first.sourceHash).toMatch(/^[a-f0-9]{64}$/)
    repository.get.mockReturnValue({ ...first, cached: true } as any)
    expect((await facade.convert('paper')).cached).toBe(true)
    expect(convert).toHaveBeenCalledTimes(1)
  })
  it('rejects stale saves when the official parser configuration changes', async () => {
    const { facade, repository, setOfficialConfig } = fixture()
    const first = await facade.convert('paper')
    setOfficialConfig({ ...structuredClone(OFFICIAL_DOCLING_CONFIG), schemaVersion: 2 } as never)
    expect(() => facade.save('paper', first)).toThrow('配置')
    expect(repository.save).not.toHaveBeenCalled()
  })
  it('ignores legacy deployment fields and authentication-only changes in cache identity', async () => {
    const { facade, convert, setCredentials } = fixture()
    const first = await facade.convert('paper')
    setCredentials({ apiKey: 'new-key', baseUrl: 'http://127.0.0.1:5001', timeoutSeconds: 600, ocr: false, formula: false })
    expect(facade.save('paper', first).configHash).toBe(first.configHash)
    await facade.convert('another-paper')
    expect(convert).toHaveBeenLastCalledWith(expect.any(Uint8Array), 'p.pdf', { apiKey: 'new-key' })
  })
})
