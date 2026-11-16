import test from 'node:test'
import assert from 'node:assert/strict'
import { nodeSecurityErrors, electronSecurityErrors } from '../lib/runtime-security.mjs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, mkdirSync, symlinkSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import afterPack from '../check-packaged-runtime.cjs'

test('rejects every pre-patch supported runtime and unknown release lines', () => {
  for (const version of ['22.23.3', '24.20.0', '24.22.0', '26.11.1', '26.12.0', '20.20.0', '25.9.0', '27.0.0', '24.22.1-rc.1', 'garbage']) {
    assert.ok(nodeSecurityErrors(version).length, version)
  }
  for (const version of ['22.23.4', '24.22.1', '26.12.1']) {
    assert.deepEqual(nodeSecurityErrors(version), [], version)
  }
})

test('patched Node alone cannot approve an Electron distribution', () => {
  assert.ok(electronSecurityErrors({ node: '24.22.1', electron: '44.9.3' }, '44.9.3').length)
  assert.ok(electronSecurityErrors({ node: '24.20.0', electron: '44.2.0' }, '44.2.0').some(error => error.includes('24.22.1')))
})

test('approval binds Electron, embedded Node, Chromium and official evidence', () => {
  const policy = { approvedElectron: [{
    electron: '44.11.3',
    node: '24.22.2',
    chromium: '152.0.7977.169',
    evidence: 'https://releases.electronjs.org/release/v44.11.3',
  }] }
  assert.deepEqual(electronSecurityErrors({
    electron: '44.11.3', node: '24.22.2', chrome: '152.0.7977.169',
  }, '44.11.3', policy), [])
  assert.ok(electronSecurityErrors({
    electron: '44.11.3', node: '24.22.2', chrome: '152.0.7977.168',
  }, '44.11.3', policy).some(error => error.includes('Chromium')))
})

test('the executable gate rejects a plain Node binary even when its Node version is patched', () => {
  const script = fileURLToPath(new URL('../check-runtime.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [script, '--executable', process.execPath], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /实际 Electron/)
  assert.match(result.stderr, /禁止打包与发布/)
})

test('builder afterPack checks the actual executable before writing an approval receipt', { skip: process.platform === 'win32' }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'papermind-package-security-'))
  try {
    mkdirSync(join(directory, 'resources'))
    symlinkSync(process.execPath, join(directory, 'test-app'))
    await assert.rejects(afterPack({ appOutDir: directory, electronPlatformName: 'linux',
      packager: { appInfo: { productFilename: 'TestApp' }, config: { linux: { executableName: 'test-app' } } },
    }), /实际 Electron/)
    assert.equal(existsSync(join(directory, 'resources', 'runtime-security.json')), false)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('builder afterPack requires native bindings to come from app.asar.unpacked', () => {
  const resources = mkdtempSync(join(tmpdir(), 'papermind-native-unpack-'))
  const sqliteRelative = join('node_modules', 'better-sqlite3', 'prebuilds', 'linux-x64.node')
  const sharpRelative = join('node_modules', '@img', 'sharp-linux-x64', 'lib', 'sharp-linux-x64.node')
  try {
    for (const relative of [sqliteRelative, sharpRelative]) {
      const physical = join(resources, 'app.asar.unpacked', relative)
      mkdirSync(dirname(physical), { recursive: true })
      writeFileSync(physical, 'native fixture')
    }
    const workingNativeResult = {
      ok: true,
      electron: '44.11.3',
      node: '24.22.2',
      chrome: '152.0.7977.169',
      platform: 'linux',
      arch: 'x64',
      sqliteValue: 42,
      sharp: { width: 2, height: 2, format: 'png' },
      sqliteBinding: join(resources, 'app.asar', sqliteRelative),
      sharpBinding: join(resources, 'app.asar', sharpRelative),
    }
    assert.deepEqual(afterPack.packagedNativeErrors(workingNativeResult, resources), [])
    rmSync(join(resources, 'app.asar.unpacked', sharpRelative))
    assert.ok(afterPack.packagedNativeErrors(workingNativeResult, resources)
      .some(error => /Sharp.*app\.asar\.unpacked/.test(error)))
  } finally { rmSync(resources, { recursive: true, force: true }) }
})
