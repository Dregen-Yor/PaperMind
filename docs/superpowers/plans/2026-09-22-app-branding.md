# PaperMind 应用名称与跨平台图标 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修正 PaperMind 的 macOS 应用名称及 Dock 图标大小，并补齐 Windows/Linux 的应用图标与安装入口。

**Architecture:** 保留现有 SVG 品牌母版，生成并提交各平台原生图标。macOS 开发启动使用项目专属的品牌化 Electron 副本，通过 Vite 插件自定义启动模块保持热重启能力；正式包使用 electron-builder 平台配置，运行时资源明确随包分发。Linux 安装器从 AppImage 提取图标并持久安装。

**Tech Stack:** Electron 44、electron-builder 24（当前安装 24.13.3）、vite-plugin-electron 0.28、TypeScript、Node ESM、Vitest、Node test runner、Bash；图标栅格化固定使用 sharp 0.34.5（当前依赖树已有此版本）。

**Spec:** [2026-09-22-app-branding-design.md](../specs/2026-09-22-app-branding-design.md)

## Global Constraints

- 默认保留现有书本与知识图谱品牌图案，不重新设计 logo。
- 不要把 macOS 的额外留白应用到网页内 logo。
- macOS：从矢量图生成 1024 × 1024 透明画布，图案主体先以约 82% 的画布宽高居中作为设计起点，再通过 Dock 对照确定最终比例。
- Windows：生成包含 16、24、32、48、64、128、256 像素表示的 ICO。
- Linux：输出 16、32、48、64、128、256、512 像素 PNG 图标目录。
- 普通开发直接使用已提交的图标产物，不应每次启动都依赖 macOS `iconutil` 或在线下载。
- 使用 `com.papermind.app.dev` 区分开发态身份；正式包保持 `com.papermind.app`。
- 平台专属 API 和 macOS 工具仅在对应平台分支调用。
- 保持现有用户数据目录行为：开发态 bundle ID 变化不应附带更改 `app.getPath('userData')`。
- 无需改 Vue 页面、数据库结构或 IPC 接口。
- 未运行的平台明确标为待验收。
- 不修改原版 `node_modules/electron/dist`；不手工修改或提交 `dist/`、`dist-electron/`、`release/`。
- 遵守仓库 Node `^20.19.0 || ^22.13.0 || >=24.0.0`、npm `>=10.0.0 <11`；不升级 Electron/builder/Vite。
- 当前用户只要求保存施工方案；本文复核后选择执行方式，才进入实施。设计文件状态仍写“草案”，本轮引用该文件编写计划不等于已完成代码修复。

## Review Focus

1. 项目目录含空格、非 ASCII 字符，或 shell 工作目录不在仓库：资源和自定义启动模块仍能正确加载（Task 2/3）。
2. Electron 升级、图标变化、缓存缺文件或上次签名失败：不复用失效副本，不留下成功标记（Task 2）。
3. 新增 macOS 品牌化逻辑进入 Windows/Linux：不能调用 plutil/codesign，不能覆盖正常 Electron 路径（Task 2/3）。
4. Linux AppImage 缺失图标或提取失败：不能覆盖已有正常入口；持久图标不能指向临时目录；含空格的 Exec 能启动（Task 4）。
5. 开发包 bundle ID 改变、热重启、Dock 固定项缓存：旧数据继续可读、无残留进程；系统名称需真实 UI 验证（Task 5，实机验收，不冒充单元测试覆盖）。

---

## 文件与职责

路径均相对仓库根目录。新增文件严格围绕本功能，不拆出通用品牌框架。

| 文件 | 操作与职责 |
| --- | --- |
| `assets/papermind-icon.svg`、`assets/papermind-icon.png` | 只读母版与原有页面资源 |
| `assets/icons/mac.png`、`mac.icns`、`win.ico`、`linux/{size}x{size}.png` | 新增可提交的操作系统图标 |
| `scripts/lib/icon-assets.mjs` | 栅格化、ICO/ICNS 封装及资源校验函数 |
| `scripts/generate-icons.mjs`、`scripts/check-icons.mjs` | 生成与只读检查 CLI |
| `scripts/lib/dev-branding.mjs` | macOS 副本准备、指纹和自定义启动模块 |
| `scripts/dev.mjs` | 调用副本准备并启动 Vite |
| `scripts/ensure-electron.mjs` | 仅确保原始 Electron 可执行文件完整，不再管理品牌缓存 |
| `vite.config.ts` | 使用自定义启动模块；排除 Node runner 的测试目录 |
| `electron/branding.ts` | 纯路径及平台身份函数，供主进程和测试复用 |
| `electron/main.ts` | 平台名称、窗口图标、开发 Dock 图标接入 |
| `scripts/install.sh` | Linux 图标持久安装与可测试的函数入口 |
| `package.json`、`package-lock.json` | 固定图标依赖、脚本、平台打包配置 |
| `scripts/tests/icon-assets.test.mjs`、`dev-branding.test.mjs`、`linux-install.test.mjs` | Node 自带 runner；无 Electron/DOM 依赖 |
| `src/tests/branding.test.ts` | Vitest：平台分支、路径与主进程接入 |
| `README.md`、`docs/testing/app-branding.md` | 维护说明与真实验收记录 |

**执行顺序：** Task 1 → Task 2 → Task 3 → Task 4 → Task 5。Task 2 和 Task 3 共用 Task 1 的资源命名；Task 4 必须使用 Task 3 确定的 Linux 身份。推荐 Native 顺序执行，避免同一组配置文件并行修改。

**实施前基线：** 读取仓库 `AGENTS.md`，检查 `git status --short`，记录 `npm run typecheck`、`npm test` 的基线。不覆盖当前未跟踪的 `2026-09-21-progressive-topic-index.md`。如使用隔离 checkout，在开始实施时按 using-git-worktrees 技能创建，并确认本文与设计文档均在执行工作区可读。

## Task 1：生成与校验平台图标

**Files:** 创建图标资源、`scripts/lib/icon-assets.mjs`、生成/检查 CLI、`scripts/tests/icon-assets.test.mjs`；修改 `package.json`、锁文件和 `vite.config.ts` 的 test.exclude。

**Interfaces:**

