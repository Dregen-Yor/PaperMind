import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { prepareDevBranding } from './lib/dev-branding.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const environment = { ...process.env }
delete environment.PAPERMIND_ELECTRON_LAUNCHER
// macOS：准备品牌化副本（名称 / bundle ID / 图标），把启动模块交给 vite 插件
const launcher = prepareDevBranding({ root, platform: process.platform, arch: process.arch })
if (launcher) environment.PAPERMIND_ELECTRON_LAUNCHER = pathToFileURL(launcher).href

// 用 Node 直接跑 vite.js，避免 Windows .cmd 与 shell 路径转义；信号转发给 child 后再退出
const child = spawn(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), ...process.argv.slice(2)], {
  cwd: root,
  env: environment,
  stdio: 'inherit',
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}
child.on('error', error => { console.error(error); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
