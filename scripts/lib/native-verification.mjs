import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PREFIX = 'PAPERMIND_NATIVE_SMOKE='
const probePath = fileURLToPath(new URL('../probes/native-smoke.cjs', import.meta.url))

function contextOf(result) {
  return `platform=${result?.platform ?? 'unknown'} arch=${result?.arch ?? 'unknown'} `
    + `electron=${result?.electron ?? 'unknown'} node=${result?.node ?? 'unknown'}`
}

export function nativeProbeErrors(result) {
  if (!result || typeof result !== 'object') return ['Native dependency probe returned no result']
  const context = contextOf(result)
  if (!result.ok) {
    const expectedSharp = `@img/sharp-${result.platform ?? 'unknown'}-${result.arch ?? 'unknown'}`
    if (String(result.error).includes('@img/sharp') || /sharp/i.test(String(result.error))) {
      return [`Sharp optional package missing or incompatible: expected=${expectedSharp}; ${context}; error=${result.error ?? 'unknown'}`]
    }
    return [`Native dependency probe failed: ${context}; error=${result.error ?? 'unknown'}; source compilation fallback is disabled`]
  }

  const errors = []
  if (result.sqliteValue !== 42) {
    errors.push(`better-sqlite3 functional check failed: expected=42 actual=${result.sqliteValue ?? 'missing'}; ${context}`)
  }
  if (result.sharp?.width !== 2 || result.sharp?.height !== 2 || result.sharp?.format !== 'png') {
    errors.push(`Sharp functional check failed: expected=2x2/png actual=${result.sharp?.width ?? 'missing'}x${result.sharp?.height ?? 'missing'}/${result.sharp?.format ?? 'missing'}; ${context}`)
  }
  if (typeof result.sqliteBinding !== 'string' || !result.sqliteBinding.endsWith('.node')) {
    errors.push(`better-sqlite3 binding path missing: ${context}`)
  }
  if (typeof result.sharpBinding !== 'string' || !result.sharpBinding.endsWith('.node')) {
    errors.push(`Sharp binding path missing: ${context}`)
  }
  return errors
}

export function runNativeProbe({ executable, requireRoot, timeout = 30_000 }) {
  if (!executable) return { ok: false, error: 'Electron executable is missing' }
  const environment = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    ...(requireRoot ? { PAPERMIND_REQUIRE_ROOT: requireRoot } : {}),
  }
  const probe = spawnSync(executable, [probePath], {
    encoding: 'utf8',
    env: environment,
    timeout,
    maxBuffer: 256 * 1024,
  })
  const line = String(probe.stdout).split(/\r?\n/).find(entry => entry.startsWith(PREFIX))
  if (line) {
    try {
      return JSON.parse(line.slice(PREFIX.length))
    } catch {
      return { ok: false, error: 'Native dependency probe returned invalid JSON' }
    }
  }
  if (probe.error?.code === 'ETIMEDOUT') {
    return { ok: false, error: `Native dependency probe timed out after ${timeout}ms` }
  }
  const diagnostic = String(probe.stderr || probe.error?.message || `exit status ${probe.status}`).trim().split(/\r?\n/, 1)[0]
  return { ok: false, error: `Native dependency probe produced no result: ${diagnostic}` }
}