```js
// scripts/lib/icon-assets.mjs，ESM
export async function renderIcon(svg, size, scale) {} // Buffer|string → Promise<Buffer PNG>
export function encodeIco(images) {} // Array<{size:number,png:Buffer}> → Buffer
export function encodeIcns(images) {} // Array<{size:number,png:Buffer}> → Buffer
export async function generateIcons(root) {} // root:string → Promise<void>
export async function checkIcons(root) {} // root:string → Promise<void>，失败抛含文件名的 Error
```

只在维护图标时使用 sharp，不在 Electron 主进程导入该模块。ICNS 使用现代 PNG 表示，无需引入 iconutil 平台依赖。

- [ ] **Step 1：补充依赖与测试入口。** 实施时运行 `npm install --save-dev --save-exact sharp@0.34.5`，不在本轮计划编写时安装。`vite.config.ts` 的 `test.exclude` 增加 `'scripts/tests/**'`。先添加 `test:branding`，随着 Task 2/4 的测试文件落地扩展显式列表，避免 Windows shell 通配符差异。

```json
{
  "icons:generate": "node scripts/generate-icons.mjs",
  "icons:check": "node scripts/check-icons.mjs",
  "test:branding": "node --test scripts/tests/icon-assets.test.mjs"
}
```

最终 `test` 为 `vitest run && npm run test:branding`。新 CLI 用 `fileURLToPath(new URL('..', import.meta.url))` 定位根目录，不用 cwd。

- [ ] **Step 2：先写有真实解码的失败测试。** `icon-assets.test.mjs` 使用 `node:test`、`node:assert/strict`、sharp，包含下面主体；`svg` 从真实母版读取。

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import sharp from 'sharp'
import { renderIcon, encodeIco, encodeIcns } from '../lib/icon-assets.mjs'
const svg = await readFile(new URL('../../assets/papermind-icon.svg', import.meta.url))

test('mac icon has transparent padding and a centered opaque body', async () => {
  const png = await renderIcon(svg, 1024, 0.82)
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const alpha = (x, y) => data[(y * info.width + x) * 4 + 3]
  assert.equal(info.width, 1024)
  assert.equal(info.height, 1024)
  assert.equal(alpha(512, 0), 0)
  assert.equal(alpha(0, 512), 0)
  assert.equal(alpha(512, 512), 255)
  const body = []
  for (let x = 0; x < 1024; x++) if (alpha(x, 512) > 0) body.push(x)
  assert.ok(body[0] >= 91 && body[0] <= 93)
  assert.ok(Math.abs(body[0] - (1023 - body.at(-1))) <= 1)
})

test('ICO stores every requested resolution with valid PNG offsets', async () => {
  const sizes = [16, 24, 32, 48, 64, 128, 256]
  const images = await Promise.all(sizes.map(async size => ({ size, png: await renderIcon(svg, size, 1) })))
  const ico = encodeIco(images)
  assert.equal(ico.readUInt16LE(2), 1)
  assert.equal(ico.readUInt16LE(4), sizes.length)
  for (let i = 0; i < sizes.length; i++) {
    const entry = 6 + i * 16
    const offset = ico.readUInt32LE(entry + 12)
    const length = ico.readUInt32LE(entry + 8)
    const metadata = await sharp(ico.subarray(offset, offset + length)).metadata()
    assert.equal(metadata.width, sizes[i])
    assert.equal(metadata.height, sizes[i])
    assert.equal(ico[entry], sizes[i] === 256 ? 0 : sizes[i])
  }
})

test('ICNS contains full-size PNG representations', async () => {
  const sizes = [16, 32, 64, 128, 256, 512, 1024]
  const images = await Promise.all(sizes.map(async size => ({ size, png: await renderIcon(svg, size, 0.82) })))
  const icns = encodeIcns(images)
  assert.equal(icns.toString('ascii', 0, 4), 'icns')
  assert.equal(icns.readUInt32BE(4), icns.length)
  let offset = 8
  const decoded = []
  while (offset < icns.length) {
    const length = icns.readUInt32BE(offset + 4)
    assert.ok(length > 8 && offset + length <= icns.length)
    decoded.push((await sharp(icns.subarray(offset + 8, offset + length)).metadata()).width)
    offset += length
  }
  assert.equal(offset, icns.length)
  assert.deepEqual(decoded, sizes)
})
```

- [ ] **Step 3：执行 RED。** `npm run test:branding`；预期失败原因是模块/导出不存在，记录输出。不能将 sharp 未安装当作业务 RED。

- [ ] **Step 4：实现生成核心。** SVG 直接按目标尺寸栅格化，不能先用旧 512 PNG 放大。

```js
import sharp from 'sharp'

export async function renderIcon(svg, size, scale) {
  const inner = Math.round(size * scale)
  const png = await sharp(svg, { density: 288 }).resize(inner, inner).png().toBuffer()
  return sharp({ create: { width: size, height: size, channels: 4, background: '#00000000' } })
    .composite([{ input: png, left: Math.floor((size - inner) / 2), top: Math.floor((size - inner) / 2) }])
    .png().toBuffer()
}

export function encodeIco(images) {
  const header = Buffer.alloc(6 + 16 * images.length)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  let offset = header.length
  images.forEach(({ size, png }, i) => {
    const start = 6 + i * 16
    header[start] = size === 256 ? 0 : size
    header[start + 1] = size === 256 ? 0 : size
    header.writeUInt16LE(1, start + 4)
    header.writeUInt16LE(32, start + 6)
    header.writeUInt32LE(png.length, start + 8)
    header.writeUInt32LE(offset, start + 12)
    offset += png.length
  })
  return Buffer.concat([header, ...images.map(image => image.png)])
}

export function encodeIcns(images) {
  const types = new Map([[16, 'icp4'], [32, 'icp5'], [64, 'icp6'], [128, 'ic07'], [256, 'ic08'], [512, 'ic09'], [1024, 'ic10']])
  const chunks = images.map(({ size, png }) => {
    const type = types.get(size)
    if (!type) throw new Error(`Unsupported ICNS size: ${size}`)
    const header = Buffer.alloc(8)
    header.write(type, 0, 4, 'ascii')
    header.writeUInt32BE(png.length + 8, 4)
    return Buffer.concat([header, png])
  })
  const header = Buffer.alloc(8)
  header.write('icns')
  header.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4)
  return Buffer.concat([header, ...chunks])
}
```

- [ ] **Step 5：编写生成函数与 CLI。** `generateIcons` 读取母版，创建 `assets/icons/linux`；mac 尺寸 `[16,32,64,128,256,512,1024]` scale `0.82`；Windows 尺寸 `[16,24,32,48,64,128,256]` scale `1`；Linux 尺寸 `[16,32,48,64,128,256,512]` scale `1`。Windows/Linux 比例独立，不继承 mac 变量。

```js
const mac = await Promise.all([16, 32, 64, 128, 256, 512, 1024]
  .map(async size => ({ size, png: await renderIcon(svg, size, 0.82) })))
