import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { electronBinaryPath, prepareElectron } from '../lib/electron-install.mjs'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'papermind-electron-install-'))
  const electronDir = join(root, 'node_modules/electron')
  mkdirSync(electronDir, { recursive: true })
  writeFileSync(join(electronDir, 'package.json'), JSON.stringify({ version: '44.11.3' }))
  writeFileSync(join(electronDir, 'install.js'), '// fixture')
  return root
}

function writeReadyFixture(root, version = '44.11.3') {
  const electronDir = join(root, 'node_modules/electron')
  mkdirSync(electronDir, { recursive: true })
  writeFileSync(join(electronDir, 'package.json'), JSON.stringify({ version }))
  writeFileSync(join(electronDir, 'path.txt'), 'fixture')
  const binary = electronBinaryPath(electronDir)
  mkdirSync(dirname(binary), { recursive: true })
  writeFileSync(binary, 'fixture')
}

test('missing binary invokes install.js without adding a private mirror', () => {
  const root = fixture()
  const calls = []
  try {
    const result = prepareElectron({
      root,
      env: {},
      runInstall: call => {
        calls.push(call)
        writeReadyFixture(root)
        return { status: 0 }
      },
    })
    assert.equal(result.downloaded, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].env.ELECTRON_MIRROR, undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an explicit ELECTRON_MIRROR is passed through unchanged', () => {
  const root = fixture()
  const calls = []
  try {
    prepareElectron({
      root,
      env: { ELECTRON_MIRROR: 'https://mirror.example/electron/' },
      runInstall: call => {
        calls.push(call)
        writeReadyFixture(root)
        return { status: 0 }
      },
    })
    assert.equal(calls[0].env.ELECTRON_MIRROR, 'https://mirror.example/electron/')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('missing package and failed download mention npm ci and network configuration', () => {
  const emptyRoot = mkdtempSync(join(tmpdir(), 'papermind-electron-empty-'))
  const root = fixture()
  try {
    assert.throws(() => prepareElectron({ root: emptyRoot, env: {}, runInstall: () => assert.fail() }), /npm ci/)
    assert.throws(() => prepareElectron({ root, env: {}, runInstall: () => ({ status: 1 }) }), /proxy|ELECTRON_MIRROR/)
  } finally {
    rmSync(emptyRoot, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

test('download preparation contains no private mirror fallback', () => {
  const source = [
    readFileSync(resolve('scripts/ensure-electron.mjs'), 'utf8'),
    readFileSync(resolve('scripts/lib/electron-install.mjs'), 'utf8'),
  ].join('\n')
  assert.doesNotMatch(source, /npmmirror\.com|registry\.npmmirror\.com/)
  assert.doesNotMatch(source, /ELECTRON_MIRROR\s*=/)
})
