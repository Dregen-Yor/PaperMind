# 跨平台可复现安装与构建 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 PaperMind 在四个官方平台上通过精确工具链执行一次 `npm ci` 即完成依赖安装、Electron 准备和原生模块验证，并用 registry 中立的 lockfile、PR CI、原生发布 CI 和 README 固化该契约。

**Architecture:** 把安装规则集中到纯函数模块 `scripts/lib/install-contract.mjs`，由小型 CLI 分别执行工具链、manifest 和原生验证；`postinstall` 只负责准备官方 Electron 二进制并运行真实 Electron smoke test，不再重建原生模块。CI 与 release 都调用同一组项目命令，打包后的 Electron 再通过 afterPack 对批准运行时、SQLite、Sharp 和 ASAR 解包路径做第二次验证。

**Tech Stack:** Node.js 24.22.1、npm 10.9.4、Electron 44.11.3、Node `node:test`、Vitest、GitHub Actions、electron-builder、better-sqlite3 13.0.3、Sharp 0.34.5。

**Spec:** `docs/superpowers/specs/2026-11-16-reproducible-cross-platform-install-design.md`

## Global Constraints

- 主机工具链只能是 Node.js `24.22.1` 和 npm `10.9.4`；不匹配必须失败并打印 expected/actual。
- Electron 必须是 `44.11.3`，且只批准 Electron `44.11.3` / Node `24.22.2` / Chromium `152.0.7977.169`。
- 官方平台为 Windows 11 x64、macOS 13+ x64、macOS 13+ arm64、Linux x64（Ubuntu 22.04+ 或 glibc 2.34+）；Windows 10 x64仅尽力支持。
- 普通用户唯一依赖安装命令是 `npm ci`；不得要求 Python、C/C++ 编译器、Visual Studio、Xcode CLI、GCC 或 Make。
- `dependencies` 与 `devDependencies` 全部使用精确版本；移除 `@electron/rebuild` 和所有 `electron-rebuild` 调用。
- lockfile 必须保留 integrity、optional platform packages，不得保存 npm registry 主机或缺少 optional dependencies。
- Electron 默认从官方源下载；只尊重用户显式提供的 `ELECTRON_MIRROR`，不得自动切换私人镜像。
- 每个平台在本机架构独立执行 `npm ci`；不缓存或跨平台复用 `node_modules`。
- 当前发布产物允许未签名，但 README 必须明确 Gatekeeper 与 SmartScreen 限制。
- 不修改 Docling、UI、数据库和业务行为；不推送、合并或发布。

## Review Focus

- 机器装有全局 libvips 时，Sharp 的 install hook 可能尝试源码构建；lockfile 必须不含 `node-gyp`，让该路径在调用编译器前失败，默认预编译路径则正常通过。
- 用户使用自定义 npm registry 重新生成 lockfile 时，不得把镜像域名写入仓库；repository contract test 必须扫描全部 `resolved` 和 URL 字段。
- 用户或 CI 省略 optional dependencies 时，Sharp 必须报告缺失的具体 `@img/sharp-<platform>-<arch>` 包，不能给模糊的 native load 错误。
- `node_modules/electron/package.json` 正确但 `dist` 是旧版本或残缺下载时，必须读取真实二进制版本并失败，不能只信 manifest。
- 打包产物可能包含原生模块但没有正确 ASAR 解包；afterPack 必须让打包后的 Electron 实际加载模块，并确认 `.node` 路径位于 `app.asar.unpacked`。

---

### Task 1: 建立纯安装契约与工具链验证

**Files:**
- Create: `scripts/lib/install-contract.mjs`
- Create: `scripts/verify-toolchain.mjs`
- Create: `scripts/verify-manifest.mjs`
- Create: `scripts/tests/install-contract.test.mjs`

**Interfaces:**
- Consumes: `package.json`、`package-lock.json`、`.nvmrc`、`.npmrc` 的文本或解析结果；Node `process`/`os` 暴露的平台信息。
- Produces: `toolchainErrors(actual): string[]`、`manifestErrors(input): string[]`、`readActualNpmVersion(): string`、`readActualToolchain(): object`，供 CLI、postinstall 和后续 repository contract test 共用。

- [ ] **Step 1: 写工具链失败测试。**

在 `scripts/tests/install-contract.test.mjs` 先定义期望 API：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { manifestErrors, toolchainErrors } from '../lib/install-contract.mjs'

const supported = {
  node: '24.22.1', npm: '10.9.4', platform: 'darwin', arch: 'arm64',
  release: '24.6.0', glibc: null,
}

test('accepts the exact toolchain on a supported platform', () => {
  assert.deepEqual(toolchainErrors(supported), [])
})

test('reports exact expected and actual toolchain versions', () => {
  const errors = toolchainErrors({ ...supported, node: '24.22.2', npm: '11.0.0' })
  assert.ok(errors.some(error => error.includes('expected=24.22.1') && error.includes('actual=24.22.2')))
  assert.ok(errors.some(error => error.includes('expected=10.9.4') && error.includes('actual=11.0.0')))
})

test('rejects unsupported platforms and Linux glibc below 2.34', () => {
  assert.ok(toolchainErrors({ ...supported, platform: 'linux', arch: 'arm64', glibc: '2.39' }).length)
  assert.ok(toolchainErrors({ ...supported, platform: 'linux', arch: 'x64', glibc: '2.33' })
    .some(error => error.includes('glibc') && error.includes('2.34')))
})

