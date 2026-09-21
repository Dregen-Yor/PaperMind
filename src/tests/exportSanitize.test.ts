import { describe, expect, it } from 'vitest'
import { stripApiKeysFromSettings, backupFileName } from '../utils/exportSanitize'

describe('导出脱敏（#5）', () => {
  it('剔除 llm_profiles 的 apiKey，其余字段原样保留', () => {
    const rows = [
      { key: 'llm_profiles', value: JSON.stringify([{ id: 'a', name: 'ds', apiKey: 'sk-secret', model: 'm' }]) },
      { key: 'llm_profile_chat', value: '"a"' },
    ]
    const out = stripApiKeysFromSettings(rows)
    const profiles = JSON.parse(out[0].value)
    expect(profiles[0].apiKey).toBe('')
    expect(profiles[0].model).toBe('m')
    expect(out[1]).toEqual(rows[1])
  })

  it('非 JSON 的 value 原样保留，不抛错', () => {
    const rows = [{ key: 'llm_profiles', value: 'not-json' }]
    expect(stripApiKeysFromSettings(rows)).toEqual(rows)
  })

  it('huggingface_token 置为空字符串的 JSON 形式', () => {
    const rows = [
      { key: 'huggingface_token', value: JSON.stringify('hf-secret') },
      { key: 'semantic_tree_enabled', value: 'true' },
    ]
    const out = stripApiKeysFromSettings(rows)
    expect(out[0].value).toBe('""')
    expect(JSON.parse(out[0].value)).toBe('')
    expect(out[1]).toEqual(rows[1])
  })

  it('遗留 llm_config 的 apiKey 置空，其余字段保留', () => {
    const rows = [
      { key: 'llm_config', value: JSON.stringify({ apiKey: 'sk-old', model: 'm', baseUrl: 'https://x' }) },
    ]
    const out = stripApiKeysFromSettings(rows)
    expect(JSON.parse(out[0].value)).toEqual({ apiKey: '', model: 'm', baseUrl: 'https://x' })
  })

  it('llm_config 非对象或非 JSON 时原样保留', () => {
    const rows = [
      { key: 'llm_config', value: 'not-json' },
      { key: 'llm_config_other', value: JSON.stringify({ apiKey: 'sk-x' }) },
    ]
    const out = stripApiKeysFromSettings(rows)
    expect(out[0]).toEqual(rows[0])
    expect(out[1]).toEqual(rows[1])
    expect(stripApiKeysFromSettings([{ key: 'llm_config', value: JSON.stringify('plain') }])[0].value).toBe('"plain"')
  })

  it('数组内非对象元素原样保留，对象元素 apiKey 清空', () => {
    const rows = [{ key: 'llm_profiles', value: JSON.stringify([null, { name: 'x', apiKey: 'k' }]) }]
    const out = stripApiKeysFromSettings(rows)
    const profiles = JSON.parse(out[0].value)
    expect(profiles[0]).toBeNull()
    expect(profiles[1]).toEqual({ name: 'x', apiKey: '' })
  })

  it('文件名带可读日期', () => {
    expect(backupFileName(new Date(2026, 8, 21, 15, 4))).toBe('papermind-backup-2026-09-21-1504.json')
  })
})
