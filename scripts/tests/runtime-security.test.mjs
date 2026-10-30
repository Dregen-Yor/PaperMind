import test from 'node:test'
import assert from 'node:assert/strict'
import { nodeSecurityErrors, electronSecurityErrors } from '../lib/runtime-security.mjs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, mkdirSync, symlinkSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

test('approval binds the actual Electron and Node pair and published evidence', () => {
  const policy = { approvedElectron: [{ electron: '99.0.0', node: '24.22.1', evidence: 'https://releases.electronjs.org/release/v99.0.0' }] }
  assert.deepEqual(electronSecurityErrors({ node: '24.22.1', electron: '99.0.0' }, '99.0.0', policy), [])
  assert.ok(electronSecurityErrors({ node: '24.22.0', electron: '99.0.0' }, '99.0.0', policy).length)
  assert.ok(electronSecurityErrors({ node: '24.22.1', electron: '99.0.0' }, '98.0.0', policy).length)
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