await writeFile(join(out, 'mac.png'), mac.at(-1).png)
await writeFile(join(out, 'mac.icns'), encodeIcns(mac))
const win = await Promise.all([16, 24, 32, 48, 64, 128, 256]
  .map(async size => ({ size, png: await renderIcon(svg, size, 1) })))
await writeFile(join(out, 'win.ico'), encodeIco(win))
for (const size of [16, 32, 48, 64, 128, 256, 512]) {
  await writeFile(join(out, 'linux', `${size}x${size}.png`), await renderIcon(svg, size, 1))
}
```

`generate-icons.mjs` 主体为 `await generateIcons(root)`；失败打印错误并设 `process.exitCode = 1`。这里的 `writeFile`/`readFile`/`mkdir` 从 `node:fs/promises` 导入，`join` 从 `node:path` 导入，`out = join(root, 'assets/icons')`，提前创建输出目录。

- [ ] **Step 6：实现只读校验。** `checkIcons` 逐个读取规定文件，用 sharp 解码 PNG；ICO 校验 header、七个 entry 的尺寸/边界并逐 PNG 解码；ICNS 校验总长、chunk 类型、边界及七个 PNG 尺寸。复用以上测试里的解析循环，把 assert 换成含文件名的 Error。所有 PNG 强制 `width === height === expectedSize && hasAlpha === true`；mac.png 额外检查四边中点 alpha=0。CLI 主体为 `await checkIcons(root)`。

给校验补一个临时目录回归，生成后损坏 ICO，再确认校验失败：

```js
const root = await mkdtemp(join(tmpdir(), 'pm-icons-'))
try {
  await mkdir(join(root, 'assets'), { recursive: true })
  await writeFile(join(root, 'assets/papermind-icon.svg'), svg)
  await generateIcons(root)
  await checkIcons(root)
  await writeFile(join(root, 'assets/icons/win.ico'), Buffer.from('invalid'))
  await assert.rejects(checkIcons(root), /win\.ico/)
} finally {
  await rm(root, { recursive: true, force: true })
}
```

在 test 文件增加对应 Node imports 和 `generateIcons/checkIcons` imports，放进独立 `test`。校验读取/解析异常统一包装为 `new Error(filename + ': ' + error.message)`。

- [ ] **Step 7：验证并提交。** 运行 `npm run icons:generate`、`npm run icons:check`、`npm run test:branding`。生成两遍对比资源哈希应一致；实机 ICNS 解码留给 Task 5。执行 `git diff --check` 后仅提交 Task 1 文件，提交名 `feat: generate native application icons`。

## Task 2：macOS 开发包身份与启动路径

**Files:** 新建 `scripts/lib/dev-branding.mjs`、`scripts/tests/dev-branding.test.mjs`；修改 `scripts/dev.mjs`、`scripts/ensure-electron.mjs`、`vite.config.ts`、`package.json` 测试列表。

**Interfaces:**

```js
export function brandingFingerprint({ version, arch, icon, revision }) {} // → string SHA256
export function launcherSource(executable) {} // → string ESM source
export function prepareDevBranding({ root, platform, arch, run }) {} // → string|null（launcher.mjs 绝对路径）
// root:string；platform 默认为 process.platform；arch 默认为 process.arch
// run 默认为 execFileSync；签名/修改失败必须抛出，不吞错。
```

缓存根固定为 `root/node_modules/.papermind-electron`；成功状态文件 `.branding.json`，副本 `PaperMind.app`，启动模块 `launcher.mjs`。`run(command,args)` 供测试替换，仅传数组参数，禁止拼 shell。

- [ ] **Step 1：写失败测试。** 新测试用临时 root 含空格/中文，从 fixture 创建 `node_modules/electron/package.json`、`dist/Electron.app/Contents/MacOS/Electron`、`Contents/Resources`、`Info.plist` 和 `assets/icons/mac.icns`。fixture 假二进制内容为 `'fake electron'`，package version 为 `'44.2.0'`，plist 内容为最小空字典。`run` 测试替身记录调用，不执行原生工具。

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { prepareDevBranding, brandingFingerprint } from '../lib/dev-branding.mjs'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'Paper Mind 中文-'))
  const files = {
    'node_modules/electron/package.json': '{"version":"44.2.0"}',
    'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron': 'fake electron',
    'node_modules/electron/dist/Electron.app/Contents/Info.plist': '<plist version="1.0"><dict/></plist>',
    'node_modules/electron/dist/Electron.app/Contents/Resources/electron.icns': 'old icon',
    'assets/icons/mac.icns': 'new icon',
  }
  for (const [name, value] of Object.entries(files)) {
    mkdirSync(join(root, name, '..'), { recursive: true })
    writeFileSync(join(root, name), value)
  }
  return root
}

test('non-macOS returns before touching filesystem or tools', () => {
  for (const platform of ['win32', 'linux']) {
    assert.equal(prepareDevBranding({ root: '/nonexistent', platform, arch: 'x64', run: () => assert.fail('native tool') }), null)
  }
})

test('launcher imports from a path with spaces and cache is reused', async () => {
  const root = fixture()
  const calls = []
  const args = { root, platform: 'darwin', arch: 'arm64', run: (...call) => calls.push(call) }
  try {
    const launcher = prepareDevBranding(args)
    const executable = (await import(pathToFileURL(launcher).href)).default
    assert.equal(executable, join(root, 'node_modules/.papermind-electron/PaperMind.app/Contents/MacOS/Electron'))
    assert.equal(readFileSync(executable, 'utf8'), 'fake electron')
    assert.ok(calls.some(([cmd]) => cmd === 'plutil'))
    const count = calls.length
    prepareDevBranding(args)
    assert.equal(calls.length, count)
    writeFileSync(join(root, 'assets/icons/mac.icns'), 'changed')
    prepareDevBranding(args)
    assert.ok(calls.length > count)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('failed signing never produces a successful cache marker', () => {
  const root = fixture()
  try {
    assert.throws(() => prepareDevBranding({ root, platform: 'darwin', arch: 'arm64', run: command => {
      if (command === 'codesign') throw new Error('sign failed')
    } }), /sign failed/)
    assert.equal(existsSync(join(root, 'node_modules/.papermind-electron/.branding.json')), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('all identity inputs invalidate fingerprints', () => {
  const base = { version: '44.2.0', arch: 'arm64', icon: Buffer.from('a'), revision: 1 }
  for (const patch of [{ version: '44.3.0' }, { arch: 'x64' }, { icon: Buffer.from('b') }, { revision: 2 }]) {
    assert.notEqual(brandingFingerprint(base), brandingFingerprint({ ...base, ...patch }))
  }
})
```

