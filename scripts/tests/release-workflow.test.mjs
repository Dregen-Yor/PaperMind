import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const workflow = readFileSync('.github/workflows/release.yml', 'utf8')

test('release builds all four targets on their native runners', () => {
  const expected = [
    ['ubuntu-22.04', '--linux --x64'],
    ['macos-15-intel', '--mac --x64'],
    ['macos-15', '--mac --arm64'],
    ['windows-2025', '--win --x64'],
  ]
  for (const [runner, args] of expected) {
    const pattern = new RegExp(`os: ${runner.replaceAll('.', '\\.')}[\\s\\S]{0,180}eb_args: ${args.replaceAll('-', '\\-')}`)
    assert.match(workflow, pattern, `${runner} ${args}`)
  }
})

test('every release matrix entry uses the reproducible install and source build contract', () => {
  for (const command of [
    'npm install --global npm@10.9.4 --ignore-scripts',
    'npm ci',
    'npm run verify:install',
    'git diff --exit-code -- package.json package-lock.json .npmrc',
    'npm run build:source',
    'npm exec electron-builder -- ${{ matrix.eb_args }}',
  ]) assert.ok(workflow.includes(command), command)
  assert.doesNotMatch(workflow, /python3 make g\+\+|npm ci --ignore-scripts|--omit=optional/)
})

test('release artifacts include per-file and aggregate SHA-256 checksums', () => {
  assert.match(workflow, /shasum -a 256 "\$ASSET" > "\$ASSET\.sha256"/)
  assert.match(workflow, /sha256sum \* \| tee checksums-sha256\.txt/)
  assert.match(workflow, /files: artifacts\/\*/)
})
