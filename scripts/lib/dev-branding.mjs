// macOS 开发态品牌化：在 node_modules/.papermind-electron 下维护一份带
// PaperMind 身份（名称 / bundle ID / 图标）的 ad-hoc 签名副本，并把自定义启动
// 模块交给 vite-plugin-electron 作为 Electron 入口。原版 node_modules/electron/dist
// 始终只读；副本用指纹（Electron 版本 + 架构 + 图标 + revision）判断是否需要重建。
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// 品牌逻辑（plist 键、签名参数、缓存布局）变更时必须递增，让旧副本失效
const REVISION = 2
const CACHE_DIR = 'node_modules/.papermind-electron'
const APP_DIR = 'PaperMind.app'
const LAUNCHER = 'launcher.mjs'
const MARKER = '.branding.json'
const NATIVE_ICON = 'Contents/Resources/papermind.icns'
const IDENTITY = {
  CFBundleName: 'PaperMind',
  CFBundleDisplayName: 'PaperMind',
  CFBundleIdentifier: 'com.papermind.app.dev',
  CFBundleIconFile: 'papermind.icns',
}

export function brandingFingerprint({ version, arch, icon, revision }) {
  return createHash('sha256').update(JSON.stringify({ version, arch, revision }))
    .update(icon).digest('hex')
}

export function launcherSource(executable) {
  return `export default ${JSON.stringify(executable)}\n`
}

// → launcher.mjs 绝对路径；非 darwin 返回 null（不碰文件系统、不调原生工具）
export function prepareDevBranding({ root, platform = process.platform, arch = process.arch, run = execFileSync }) {
  if (platform !== 'darwin') return null

  const cache = join(root, CACHE_DIR)
  const launcher = join(cache, LAUNCHER)
  const executable = join(cache, APP_DIR, 'Contents/MacOS/Electron')
  const icon = readFileSync(join(root, 'assets/icons/mac.icns'))
  const version = JSON.parse(readFileSync(join(root, 'node_modules/electron/package.json'), 'utf8')).version
  const fingerprint = brandingFingerprint({ version, arch, icon, revision: REVISION })

  if (!cacheIsUsable({ cache, fingerprint, icon, launcher, executable })) {
    buildCache({ root, cache, fingerprint, icon, launcher, executable, run })
  }
  return launcher
}

// 有效 = marker 指纹一致 + 副本四件套齐全 + 已复制图标与当前输入同源 + launcher 内容符合期望
function cacheIsUsable({ cache, fingerprint, icon, launcher, executable }) {
  const app = join(cache, APP_DIR)
  const copiedIcon = join(app, NATIVE_ICON)
  if (!existsSync(executable) || !existsSync(join(app, 'Contents/Info.plist')) || !existsSync(copiedIcon) || !existsSync(launcher)) {
    return false
  }
  try {
    if (JSON.parse(readFileSync(join(cache, MARKER), 'utf8'))?.fingerprint !== fingerprint) return false
    if (sha256(readFileSync(copiedIcon)) !== sha256(icon)) return false
    return readFileSync(launcher, 'utf8') === launcherSource(executable)
  } catch {
    // Marker 损坏、副本不可读都按失效处理，交给 staging 重建
    return false
  }
}

// 先在同一 node_modules 下的 staging 里完成拷贝、改名、换图标、重签，全部成功才切换 cache
function buildCache({ root, cache, fingerprint, icon, launcher, executable, run }) {
  const staging = mkdtempSync(join(root, 'node_modules/.papermind-electron-'))
  const stagedApp = join(staging, APP_DIR)
  try {
    // verbatimSymlinks：cpSync 默认把相对软链改写成指向源码树的绝对路径，framework 根目录
    // 的 Versions/Current 软链一旦被改写，codesign 会报 "unsealed contents in the root
    // directory of an embedded framework"，副本也会反过来依赖原版 dist
    cpSync(join(root, 'node_modules/electron/dist/Electron.app'), stagedApp, { recursive: true, verbatimSymlinks: true })
    for (const [key, value] of Object.entries(IDENTITY)) {
      run('plutil', ['-replace', key, '-string', value, join(stagedApp, 'Contents/Info.plist')])
    }
    copyFileSync(join(root, 'assets/icons/mac.icns'), join(stagedApp, NATIVE_ICON))
    signAdHoc(stagedApp, run)
    run('codesign', ['--verify', '--deep', '--strict', stagedApp])
    writeFileSync(join(staging, LAUNCHER), launcherSource(executable))
    writeFileSync(join(staging, MARKER), JSON.stringify({ fingerprint }))
    swapCache(staging, cache)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

function swapCache(staging, cache) {
  // pid 后缀避免与上一轮构建或其它会话的 backup 冲突；同 pid 的残留只可能是本进程上一次中断
  const backup = `${cache}.${process.pid}.bak`
  rmSync(backup, { recursive: true, force: true })
  const hadCache = existsSync(cache)
  if (hadCache) renameSync(cache, backup)
  try {
    renameSync(staging, cache)
  } catch (error) {
    if (hadCache) renameSync(backup, cache)
    throw error
  }
  if (hadCache) rmSync(backup, { recursive: true, force: true })
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

// 官方 dist 的嵌套代码（helper、framework）是 linker-signed、没有资源封印，`--verify --deep
// --strict` 因此必然失败；这里由内向外用同一条命令重签，最后签外层 bundle，让资源封印覆盖重签
// 后的嵌套代码。嵌套项额外请求保留出厂标识符，但实测官方 dist 的嵌套项都是 linker-signed，
// codesign 文档明确「previous binary 带 linker-signed 标记时 --preserve-metadata 整个选项被忽略」，
// 因此其实际标识符仍来自各自的 Info.plist（com.github.Electron.helper 等），与未加 identifier 时一致。
// 不递归删除签名，也不改动 helper 的 entitlements。
function signAdHoc(stagedApp, run) {
  const frameworks = join(stagedApp, 'Contents/Frameworks')
  if (existsSync(frameworks)) {
    for (const nested of readdirSync(frameworks)) {
      run('codesign', ['--force', '--sign', '-', '--preserve-metadata=entitlements,identifier', join(frameworks, nested)])
    }
  }
  run('codesign', ['--force', '--sign', '-', '--preserve-metadata=entitlements', stagedApp])
}