test('Windows 10 x64 is best-effort instead of a hard platform failure', () => {
  assert.deepEqual(toolchainErrors({ ...supported, platform: 'win32', arch: 'x64', release: '10.0.19045' }), [])
})
```

- [ ] **Step 2: 运行测试并确认 RED。**

Run: `node --test scripts/tests/install-contract.test.mjs`

Expected: FAIL，原因是 `scripts/lib/install-contract.mjs` 不存在；不能是测试语法错误。

- [ ] **Step 3: 实现精确工具链和平台判断。**

`scripts/lib/install-contract.mjs` 导出以下常量和纯函数：

```js
export const EXPECTED_NODE = '24.22.1'
export const EXPECTED_NPM = '10.9.4'
export const EXPECTED_ELECTRON = '44.11.3'

export function toolchainErrors({ node, npm, platform, arch, release, glibc }) {
  const errors = []
  if (node !== EXPECTED_NODE) errors.push(`Node.js version mismatch: expected=${EXPECTED_NODE} actual=${node}`)
  if (npm !== EXPECTED_NPM) errors.push(`npm version mismatch: expected=${EXPECTED_NPM} actual=${npm}`)
  if (platform === 'linux') {
    if (arch !== 'x64') errors.push(`Unsupported platform: platform=${platform} arch=${arch}`)
    if (!glibc || compareVersions(glibc, '2.34') < 0) errors.push(`Unsupported glibc: expected=>=2.34 actual=${glibc ?? 'unknown'}`)
  } else if (platform === 'darwin') {
    if (!['x64', 'arm64'].includes(arch) || Number(release.split('.')[0]) < 22) {
      errors.push(`Unsupported platform: platform=${platform} arch=${arch} release=${release}`)
    }
  } else if (platform !== 'win32' || arch !== 'x64') {
    errors.push(`Unsupported platform: platform=${platform} arch=${arch}`)
  }
  return errors
}
```

同文件实现 `readActualNpmVersion()`：优先解析 `npm_config_user_agent` 中的 `npm/<version>`，直接运行 CLI 时用 `execFileSync(npmExecutable, ['--version'])` 回退；Windows 使用 `npm.cmd`，其他平台使用 `npm`。glibc 使用 `process.report.getReport().header.glibcVersionRuntime`，macOS 最低版本用 Darwin major 22 判断。Windows build `< 22000` 只向 stderr 输出 best-effort warning，不加入 errors。

- [ ] **Step 4: 增加 manifest 纯函数测试。**

在同一测试文件加入：

```js
const validManifest = {
  packageManager: 'npm@10.9.4',
  engines: { node: '24.22.1', npm: '10.9.4' },
  dependencies: { sharp: '0.34.5' },
  devDependencies: { electron: '44.11.3' },
  scripts: { postinstall: 'node scripts/prepare-install.mjs' },
}
const validLock = {
  lockfileVersion: 3,
  packages: {
    '': { dependencies: { sharp: '0.34.5' }, devDependencies: { electron: '44.11.3' } },
    'node_modules/sharp': { version: '0.34.5', integrity: 'sha512-fixture' },
    'node_modules/electron': { version: '44.11.3', integrity: 'sha512-fixture' },
    'node_modules/@img/sharp-darwin-arm64': { version: '0.34.5', integrity: 'sha512-fixture', optional: true },
    'node_modules/@img/sharp-darwin-x64': { version: '0.34.5', integrity: 'sha512-fixture', optional: true },
    'node_modules/@img/sharp-linux-x64': { version: '0.34.5', integrity: 'sha512-fixture', optional: true },
    'node_modules/@img/sharp-win32-x64': { version: '0.34.5', integrity: 'sha512-fixture', optional: true },
  },
}

test('accepts an exact registry-neutral manifest and lock', () => {
  assert.deepEqual(manifestErrors({ manifest: validManifest, lock: validLock,
    nvmrc: '24.22.1\n', npmrc: 'engine-strict=true\nsave-exact=true\nomit-lockfile-registry-resolved=true\ninclude=optional\n' }), [])
})