另在缓存复用测试中删除副本可执行文件、破坏 `.branding.json` 各一次，分别重新调用并验证可执行文件恢复。使用相同 fixture，原版二进制及 plist 前后字节不变。

- [ ] **Step 2：运行 RED。** `node --test scripts/tests/dev-branding.test.mjs`；预期模块不存在。

- [ ] **Step 3：实现指纹、缓存完整性检查与 staging 重建。** `revision = 1`；后续品牌逻辑修改必须递增。哈希输入如下：

```js
export function brandingFingerprint({ version, arch, icon, revision }) {
  return createHash('sha256').update(JSON.stringify({ version, arch, revision }))
    .update(icon).digest('hex')
}
export function launcherSource(executable) {
  return `export default ${JSON.stringify(executable)}\n`
}
```

`createHash` 从 `node:crypto` 导入。先 `if (platform !== 'darwin') return null`，再读取版本和 ICNS。有效缓存要求 marker fingerprint 一致，binary/plist/icon/launcher 均存在，已复制 icon 与输入 hash 一致，launcher 内容等于 `launcherSource(expectedExecutable)`；marker 解析失败按失效处理。修改品牌代码由 revision 失效，不每次递归 hash 整个 Electron bundle。

构建时在同一 `node_modules` 下 `mkdtempSync` 创建 staging，执行以下核心，所有路径均来自 root：

```js
cpSync(sourceApp, stagedApp, { recursive: true })
for (const [key, value] of Object.entries({
  CFBundleName: 'PaperMind',
  CFBundleDisplayName: 'PaperMind',
  CFBundleIdentifier: 'com.papermind.app.dev',
  CFBundleIconFile: 'papermind.icns',
})) run('plutil', ['-replace', key, '-string', value, join(stagedApp, 'Contents/Info.plist')])
copyFileSync(iconPath, join(stagedApp, 'Contents/Resources/papermind.icns'))
run('codesign', ['--force', '--sign', '-', '--preserve-metadata=entitlements', stagedApp])
run('codesign', ['--verify', '--deep', '--strict', stagedApp])
writeFileSync(join(staging, 'launcher.mjs'), launcherSource(finalExecutable))
writeFileSync(join(staging, '.branding.json'), JSON.stringify({ fingerprint }))
```

`sourceApp = join(root,'node_modules/electron/dist/Electron.app')`；`stagedApp = join(staging,'PaperMind.app')`；`iconPath = join(root,'assets/icons/mac.icns')`；`finalExecutable = join(cache,'PaperMind.app/Contents/MacOS/Electron')`。用 `try/finally` 清理 staging。先完成 staging 才切换 cache：旧 cache rename 为带 pid 的 backup，staging rename 为 cache；后者失败则恢复 backup。成功后删除 backup。不在本任务处理并发 dev 会话，README 明确同一工作区同时只运行一个 dev；不删除其他工作区副本。

保留 Electron helper 的原签名及 entitlements；不要递归删除签名。若真实 `codesign` 校验失败，保留工具输出并定位签名链，修复后复测，不能跳过校验或关闭系统安全机制。

- [ ] **Step 4：接入开发入口。** `dev.mjs` 从脚本位置获取 root，将原 macOS 拷贝与 override 逻辑替换为：

```js
const root = fileURLToPath(new URL('..', import.meta.url))
const environment = { ...process.env }
delete environment.PAPERMIND_ELECTRON_LAUNCHER
const launcher = prepareDevBranding({ root, platform: process.platform, arch: process.arch })
if (launcher) environment.PAPERMIND_ELECTRON_LAUNCHER = pathToFileURL(launcher).href
const child = spawn(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), ...process.argv.slice(2)], {
  cwd: root,
  env: environment,
  stdio: 'inherit',
})
child.on('error', error => { console.error(error); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
```

导入 `fileURLToPath/pathToFileURL`、`join` 和 `prepareDevBranding`；不再设置 `ELECTRON_OVERRIDE_DIST_PATH`。改用 Node 启动 Vite，消除 Windows `.cmd` 和 shell 路径转义差异。标准退出/信号转发测试及实际热重启见 Task 5；如包装进程收到 SIGINT/SIGTERM，转发给 child 且等 child exit，避免直接 `process.exit()` 留孤儿。

`vite.config.ts` 主进程 onstart 替换为：

```ts
onstart(options) {
  const launcher = process.platform === 'darwin'
    ? process.env.PAPERMIND_ELECTRON_LAUNCHER
    : undefined
  return options.startup(undefined, undefined, launcher)
},
```

保留 preload 的 reload 和主进程 plugin 的 exit 管理。传入 file URL 可正确处理空格；不用 shell 拼执行命令。

- [ ] **Step 5：收敛 ensure-electron 职责。** 删除 `.electron-version` 与品牌副本清理、mkdir、writeFile 逻辑，保留原始下载、自愈和代理行为。root 同样从脚本位置解析；macOS 完整性检查改为 `dist/Electron.app/Contents/MacOS/Electron` 而不是只查 app 目录。

```js
const root = fileURLToPath(new URL('..', import.meta.url))
function distBinaryPath() {
  if (process.platform === 'darwin') return resolve(electronDir, 'dist/Electron.app/Contents/MacOS/Electron')
  if (process.platform === 'win32') return resolve(electronDir, 'dist/electron.exe')
  return resolve(electronDir, 'dist/electron')
}
```

删除不再使用的 fs imports 和 `electronVersion` 函数。确保 `package.json` 的 dev 顺序仍是 ensure → dev。

