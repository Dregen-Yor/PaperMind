import { execFileSync } from 'node:child_process'
import os from 'node:os'

export const EXPECTED_NODE = '24.22.1'
export const EXPECTED_NPM = '10.9.4'
export const EXPECTED_ELECTRON = '44.11.3'

function compareVersions(actual, expected) {
  const left = String(actual).split('.').map(Number)
  const right = String(expected).split('.').map(Number)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return Math.sign(difference)
  }
  return 0
}

export function toolchainErrors({ node, npm, platform, arch, release, glibc }) {
  const errors = []
  if (node !== EXPECTED_NODE) {
    errors.push(`Node.js version mismatch: expected=${EXPECTED_NODE} actual=${node ?? 'unknown'}`)
  }
  if (npm !== EXPECTED_NPM) {
    errors.push(`npm version mismatch: expected=${EXPECTED_NPM} actual=${npm ?? 'unknown'}`)
  }

  if (platform === 'linux') {
    if (arch !== 'x64') errors.push(`Unsupported platform: platform=${platform} arch=${arch}`)
    if (!glibc || compareVersions(glibc, '2.34') < 0) {
      errors.push(`Unsupported glibc: expected=>=2.34 actual=${glibc ?? 'unknown'}`)
    }
  } else if (platform === 'darwin') {
    const darwinMajor = Number(String(release).split('.')[0])
    if (!['x64', 'arm64'].includes(arch) || !Number.isInteger(darwinMajor) || darwinMajor < 22) {
      errors.push(`Unsupported platform: platform=${platform} arch=${arch} release=${release ?? 'unknown'}`)
    }
  } else if (platform !== 'win32' || arch !== 'x64') {
    errors.push(`Unsupported platform: platform=${platform} arch=${arch}`)
  }

  return errors
}

export function readActualNpmVersion(environment = process.env) {
  const userAgentVersion = environment.npm_config_user_agent?.match(/(?:^|\s)npm\/([^\s]+)/)?.[1]
  if (userAgentVersion) return userAgentVersion

  if (environment.npm_execpath) {
    return execFileSync(process.execPath, [environment.npm_execpath, '--version'], {
      encoding: 'utf8',
      env: environment,
    }).trim()
  }

  const executable = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  return execFileSync(executable, ['--version'], { encoding: 'utf8', env: environment }).trim()
}

export function readActualToolchain() {
  const report = process.report?.getReport()
  return {
    node: process.versions.node,
    npm: readActualNpmVersion(),
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    glibc: report?.header?.glibcVersionRuntime ?? null,
  }
}

const EXACT_VERSION = /^\d+\.\d+\.\d+$/
const SHARP_TARGETS = [
  '@img/sharp-darwin-arm64',
  '@img/sharp-darwin-x64',
  '@img/sharp-linux-x64',
  '@img/sharp-win32-x64',
]

function parseNpmrc(source) {
  const entries = new Map()
  for (const rawLine of String(source).split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const separator = line.indexOf('=')
    if (separator < 0) {
      entries.set(line, '')
      continue
    }
    entries.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim())
  }
  return entries
}

function directDependencyErrors(manifest, lockRoot) {
  const errors = []
  for (const group of ['dependencies', 'devDependencies']) {
    const declared = manifest[group] ?? {}
    const locked = lockRoot?.[group] ?? {}
    for (const [name, version] of Object.entries(declared)) {
      if (!EXACT_VERSION.test(version)) {
        errors.push(`${group}.${name} must use an exact version: actual=${version}`)
      }
      if (locked[name] !== version) {
        errors.push(`lock root mismatch for ${group}.${name}: expected=${version} actual=${locked[name] ?? 'missing'}`)
      }
    }
    for (const name of Object.keys(locked)) {
      if (!(name in declared)) errors.push(`lock root has undeclared ${group}.${name}`)
    }
  }
  return errors
}

