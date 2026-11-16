import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const readme = readFileSync('README.md', 'utf8')
const agents = readFileSync('AGENTS.md', 'utf8')
const claude = readFileSync('CLAUDE.md', 'utf8')

function section(document, start, end) {
  const startIndex = document.indexOf(start)
  assert.notEqual(startIndex, -1, `missing section: ${start}`)
  const endIndex = document.indexOf(end, startIndex + start.length)
  assert.notEqual(endIndex, -1, `missing section boundary: ${end}`)
  return document.slice(startIndex, endIndex)
}

test('README gives ordinary users only npm ci', () => {
  const quickStart = section(readme, '## 快速开始', '## 配置模型')
  assert.match(quickStart, /Node\.js `24\.22\.1`/)
  assert.match(quickStart, /npm `10\.9\.4`/)
  assert.match(quickStart, /npm ci/)
  assert.doesNotMatch(quickStart, /npm install(?:\s|$)/m)
})

test('npm install appears only in the maintainer upgrade section', () => {
  const maintainer = section(readme, '### 维护者升级依赖', '## License')
  assert.match(maintainer, /npm install --save-exact <package>@<explicit-version>/)
  assert.equal((readme.match(/npm install/g) ?? []).length, 1)
})

test('README documents the support matrix and unsigned warnings', () => {
  for (const text of ['Windows 11 x64', 'macOS 13+', 'glibc 2.34', 'Gatekeeper', 'SmartScreen']) {
    assert.match(readme, new RegExp(text))
  }
})

test('agent documentation uses the locked install contract', () => {
  for (const [name, document] of [['AGENTS.md', agents], ['CLAUDE.md', claude]]) {
    assert.match(document, /Node `24\.22\.1`/m, name)
    assert.match(document, /npm `10\.9\.4`/m, name)
    assert.match(document, /npm ci/m, name)
    assert.doesNotMatch(document, /npm install(?:\s|$)|electron-rebuild|npm run rebuild/m, name)
  }
})
