import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const workflow = readFileSync('.github/workflows/ci.yml', 'utf8')

test('PR CI installs and builds on the four native runners', () => {
  for (const runner of ['ubuntu-22.04', 'windows-2025', 'macos-15-intel', 'macos-15']) {
    assert.match(workflow, new RegExp(`- ${runner.replaceAll('.', '\\.')}(?:\\s|$)`), runner)
  }
  assert.match(workflow, /run: npm ci(?:\s|$)/)
  assert.match(workflow, /run: npm run verify:install/)
  assert.match(workflow, /run: npm run typecheck/)
  assert.match(workflow, /run: npm run build:source/)
  assert.doesNotMatch(workflow, /npm ci --ignore-scripts|--omit=optional/)
  assert.doesNotMatch(workflow, /node_modules[^\n]*cache|cache[^\n]*node_modules/)
})

test('full tests run once on Linux while native verification runs for every matrix entry', () => {
  assert.match(workflow, /if: runner\.os == 'Linux'[\s\S]{0,160}run: npm test/)
  assert.match(workflow, /if: runner\.os == 'Linux'[\s\S]{0,160}run: npm run security:test/)
  assert.equal((workflow.match(/npm run verify:install/g) ?? []).length, 1)
  assert.equal((workflow.match(/run: npm test(?:\s|$)/g) ?? []).length, 1)
})

test('CI bootstraps and verifies the exact npm version before project installation', () => {
  const bootstrap = workflow.indexOf('npm install --global npm@10.9.4 --ignore-scripts')
  const nodeVersion = workflow.indexOf('node --version')
  const npmVersion = workflow.indexOf('npm --version')
  const install = workflow.indexOf('run: npm ci')
  assert.ok(bootstrap >= 0)
  assert.ok(nodeVersion > bootstrap)
  assert.ok(npmVersion > bootstrap)
  assert.ok(install > npmVersion)
})
