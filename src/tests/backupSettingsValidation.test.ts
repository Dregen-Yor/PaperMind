import { describe, expect, it } from 'vitest'
import { validateBackupInput } from '../../electron/db/backupValidation'

const profile = {
  id: 'local', name: '', provider: 'ollama', model: '', apiKey: '',
  baseUrl: '', temperature: 0.7, maxTokens: 0, topK: 0, systemPrompt: '',
}

function backupWith(key: string, value: unknown) {
  return { version: 1, settings: [{ key, value: JSON.stringify(value) }] }
}

describe('backup settings validation', () => {
  it.each(['', '{', 'undefined', '{"apiKey":"private-backup-secret"'])('rejects malformed JSON without disclosing its content (%j)', value => {
    let message = ''
    try { validateBackupInput({ version: 1, settings: [{ key: 'future_setting', value }] }) }
    catch (error) { message = (error as Error).message }
    expect(message).toContain('future_setting')
    expect(message).not.toContain('private-backup-secret')
  })

  it.each([null, true, 42, 'future', [], { nested: ['anything', null] }].map(value => [value]))('allows arbitrary JSON for unknown settings (%j)', value => {
    expect(() => validateBackupInput(backupWith('future_setting', value))).not.toThrow()
  })

  it.each([
    [null], ['profile'], [{}], [{ ...profile, id: '' }], [{ ...profile, id: null }],
    [{ ...profile, name: 1 }], [{ ...profile, provider: 'invalid' }],
    [{ ...profile, provider: ['openai'] }], [{ ...profile, provider: { toString: null } }], [{ ...profile, apiKey: {} }],
    [{ ...profile, model: null }], [{ ...profile, baseUrl: [] }], [{ ...profile, temperature: '0.7' }],
    [{ ...profile, maxTokens: '8192' }], [{ ...profile, topK: -1 }], [{ ...profile, systemPrompt: false }],
    [profile, { ...profile }],
  ].map(value => [value]))('rejects malformed or ambiguous profiles (%j)', value => {
    expect(() => validateBackupInput(backupWith('llm_profiles', value))).toThrow(/llm_profiles/)
  })

  it.each(['id', 'name', 'provider', 'model', 'apiKey', 'baseUrl', 'temperature', 'topK', 'systemPrompt'])('rejects a profile missing required %s', key => {
    const incomplete: Record<string, unknown> = { ...profile }
    delete incomplete[key]
    expect(() => validateBackupInput(backupWith('llm_profiles', [incomplete]))).toThrow(/llm_profiles/)
  })

  it.each([{}, 'profiles', false])('rejects a non-array profiles value (%j)', value => {
    expect(() => validateBackupInput(backupWith('llm_profiles', value))).toThrow(/llm_profiles/)
  })

  it('preserves legacy profile migration and default fallbacks without rewriting values', () => {
    const { maxTokens: _maxTokens, ...withoutMaxTokens } = profile
    const { id: _id, name: _name, topK: _topK, ...legacyConfig } = withoutMaxTokens
    const backup = { version: 1, settings: [
      { key: 'llm_profiles', value: JSON.stringify([withoutMaxTokens]) },
      { key: 'llm_config', value: JSON.stringify(legacyConfig) },
      { key: 'llm_profile_chat', value: JSON.stringify('deleted-profile') },
      { key: 'llm_profile_index', value: JSON.stringify('') },
      { key: 'docling_config', value: '{}' },
      { key: 'semantic_tree_enabled', value: JSON.stringify('true') },
      { key: 'llm_max_tokens_unlimited_migrated', value: 'false' },
    ] }
    const original = JSON.stringify(backup)
    expect(() => validateBackupInput(backup)).not.toThrow()
    expect(JSON.stringify(backup)).toBe(original)
    expect(() => validateBackupInput(backupWith('llm_profiles', []))).not.toThrow()
    expect(() => validateBackupInput(backupWith('llm_profiles', null))).not.toThrow()
    expect(() => validateBackupInput(backupWith('llm_config', null))).not.toThrow()
    expect(() => validateBackupInput(backupWith('docling_config', null))).not.toThrow()
  })

  it.each([0, 4096, 0.5, -1, 100_000])('keeps numeric maxTokens values normalized by chat.init (%s)', maxTokens => {
    expect(() => validateBackupInput(backupWith('llm_profiles', [{ ...profile, maxTokens }]))).not.toThrow()
  })

  it.each([
    ['llm_config', []], ['llm_config', 'config'], ['llm_config', {}],
    ['llm_config', { ...profile, topK: '10' }],
    ['llm_profile_chat', {}], ['llm_profile_index', 1],
    ['huggingface_token', { token: 'private-backup-secret' }],
    ['ek5_context_chars', '4000'], ['ek5_context_chars', 3999],
    ['ek5_context_chars', 1_000_001], ['ek5_context_chars', 4000.5],
    ['semantic_tree_enabled', 'yes'], ['semantic_tree_enabled', 1],
    ['llm_max_tokens_unlimited_migrated', 'true'],
    ['docling_config', []], ['docling_config', 'config'],
    ['docling_config', { apiKey: 123 }], ['docling_config', { baseUrl: 123 }],
    ['docling_config', { baseUrl: 'file:///tmp/docling' }],
    ['docling_config', { baseUrl: 'https://user:private-backup-secret@example.com' }],
    ['docling_config', { timeoutSeconds: 29 }], ['docling_config', { timeoutSeconds: 1801 }],
    ['docling_config', { ocr: 'false' }], ['docling_config', { formula: 0 }],
  ])('rejects invalid known setting %s (%j) without disclosing values', (key, value) => {
    let message = ''
    try { validateBackupInput(backupWith(key as string, value)) }
    catch (error) { message = (error as Error).message }
    expect(message).toContain(key)
    expect(message).not.toContain('private-backup-secret')
  })

  it.each([
    ['llm_profile_chat', null], ['llm_profile_index', 'local'], ['huggingface_token', ''],
    ['huggingface_token', null], ['ek5_context_chars', 4000], ['ek5_context_chars', 1_000_000],
    ['semantic_tree_enabled', true], ['semantic_tree_enabled', false], ['semantic_tree_enabled', 'false'],
    ['llm_max_tokens_unlimited_migrated', true],
    ['docling_config', { baseUrl: '', apiKey: '', timeoutSeconds: 600, ocr: false, formula: true }],
    ['docling_config', { baseUrl: 'http://localhost:5001', timeoutSeconds: null }],
  ])('allows supported known setting %s (%j)', (key, value) => {
    expect(() => validateBackupInput(backupWith(key as string, value))).not.toThrow()
  })
})
