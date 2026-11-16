import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { nativeProbeErrors, runNativeProbe } from '../lib/native-verification.mjs'
import { electronSecurityErrors } from '../lib/runtime-security.mjs'

test('rejects a probe result missing the platform Sharp optional package', () => {
  const errors = nativeProbeErrors({
    ok: false,
    platform: 'darwin',
    arch: 'arm64',
    electron: '44.11.3',
    node: '24.22.2',
    error: "Cannot find module '@img/sharp-darwin-arm64'",
  })
  assert.ok(errors.some(error => error.includes('@img/sharp-darwin-arm64')))
})

test('accepts a real functional result and preserves binding paths', () => {
  assert.deepEqual(nativeProbeErrors({
    ok: true,
    electron: '44.11.3',
    node: '24.22.2',
    chrome: '152.0.7977.169',
    platform: 'linux',
    arch: 'x64',
    sqliteValue: 42,
    sharp: { width: 2, height: 2, format: 'png' },
    sqliteBinding: '/app/node_modules/better-sqlite3/prebuilds/linux-x64.node',
    sharpBinding: '/app/node_modules/@img/sharp-linux-x64/lib/sharp-linux-x64.node',
  }), [])
})

test('package metadata cannot approve a stale Electron binary result', () => {
  const errors = electronSecurityErrors({
    electron: '44.9.3', node: '24.22.0', chrome: '152.0.0.0',
  }, '44.11.3')
  assert.ok(errors.some(error => error.includes('expected=44.11.3') && error.includes('actual=44.9.3')))
})

test('the native probe resolves Sharp through its exported sharp.node subpath', () => {
  const result = runNativeProbe({ executable: process.execPath, requireRoot: resolve('package.json') })
  assert.equal(result.ok, true, result.error)
  assert.match(result.sharpBinding, /@img\/sharp-[^/]+\/lib\/sharp-[^/]+\.node$/)
})
