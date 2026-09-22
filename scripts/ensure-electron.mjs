// dev 前置自愈：确保原始 Electron 二进制就绪。
//
// 背景：Electron 44 起 npm 包不再自带 postinstall 下载二进制（registry 元数据
// scripts 为 null），npm install 后 dist/ 与 path.txt 会缺失。此脚本在 dev 前补齐：
// 二进制缺失自动下载。macOS 品牌化副本（含 Electron 版本指纹）由
// scripts/lib/dev-branding.mjs 独立管理，这里不再涉及。
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const electronDir = resolve(root, 'node_modules/electron')

// 启动 Electron 用的是平台专属路径，此脚本与其保持同平台口径
function distBinaryPath() {
  if (process.platform === 'darwin') return resolve(electronDir, 'dist/Electron.app/Contents/MacOS/Electron')
  if (process.platform === 'win32') return resolve(electronDir, 'dist/electron.exe')
  return resolve(electronDir, 'dist/electron')
}

function binaryReady() {
  return existsSync(resolve(electronDir, 'path.txt')) && existsSync(distBinaryPath())
}

function download() {
  // @electron/get 认 ELECTRON_MIRROR；无代理环境时回落 npmmirror（境内直连可用）
  const env = { ...process.env }
  if (!env.ELECTRON_MIRROR && !env.HTTPS_PROXY && !env.HTTP_PROXY) {
    env.ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
  }
  console.log('[ensure-electron] Electron 二进制缺失，开始下载（首次需要几分钟）…')
  const result = spawnSync(process.execPath, [resolve(electronDir, 'install.js')], {
    stdio: 'inherit',
    cwd: electronDir,
    env,
  })
  if (result.status !== 0 || !binaryReady()) {
    console.error(
      '[ensure-electron] Electron 二进制下载失败。\n' +
        '  请配置代理（或 ELECTRON_MIRROR）后重试，例如：\n' +
        '  HTTP_PROXY=http://127.0.0.1:7897 HTTPS_PROXY=http://127.0.0.1:7897 npm run dev',
    )
    process.exit(1)
  }
  console.log('[ensure-electron] Electron 二进制下载完成。')
}

// ---- 主流程 ----

if (!existsSync(electronDir)) {
  console.error('[ensure-electron] 未找到 node_modules/electron，请先运行 npm install。')
  process.exit(1)
}

if (!binaryReady()) download()