function findLockUrls(value, path = 'lock') {
  const errors = []
  if (Array.isArray(value)) {
    value.forEach((entry, index) => errors.push(...findLockUrls(entry, `${path}[${index}]`)))
    return errors
  }
  if (!value || typeof value !== 'object') return errors
  for (const [key, entry] of Object.entries(value)) {
    const entryPath = `${path}.${key}`
    const knownRegistryHost = typeof entry === 'string'
      && /https?:\/\/(?:registry\.npmjs\.org|registry\.npmmirror\.com)(?:[/:?#]|$)/i.test(entry)
    if (key === 'resolved' || knownRegistryHost) {
      errors.push(`lockfile contains registry URL at ${entryPath}`)
    } else {
      errors.push(...findLockUrls(entry, entryPath))
    }
  }
  return errors
}

export function manifestErrors({ manifest, lock, nvmrc, npmrc }) {
  const errors = []
  const lockPackages = lock?.packages ?? {}
  const lockRoot = lockPackages['']

  if (manifest?.packageManager !== `npm@${EXPECTED_NPM}`) {
    errors.push(`packageManager mismatch: expected=npm@${EXPECTED_NPM} actual=${manifest?.packageManager ?? 'missing'}`)
  }
  if (manifest?.engines?.node !== EXPECTED_NODE) {
    errors.push(`engines.node mismatch: expected=${EXPECTED_NODE} actual=${manifest?.engines?.node ?? 'missing'}`)
  }
  if (manifest?.engines?.npm !== EXPECTED_NPM) {
    errors.push(`engines.npm mismatch: expected=${EXPECTED_NPM} actual=${manifest?.engines?.npm ?? 'missing'}`)
  }
  if (String(nvmrc).trim() !== EXPECTED_NODE) {
    errors.push(`.nvmrc mismatch: expected=${EXPECTED_NODE} actual=${String(nvmrc).trim() || 'missing'}`)
  }

  errors.push(...directDependencyErrors(manifest ?? {}, lockRoot))

  if (manifest?.devDependencies?.electron !== EXPECTED_ELECTRON) {
    errors.push(`Electron version mismatch: expected=${EXPECTED_ELECTRON} actual=${manifest?.devDependencies?.electron ?? 'missing'}`)
  }
  if (manifest?.devDependencies?.['@electron/rebuild'] !== undefined) {
    errors.push('@electron/rebuild is forbidden; supported platforms must use bundled prebuilds')
  }

  const scripts = manifest?.scripts ?? {}
  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command !== 'string') continue
    if (/electron-rebuild/.test(command)) errors.push(`script ${name} contains forbidden electron-rebuild`)
    if (/\bnode-gyp\b/.test(command)) errors.push(`script ${name} contains forbidden node-gyp`)
  }
  if (scripts.postinstall !== 'node scripts/prepare-install.mjs') {
    errors.push(`postinstall mismatch: expected=node scripts/prepare-install.mjs actual=${scripts.postinstall ?? 'missing'}`)
  }

  const npmConfig = parseNpmrc(npmrc)
  for (const [key, expected] of [
    ['engine-strict', 'true'],
    ['save-exact', 'true'],
    ['omit-lockfile-registry-resolved', 'true'],
    ['include', 'optional'],
  ]) {
    if (npmConfig.get(key) !== expected) {
      errors.push(`.npmrc ${key} mismatch: expected=${expected} actual=${npmConfig.get(key) ?? 'missing'}`)
    }
  }
  for (const key of npmConfig.keys()) {
    if (key === 'registry' || key.endsWith(':registry')) errors.push(`.npmrc must not configure registry: ${key}`)
  }

  if (lock?.lockfileVersion !== 3) {
    errors.push(`lockfileVersion mismatch: expected=3 actual=${lock?.lockfileVersion ?? 'missing'}`)
  }
  if (!lockRoot) errors.push('lockfile packages root is missing')
  errors.push(...findLockUrls(lock))

  for (const [path, entry] of Object.entries(lockPackages)) {
    if (!path || entry?.link || !entry?.version) continue
    if (!entry.integrity) errors.push(`lock package integrity missing: ${path}`)
  }
  if (lockPackages['node_modules/node-gyp']) {
    errors.push('lockfile contains forbidden node-gyp source compiler')
  }
  for (const name of SHARP_TARGETS) {
    if (!lockPackages[`node_modules/${name}`]) errors.push(`lockfile missing optional package ${name}`)
  }

  return errors
}