test('rejects ranges, registry URLs, native rebuilds, node-gyp and missing optional targets', () => {
  const manifest = structuredClone(validManifest)
  manifest.dependencies.sharp = '^0.34.5'
  manifest.devDependencies['@electron/rebuild'] = '4.2.0'
  manifest.scripts.postinstall = 'electron-rebuild'
  const lock = structuredClone(validLock)
  lock.packages['node_modules/sharp'].resolved = 'https://registry.example.test/sharp.tgz'
  lock.packages['node_modules/node-gyp'] = { version: '12.4.0' }
  delete lock.packages['node_modules/@img/sharp-win32-x64']
  const errors = manifestErrors({ manifest, lock, nvmrc: '24.22.1', npmrc: '' })
  for (const expected of ['exact version', 'registry URL', '@electron/rebuild', 'electron-rebuild', 'node-gyp', '@img/sharp-win32-x64']) {
    assert.ok(errors.some(error => error.includes(expected)), expected)
  }
})
```

- [ ] **Step 5: 运行扩展测试并确认 RED。**

Run: `node --test scripts/tests/install-contract.test.mjs`

Expected: 新增 manifest 测试 FAIL，原因是 `manifestErrors` 尚未导出。

- [ ] **Step 6: 实现 manifest/lock 校验。**

`manifestErrors()` 必须：

```js
export function manifestErrors({ manifest, lock, nvmrc, npmrc }) {
  // 1. packageManager、engines、.nvmrc 精确匹配 EXPECTED_NODE/EXPECTED_NPM
  // 2. dependencies/devDependencies 每个值匹配 /^\d+\.\d+\.\d+$/
  // 3. electron === EXPECTED_ELECTRON；不存在 @electron/rebuild
  // 4. 所有 scripts 字符串不含 electron-rebuild/node-gyp，postinstall 精确为 node scripts/prepare-install.mjs
  // 5. npmrc 四项必须为 true/optional，且没有 registry=
  // 6. 递归扫描 lock：任何 http(s) URL 或 resolved 字段报 registry URL
  // 7. lock 根依赖与 manifest 完全一致，每个普通 package 有 version 和 integrity
  // 8. lock 不含 node_modules/node-gyp
  // 9. lock 含 @img/sharp-{darwin-arm64,darwin-x64,linux-x64,win32-x64}
  // 返回稳定、可断言的字符串数组，不修改输入
}
```

对 npm alias、Git、file、workspace、tag、预发布等非三段精确 semver 一律失败；本项目当前不需要这些例外。

- [ ] **Step 7: 实现两个 CLI。**

`readActualToolchain()` 收集真实版本/平台，`scripts/verify-toolchain.mjs` 调用它并打印：

```js
const actual = {
  node: process.versions.node,
  npm: readActualNpmVersion(),
  platform: process.platform,
  arch: process.arch,
  release: os.release(),
  glibc: process.report?.getReport()?.header?.glibcVersionRuntime ?? null,
}
```

有 errors 时逐行 `console.error()` 并设置 `process.exitCode = 1`；成功时输出一行 JSON 和 `Toolchain verification passed`。`scripts/verify-manifest.mjs` 从仓库根读取四个文件、调用 `manifestErrors()`，行为相同，成功输出 `Manifest verification passed`。

- [ ] **Step 8: 运行单元测试并提交。**

Run: `node --test scripts/tests/install-contract.test.mjs`

Expected: PASS；不要运行真实 `verify-toolchain`，因为在 Task 3 完成前仓库 manifest 仍不符合新契约。

```bash
git add scripts/lib/install-contract.mjs scripts/verify-toolchain.mjs scripts/verify-manifest.mjs scripts/tests/install-contract.test.mjs
git diff --cached --check
git commit -m "test(build): 定义可复现安装契约"
```

### Task 2: 批准 Electron 运行时并建立真实原生 smoke test

**Files:**
- Modify: `config/runtime-security.json`
- Modify: `scripts/lib/runtime-security.mjs`
- Modify: `scripts/lib/runtime-security.d.mts`
- Modify: `scripts/check-runtime.mjs`
- Modify: `scripts/tests/runtime-security.test.mjs`
- Create: `scripts/probes/native-smoke.cjs`
- Create: `scripts/lib/native-verification.mjs`
- Create: `scripts/verify-native.mjs`
- Create: `scripts/tests/native-verification.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `EXPECTED_ELECTRON`；项目 Electron 可执行文件；`PAPERMIND_REQUIRE_ROOT`（可选 package.json 绝对路径）。
- Produces: `electronSecurityErrors({electron,node,chrome}, expected, policy)` 精确元组校验；`runNativeProbe({executable, requireRoot})` 返回实际 runtime、SQLite 查询值、Sharp 元数据和 binding 路径，供源码安装与 afterPack 共用。

- [ ] **Step 1: 先写精确 Chromium 元组失败测试。**

在 `scripts/tests/runtime-security.test.mjs` 将批准测试改为：

```js
test('approval binds Electron, embedded Node, Chromium and official evidence', () => {
  const policy = { approvedElectron: [{
    electron: '44.11.3', node: '24.22.2', chromium: '152.0.7977.169',
    evidence: 'https://releases.electronjs.org/release/v44.11.3',
  }] }
  assert.deepEqual(electronSecurityErrors({ electron: '44.11.3', node: '24.22.2', chrome: '152.0.7977.169' }, '44.11.3', policy), [])
  assert.ok(electronSecurityErrors({ electron: '44.11.3', node: '24.22.2', chrome: '152.0.7977.168' }, '44.11.3', policy)
    .some(error => error.includes('Chromium')))
})
```

- [ ] **Step 2: 运行并确认 RED。**

Run: `node --test scripts/tests/runtime-security.test.mjs`

Expected: Chromium 不匹配用例 FAIL，因为现有策略没有校验 `chrome`。

- [ ] **Step 3: 扩展安全策略为完整元组。**

`config/runtime-security.json` 的批准项精确写为：

```json
{
  "electron": "44.11.3",
  "node": "24.22.2",
  "chromium": "152.0.7977.169",
  "evidence": "https://releases.electronjs.org/release/v44.11.3"
}
```

`electronSecurityErrors()` 要求 electron、node、`versions.chrome` 三者同时命中；错误分别包含 Electron、Node 或 Chromium 的 expected/actual。同步 `.d.mts` 类型，并让 `scripts/check-runtime.mjs` 输出与 receipt 都包含 `chrome`、`platform`、`arch`。

- [ ] **Step 4: 再跑安全策略测试确认 GREEN。**

Run: `node --test scripts/tests/runtime-security.test.mjs`

Expected: PASS，包括旧版本拒绝、普通 Node 二进制拒绝和 afterPack fail-closed。

- [ ] **Step 5: 写 native probe 解析与错误测试。**

`scripts/tests/native-verification.test.mjs` 使用临时 fake executable/fixture 测试以下行为：

```js
test('rejects a probe result missing the platform Sharp optional package', () => {
  const errors = nativeProbeErrors({
    ok: false, platform: 'darwin', arch: 'arm64', electron: '44.11.3', node: '24.22.2',
    error: "Cannot find module '@img/sharp-darwin-arm64'",
  })
  assert.ok(errors.some(error => error.includes('@img/sharp-darwin-arm64')))
})

test('accepts a real functional result and preserves binding paths', () => {
  assert.deepEqual(nativeProbeErrors({
    ok: true, electron: '44.11.3', node: '24.22.2', chrome: '152.0.7977.169',
    platform: 'linux', arch: 'x64', sqliteValue: 42,
    sharp: { width: 2, height: 2, format: 'png' },
    sqliteBinding: '/app/node_modules/better-sqlite3/prebuilds/linux-x64.node',
    sharpBinding: '/app/node_modules/@img/sharp-linux-x64/lib/sharp-linux-x64.node',
  }), [])
})

test('package metadata cannot approve a stale Electron binary result', () => {
  const errors = electronSecurityErrors({
    electron: '44.9.3', node: '24.22.0', chrome: '152.0.0.0',
  }, '44.11.3')
  assert.ok(errors.some(error => error.includes('expected=44.11.3') && error.includes('actual=44.9.3')))
})
```