- [ ] **Step 6：运行 GREEN 并提交。** 扩展 `test:branding` 显式追加 `scripts/tests/dev-branding.test.mjs`；执行测试、`node --check scripts/dev.mjs`、`node --check scripts/ensure-electron.mjs`。macOS 用 `npm run dev` 实测一次，检查真实 plist/签名且改主进程代码触发热重启。提交名 `fix: brand macOS development app identity`，仅添加本任务文件。

## Task 3：运行时资源及正式包身份

**Files:** 新建 `electron/branding.ts`、`src/tests/branding.test.ts`；修改 `electron/main.ts`、`package.json`。

**Interfaces:**

```ts
export interface BrandingPaths {
  platform: NodeJS.Platform
  isPackaged: boolean
  appPath: string
  resourcesPath: string
}
export function getIconPath(paths: BrandingPaths): string
export interface BrandingApp {
  setName(name: string): void
  setAppUserModelId(id: string): void
  setDesktopName(name: string): void
}
export function configureIdentity(app: BrandingApp, platform: NodeJS.Platform): void
```

`appPath` 来自 `app.getAppPath()`，不是 cwd；打包资源根为 `resourcesPath/icons`。Linux 桌面身份固定 `com.papermind.app.desktop`，安装器和窗口身份一起使用。

- [ ] **Step 1：编写失败测试。** Vitest 文件设 `// @vitest-environment node`，不启动真实 Electron。

```ts
import { describe, it, expect, vi } from 'vitest'
import { join } from 'node:path'
import { getIconPath, configureIdentity } from '../../electron/branding'

describe('branding paths and identity', () => {
  it.each([
    ['darwin', 'mac.png'], ['win32', 'win.ico'], ['linux', 'linux/512x512.png'],
  ] as const)('resolves %s without shell cwd', (platform, file) => {
    expect(getIconPath({ platform, isPackaged: false, appPath: '/tmp/Paper Mind 中文', resourcesPath: '/unused' }))
      .toBe(join('/tmp/Paper Mind 中文', 'assets/icons', file))
    expect(getIconPath({ platform, isPackaged: true, appPath: '/archive/app.asar', resourcesPath: '/installed/resources' }))
      .toBe(join('/installed/resources', 'icons', file))
  })
  it.each(['darwin', 'linux', 'win32'] as const)('calls only %s identity APIs', platform => {
    const app = { setName: vi.fn(), setAppUserModelId: vi.fn(), setDesktopName: vi.fn() }
    configureIdentity(app, platform)
    expect(app.setName).toHaveBeenCalledWith('PaperMind')
    expect(app.setAppUserModelId).toHaveBeenCalledTimes(platform === 'win32' ? 1 : 0)
    expect(app.setDesktopName).toHaveBeenCalledTimes(platform === 'linux' ? 1 : 0)
    if (platform === 'win32') expect(app.setAppUserModelId).toHaveBeenCalledWith('com.papermind.app')
    if (platform === 'linux') expect(app.setDesktopName).toHaveBeenCalledWith('com.papermind.app.desktop')
  })
})
```

- [ ] **Step 2：运行 RED。** `npx vitest run src/tests/branding.test.ts`；预期 branding 模块不存在。

- [ ] **Step 3：实现纯函数。**

```ts
import { join } from 'node:path'
export function getIconPath(paths: BrandingPaths): string {
  const root = paths.isPackaged ? join(paths.resourcesPath, 'icons') : join(paths.appPath, 'assets/icons')
  const file = paths.platform === 'darwin' ? 'mac.png' : paths.platform === 'win32' ? 'win.ico' : 'linux/512x512.png'
  return join(root, file)
}
export function configureIdentity(app: BrandingApp, platform: NodeJS.Platform): void {
  app.setName('PaperMind')
  if (platform === 'win32') app.setAppUserModelId('com.papermind.app')
  if (platform === 'linux') app.setDesktopName('com.papermind.app.desktop')
}
```

同文件补入上面的两个 interface。不要调用 `app.setPath`，保留数据库的 `app.getPath('userData')` 行为。

- [ ] **Step 4：接入主进程。** 用 `configureIdentity(app, process.platform)` 替换原 `app.setName` 行，保持在 ready 前。`createWindow` 之前定义 `getRuntimeIconPath()`：

```ts
const getRuntimeIconPath = () => getIconPath({
  platform: process.platform,
  isPackaged: app.isPackaged,
  appPath: app.getAppPath(),
  resourcesPath: process.resourcesPath,
})
```

Windows/Linux 的 BrowserWindow 使用 `icon: process.platform === 'darwin' ? undefined : getRuntimeIconPath()`。开发 macOS 的 ready 分支改成 `process.platform === 'darwin' && !app.isPackaged`，通过统一路径加载 PNG；`isEmpty()` 时 `console.warn('[branding] Unable to load icon:', iconPath)`，否则 dock.setIcon。正式 macOS 不覆盖 bundle 图标。PNG 和 ICNS 都由 Task 1 的同一 scale 生成。

- [ ] **Step 5：增加主进程接入回归。** 同一测试文件补充下面接入用例；把 `afterEach` 加入 Vitest imports。mock 内只提供 main 实际用到的行为，避免加载 SQLite。

```ts
const state = vi.hoisted(() => ({
  packaged: false,
  empty: false,
  dockIcon: vi.fn(),
  window: vi.fn(),
}))
vi.mock('electron', () => ({
  app: {
    get isPackaged() { return state.packaged },
    setName: vi.fn(), setAppUserModelId: vi.fn(), setDesktopName: vi.fn(),
    getAppPath: () => '/tmp/Paper Mind 中文',
    commandLine: { appendSwitch: vi.fn() },
    whenReady: () => Promise.resolve(),
    on: vi.fn(), quit: vi.fn(),
    dock: { setIcon: state.dockIcon },
  },
  BrowserWindow: class {
    static getAllWindows() { return [] }
    constructor(options: unknown) { state.window(options) }
    webContents = { setWindowOpenHandler: vi.fn(), on: vi.fn() }
    loadURL = vi.fn()
    loadFile = vi.fn()
  },
  nativeImage: { createFromPath: () => ({ isEmpty: () => state.empty }) },
  shell: { openExternal: vi.fn() },
}))
vi.mock('../../electron/db', () => ({ initDb: vi.fn() }))
vi.mock('../../electron/ipc', () => ({ registerIpc: vi.fn() }))

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
afterEach(() => {
  Object.defineProperty(process, 'platform', platformDescriptor)
  vi.restoreAllMocks()
  vi.clearAllMocks()
  state.packaged = false
  state.empty = false
})

it('packaged macOS keeps bundle icon', async () => {
  vi.resetModules()
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'darwin' })
  state.packaged = true
  await import('../../electron/main')
  await vi.waitFor(() => expect(state.window).toHaveBeenCalledOnce())
  expect(state.dockIcon).not.toHaveBeenCalled()
})

it('missing development icon logs its path and still opens a window', async () => {
  vi.resetModules()
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'darwin' })
  state.empty = true
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  await import('../../electron/main')
  await vi.waitFor(() => expect(state.window).toHaveBeenCalledOnce())
  expect(warn).toHaveBeenCalledWith('[branding] Unable to load icon:', expect.stringContaining('mac.png'))
  expect(state.dockIcon).not.toHaveBeenCalled()
})
```

