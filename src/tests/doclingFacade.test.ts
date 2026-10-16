import { describe, expect, it, vi } from 'vitest'
import { createDoclingFacade } from '../../electron/docling'
import { DEFAULT_DOCLING_SETTINGS, normalizeDoclingDocument } from '../utils/doclingDocument'
const fixture = () => {
  let config = { ...DEFAULT_DOCLING_SETTINGS, baseUrl: 'http://localhost:5001' }
  const document = normalizeDoclingDocument({ texts: [{ text: 'Evidence' }] })
  const repository = { get: vi.fn().mockReturnValue(null), save: vi.fn((_id, record) => record), readAsset: vi.fn(), exportBackup: vi.fn(), importBackup: vi.fn() }
  const convert = vi.fn().mockResolvedValue(document)
  const facade = createDoclingFacade({ readPaper: () => ({ bytes: new Uint8Array([1, 2]), name: 'p.pdf' }), getSettings: () => config, repository, convert })
  return { facade, repository, convert, setConfig: (c: typeof config) => { config = c }, config }
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
  it('rejects stale saves when parser configuration changes', async () => {
    const { facade, repository, setConfig, config } = fixture()
    const first = await facade.convert('paper')
    setConfig({ ...config, formula: false })
    expect(() => facade.save('paper', first)).toThrow('配置')
    expect(repository.save).not.toHaveBeenCalled()
  })
  it('does not invalidate cache on an authentication-only change', async () => {
    const { facade, setConfig, config } = fixture()
    const first = await facade.convert('paper')
    setConfig({ ...config, apiKey: 'new-key' })
    expect(facade.save('paper', first).configHash).toBe(first.configHash)
  })
})