- [ ] **Step 6: 运行并确认 RED。**

Run: `node --test scripts/tests/native-verification.test.mjs`

Expected: FAIL，原因是 `scripts/lib/native-verification.mjs` 不存在。

- [ ] **Step 7: 实现真实 Electron probe。**

`scripts/probes/native-smoke.cjs` 必须使用 `createRequire(PAPERMIND_REQUIRE_ROOT || <repo>/package.json)`，然后：

```js
const Database = projectRequire('better-sqlite3')
const sharp = projectRequire('sharp')
const db = new Database(':memory:')
db.exec('CREATE TABLE smoke (value INTEGER NOT NULL); INSERT INTO smoke VALUES (42)')
const sqliteValue = db.prepare('SELECT value FROM smoke').pluck().get()
db.close()
const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#336699ff' } }).png().toBuffer()
const metadata = await sharp(png).metadata()
```

输出唯一一行前缀 `PAPERMIND_NATIVE_SMOKE=` 的 JSON，字段为 `ok`、完整 runtime、`sqliteValue`、Sharp metadata、推导出的 better-sqlite3 prebuild 路径和 `projectRequire.resolve('@img/sharp-<platform>-<arch>/lib/sharp-<platform>-<arch>.node')`。捕获错误时仍输出同前缀 JSON，包含 platform/arch/runtime 和单行 error，不打印环境变量。

`scripts/lib/native-verification.mjs` 导出：

```js
export function nativeProbeErrors(result) { /* 功能值、字段与针对性 @img 诊断 */ }
export function runNativeProbe({ executable, requireRoot, timeout = 30_000 }) {
  // spawnSync(executable, [probePath], { env: {..., ELECTRON_RUN_AS_NODE:'1', PAPERMIND_REQUIRE_ROOT: requireRoot} })
  // 精确解析 PAPERMIND_NATIVE_SMOKE= 行；非零/超时/无 JSON 都返回稳定错误
}
```

`scripts/verify-native.mjs` 用 `createRequire()` 解析 Electron executable，运行 probe，再调用 `electronSecurityErrors()` 和 `nativeProbeErrors()`；失败输出 expected/actual，成功输出 JSON 与 `Native dependency verification passed`。

- [ ] **Step 8: 运行 native 单元测试并提交。**

Run: `node --test scripts/tests/native-verification.test.mjs scripts/tests/runtime-security.test.mjs`

Expected: PASS。此时不运行真实 `verify-native`，因为 Electron 仍是 44.9.3/本地可能更旧；Task 3 更新依赖后运行真实验证。

```bash
git add config/runtime-security.json scripts/lib/runtime-security.mjs scripts/lib/runtime-security.d.mts scripts/check-runtime.mjs scripts/tests/runtime-security.test.mjs scripts/probes/native-smoke.cjs scripts/lib/native-verification.mjs scripts/verify-native.mjs scripts/tests/native-verification.test.mjs
git diff --cached --check
git commit -m "feat(build): 校验 Electron 原生运行时"
```

### Task 3: 固定 manifest/lock 并替换安装生命周期

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.npmrc`
- Modify: `scripts/ensure-electron.mjs`
- Create: `scripts/lib/electron-install.mjs`
- Create: `scripts/prepare-install.mjs`
- Create: `scripts/tests/electron-install.test.mjs`
- Create: `scripts/tests/repository-install-contract.test.mjs`

**Interfaces:**
- Consumes: Tasks 1–2 的三个 verify CLI、`runNativeProbe()` 与精确版本常量。
- Produces: `npm ci` 的完整生命周期；`prepareElectron({root, env, runInstall})` 可测试 API；稳定 scripts：`verify:toolchain`、`verify:manifest`、`verify:native`、`verify:install`、`build:source`。

- [ ] **Step 1: 写 Electron 准备脚本的失败测试。**

`scripts/tests/electron-install.test.mjs` 用临时目录构造 Electron package，覆盖：

```js
test('missing binary invokes install.js without adding a private mirror', () => {
  const calls = []
  const result = prepareElectron({ root, env: {}, runInstall: call => { calls.push(call); writeReadyFixture(root, '44.11.3') } })
  assert.equal(result.downloaded, true)
  assert.equal(calls[0].env.ELECTRON_MIRROR, undefined)
})

test('an explicit ELECTRON_MIRROR is passed through unchanged', () => {
  const calls = []
  prepareElectron({ root, env: { ELECTRON_MIRROR: 'https://mirror.example/electron/' }, runInstall: call => calls.push(call) })
  assert.equal(calls[0].env.ELECTRON_MIRROR, 'https://mirror.example/electron/')
})

