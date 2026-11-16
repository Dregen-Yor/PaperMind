import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
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

test('npm lifecycle options prevent Sharp from selecting its source build', () => {
  const npmrc = readFileSync('.npmrc', 'utf8')
  const nodeOptions = npmrc.match(/^node-options=(.+)$/m)?.[1]
  assert.ok(nodeOptions, '.npmrc must define lifecycle node-options')
  const check = spawnSync(process.execPath, ['node_modules/sharp/install/check.js'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_OPTIONS: nodeOptions,
      SHARP_IGNORE_GLOBAL_LIBVIPS: '',
      SHARP_FORCE_GLOBAL_LIBVIPS: '1',
      npm_config_build_from_source: 'true',
    },
  })
  assert.equal(check.status, 0, check.stderr || check.stdout)
})

test('the default test command runs every install contract suite', () => {
  const { manifest } = readRepositoryContract()
  assert.match(manifest.scripts.test, /npm run test:install/)
  for (const file of [
    'scripts/tests/install-contract.test.mjs',
    'scripts/tests/electron-install.test.mjs',
    'scripts/tests/native-verification.test.mjs',
    'scripts/tests/repository-install-contract.test.mjs',
  ]) assert.ok(manifest.scripts['test:install'].includes(file), file)
})