正式包路径测试由纯函数覆盖；这里 macOS 正式包不会调用 runtime 图标解析，Node 测试不需要伪造 Electron 的 `process.resourcesPath`。增加 Windows/Linux 主进程用例时，须显式定义并在 afterEach 恢复该属性。

- [ ] **Step 6：显式打包资源。** 合并以下内容，不覆盖原 files/asarUnpack/targets。Linux executableName 设为反向域名，以便 AppImage 生成的图标/桌面入口与运行身份一致；Task 5 从真实 AppImage 检查其桌面文件名，若 builder 24 不按该名称生成，修正生成入口使实际文件名一致，不能靠猜测放行。

```json
{
  "build": {
    "appId": "com.papermind.app",
    "extraResources": [{ "from": "assets/icons", "to": "icons", "filter": ["**/*"] }],
    "mac": { "target": "dmg", "icon": "assets/icons/mac.icns" },
    "win": { "target": "nsis", "icon": "assets/icons/win.ico" },
    "linux": {
      "target": "AppImage",
      "icon": "assets/icons/linux",
      "executableName": "com.papermind.app",
      "desktop": { "StartupWMClass": "com.papermind.app" }
    }
  }
}
```

build 脚本前置 `npm run icons:check &&`，失败时禁止继续打包，避免 builder 静默回退默认图标。不要修改 productName、appId 或用户数据路径来消除测试错误。

- [ ] **Step 7：运行 GREEN 并提交。** `npx vitest run src/tests/branding.test.ts`、`npm run icons:check`、`npm run typecheck`。提交名 `fix: configure application branding across platforms`。

## Task 4：Linux 安装入口持久化图标

**Files:** 修改 `scripts/install.sh`、`package.json` 的 test:branding；新增 `scripts/tests/linux-install.test.mjs`。

**Interfaces:** `install_linux_appimage IMAGE_PATH INSTALL_DIR DATA_DIR` Bash 函数；参数都是绝对路径。产物为 `INSTALL_DIR/papermind.AppImage`、`DATA_DIR/icons/hicolor/512x512/apps/com.papermind.app.png`、`DATA_DIR/applications/com.papermind.app.desktop`。源文件保留到安装成功，提取失败不覆盖旧应用/图标/desktop。

- [ ] **Step 1：把现有安装器变为可 source 的脚本。** 顶层保留函数定义，把联网、平台检测和实际安装包下载流程包进 `main()`，末尾使用：

```bash
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
```

原 `curl ... | bash` 调用不能失效：通过 stdin 执行时 `BASH_SOURCE[0]` 在 `set -u` 下可能未设置，实际 guard 写成 `if [[ "${BASH_SOURCE[0]:-}" == "$0" || -z "${BASH_SOURCE[0]:-}" ]]; then main "$@"; fi`。导入仅定义函数，不访问网络。保留 macOS 分支原行为，不顺手重构其安装逻辑。

- [ ] **Step 2：先写隔离安装测试。** Windows 跳过 Bash 实机测试并报告 skip；Linux/macOS 执行。测试创建 fake AppImage，通过自身脚本模拟 `--appimage-extract`，不依赖网络或 FUSE。

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
const installer = resolve('scripts/install.sh')