test('missing package and failed download mention npm ci and network configuration', () => {
  assert.throws(() => prepareElectron({ root: emptyRoot, env: {}, runInstall: () => assert.fail() }), /npm ci/)
  assert.throws(() => prepareElectron({ root, env: {}, runInstall: () => ({ status: 1 }) }), /proxy|ELECTRON_MIRROR/)
})
```

再加一个源码扫描断言：`scripts/ensure-electron.mjs` 和新 library 不含 `npmmirror.com`、`registry.npmmirror.com` 或任何自动 mirror 赋值。

- [ ] **Step 2: 运行并确认 RED。**

Run: `node --test scripts/tests/electron-install.test.mjs`

Expected: FAIL，原因是 `scripts/lib/electron-install.mjs` 不存在。

- [ ] **Step 3: 提取并实现 Electron 准备库。**

`scripts/lib/electron-install.mjs`：

```js
export function electronBinaryPath(electronDir, platform = process.platform) { /* 三平台路径 */ }
export function electronPackageState(root) { /* package version/path.txt/binary exists */ }
export function prepareElectron({ root, env = process.env, runInstall = defaultRun }) {
  // package 不存在或版本 != 44.11.3：抛 expected/actual + npm ci
  // path.txt 和 binary 都存在：返回 {downloaded:false,binary}
  // 缺失：只运行 node_modules/electron/install.js，env 原样复制，不补 mirror
  // 下载后再次检查；失败提示 proxy/TLS/ELECTRON_MIRROR，不输出代理值
}
```

`scripts/ensure-electron.mjs` 只解析仓库根、调用 `prepareElectron()` 并打印结果，不再包含下载策略。所有“请先运行 npm install”改成“请运行 npm ci”。

- [ ] **Step 4: 运行 Electron 准备测试确认 GREEN。**

Run: `node --test scripts/tests/electron-install.test.mjs`

Expected: PASS，且扫描证明没有私人 mirror。

- [ ] **Step 5: 写仓库契约集成测试并确认 RED。**

`scripts/tests/repository-install-contract.test.mjs` 读取真实四个文件并断言：

```js
test('repository dependency contract is reproducible', () => {
  assert.deepEqual(manifestErrors(readRepositoryContract()), [])
})

test('the install lifecycle uses prebuilt native modules only', () => {
  assert.equal(manifest.devDependencies['@electron/rebuild'], undefined)
  assert.equal(lock.packages['node_modules/node-gyp'], undefined)
  assert.equal(manifest.scripts.postinstall, 'node scripts/prepare-install.mjs')
  assert.doesNotMatch(JSON.stringify(manifest.scripts), /electron-rebuild|node-gyp/)
})
```

Run: `node --test scripts/tests/repository-install-contract.test.mjs`

Expected: FAIL，至少报告范围版本、旧 Electron、registry URL、缺 `.npmrc` 项、`@electron/rebuild` 和旧 postinstall。

- [ ] **Step 6: 精确更新 `package.json`。**

版本必须写为：

```json
{
  "packageManager": "npm@10.9.4",
  "engines": { "node": "24.22.1", "npm": "10.9.4" },
  "dependencies": {
    "@element-plus/icons-vue": "2.3.2",
    "@huggingface/transformers": "3.8.1",
    "better-sqlite3": "13.0.3",
    "dompurify": "3.4.12",
    "element-plus": "2.14.1",
    "katex": "0.18.1",
    "markdown-it": "14.3.0",
    "markdown-it-texmath": "1.0.0",
    "parse5": "8.0.1",
    "pdfjs-dist": "6.0.227",
    "pinia": "3.0.4",
    "sharp": "0.34.5",
    "vue": "3.5.35",
    "vue-router": "4.6.4"
  },
  "devDependencies": {
    "@types/better-sqlite3": "7.6.13",
    "@types/markdown-it": "14.1.2",
    "@types/node": "26.4.1",
    "@vitejs/plugin-vue": "5.2.4",
    "@vitest/ui": "4.1.8",
    "@vue/test-utils": "2.4.11",
    "electron": "44.11.3",
    "electron-builder": "24.13.3",
    "jsdom": "29.1.1",
    "tsx": "4.23.13",
    "typescript": "5.9.3",
    "vite": "6.4.3",
    "vite-plugin-electron": "0.28.8",
    "vite-plugin-electron-renderer": "0.14.7",
    "vitest": "4.1.8",
    "vue-tsc": "2.2.12"
  }
}
```

删除 `@electron/rebuild`、`rebuild`、`prerebuild`。scripts 调整为：

```json
{
  "verify:toolchain": "node scripts/verify-toolchain.mjs",
  "verify:manifest": "node scripts/verify-manifest.mjs",
  "verify:native": "node scripts/verify-native.mjs",
  "verify:install": "npm run verify:toolchain && npm run verify:manifest && npm run verify:native",
  "prepare:install": "node scripts/prepare-install.mjs",
  "preinstall": "node scripts/verify-toolchain.mjs",
  "postinstall": "node scripts/prepare-install.mjs",
  "predev": "npm run verify:install",
  "dev": "node scripts/dev.mjs",
  "build:source": "npm run icons:check && npm run typecheck && vite build",
  "prebuild": "npm run verify:install",
  "build": "npm run build:source && electron-builder"
}
```

保留既有 test/bench/preview/security scripts；其 pre-hooks 统一改成 `npm run verify:toolchain`，`security:runtime` 继续执行真实 Electron 安全检查。

- [ ] **Step 7: 更新 `.npmrc` 并生成 registry-neutral lockfile。**

`.npmrc` 精确为：

```ini
engine-strict=true
save-exact=true
omit-lockfile-registry-resolved=true
include=optional
```

在 Node `24.22.1` + npm `10.9.4` 环境下运行：

```bash
npm install --package-lock-only --ignore-scripts
```

Expected: lockfile 更新 Electron `44.11.3`，根版本与 manifest 全相等；所有 npm tarball `resolved` 域名消失；`@img` 四目标存在；删除 `@electron/rebuild` 和 `node-gyp`。如果 npm 仍写入 registry URL，先检查有效 npm 版本和 `.npmrc`，不得用文本替换伪造 lockfile。

- [ ] **Step 8: 实现 postinstall 编排。**

`scripts/prepare-install.mjs` 顺序执行：

```js
assertNoErrors(toolchainErrors(readActualToolchain()))
assertNoErrors(manifestErrors(readRepositoryContract()))
prepareElectron({ root })
const result = runNativeProbe({ executable: require('electron'), requireRoot: join(root, 'package.json') })
assertNoErrors([...electronSecurityErrors(result, '44.11.3'), ...nativeProbeErrors(result)])
```

错误原样保留根因并以 1 退出；成功打印 `Install preparation passed`。不要调用 npm、修改 manifest/lock，或设置 mirror。

- [ ] **Step 9: 用精确工具链做一次真实干净安装并确认 GREEN。**

先记录契约文件 hash，然后运行：

```bash
shasum package.json package-lock.json .npmrc > /tmp/papermind-contract-before.sha256
npm ci
shasum package.json package-lock.json .npmrc > /tmp/papermind-contract-after.sha256
diff -u /tmp/papermind-contract-before.sha256 /tmp/papermind-contract-after.sha256
npm run verify:install
node --test scripts/tests/install-contract.test.mjs scripts/tests/electron-install.test.mjs scripts/tests/native-verification.test.mjs scripts/tests/repository-install-contract.test.mjs scripts/tests/runtime-security.test.mjs
```

Expected: `npm ci` 不调用编译器；Electron 从官方源或用户已有显式镜像准备成功；实际元组、SQLite 查询和 Sharp 2×2 PNG 全部通过；hash 无差异；全部 Node tests PASS。

- [ ] **Step 10: 提交依赖生命周期。**

```bash
git add package.json package-lock.json .npmrc scripts/ensure-electron.mjs scripts/lib/electron-install.mjs scripts/prepare-install.mjs scripts/tests/electron-install.test.mjs scripts/tests/repository-install-contract.test.mjs
git diff --cached --check
git commit -m "build(deps): 固定跨平台安装依赖"
```

### Task 4: 用四平台 PR CI 验证真实安装

**Files:**
- Modify: `.github/workflows/ci.yml`
- Create: `scripts/tests/ci-workflow.test.mjs`
- Modify: `package.json`（将新测试加入 `test:architecture`）

**Interfaces:**
- Consumes: Task 3 的稳定 npm scripts。
- Produces: 四个平台相同的 `npm ci`/native/typecheck/build gate；Linux 额外运行完整测试。

- [ ] **Step 1: 写 CI workflow contract test。**

`scripts/tests/ci-workflow.test.mjs` 读取 YAML 文本并断言：

```js
test('PR CI installs and builds on the four native runners', () => {
  for (const runner of ['ubuntu-22.04', 'windows-2025', 'macos-15-intel', 'macos-15']) assert.match(workflow, new RegExp(runner))
  assert.match(workflow, /npm ci/)
  assert.match(workflow, /npm run verify:install/)
  assert.match(workflow, /npm run typecheck/)
  assert.match(workflow, /npm run build:source/)
  assert.doesNotMatch(workflow, /npm ci --ignore-scripts|--omit=optional/)
  assert.doesNotMatch(workflow, /node_modules[^\n]*cache|cache[^\n]*node_modules/)
})

