import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EXPECTED_ELECTRON } from './install-contract.mjs'

export function electronBinaryPath(electronDir, platform = process.platform) {
  if (platform === 'darwin') return join(electronDir, 'dist/Electron.app/Contents/MacOS/Electron')
  if (platform === 'win32') return join(electronDir, 'dist/electron.exe')
  return join(electronDir, 'dist/electron')
}

export function electronPackageState(root, platform = process.platform) {
  const electronDir = join(root, 'node_modules/electron')
  const packagePath = join(electronDir, 'package.json')
  if (!existsSync(packagePath)) {
    return { electronDir, version: null, binary: electronBinaryPath(electronDir, platform), ready: false }
  }
  let version = null
  try {
    version = JSON.parse(readFileSync(packagePath, 'utf8')).version ?? null
  } catch {
    version = null
  }
  const binary = electronBinaryPath(electronDir, platform)
  const ready = existsSync(join(electronDir, 'path.txt')) && existsSync(binary)
  return { electronDir, version, binary, ready }
}

function defaultRun({ electronDir, installScript, env }) {
  return spawnSync(process.execPath, [installScript], {
    cwd: electronDir,
    env,
    stdio: 'inherit',
  })
}

export function prepareElectron({ root, env = process.env, runInstall = defaultRun }) {
  const initial = electronPackageState(root)
  if (!initial.version) {
    throw new Error(`Electron package is missing: expected=${EXPECTED_ELECTRON} actual=missing; run npm ci`)
  }
  if (initial.version !== EXPECTED_ELECTRON) {
    throw new Error(`Electron package version mismatch: expected=${EXPECTED_ELECTRON} actual=${initial.version}; run npm ci`)
  }
  if (initial.ready) return { downloaded: false, binary: initial.binary }

  const installScript = join(initial.electronDir, 'install.js')
  if (!existsSync(installScript)) {
    throw new Error(`Electron installer is missing for ${EXPECTED_ELECTRON}; run npm ci`)
  }
  console.log('[ensure-electron] Electron binary is missing; downloading from the configured official source')
  const result = runInstall({
    electronDir: initial.electronDir,
    installScript,
    env: { ...env },
  })
  const final = electronPackageState(root)
  if (result?.status !== 0 || !final.ready) {
    throw new Error('Electron binary download failed; check network/proxy/TLS settings or an explicit ELECTRON_MIRROR and retry npm ci')
  }
  return { downloaded: true, binary: final.binary }
}