test('Linux install persists icon and quotes a spaced executable path', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'Paper Mind install-'))
  const image = join(root, 'input.AppImage')
  const bin = join(root, 'my bin')
  const data = join(root, 'my data')
  writeFileSync(image, '#!/usr/bin/env bash\nset -eu\ntest "$1" = --appimage-extract\nmkdir -p squashfs-root/usr/share/icons/hicolor/512x512/apps\nprintf "\\211PNG\\r\\n\\032\\nfixture" > squashfs-root/usr/share/icons/hicolor/512x512/apps/com.papermind.app.png\n', { mode: 0o755 })
  try {
    const result = spawnSync('bash', ['-c', 'source "$1"; install_linux_appimage "$2" "$3" "$4"', 'test', installer, image, bin, data], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    const desktop = readFileSync(join(data, 'applications/com.papermind.app.desktop'), 'utf8')
    assert.ok(desktop.includes(`Exec="${join(bin, 'papermind.AppImage')}" %U`))
    assert.ok(desktop.includes('Icon=com.papermind.app\n'))
    assert.ok(desktop.includes('StartupWMClass=com.papermind.app\n'))
    assert.ok(existsSync(join(data, 'icons/hicolor/512x512/apps/com.papermind.app.png')))
    assert.ok(!desktop.includes('squashfs-root'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})
```

另外创建失败 fake AppImage（脚本 `exit 7`），预先写旧 desktop 内容为 `'old entry'` 和旧图标 `'old icon'`，断言 result.status 非零且两文件字节未变；再用成功但不输出 PNG 的 fake 验证同一行为。两个用例代码沿用相同 temp/finally 结构，不访问真实用户目录。

- [ ] **Step 3：运行 RED。** `node --test scripts/tests/linux-install.test.mjs`；预期找不到函数。若 Windows 执行显示 skip，只能作为未运行记录，Linux CI 或实机必须实际执行。

- [ ] **Step 4：实现安装函数。** 放在 main 前，用 subshell 限定 trap 生命周期。提取全包不依赖已安装 FUSE。以下是核心流程：

```bash
install_linux_appimage() (
  set -euo pipefail
  local image="$1" install_dir="$2" data_dir="$3"
  local scratch icon exec_path
  scratch=$(mktemp -d)
  trap 'rm -rf "$scratch"' EXIT
  (cd "$scratch" && "$image" --appimage-extract >/dev/null)
  icon="$scratch/squashfs-root/usr/share/icons/hicolor/512x512/apps/com.papermind.app.png"
  if [[ ! -s "$icon" ]]; then
    printf 'PaperMind 安装失败：AppImage 缺少 512px 品牌图标\n' >&2
    exit 1
  fi
  exec_path="$install_dir/papermind.AppImage"
  # Desktop Exec 内部双引号参数的反斜杠需要同时满足 desktop 与 Exec 两层转义。
  exec_path=${exec_path//\\/\\\\\\\\}
  exec_path=${exec_path//\$/\\\\\$}
  exec_path=${exec_path//\`/\\\\\`}
  exec_path=${exec_path//\"/\\\\\"}
  exec_path=${exec_path//%/%%}
  cat > "$scratch/com.papermind.app.desktop" <<DESKTOP
[Desktop Entry]
Name=PaperMind
Exec="$exec_path" %U
Icon=com.papermind.app
StartupWMClass=com.papermind.app
Terminal=false
Type=Application
Categories=Education;Science;
Comment=本地学术论文阅读助手
DESKTOP
  mkdir -p "$install_dir" "$data_dir/applications" "$data_dir/icons/hicolor/512x512/apps"
  install -m 644 "$icon" "$data_dir/icons/hicolor/512x512/apps/com.papermind.app.png"
  install -m 755 "$image" "$install_dir/papermind.AppImage"
  install -m 644 "$scratch/com.papermind.app.desktop" "$data_dir/applications/com.papermind.app.desktop"
  # 仅删除本安装器创建的旧品牌入口，不能删除同名但指向其他程序的入口。
  local old="$data_dir/applications/papermind.desktop"
  if [[ -f "$old" ]] && grep -Fxq 'Name=PaperMind' "$old" && grep -Fq "$install_dir/papermind.AppImage" "$old"; then
    rm "$old"
  fi
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$data_dir/applications" || true
  fi
)
```

图标缺失或 extraction 失败时，上面所有 install 均尚未运行。错误打印原命令信息。普通下载 AppImage 先 `chmod +x` 再传入；main 的 Linux 分支替换为：

```bash
install_linux_appimage "/tmp/${FILENAME}" "${HOME}/.local/bin" "${XDG_DATA_HOME:-${HOME}/.local/share}"
rm "/tmp/${FILENAME}"
```

不要把新的图标路径写成构建机绝对路径。自定义 XDG_DATA_HOME 必须是绝对路径；若用户设置相对值，入口处报错退出，不在 cwd 安装。用户路径含换行无法安全进入 desktop 文件，函数入口明确拒绝并提示目录路径不能包含换行；空格、中文必须支持。

- [ ] **Step 5：补路径转义与迁移回归。** 在临时目录测试含 `%`、`$`、引号和反斜杠路径，检查生成的 Exec 符合 desktop 转义规则；在 Linux 安装 `desktop-file-validate` 可用时校验输出，在 Task 5 用 `gio launch` 实际验证包含空格路径。旧入口只在 Name/Exec 都匹配时删除，不相关文件必须保留。补失败用例到上述测试文件：

```js
for (const exitCode of [0, 7]) {
  test(`extraction exit ${exitCode} without an icon preserves existing installation`, { skip: process.platform === 'win32' }, () => {
    const root = mkdtempSync(join(tmpdir(), 'pm-install-fail-'))
    const image = join(root, 'input.AppImage')
    const bin = join(root, 'bin')
    const data = join(root, 'data')
    const oldDesktop = join(data, 'applications/com.papermind.app.desktop')
    const oldIcon = join(data, 'icons/hicolor/512x512/apps/com.papermind.app.png')
    const oldBinary = join(bin, 'papermind.AppImage')
    for (const [file, content] of [[oldDesktop, 'old entry'], [oldIcon, 'old icon'], [oldBinary, 'old binary']]) {
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, content)
    }
    writeFileSync(image, `#!/usr/bin/env bash\nexit ${exitCode}\n`, { mode: 0o755 })
    try {
      const result = spawnSync('bash', ['-c', 'source "$1"; install_linux_appimage "$2" "$3" "$4"', 'test', installer, image, bin, data], { encoding: 'utf8' })
      assert.notEqual(result.status, 0)
      assert.equal(readFileSync(oldDesktop, 'utf8'), 'old entry')
      assert.equal(readFileSync(oldIcon, 'utf8'), 'old icon')
      assert.equal(readFileSync(oldBinary, 'utf8'), 'old binary')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
}
```

旧入口迁移测试在成功 fixture 调用前写入以下文件，成功后断言 legacy 不存在，unrelated 原样保留：

```js
const legacy = join(data, 'applications/papermind.desktop')
const unrelated = join(data, 'applications/another.desktop')
mkdirSync(join(data, 'applications'), { recursive: true })
writeFileSync(legacy, `Name=PaperMind\nExec=${join(bin, 'papermind.AppImage')}\n`)
writeFileSync(unrelated, 'Name=Another\nExec=/usr/bin/another\n')
// 执行该 fixture 原有 spawnSync 后：
assert.equal(existsSync(legacy), false)
assert.equal(readFileSync(unrelated, 'utf8'), 'Name=Another\nExec=/usr/bin/another\n')
```

再单独用成功 fixture 写 `papermind.desktop` 为 `Name=Other`、`Exec=/other/app`，安装后断言该文件原样保留。所有路径均在临时 root 内，禁止使用真实 HOME 做测试。

- [ ] **Step 6：运行 GREEN 并提交。** `bash -n scripts/install.sh`、`node --test scripts/tests/linux-install.test.mjs`。`test:branding` 最终显式列出三个 `.test.mjs` 文件。提交名 `fix: install Linux desktop branding resources`。

## Task 5：全量验证、平台验收及维护文档

**Files:** 修改 `README.md`；新建 `docs/testing/app-branding.md`。若验收发现问题，在所属 Task 文件中修正，重跑对应测试，再做受影响的实机复测。

**Interfaces:** 消费所有前序任务产物；输出可核查的验收记录。不得用“单元测试通过”代替安装包和系统 UI 结果。

- [ ] **Step 1：执行一次完整自动检查。**

```bash
npm run icons:check
npm run typecheck
npm test
git diff --check
```

记录命令、平台、结果；失败先判断是否基线已有，不把失败隐藏在宽泛 skip 中。确认生成图标不需要网络、macOS 命令或应用启动。

- [ ] **Step 2：验证 macOS 开发态及用户数据。** 修改前后使用同一个用户环境，在调试器中读取 `app.getPath('userData')` 并记录实际路径；不记录数据库内容或 API Key。确认原论文、设置可读。分别验证首次启动、缓存复用、图标 hash 变化、缓存缺文件、主进程热重启、Ctrl-C 退出。执行：

```bash
npm run dev
plutil -p node_modules/.papermind-electron/PaperMind.app/Contents/Info.plist
codesign --verify --deep --strict node_modules/.papermind-electron/PaperMind.app
```

第二、三条在独立终端运行。用活动监视器确认退出后没有本工作区 Electron 残留，不终止其他应用进程。修改图标模拟测试后必须恢复正确产物。另从其他目录使用脚本绝对路径启动一次，验证 cwd 不影响运行。

- [ ] **Step 3：验证 macOS 安装包和视觉比例。** `npm run build` 后从新 DMG 安装/打开本次产物，核验包身份、Finder/Dock/Cmd-Tab 图标与悬浮名称。安装操作避免覆盖用户正在使用的旧包：可挂载后复制到临时验证目录启动，最终再测标准安装入口。保持 Dock 相同大小、鼠标离开或关闭放大，保存前后截图到测试记录引用位置。82% 是起点，若调整 scale，应同时重新生成 mac PNG/ICNS、更新 alpha 测试的边界范围，并重跑 Task 1。检查固定项在退出后仍显示正确图标。

- [ ] **Step 4：Windows 本机验收。** `npm run dev` 后确认无 plutil/codesign 调用；`npm run build` 生成 NSIS，检查安装器、exe、开始菜单、快捷方式和任务栏图标，启动两个窗口验证分组。开发通用 electron.exe 文件属性保留 Electron 可以记录为预期限制；正式 exe/快捷方式不能以此豁免。记录架构、系统版本、安装路径及结果。

- [ ] **Step 5：Linux 本机验收。** `npm run build` 后对本次 AppImage 执行：

```bash
# 在仓库根目录的 Bash 中运行；多个历史产物时先选定本次构建产物。
appimages=(release/*.AppImage)
test "${#appimages[@]}" -eq 1
appimage_path="$(pwd)/${appimages[0]}"
test -f "$appimage_path"
chmod +x "$appimage_path"
inspection_dir=$(mktemp -d)
(cd "$inspection_dir" && "$appimage_path" --appimage-extract)
```

记录本次产物路径与修改时间，禁止用旧产物代替。确认提取出的 icon 路径与 Task 4 一致，desktop 文件名为 `com.papermind.app.desktop`，Icon 和 StartupWMClass 均匹配 `com.papermind.app`。若不一致，定位 builder 24 的生成结果并修正，验收不通过前不发布。

在隔离的 XDG_DATA_HOME/安装目录调用安装函数，运行 `desktop-file-validate` 与 `gio launch` 测实际入口，再验证用户正常菜单入口；记录 GNOME/KDE 和 X11/Wayland 条件。AppImage 在无 FUSE 环境提取也应成功；提取失败必须给明确失败信息。

- [ ] **Step 6：写维护说明与验收记录。** README 增加以下内容：

```markdown
### 应用名称与图标

品牌母版为 assets/papermind-icon.svg。修改后运行 npm run icons:generate，
再运行 npm run icons:check，并提交 assets/icons 内的平台产物。
普通 npm run dev 不会重新生成图标。

macOS 开发启动使用 node_modules/.papermind-electron/PaperMind.app，
资源或 Electron 版本改变时自动刷新。请使用 npm run dev；直接运行 vite
会绕过品牌副本准备。同一工作区同时仅运行一个开发实例。

系统图标仍旧时，先核对实际启动包和版本，再移除旧 Dock 固定项并重新固定。
不要把清空系统缓存或关闭安全机制作为常规步骤。

Windows 开发进程的 electron.exe 元数据仍可能显示 Electron；正式安装包
通过原生图标与品牌配置分发。Linux 安装入口依赖持久安装的 hicolor 图标。
```

验收记录至少使用此表，不提前填 PASS：

| 平台/架构/桌面环境 | 开发名称/图标 | 安装包名称/图标 | 退出/重启 | 数据路径 | 截图/命令证据 | 结果 |
| --- | --- | --- | --- | --- | --- | --- |

只有实际运行的行写通过；缺少设备写“未运行：缺少对应平台环境”。签名失败、Dock 名称仍旧、真实 desktop 不匹配写失败及复现命令，不掩盖为缓存问题。最后列出执行过的自动检查和构建命令；本地测试路径可脱敏，不提交用户数据。

- [ ] **Step 7：收尾复核与提交。** 自查 spec 每条验收都有记录；所有产品修改完成后运行要求的检查，新增改动只重跑受影响项。提交 `docs: document application branding verification`。只提交明确的源码/图标/测试/文档；不提交 node_modules、安装包、用户截图中敏感信息或数据库。

## 计划自审与交付边界

- 设计覆盖：平台资源 → Task 1；开发身份与路径/缓存/签名 → Task 2；运行时与包资源 → Task 3；Linux 自建入口 → Task 4；系统缓存、视觉比例、已有数据及全平台实测 → Task 5。
- 跨任务接口已固定：mac.png/mac.icns/win.ico/linux PNG；launcher 导出绝对可执行路径；PAPERMIND_ELECTRON_LAUNCHER 传 file URL；Linux 身份 com.papermind.app；正式 appId 保持原值。
- 当前调研没有运行新的生成脚本、启动器或安装包。builder 24 的实际 AppImage 文件布局、macOS ad-hoc 重签及最终 Dock 名称是执行阶段必须用真实产物确认的门槛。
- 本计划仅处理应用品牌相关内容，不升级打包框架，不修改下载镜像策略、数据库 API、Vue 页面或 GPU 参数。
- 施工方案落盘后先由用户评审并选择执行方式：Native（推荐，五项任务接口紧密、配置文件重叠）或 Subagent-driven（每项独立实施和复核，成本更高）。