test('full tests run once on Linux while native verification runs for every matrix entry', () => {
  assert.match(workflow, /if: runner\.os == 'Linux'[\s\S]*npm test/)
  assert.equal((workflow.match(/npm run verify:install/g) ?? []).length, 1)
})
```

再断言 npm bootstrap 为 `npm install --global npm@10.9.4 --ignore-scripts`，且在 bootstrap 之后运行 `npm --version` 和 `node --version`；这是工具链准备，不是项目依赖安装。

- [ ] **Step 2: 运行并确认 RED。**

Run: `node --test scripts/tests/ci-workflow.test.mjs`

Expected: FAIL，现有 workflow 只有 Ubuntu、使用 `--ignore-scripts` 且没有 native/build matrix。

- [ ] **Step 3: 将 CI 改成单一矩阵 job。**

`.github/workflows/ci.yml` 使用：

```yaml
strategy:
  fail-fast: false
  matrix:
    os: [ubuntu-22.04, windows-2025, macos-15-intel, macos-15]
runs-on: ${{ matrix.os }}
```

步骤固定为 checkout → setup-node `.nvmrc` + npm download cache → 安装 npm 10.9.4 → 打印/验证版本 → `npm ci` → `npm run verify:install` → `git diff --exit-code -- package.json package-lock.json .npmrc` → `npm run typecheck` → `npm run build:source`。仅 Linux 用 `if: runner.os == 'Linux'` 执行 `npm test` 和 `npm run security:test`。

不得安装编译器、使用 `--ignore-scripts`、上传 `node_modules` 或在 job 之间传递安装目录。`actions/setup-node cache: npm` 只缓存下载内容，允许保留。

- [ ] **Step 4: 把 workflow contract test 加入项目测试并确认 GREEN。**

在 `test:architecture` 的 `node --test` 文件列表加入 `scripts/tests/ci-workflow.test.mjs`。

Run: `node --test scripts/tests/ci-workflow.test.mjs && npm run typecheck`

Expected: workflow tests 与 TypeScript typecheck PASS。

- [ ] **Step 5: 提交 PR CI。**

```bash
git add .github/workflows/ci.yml scripts/tests/ci-workflow.test.mjs package.json
git diff --cached --check
git commit -m "ci: 验证四平台可复现安装"
```

### Task 5: 校验四平台安装包的运行时、原生模块与校验和

**Files:**
- Modify: `scripts/check-packaged-runtime.cjs`
- Modify: `scripts/tests/runtime-security.test.mjs`
- Modify: `.github/workflows/release.yml`
- Modify: `src/tests/releaseArtifact.test.ts`
- Create: `scripts/tests/release-workflow.test.mjs`
- Modify: `package.json`（加入 release workflow contract test）

**Interfaces:**
- Consumes: Task 2 的 native probe 与 Task 3 的 `verify:install`。
- Produces: afterPack receipt（runtime + native probe + policy SHA）；release 四目标产物与 `checksums-sha256.txt`。

- [ ] **Step 1: 写 afterPack 原生加载和 ASAR 路径失败测试。**

扩展 `scripts/tests/runtime-security.test.mjs`：直接把一个功能成功但 binding path 不在 `app.asar.unpacked` 的 probe result 交给纯校验函数，断言拒绝：

```js
const errors = afterPack.packagedNativeErrors({
  ...workingNativeResult,
  sqliteBinding: '/resources/app.asar/node_modules/better-sqlite3/prebuilds/linux-x64.node',
})
assert.ok(errors.some(error => /app\.asar\.unpacked/.test(error)))
```

为便于测试，`check-packaged-runtime.cjs` 默认导出 hook，同时将纯校验函数挂为 `module.exports.packagedNativeErrors`；测试不伪造安全通过，只直接覆盖 path 规则。

- [ ] **Step 2: 运行并确认 RED。**

Run: `node --test scripts/tests/runtime-security.test.mjs`

Expected: FAIL，因为当前 afterPack 只验证 Electron/Node，不检查 native result 或 ASAR 路径。

- [ ] **Step 3: 扩展 afterPack。**

`scripts/check-packaged-runtime.cjs` 先运行不带 receipt 的 `check-runtime --executable` 并解析其 runtime JSON，再用打包后的 executable 执行 `scripts/probes/native-smoke.cjs`，并设置：

```js
PAPERMIND_REQUIRE_ROOT = join(resources, 'app.asar', 'package.json')
ELECTRON_RUN_AS_NODE = '1'
```

解析 probe JSON 后执行 functional checks，并要求 `sqliteBinding`、`sharpBinding` 的规范化路径都包含 `${sep}app.asar.unpacked${sep}`。两项检查全部通过后，afterPack 自己读取 `config/runtime-security.json` 计算 SHA-256，并一次性写入包含 runtime、native smoke 摘要、build Node、policy hash 和两个 binding 相对路径的 receipt；任一错误发生时 receipt 不存在。afterPack 成功输出实际 runtime、platform/arch、SQLite 42、Sharp 2×2 PNG 和 unpack 路径。

- [ ] **Step 4: 运行 afterPack 测试确认 GREEN。**

Run: `node --test scripts/tests/runtime-security.test.mjs`

Expected: PASS，普通 Node fixture 仍被安全 gate 拒绝，错误 binding 路径也被拒绝。

- [ ] **Step 5: 写 release workflow contract tests。**

`scripts/tests/release-workflow.test.mjs` 断言 runner/target 精确映射：

```js
const expected = [
  ['ubuntu-22.04', '--linux --x64'],
  ['macos-15-intel', '--mac --x64'],
  ['macos-15', '--mac --arm64'],
  ['windows-2025', '--win --x64'],
]
```

并断言每个 matrix job 运行 npm bootstrap、`npm ci`、`npm run verify:install`、`npm run build:source` 和 electron-builder；不安装 `python3 make g++`，不含 `--ignore-scripts`；最终 release job 对全部 artifact 执行 SHA-256 并上传/发布 `checksums-sha256.txt`。

在 `src/tests/releaseArtifact.test.ts` 的 artifact name 参数补上 `['darwin-x64', 'dmg']`。

- [ ] **Step 6: 运行并确认 RED。**

Run: `node --test scripts/tests/release-workflow.test.mjs && npm exec vitest run src/tests/releaseArtifact.test.ts`

Expected: release workflow test FAIL（旧 runner、Linux 编译工具、缺 build:source/native contract）；artifact naming 用例可先 PASS。

- [ ] **Step 7: 更新 release workflow。**

使用固定 runner：`ubuntu-22.04`、`macos-15-intel`、`macos-15`、`windows-2025`。删除 Linux `python3 make g++` 安装。每个 job 顺序为精确工具链 → `npm ci` → `npm run verify:install` → contract files diff → `npm run build:source` → `npm exec electron-builder -- <target args>`。保留 `CSC_IDENTITY_AUTO_DISCOVERY=false`。

afterPack 自动执行打包运行时/native/ASAR gate。重命名后为单个 artifact 生成 SHA-256 sidecar，最终 release job 再生成包含所有文件的 `checksums-sha256.txt`，并把总表和安装包一起发布。

- [ ] **Step 8: 运行 release 静态测试确认 GREEN 并提交。**

Run: `node --test scripts/tests/release-workflow.test.mjs scripts/tests/runtime-security.test.mjs && npm exec vitest run src/tests/releaseArtifact.test.ts`

Expected: 全部 PASS。

```bash
git add scripts/check-packaged-runtime.cjs scripts/tests/runtime-security.test.mjs .github/workflows/release.yml src/tests/releaseArtifact.test.ts scripts/tests/release-workflow.test.mjs package.json
git diff --cached --check
git commit -m "ci(release): 校验原生安装包产物"
```

### Task 6: 统一用户与维护者安装文档

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`
- Create: `scripts/tests/install-docs.test.mjs`
- Modify: `package.json`（将文档测试加入 `test:architecture`）

