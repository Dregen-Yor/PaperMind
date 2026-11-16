import test from 'node:test'
import assert from 'node:assert/strict'
import { manifestErrors, toolchainErrors } from '../lib/install-contract.mjs'

const supported = {
  node: '24.22.1',
  npm: '10.9.4',
  platform: 'darwin',
  arch: 'arm64',
  release: '24.6.0',
  glibc: null,
}

test('accepts the exact toolchain on a supported platform', () => {
  assert.deepEqual(toolchainErrors(supported), [])
})

test('reports exact expected and actual toolchain versions', () => {
  const errors = toolchainErrors({ ...supported, node: '24.22.2', npm: '11.0.0' })
  assert.ok(errors.some(error => error.includes('expected=24.22.1') && error.includes('actual=24.22.2')))
  assert.ok(errors.some(error => error.includes('expected=10.9.4') && error.includes('actual=11.0.0')))
})

test('rejects unsupported platforms and Linux glibc below 2.34', () => {
  assert.ok(toolchainErrors({ ...supported, platform: 'linux', arch: 'arm64', glibc: '2.39' }).length)
  assert.ok(toolchainErrors({ ...supported, platform: 'linux', arch: 'x64', glibc: '2.33' })
    .some(error => error.includes('glibc') && error.includes('2.34')))
})

test('Windows 10 x64 is best-effort instead of a hard platform failure', () => {
  assert.deepEqual(toolchainErrors({ ...supported, platform: 'win32', arch: 'x64', release: '10.0.19045' }), [])
})

const validManifest = {
  packageManager: 'npm@10.9.4',
  engines: { node: '24.22.1', npm: '10.9.4' },
  dependencies: { sharp: '0.34.5' },
  devDependencies: { electron: '44.11.3' },
  scripts: { postinstall: 'node scripts/prepare-install.mjs' },
}

const validLock = {
  lockfileVersion: 3,
  packages: {
    '': { dependencies: { sharp: '0.34.5' }, devDependencies: { electron: '44.11.3' } },
    'node_modules/sharp': {
      version: '0.34.5',
      integrity: 'sha512-fixture',
      funding: { url: 'https://opencollective.example/sharp' },
    },
    'node_modules/electron': { version: '44.11.3', integrity: 'sha512-fixture' },
    'node_modules/@img/sharp-darwin-arm64': { version: '0.34.5', integrity: 'sha512-fixture', optional: true },
    'node_modules/@img/sharp-darwin-x64': { version: '0.34.5', integrity: 'sha512-fixture', optional: true },
    'node_modules/@img/sharp-linux-x64': { version: '0.34.5', integrity: 'sha512-fixture', optional: true },
    'node_modules/@img/sharp-win32-x64': { version: '0.34.5', integrity: 'sha512-fixture', optional: true },
  },
}

test('accepts an exact registry-neutral manifest and lock', () => {
  assert.deepEqual(manifestErrors({
    manifest: validManifest,
    lock: validLock,
    nvmrc: '24.22.1\n',
    npmrc: 'engine-strict=true\nsave-exact=true\nomit-lockfile-registry-resolved=true\ninclude=optional\n',
  }), [])
})

test('rejects ranges, registry URLs, native rebuilds, node-gyp and missing optional targets', () => {
  const manifest = structuredClone(validManifest)
  manifest.dependencies.sharp = '^0.34.5'
  manifest.devDependencies['@electron/rebuild'] = '4.2.0'
  manifest.scripts.postinstall = 'electron-rebuild'
  const lock = structuredClone(validLock)
  lock.packages['node_modules/sharp'].resolved = 'https://registry.example.test/sharp.tgz'
  lock.packages['node_modules/node-gyp'] = { version: '12.4.0' }
  delete lock.packages['node_modules/@img/sharp-win32-x64']

  const errors = manifestErrors({ manifest, lock, nvmrc: '24.22.1', npmrc: '' })
  for (const expected of [
    'exact version',
    'registry URL',
    '@electron/rebuild',
    'electron-rebuild',
    'node-gyp',
    '@img/sharp-win32-x64',
  ]) {
    assert.ok(errors.some(error => error.includes(expected)), expected)
  }
})
