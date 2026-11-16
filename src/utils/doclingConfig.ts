import rawConfig from '../../config/docling-service.json'
import type { DoclingCredentials, OfficialDoclingConfig } from '../types/doclingConfig'

export const DOCLING_SETTINGS_KEY = 'docling_config'

type JsonObject = Record<string, unknown>

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}必须是对象`)
  return value as JsonObject
}

function rejectSensitiveKeys(value: unknown, path = 'Docling 官方配置'): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectSensitiveKeys(item, `${path}[${index}]`))
    return
  }
  for (const [key, child] of Object.entries(value as JsonObject)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (['apikey', 'token', 'secret', 'password', 'credential', 'credentials', 'clientsecret'].some(part => normalized.includes(part))) {
      throw new Error(`${path}.${key}不能包含凭据或密钥`)
    }
    rejectSensitiveKeys(child, `${path}.${key}`)
  }
}

function exactKeys(value: JsonObject, keys: readonly string[], label: string): void {
  const allowed = new Set(keys)
  const unknown = Object.keys(value).filter(key => !allowed.has(key))
  const missing = keys.filter(key => !(key in value))
  if (unknown.length) throw new Error(`${label}包含未知字段：${unknown.join(', ')}`)
  if (missing.length) throw new Error(`${label}缺少字段：${missing.join(', ')}`)
}

function exact<T>(value: unknown, expected: T, label: string): T {
  if (value !== expected) throw new Error(`${label}必须为 ${String(expected)}`)
  return expected
}

function parseIpv4(host: string): number[] | undefined {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return undefined
  const octets = host.split('.').map(Number)
  return octets.every(value => value >= 0 && value <= 255) ? octets : undefined
}

function privateOrReservedIpv4(octets: number[]): boolean {
  const [a, b, c] = octets
  return a === 0
    || a === 10
    || a === 100 && b >= 64 && b <= 127
    || a === 127
    || a === 169 && b === 254
    || a === 172 && b >= 16 && b <= 31
    || a === 192 && b === 0 && c === 0
    || a === 192 && b === 0 && c === 2
    || a === 192 && b === 168
    || a === 198 && (b === 18 || b === 19)
    || a === 198 && b === 51 && c === 100
    || a === 203 && b === 0 && c === 113
    || a >= 224
}

function parseIpv6(host: string): number[] | undefined {
  const unwrapped = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (!unwrapped.includes(':') || unwrapped.includes('%')) return undefined
  let text = unwrapped
  const ipv4Match = text.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (ipv4Match) {
    const octets = parseIpv4(ipv4Match[1])
    if (!octets) return undefined
    text = `${text.slice(0, -ipv4Match[1].length)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return undefined
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves[1] ? halves[1].split(':') : []
  if (halves.length === 1 && left.length !== 8) return undefined
  const zeroCount = halves.length === 2 ? 8 - left.length - right.length : 0
  if (zeroCount < (halves.length === 2 ? 1 : 0)) return undefined
  const parts = [...left, ...Array(zeroCount).fill('0'), ...right]
  if (parts.length !== 8 || parts.some(part => !/^[0-9a-f]{1,4}$/.test(part))) return undefined
  return parts.map(part => Number.parseInt(part, 16))
}

function privateOrReservedIpv6(parts: number[]): boolean {
  const allZeroPrefix = parts.slice(0, 6).every(part => part === 0)
  const mappedIpv4 = allZeroPrefix || parts.slice(0, 5).every(part => part === 0) && parts[5] === 0xffff
  if (mappedIpv4 && privateOrReservedIpv4([parts[6] >> 8, parts[6] & 0xff, parts[7] >> 8, parts[7] & 0xff])) return true
  return parts.every(part => part === 0)
    || parts.slice(0, 7).every(part => part === 0) && parts[7] === 1
    || (parts[0] & 0xfe00) === 0xfc00
    || (parts[0] & 0xffc0) === 0xfe80
    || (parts[0] & 0xff00) === 0xff00
    || parts[0] === 0x2001 && parts[1] === 0x0db8
}

function officialBaseUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Docling 官方服务地址必须是字符串')
  let url: URL
  try { url = new URL(value) } catch { throw new Error('Docling 官方服务地址无效') }
  if (url.protocol !== 'https:') throw new Error('Docling 官方服务必须使用 HTTPS')
  if (url.username || url.password) throw new Error('Docling 官方服务地址不能包含凭据')
  if (url.search || url.hash) throw new Error('Docling 官方服务地址不能包含查询参数或片段')
  if (url.pathname !== '/' && url.pathname !== '') throw new Error('Docling 官方服务地址必须是根地址')
  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) {
    throw new Error('Docling 官方服务地址必须使用公网主机')
  }
  const ipv4 = parseIpv4(host)
  if (ipv4 && privateOrReservedIpv4(ipv4)) throw new Error('Docling 官方服务地址不能使用私网或保留 IPv4 地址')
  const ipv6 = parseIpv6(host)
  if (host.includes(':') && !ipv6) throw new Error('Docling 官方服务 IPv6 地址无效')
  if (ipv6 && privateOrReservedIpv6(ipv6)) throw new Error('Docling 官方服务地址不能使用私网或保留 IPv6 地址')
  return url.href.replace(/\/$/, '')
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as JsonObject)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

export function normalizeDoclingCredentials(value: unknown): DoclingCredentials {
  if (value === null || value === undefined) return { apiKey: '' }
  const credentials = object(value, 'Docling 凭据')
  if (credentials.apiKey === undefined) return { apiKey: '' }
  if (typeof credentials.apiKey !== 'string') throw new Error('Docling API Key 必须是字符串')
  return { apiKey: credentials.apiKey.trim() }
}

export function parseDoclingCredentials(value: unknown): DoclingCredentials {
  const credentials = object(value, 'Docling 凭据')
  exactKeys(credentials, ['apiKey'], 'Docling 凭据')
  if (typeof credentials.apiKey !== 'string') throw new Error('Docling API Key 必须是字符串')
  return { apiKey: credentials.apiKey.trim() }
}

export function parseOfficialDoclingConfig(value: unknown): Readonly<OfficialDoclingConfig> {
  rejectSensitiveKeys(value)
  const root = object(value, 'Docling 官方配置')
  exactKeys(root, ['schemaVersion', 'baseUrl', 'timeoutSeconds', 'conversion'], 'Docling 官方配置')
  const conversion = object(root.conversion, 'Docling conversion 配置')
  exactKeys(conversion, [
    'fromFormat', 'toFormat', 'targetType', 'imageExportMode', 'includeImages', 'imageScale',
    'ocr', 'formula', 'table', 'layoutPreset',
  ], 'Docling conversion 配置')
  const ocr = object(conversion.ocr, 'Docling OCR 配置')
  exactKeys(ocr, ['enabled', 'engine', 'preset'], 'Docling OCR 配置')
  const formula = object(conversion.formula, 'Docling 公式配置')
  exactKeys(formula, ['enabled', 'preset'], 'Docling 公式配置')
  const table = object(conversion.table, 'Docling 表格配置')
  exactKeys(table, ['enabled', 'mode', 'preset'], 'Docling 表格配置')
  const result: OfficialDoclingConfig = {
    schemaVersion: exact(root.schemaVersion, 1, 'schemaVersion'),
    baseUrl: officialBaseUrl(root.baseUrl),
    timeoutSeconds: exact(root.timeoutSeconds, 60, 'timeoutSeconds'),
    conversion: {
      fromFormat: exact(conversion.fromFormat, 'pdf', 'fromFormat'),
      toFormat: exact(conversion.toFormat, 'json', 'toFormat'),
      targetType: exact(conversion.targetType, 'inbody', 'targetType'),
      imageExportMode: exact(conversion.imageExportMode, 'embedded', 'imageExportMode'),
      includeImages: exact(conversion.includeImages, true, 'includeImages'),
      imageScale: exact(conversion.imageScale, 2, 'imageScale'),
      ocr: {
        enabled: exact(ocr.enabled, true, 'ocr.enabled'),
        engine: exact(ocr.engine, 'rapidocr', 'ocr.engine'),
        preset: exact(ocr.preset, 'rapidocr', 'ocr.preset'),
      },
      formula: {
        enabled: exact(formula.enabled, true, 'formula.enabled'),
        preset: exact(formula.preset, 'codeformulav2', 'formula.preset'),
      },
      table: {
        enabled: exact(table.enabled, true, 'table.enabled'),
        mode: exact(table.mode, 'accurate', 'table.mode'),
        preset: exact(table.preset, 'tableformer_v1_accurate', 'table.preset'),
      },
      layoutPreset: exact(conversion.layoutPreset, 'layout_heron_default', 'layoutPreset'),
    },
  }
  return deepFreeze(result)
}

export const OFFICIAL_DOCLING_CONFIG = parseOfficialDoclingConfig(rawConfig)