**Interfaces:**
- Consumes: 最终 npm scripts、支持矩阵与未签名发布限制。
- Produces: 普通用户只有 `npm ci` 的可复制步骤；维护者显式版本升级说明；agent 文档与实际命令一致。

- [ ] **Step 1: 写文档失败测试。**

`scripts/tests/install-docs.test.mjs` 读取三份文档，断言：

```js
test('README gives ordinary users only npm ci', () => {
  const quickStart = section(readme, '## 快速开始', '## 配置模型')
  assert.match(quickStart, /Node\.js `24\.22\.1`/)
  assert.match(quickStart, /npm `10\.9\.4`/)
  assert.match(quickStart, /npm ci/)
  assert.doesNotMatch(quickStart, /npm install(?:\s|$)/m)
})

test('npm install appears only in the maintainer upgrade section', () => {
  const maintainer = section(readme, '### 维护者升级依赖', '## ')
  assert.match(maintainer, /npm install --save-exact <package>@<explicit-version>/)
  assert.equal((readme.match(/npm install/g) ?? []).length, 1)
})

test('README documents the support matrix and unsigned warnings', () => {
  for (const text of ['Windows 11 x64', 'macOS 13+', 'glibc 2.34', 'Gatekeeper', 'SmartScreen']) assert.match(readme, new RegExp(text))
})
```

