import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { nodeSecurityErrors, electronSecurityErrors } from './lib/runtime-security.mjs'

const require = createRequire(import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const baseline = readFileSync(new URL('../.nvmrc', import.meta.url), 'utf8').trim()
let errors = nodeSecurityErrors(process.versions.node)
let inspectedVersions
if (process.versions.node.split('.')[0] !== baseline.split('.')[0]) errors.push(`项目开发与构建统一使用 Node.js ${baseline} 所在 LTS 分支`)

if (process.argv.includes('--electron') || process.argv.includes('--executable')) {
  const position = process.argv.indexOf('--executable')
  const executable = position < 0 ? require('electron') : process.argv[position + 1]
  if (!executable) throw new Error('缺少待检查的 Electron 可执行文件')
  const probe = spawnSync(executable, ['-p', 'JSON.stringify(process.versions)'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024,
  })
  if (probe.status !== 0 || probe.error) errors.push('无法读取实际 Electron 可执行程序的运行时版本')
  else {
    try {
      const versions = JSON.parse(probe.stdout.trim())
      inspectedVersions = versions
      console.log(JSON.stringify({ electron: versions.electron, node: versions.node, chrome: versions.chrome }))
      errors.push(...electronSecurityErrors(versions, manifest.devDependencies.electron))
    } catch { errors.push('Electron 运行时未返回有效版本信息') }
  }
}

if (errors.length) {
  console.error(errors.join('\n'))
  process.exitCode = 1
} else {
  const receiptPosition = process.argv.indexOf('--receipt')
  if (receiptPosition >= 0) {
    if (!inspectedVersions || !process.argv[receiptPosition + 1]) throw new Error('运行时证明缺少安装包检查或输出路径')
    const policy = readFileSync(new URL('../config/runtime-security.json', import.meta.url))
    writeFileSync(process.argv[receiptPosition + 1], JSON.stringify({ versions: inspectedVersions,
      buildNode: process.versions.node, policySha256: createHash('sha256').update(policy).digest('hex'),
    }, null, 2) + '\n')
  }
  console.log(`Node.js ${process.versions.node} 安全基线检查通过`)
}
