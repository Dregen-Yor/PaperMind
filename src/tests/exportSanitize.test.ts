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

  it('文件名带可读日期', () => {
    expect(backupFileName(new Date(2026, 8, 21, 15, 4))).toBe('papermind-backup-2026-09-21-1504.json')
  })
})
