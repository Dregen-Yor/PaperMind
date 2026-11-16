import { describe, expect, it } from 'vitest'
import {
  OFFICIAL_DOCLING_CONFIG,
  normalizeDoclingCredentials,
  parseOfficialDoclingConfig,
} from '../utils/doclingConfig'

const valid = () => structuredClone(OFFICIAL_DOCLING_CONFIG)

describe('official Docling configuration', () => {
  it('drives the official endpoint, timeout, and fixed parser capabilities', () => {
    expect(OFFICIAL_DOCLING_CONFIG).toMatchObject({
      schemaVersion: 1,
      baseUrl: 'https://docling.example.com',
      timeoutSeconds: 60,
      conversion: {
        fromFormat: 'pdf',
        toFormat: 'json',
        targetType: 'inbody',
        imageExportMode: 'embedded',
        includeImages: true,
        imageScale: 2,
        ocr: { enabled: true, engine: 'rapidocr', preset: 'rapidocr' },
        formula: { enabled: true, preset: 'codeformulav2' },
        table: { enabled: true, mode: 'accurate', preset: 'tableformer_v1_accurate' },
        layoutPreset: 'layout_heron_default',
      },
    })
    expect(Object.isFrozen(OFFICIAL_DOCLING_CONFIG)).toBe(true)
    expect(Object.isFrozen(OFFICIAL_DOCLING_CONFIG.conversion)).toBe(true)
    expect(Object.isFrozen(OFFICIAL_DOCLING_CONFIG.conversion.ocr)).toBe(true)
  })

  it.each([
    ['HTTP URL', { baseUrl: 'http://docling.example.com' }],
    ['loopback IPv4', { baseUrl: 'https://127.0.0.1' }],
    ['private IPv4', { baseUrl: 'https://10.0.0.8' }],
    ['link-local IPv4', { baseUrl: 'https://169.254.169.254' }],
    ['documentation IPv4', { baseUrl: 'https://192.0.2.1' }],
    ['loopback IPv6', { baseUrl: 'https://[::1]' }],
    ['link-local IPv6', { baseUrl: 'https://[fe80::1]' }],
    ['unique-local IPv6', { baseUrl: 'https://[fd00::1]' }],
    ['credentials in URL', { baseUrl: 'https://user:secret@docling.example.com' }],
    ['query in URL', { baseUrl: 'https://docling.example.com?mode=fast' }],
    ['wrong timeout', { timeoutSeconds: 61 }],
    ['unknown field', { extra: true }],
  ])('rejects %s', (_label, patch) => {
    expect(() => parseOfficialDoclingConfig({ ...valid(), ...patch })).toThrow()
  })

  it.each([
    { apiKey: 'secret' },
    { conversion: { ...valid().conversion, token: 'secret' } },
    { conversion: { ...valid().conversion, nested: { clientSecret: 'secret' } } },
  ])('rejects sensitive or unknown config fields recursively', value => {
    expect(() => parseOfficialDoclingConfig({ ...valid(), ...value })).toThrow()
  })

  it('migrates legacy settings to API-key-only credentials', () => {
    expect(normalizeDoclingCredentials({
      apiKey: '  key  ',
      baseUrl: 'http://127.0.0.1:5001',
      timeoutSeconds: 600,
      ocr: false,
      formula: false,
    })).toEqual({ apiKey: 'key' })
    expect(normalizeDoclingCredentials(null)).toEqual({ apiKey: '' })
    expect(() => normalizeDoclingCredentials({ apiKey: 42 })).toThrow('API Key')
  })
})