另断言 `AGENTS.md` 与 `CLAUDE.md` 的安装命令是 `npm ci`，不再描述 electron-rebuild。

- [ ] **Step 2: 运行并确认 RED。**

Run: `node --test scripts/tests/install-docs.test.mjs`

Expected: FAIL，当前 README 使用宽版本和 `npm install`，AGENTS/CLAUDE 也未同步。

- [ ] **Step 3: 更新 README。**

快速开始精确写为：

```bash
git clone <repository-url>
cd PaperMind
npm ci
npm run dev
```

同节说明 `npm ci` 清理 `node_modules`、不改 manifest/lock、不一致直接失败、支持矩阵不需要编译工具、自定义 registry/代理/`ELECTRON_MIRROR` 只放用户本地。增加官方矩阵表和未签名 Gatekeeper/SmartScreen 限制；构建命令保持 `npm run build`。

在“参与贡献”下增加 `### 维护者升级依赖`：

```bash
npm install --save-exact <package>@<explicit-version>
npm ci
npm run verify:install
npm run typecheck
npm test
```

明确第一行只适用于维护者有意升级，普通用户不能用它代替 `npm ci`。

- [ ] **Step 4: 同步 agent 文档并确认 GREEN。**

`AGENTS.md` 的 Build 命令改为 `npm ci installs the exact locked dependency graph and prepares the verified Electron/native runtime`；`CLAUDE.md` 所有普通安装示例改为 `npm ci`，删除自动 rebuild 描述。

将文档测试加入 `test:architecture`。

Run: `node --test scripts/tests/install-docs.test.mjs && npm run typecheck`

Expected: PASS。

- [ ] **Step 5: 提交文档。**

```bash
git add README.md AGENTS.md CLAUDE.md scripts/tests/install-docs.test.mjs package.json
git diff --cached --check
git commit -m "docs: 统一 npm ci 安装流程"
```

### Task 7: 执行干净安装、源码构建和本机安装包总验收

**Files:**
- Modify only if a test exposes a defect: files owned by Tasks 1–6
- Record no generated `dist/`、`dist-electron/`、`release/` outputs in Git

**Interfaces:**
- Consumes: 完整项目命令和所有 contract tests。
- Produces: 本机 native 平台的全链路验证证据；四平台其余部分由 PR/release workflow 在推送后执行。

- [ ] **Step 1: 核对计划覆盖和工作区。**

Run:

```bash
git status --short --branch
git log --oneline main..HEAD
git diff --stat main...HEAD
```

Expected: 只包含本计划相关 commits；没有用户文件、生成产物或未说明修改。

- [ ] **Step 2: 从空 `node_modules` 做真实 `npm ci`。**

先保存契约 hash；将现有 `node_modules` 移到 `mktemp -d` 下的可恢复位置，不直接删除；运行精确工具链的 `npm ci`；比较 hash：

```bash
shasum package.json package-lock.json .npmrc > /tmp/papermind-contract-before.sha256
npm ci
shasum package.json package-lock.json .npmrc > /tmp/papermind-contract-after.sha256
diff -u /tmp/papermind-contract-before.sha256 /tmp/papermind-contract-after.sha256
```

Expected: 无编译器调用；postinstall 输出批准 Electron 元组、SQLite 42、Sharp 2×2 PNG；diff 为空。

- [ ] **Step 3: 运行完整测试与源码构建。**

Run:

```bash
npm run verify:install
npm test
npm run typecheck
npm run build:source
```

Expected: 全部 PASS；Vite 同时产生 renderer、main、preload bundle。若测试失败，按 systematic-debugging 找根因并为修复执行新的 RED→GREEN，不放宽 contract test。

- [ ] **Step 4: 在当前原生平台生成未签名安装包。**

Run: `CSC_IDENTITY_AUTO_DISCOVERY=false npm run build`

Expected: afterPack 输出批准 runtime、SQLite/Sharp smoke 与 `app.asar.unpacked` binding paths；当前平台安装包生成成功。macOS 无证书警告允许存在，runtime/native/ASAR gate 失败不允许忽略。

- [ ] **Step 5: 检查仓库没有生成文件和依赖漂移。**

Run:

```bash
git status --short
git diff --check
git diff -- package.json package-lock.json .npmrc
```

Expected: 只有计划中尚未提交的源文件（如存在）；依赖契约无安装引起的 diff；`dist/`、`dist-electron/`、`release/` 均被忽略且未暂存。

- [ ] **Step 6: 若总验收修复了缺陷，提交单一修复 commit。**

```bash
git add -p
git diff --cached --check
git commit -m "fix(build): 修复可复现安装验收问题"
```

如果没有修复，不创建空 commit。

- [ ] **Step 7: 准备分支级审查。**

Run:

```bash
git diff --check main...HEAD
git status --short --branch
git log --oneline main..HEAD
```

Expected: 工作区干净，全部提交属于本设计；随后按 `requesting-code-review` 对整个 `main...HEAD` 做一次 fresh review，再处理 Important/Critical findings。
