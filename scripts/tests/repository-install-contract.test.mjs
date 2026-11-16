import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { manifestErrors } from '../lib/install-contract.mjs'

function readRepositoryContract() {
  return {
    manifest: JSON.parse(readFileSync('package.json', 'utf8')),
    lock: JSON.parse(readFileSync('package-lock.json', 'utf8')),
    nvmrc: readFileSync('.nvmrc', 'utf8'),
    npmrc: readFileSync('.npmrc', 'utf8'),
  }
}

test('repository dependency contract is reproducible', () => {
  assert.deepEqual(manifestErrors(readRepositoryContract()), [])
})

test('the install lifecycle uses prebuilt native modules only', () => {
  const { manifest, lock } = readRepositoryContract()
  assert.equal(manifest.devDependencies['@electron/rebuild'], undefined)
  assert.equal(lock.packages['node_modules/node-gyp'], undefined)
  assert.equal(manifest.scripts.postinstall, 'node scripts/prepare-install.mjs')
  assert.doesNotMatch(JSON.stringify(manifest.scripts), /electron-rebuild|node-gyp/)
})
